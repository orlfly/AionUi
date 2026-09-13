/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the ipc bridge before importing the module under test.
const calls = {
  created: [] as Array<Record<string, unknown>>,
  updated: [] as Array<Record<string, unknown>>,
  rules: [] as Array<{ assistant_id: string; content: string }>,
  imported: [] as string[],
  nextAssistantId: { n: 0 },
};

vi.mock('@/common', () => {
  const invoke = (impl: unknown): unknown => Object.assign(vi.fn(impl as never), { invoke: vi.fn(impl as never) });
  return {
    ipcBridge: {
      assistants: {
        create: invoke(async (req: Record<string, unknown>) => {
          calls.created.push(req);
          calls.nextAssistantId.n += 1;
          return { id: `new-${calls.nextAssistantId.n}`, name: req.name };
        }),
        update: invoke(async (req: Record<string, unknown>) => {
          calls.updated.push(req);
          return { id: req.id };
        }),
      },
      fs: {
        listAvailableSkills: invoke(async () => [{ name: 'kaneo-claim-task' }, { name: 'unrelated' }]),
        importSkills: invoke(async ({ skill_path }: { skill_path: string }) => {
          calls.imported.push(skill_path);
          return { skill_name: 'imported', skill_names: ['imported'] };
        }),
        writeAssistantRule: invoke(async ({ assistant_id, content }: { assistant_id: string; content: string }) => {
          calls.rules.push({ assistant_id, content });
          return true;
        }),
      },
    },
  };
});

import { syncKaneoAssistants } from '@/renderer/services/kaneo/kaneoSync';
import type { Assistant } from '@/common/types/agent/assistantTypes';

const TEMPLATES = {
  roles: [
    { name: 'coding', description: 'Coding role' },
    { name: 'testing', description: 'Testing role' },
  ],
  skills: [
    { name: 'claim-task', description: 'claim', forRoles: null },
    { name: 'code-style', description: 'style', forRoles: ['coding'] },
  ],
};

const mkAssistant = (id: string, name: string): Assistant => ({ id, name }) as unknown as Assistant;

beforeEach(() => {
  calls.created.length = 0;
  calls.updated.length = 0;
  calls.rules.length = 0;
  calls.imported.length = 0;
  calls.nextAssistantId.n = 0;
  vi.clearAllMocks();
});

// CRC-32 (reflected) for the zip stubs.
function crc32Of(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a minimal stored (uncompressed) zip with one text entry. */
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

const CONFIG_ZIP = makeZip([
  { name: 'roles/coding/AGENTS.md', content: 'CODING-AGENTS-MD-BODY' },
  { name: 'roles/testing/AGENTS.md', content: 'TESTING-AGENTS-MD-BODY' },
  { name: 'skills/claim-task/SKILL.md', content: '---\nname: kaneo-claim-task\ndescription: claim\n---\n\nclaim body' },
  { name: 'skills/code-style/SKILL.md', content: '---\nname: kaneo-code-style\ndescription: style\n---\n\nstyle body' },
]);

// Both fetches go through the same module; stub global fetch with URL dispatch.
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/agent/agents-config/templates')) {
        return new Response(JSON.stringify({ success: true, data: TEMPLATES }), { status: 200 });
      }
      if (url.endsWith('/api/agent/agents-config/download')) {
        return new Response(CONFIG_ZIP, { status: 200 });
      }
      if (url.endsWith('/api/fs/upload')) {
        return new Response(JSON.stringify({ success: true, data: '/tmp/aionui/general/x.zip' }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch
  );
}

describe('syncKaneoAssistants', () => {
  it('creates assistants for new roles and enables role-filtered skills', async () => {
    stubFetch();
    const result = await syncKaneoAssistants('http://kaneo', 'key', ['coding'], []);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toEqual({ role: 'coding', status: 'created' });
    expect(calls.created).toHaveLength(1);
    expect(calls.created[0]).toMatchObject({ name: 'Kaneo · coding', description: 'Coding role' });
    // claim-task is universal, code-style is coding-only; both imported.
    expect(calls.created[0]['custom_skill_names']).toEqual(['kaneo-claim-task', 'kaneo-code-style']);
    // Prompts carry the claim prompt.
    expect(calls.created[0]['prompts']).toHaveLength(1);
  });

  it('updates an existing Kaneo assistant in place instead of duplicating', async () => {
    stubFetch();
    const existing = [mkAssistant('a1', 'Kaneo · coding')];
    const result = await syncKaneoAssistants('http://kaneo', 'key', ['coding'], existing);

    expect(result.results[0]).toEqual({ role: 'coding', status: 'updated' });
    expect(calls.created).toHaveLength(0);
    expect(calls.updated).toHaveLength(1);
    expect(calls.updated[0]).toMatchObject({ id: 'a1', description: 'Coding role' });
  });

  it('never touches non-Kaneo assistants', async () => {
    stubFetch();
    const existing = [mkAssistant('a2', 'My coding assistant')];
    await syncKaneoAssistants('http://kaneo', 'key', ['coding'], existing);

    expect(calls.updated.every((u) => u['id'] !== 'a2')).toBe(true);
    expect(calls.created.every((c) => c['name'] === 'Kaneo · coding')).toBe(true);
  });

  it('isolates per-role failures without affecting other roles', async () => {
    stubFetch();
    const common = await import('@/common');
    (common.ipcBridge.fs.writeAssistantRule.invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('rule write failed')
    );

    const result = await syncKaneoAssistants('http://kaneo', 'key', ['coding', 'testing'], []);
    const byRole = Object.fromEntries(result.results.map((r) => [r.role, r.status]));
    expect(byRole['coding']).toBe('failed');
    expect(byRole['testing']).toBe('created');
  });

  it('writes role AGENTS.md via assistant rule and never exposes the API key', async () => {
    stubFetch();
    await syncKaneoAssistants('http://kaneo', 'super-secret-key', ['coding'], []);

    expect(calls.rules.length).toBeGreaterThan(0);
    for (const r of calls.rules) expect(r.content).not.toContain('super-secret-key');
    for (const c of [...calls.created, ...calls.updated]) {
      expect(JSON.stringify(c)).not.toContain('super-secret-key');
    }
  });
});
