/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Tests for useKaneoCreateTab: connection state machine, role narrowing for
// role-scoped keys, create gating on explicit role+project, and the one-shot
// credential hand-off. Client fetches are stubbed at network level.

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const credentialsUpsert = vi.fn(async () => ({ ok: true }));
const assistantsCreate = vi.fn(async (req: { name: string }) => {
  createdCount += 1;
  return { id: `assistant-${createdCount}`, name: req.name };
});
const assistantsUpdate = vi.fn(async (req: { id: string }) => ({ id: req.id }));
let createdCount = 0;

// jsdom's Blob lacks .stream(); inflateEntry needs it for zip entries.
if (typeof globalThis.Blob !== 'undefined' && !globalThis.Blob.prototype.stream) {
  Object.defineProperty(globalThis.Blob.prototype, 'stream', {
    value(this: Blob) {
      return new Response(this as unknown as BodyInit).body!;
    },
    configurable: true,
  });
}

vi.mock('@/common/adapter/httpBridge', () => ({ getBaseUrl: () => 'http://localhost:1337' }));

vi.mock('@/common', () => ({
  ipcBridge: {
    assistants: {
      create: { invoke: (...args: unknown[]) => assistantsCreate(...(args as [never])) },
      update: { invoke: (...args: unknown[]) => assistantsUpdate(...(args as [never])) },
    },
    fs: {
      listAvailableSkills: { invoke: async () => [] },
      importSkills: { invoke: async () => ({ skill_names: [] }) },
      writeAssistantRule: { invoke: async () => true },
      upload: { invoke: async () => '/tmp/aionui/general/x.zip' },
    },
    kaneoWorkspace: {
      ensure: {
        invoke: async ({ project_slug, role }: { project_slug: string; role: string }) => ({
          path: `/ws/${project_slug}/${role}/`,
          created: true,
        }),
      },
    },
    kaneoCredentials: {
      upsert: { invoke: (...args: unknown[]) => credentialsUpsert(...(args as [never])) },
    },
    acpConversation: {
      getManagedAgents: { invoke: async () => [] },
    },
  },
}));

const configValues = new Map<string, unknown>();
vi.mock('@/common/config/configService', () => ({
  configService: {
    get: (key: string) => configValues.get(key),
    set: async (key: string, value: unknown) => void configValues.set(key, value),
    remove: async (key: string) => void configValues.delete(key),
    subscribe: () => () => undefined,
  },
}));

import { useKaneoCreateTab } from '@/renderer/pages/settings/AssistantSettings/useKaneoCreateTab';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import { getKaneoContexts, setKaneoContexts } from '@/renderer/services/kaneo/kaneoContexts';

const mkAssistant = (id: string, name: string): Assistant => ({ id, name }) as unknown as Assistant;

const TEMPLATES = {
  roles: [
    { name: 'coding', description: 'Coding role' },
    { name: 'testing', description: 'Testing role' },
  ],
  skills: [{ name: 'claim-task', description: 'claim', forRoles: null }],
  agentRole: 'coding',
};

const PROJECTS = {
  projects: [{ id: 'proj-1', name: 'AionUi', slug: 'aionui' }],
};

// Minimal stored-format zip builder (same pattern as kaneoSyncFlow.test.ts).
function crc32Of(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries: Array<{ name: string; content: string }>): ArrayBuffer {
  const enc = new TextEncoder();
  const u16 = (v: number): Uint8Array => new Uint8Array([v & 255, (v >>> 8) & 255]);
  const u32 = (v: number): Uint8Array => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBytes = enc.encode(name);
    const dataBytes = enc.encode(content);
    const crc = crc32Of(dataBytes);
    locals.push(
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(dataBytes.length),
      u32(dataBytes.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      dataBytes
    );
    centrals.push(
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(dataBytes.length),
      u32(dataBytes.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(offset),
      u32(0),
      nameBytes
    );
    offset += 30 + nameBytes.length + dataBytes.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const all = [
    ...locals,
    ...centrals,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralSize),
    u32(offset),
    u16(0),
  ];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of all) {
    out.set(c, pos);
    pos += c.length;
  }
  return out.buffer;
}

const CONFIG_ZIP = makeZip([{ name: 'roles/coding/AGENTS.md', content: 'CODING-AGENTS-MD-BODY' }]);

function stubNetwork(options: { bootstrap: 'missing' | 'manifest'; agentRole?: string | null }): void {
  configValues.set('kaneo.contexts', []);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/agent/agents-config/bootstrap')) {
        if (options.bootstrap === 'missing') {
          return new Response(JSON.stringify({ success: false }), { status: 404 });
        }
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              manifestVersion: 1,
              generatedAt: '2025-01-01T00:00:00Z',
              envHash: 'h',
              identity: {
                agentRole: options.agentRole ?? 'coding',
                project: { id: 'proj-1', name: 'AionUi', slug: 'aionui' },
                server: { baseUrl: 'http://localhost' },
              },
              repositories: [],
              workflow: { statuses: [] },
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/agent/agents-config/templates')) {
        return new Response(
          JSON.stringify({ success: true, data: { ...TEMPLATES, agentRole: options.agentRole ?? null } }),
          { status: 200 }
        );
      }
      if (url.includes('/api/agent/agents-config/download')) {
        return new Response(CONFIG_ZIP, { status: 200 });
      }
      if (url.includes('/api/team')) {
        return new Response(JSON.stringify({ success: true, data: [{ id: 'team-1' }] }), { status: 200 });
      }
      if (url.includes('/api/project')) {
        return new Response(JSON.stringify({ success: true, data: PROJECTS.projects }), {
          status: 200,
        });
      }
      if (url.includes('/api/fs/upload')) {
        return new Response(JSON.stringify({ success: true, data: '/tmp/aionui/general/x.zip' }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch
  );
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  createdCount = 0;
  assistantsCreate.mockClear();
  assistantsUpdate.mockClear();
  credentialsUpsert.mockClear();
  configValues.clear();
  setKaneoContexts([]);
  vi.unstubAllGlobals();
  stubNetwork({ bootstrap: 'missing', agentRole: 'coding' });
});

const connectVia = async (hook: ReturnType<typeof renderHook<ReturnType<typeof useKaneoCreateTab>>>) => {
  // setApiKey sessions batch between renders; render first so connect's
  // useCallback closes over the fresh apiKey state.
  await act(async () => {
    hook.result.current.setApiKey('k-key');
  });
  await act(async () => {
    await hook.result.current.connect();
  });
};

describe('useKaneoCreateTab', () => {
  it('connects and narrows roles to the key-bound role', async () => {
    const hook = renderHook(() => useKaneoCreateTab({ existing: [] }));
    await connectVia(hook);

    await waitFor(() => expect(hook.result.current.phase).toBe('connected'));
    const selectable = hook.result.current.roles.filter((r) => r.selectable);
    expect(selectable.map((r) => r.name)).toEqual(['coding']);
    expect(hook.result.current.roles.find((r) => r.name === 'testing')?.selectable).toBe(false);
  });

  it('create stays disabled until both role and project are selected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('bootstrap')) return new Response(JSON.stringify({ success: false }), { status: 404 });
        if (url.includes('/api/team')) {
          return new Response(JSON.stringify({ success: true, data: [{ id: 'team-1' }] }), { status: 200 });
        }
        if (url.includes('/templates')) {
          return new Response(JSON.stringify({ success: true, data: { ...TEMPLATES, agentRole: 'coding' } }), {
            status: 200,
          });
        }
        if (url.includes('/download')) return new Response(CONFIG_ZIP, { status: 200 });
        if (url.includes('/api/project')) {
          return new Response(JSON.stringify({ success: false }), { status: 500 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as unknown as typeof fetch
    );
    const hook = renderHook(() => useKaneoCreateTab({ existing: [] }));
    await connectVia(hook);

    await waitFor(() => expect(hook.result.current.phase).toBe('connected'));
    expect(hook.result.current.canCreate).toBe(false);
    // Project listing degraded to an empty picker (per-request failure is
    // non-fatal); Create stays disabled because nothing is selectable.
    expect(hook.result.current.projects).toEqual([]);
    expect(hook.result.current.canCreate).toBe(false);

    act(() => hook.result.current.selectProject('proj-1'));
    await act(async () => {});
    expect(hook.result.current.canCreate).toBe(true);
  });

  it('surfaces connect failure with a non-blocking error and retains the base URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch);
    const hook = renderHook(() => useKaneoCreateTab({ existing: [] }));
    hook.result.current.setBaseUrl('http://kaneo-fail');
    hook.result.current.setApiKey('k');
    await act(async () => {});
    await act(async () => {
      await hook.result.current.connect();
    });
    await waitFor(() => expect(hook.result.current.phase).toBe('error'));
    expect(hook.result.current.connectError).toBeTruthy();
    expect(hook.result.current.baseUrl).toBe('http://kaneo-fail');
  });

  it('hands the plaintext key to the backend exactly once and then drops it', async () => {
    const hook = renderHook(() => useKaneoCreateTab({ existing: [] }));
    await connectVia(hook);
    await waitFor(() => expect(hook.result.current.projects.length).toBeGreaterThan(0));
    act(() => hook.result.current.selectProject('proj-1'));

    await act(async () => {
      await hook.result.current.create();
    });

    expect(assistantsCreate).toHaveBeenCalledTimes(1);
    expect(credentialsUpsert).toHaveBeenCalledTimes(1);
    expect(credentialsUpsert.mock.calls[0]?.[0]).toMatchObject({
      agent_role: 'coding',
      project_id: 'proj-1',
      api_key: 'k-key',
    });
    // Key dropped after the hand-off.
    expect(hook.result.current.apiKey).toBe('');
    expect(hook.result.current.lastResult?.status).toBe('created');
  });

  it('does not re-fire the project load with an empty key after a successful create', async () => {
    const teamCalls: string[] = [];
    const previousFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = String(new Headers(init?.headers).get('Authorization') ?? '');
      if (url.includes('/api/team')) {
        teamCalls.push(auth);
        if (auth !== 'Bearer k-key') {
          return new Response('unauthorized', { status: 401 });
        }
        return new Response(JSON.stringify({ success: true, data: [{ id: 'team-1' }] }), { status: 200 });
      }
      return previousFetch(input, init);
    }) as unknown as typeof fetch);
    const hook = renderHook(() => useKaneoCreateTab({ existing: [] }));
    await connectVia(hook);
    await waitFor(() => expect(hook.result.current.projects.length).toBeGreaterThan(0));
    act(() => hook.result.current.selectProject('proj-1'));

    await act(async () => {
      await hook.result.current.create();
    });
    expect(hook.result.current.lastResult?.status).toBe('created');
    // Allow any post-create effect flush: no further (empty-key) team call.
    await act(async () => {});
    expect(teamCalls.every((auth) => auth === 'Bearer k-key')).toBe(true);
  });

  it('releaseSecrets clears the key without any PUT when the tab closes', async () => {
    const hook = renderHook(() => useKaneoCreateTab({ existing: [] }));
    hook.result.current.setApiKey('dirty-key');
    act(() => hook.result.current.releaseSecrets());

    expect(hook.result.current.apiKey).toBe('');
    expect(credentialsUpsert).not.toHaveBeenCalled();
    expect(getKaneoContexts()).toHaveLength(0);
  });

  it('an unbound key offers the full role grid (legacy fallback)', async () => {
    stubNetwork({ bootstrap: 'missing', agentRole: null });
    const hook = renderHook(() => useKaneoCreateTab({ existing: [] }));
    await connectVia(hook);
    await waitFor(() => expect(hook.result.current.phase).toBe('connected'));

    expect(hook.result.current.roles.map((r) => r.selectable)).toEqual([true, true]);
  });
});
