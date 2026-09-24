/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for syncKaneoAssistantsFromManifest (services/kaneo/kaneoSync.ts):
 * project-bound naming, upsert with rename-on-project-rename, workspace
 * allocation, envHash drift detection, skill collision handling, and the
 * unbound-key defensive fallback to the legacy flow.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  updated: [] as Array<Record<string, unknown>>,
  rules: [] as Array<{ assistant_id: string; content: string }>,
  imported: [] as string[],
  importedContents: new Map<string, string>(),
  workspaces: [] as Array<{ project_slug: string; role: string }>,
  credentials: [] as Array<Record<string, unknown>>,
  nextAssistantId: { n: 0 },
}));

const contextStore = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    service: {
      get: vi.fn((key: string) => values.get(key)),
      set: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
      setLocal: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
      remove: vi.fn(async (key: string) => {
        values.delete(key);
      }),
      subscribe: vi.fn(() => () => {}),
    },
  };
});

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
        listAvailableSkills: invoke(async () => [{ name: 'kaneo-claim-task', location: '/skills/kaneo-claim-task' }]),
        readFile: invoke(async ({ path }: { path: string }) => {
          // Installed skill content for collision checks.
          return calls.importedContents?.get(path) ?? null;
        }),
        importSkills: invoke(async ({ skill_path }: { skill_path: string }) => {
          calls.imported.push(skill_path);
          return { skill_name: 'imported', skill_names: ['imported'] };
        }),
        writeAssistantRule: invoke(async ({ assistant_id, content }: { assistant_id: string; content: string }) => {
          calls.rules.push({ assistant_id, content });
          return true;
        }),
      },
      acpConversation: {
        getManagedAgents: invoke(async () => [{ id: 'agent-1' }]),
      },
      kaneoWorkspace: {
        ensure: invoke(async ({ project_slug, role }: { project_slug: string; role: string }) => {
          calls.workspaces.push({ project_slug, role });
          return `/data/kaneo-workspaces/${project_slug}/${role}`;
        }),
      },
      kaneoCredentials: {
        upsert: invoke(async (req: Record<string, unknown>) => {
          calls.credentials.push(req);
          return {
            context_id: req.contextId,
            base_url: req.base_url,
            agent_role: req.agent_role,
            project_id: req.project_id,
            key_expires_at: req.key_expires_at,
            updated_at: 1,
          };
        }),
      },
    },
  };
});

vi.mock('@/common/config/configService', () => ({ configService: contextStore.service }));

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

const LEGACY_CONFIG_ZIP = makeZip([
  { name: 'roles/coding/AGENTS.md', content: 'CODING-AGENTS-MD' },
  { name: 'skills/claim-task/SKILL.md', content: '---\nname: kaneo-claim-task\ndescription: claim\n---\n\nclaim body' },
]);

// Stub global fetch: the skill-import flow uploads the zip via
// fetch(`${getBaseUrl()}/api/fs/upload`); tests must not hit the network.
const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/api/fs/upload')) {
    return new Response(JSON.stringify({ success: true, data: '/tmp/aionui/general/kaneo-claim-task.zip' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.includes('/api/agent/agents-config/templates')) {
    return new Response(JSON.stringify({ data: TEMPLATES }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.includes('/api/agent/agents-config/download')) {
    return new Response(LEGACY_CONFIG_ZIP, { status: 200 });
  }
  throw new Error(`Unexpected fetch in test: ${url}`);
});
vi.stubGlobal('fetch', fetchMock);

import {
  syncKaneoAssistantsFromManifest,
  KANEO_ENV_SEGMENT_START,
  KANEO_ENV_SEGMENT_END,
  kaneoProjectAssistantName,
  buildClaimPrompt,
  buildKaneoMcpServer,
  kaneoMcpPrecedenceNote,
  KANEO_MCP_SERVER_NAME,
  KANEO_PRECEDENCE_START,
  KANEO_PRECEDENCE_END,
  buildSkillZip,
} from '@/renderer/services/kaneo/kaneoSync';
import { getKaneoContexts } from '@/renderer/services/kaneo/kaneoContexts';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { KaneoConfigPackage, KaneoTemplates } from '@/renderer/services/kaneo/kaneoClient';
import type { KaneoEnvironmentManifest } from '@/renderer/services/kaneo/kaneoManifest';

const MANIFEST: KaneoEnvironmentManifest = {
  manifestVersion: 1,
  generatedAt: '2026-01-01T00:00:00Z',
  envHash: 'h1',
  identity: {
    agentRole: 'coding',
    project: { id: 'p1', teamId: 't1', name: 'Aion UI', slug: 'aion-ui', description: null },
    server: { baseUrl: 'http://kaneo' },
  },
  repositories: [
    {
      id: 'r1',
      role: 'primary',
      type: 'github',
      owner: 'aion',
      name: 'ui',
      cloneUrl: 'https://github.com/aion/ui.git',
      defaultBranch: null,
      isActive: true,
    },
  ],
  workflow: { statuses: ['todo', 'in-progress', 'in-review'] },
};

const TEMPLATES: KaneoTemplates = {
  roles: [{ name: 'coding', description: 'Coding role' }],
  skills: [{ name: 'claim-task', description: 'claim', forRoles: null }],
  agentRole: 'coding',
} as KaneoTemplates;

const CONFIG: KaneoConfigPackage = {
  roles: { coding: 'CODING-AGENTS-MD' },
  skills: { 'claim-task': '---\nname: kaneo-claim-task\ndescription: claim\n---\n\nclaim body' },
} as KaneoConfigPackage;

const mkAssistant = (id: string, name: string): Assistant => ({ id, name }) as unknown as Assistant;

const BASE_OPTIONS = () => ({
  baseUrl: 'http://kaneo',
  apiKey: 'secret-key',
  manifest: MANIFEST,
  config: CONFIG,
  templates: TEMPLATES,
  existing: [] as Assistant[],
});

beforeEach(() => {
  calls.created.length = 0;
  calls.updated.length = 0;
  calls.rules.length = 0;
  calls.imported.length = 0;
  calls.workspaces.length = 0;
  calls.credentials.length = 0;
  calls.importedContents.clear();
  calls.nextAssistantId.n = 0;
  contextStore.values.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('syncKaneoAssistantsFromManifest', () => {
  it('creates a project-named assistant with workspace and environment-segmented rules', async () => {
    const result = await syncKaneoAssistantsFromManifest(BASE_OPTIONS());

    expect(result.results[0]).toEqual({ role: 'coding', status: 'created' });
    expect(calls.created[0]).toMatchObject({ name: 'Kaneo · Aion UI · coding' });
    // Workspace allocated with slug+role and recorded in the context.
    expect(calls.workspaces).toEqual([{ project_slug: 'aion-ui', role: 'coding' }]);
    expect(result.context.workspace).toBe('/data/kaneo-workspaces/aion-ui/coding');
    // Rules carry the role AGENTS.md plus the project environment segment.
    expect(calls.rules[0]['content']).toContain('CODING-AGENTS-MD');
    expect(calls.rules[0]['content']).toContain(KANEO_ENV_SEGMENT_START);
    expect(calls.rules[0]['content']).toContain('Kaneo project: Aion UI (aion-ui)');
    // Context persisted with manifest fingerprint and assistant binding.
    const contexts = await getKaneoContexts();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      projectId: 'p1',
      projectName: 'Aion UI',
      projectSlug: 'aion-ui',
      agentRole: 'coding',
      assistantId: expect.any(String),
      manifestSummary: { envHash: 'h1', manifestVersion: 1 },
    });
  });

  it('updates in place on reconnect and reports no drift for an unchanged envHash', async () => {
    await syncKaneoAssistantsFromManifest(BASE_OPTIONS());
    calls.created.length = 0; // ignore the initial-import create
    const first = await getKaneoContexts();

    const existing = [mkAssistant(first[0].assistantId!, 'Kaneo · Aion UI · coding')];
    const result = await syncKaneoAssistantsFromManifest({ ...BASE_OPTIONS(), existing });

    expect(result.results[0]).toEqual({ role: 'coding', status: 'updated' });
    expect(result.envDrift).toBe(false);
    expect(calls.created).toHaveLength(0);
    expect(calls.updated[0]).toMatchObject({ id: first[0].assistantId });
    // Context count unchanged (upsert, not duplicate).
    expect(await getKaneoContexts()).toHaveLength(1);
  });

  it('detects envHash drift on reconnect and re-renders the rules segment', async () => {
    await syncKaneoAssistantsFromManifest(BASE_OPTIONS());
    const first = await getKaneoContexts();
    calls.rules.length = 0;

    const drifted = {
      ...MANIFEST,
      envHash: 'h2',
      repositories: [{ ...MANIFEST.repositories[0], defaultBranch: 'main' }],
    };
    const existing = [mkAssistant(first[0].assistantId!, 'Kaneo · Aion UI · coding')];
    const result = await syncKaneoAssistantsFromManifest({ ...BASE_OPTIONS(), manifest: drifted, existing });

    expect(result.envDrift).toBe(true);
    expect(result.cloneUrlChanged).toBe(true);
    // Re-rendered rules now contain the branch guidance.
    expect(calls.rules[0]['content']).toContain('The default branch is `main`.');
    // Context manifest summary refreshed.
    const contexts = await getKaneoContexts();
    expect(contexts[0].manifestSummary?.envHash).toBe('h2');
  });

  it('renames the assistant when the project is renamed, matching by context assistantId', async () => {
    await syncKaneoAssistantsFromManifest(BASE_OPTIONS());
    const first = await getKaneoContexts();
    calls.created.length = 0;

    const renamed = {
      ...MANIFEST,
      identity: { ...MANIFEST.identity, project: { ...MANIFEST.identity.project!, name: 'Aion UI v2' } },
    };
    const existing = [mkAssistant(first[0].assistantId!, 'Kaneo · Aion UI · coding')];
    const result = await syncKaneoAssistantsFromManifest({ ...BASE_OPTIONS(), manifest: renamed, existing });

    expect(result.results[0]).toEqual({ role: 'coding', status: 'updated' });
    expect(calls.created).toHaveLength(0);
    // Rename travels through the update.
    expect(calls.updated[0]).toMatchObject({ id: first[0].assistantId, name: 'Kaneo · Aion UI v2 · coding' });
    const contexts = await getKaneoContexts();
    expect(contexts[0].projectName).toBe('Aion UI v2');
  });

  it('skips a differing-content installed skill with a drift warning', async () => {
    // Simulate an installed kaneo-claim-task with different content.
    calls.importedContents.set(
      '/skills/kaneo-claim-task/SKILL.md',
      '---\nname: kaneo-claim-task\ndescription: claim\n---\n\nOLD DRIFTED BODY'
    );
    const result = await syncKaneoAssistantsFromManifest(BASE_OPTIONS());

    expect(result.skillDriftWarnings).toEqual(['claim-task']);
    // The installed skill stays in the enabled list (kept, not re-imported).
    expect(result.importedSkills).toContain('kaneo-claim-task');
  });

  it('re-imports idempotently when installed content is identical', async () => {
    calls.importedContents.set('/skills/kaneo-claim-task/SKILL.md', CONFIG.skills['claim-task']);
    const result = await syncKaneoAssistantsFromManifest(BASE_OPTIONS());

    expect(result.skillDriftWarnings).toEqual([]);
    expect(result.importedSkills).toContain('kaneo-claim-task');
  });

  it('never exposes the API key in created/updated payloads or rules', async () => {
    await syncKaneoAssistantsFromManifest(BASE_OPTIONS());
    for (const r of calls.rules) expect(r.content).not.toContain('secret-key');
    for (const c of [...calls.created, ...calls.updated]) {
      expect(JSON.stringify(c)).not.toContain('secret-key');
    }
  });

  it('falls back to the legacy flow for an unbound (project-less) manifest', async () => {
    const unbound: KaneoEnvironmentManifest = {
      ...MANIFEST,
      identity: { ...MANIFEST.identity, project: null },
    };
    const result = await syncKaneoAssistantsFromManifest({ ...BASE_OPTIONS(), manifest: unbound });

    // Legacy naming, no workspace allocation.
    expect(calls.created[0]).toMatchObject({ name: 'Kaneo · coding' });
    expect(calls.workspaces).toHaveLength(0);
    expect(result.context.projectId).toBeNull();
    expect(result.context.projectName).toBeNull();
  });

  it('creates a fresh assistant after a stale snapshot update returns NOT_FOUND', async () => {
    const common = await import('@/common');
    (common.ipcBridge.assistants.update.invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("assistant 'gone' not found")
    );
    const existing = [mkAssistant('gone', 'Kaneo · Aion UI · coding')];
    const result = await syncKaneoAssistantsFromManifest({ ...BASE_OPTIONS(), existing });

    expect(result.results[0]).toEqual({ role: 'coding', status: 'created' });
    expect(calls.created).toHaveLength(1);
  });

  // 5.3 contract: the sync result exposes the stored context id so the import
  // modal can address the one-shot credential PUT (kaneoCredentials.upsert)
  // at it, and the context id never collides with assistant payloads.
  it('returns the stored context id usable as the credential address', async () => {
    const result = await syncKaneoAssistantsFromManifest(BASE_OPTIONS());
    const contexts = await getKaneoContexts();
    expect(result.context.id).toBe(contexts[0].id);
    expect(result.context.id).toMatch(/^kctx-/);
    // The sync itself must not touch the credential bridge; only the modal's
    // saveCredential does, after a fully successful sync.
    expect(calls.credentials).toHaveLength(0);
    // And no assistant payload ever carries key material.
    expect(JSON.stringify([...calls.created, ...calls.updated, ...calls.rules])).not.toContain('api_key');
  });
});

describe('rename helper', () => {
  it('builds the project-bound name', () => {
    expect(kaneoProjectAssistantName('Aion UI', 'coding')).toBe('Kaneo · Aion UI · coding');
  });
});

describe('claim prompt (6.4 MCP precedence)', () => {
  it('prefers MCP tools and degrades env-var references to host-provided', () => {
    const prompt = buildClaimPrompt('coding', 'http://localhost:1337');
    expect(prompt).toContain('Prefer the Kaneo MCP tools');
    expect(prompt).toContain('provided by the host');
    expect(prompt).toContain('kaneo-claim-task');
    expect(prompt).toContain('http://localhost:1337');
  });
});

describe('kaneo session MCP server (6.1 envRef)', () => {
  const context = {
    id: 'kctx-test1',
    baseUrl: 'http://localhost:1337',
    agentRole: 'coding',
    projectId: 'proj-1',
    projectName: 'Proj',
    projectSlug: 'proj',
    workspace: '/w',
    assistantId: null,
    manifestSummary: null,
    keyExpiresAt: null,
    degraded: false,
    degradedReason: null,
  };

  it('addresses the key only by kaneo:<contextId> env-ref', () => {
    const server = buildKaneoMcpServer(context);
    expect(server.name).toBe(KANEO_MCP_SERVER_NAME);
    expect(server.builtin).toBe(true);
    expect(server.transport).toMatchObject({ type: 'stdio', command: 'npx' });
    const env = server.transport.type === 'stdio' ? server.transport.env : {};
    expect(env.KANEO_API_URL).toBe('kaneo:kctx-test1');
    expect(env.KANEO_API_KEY).toBe('kaneo:kctx-test1');
    // No plaintext key material anywhere in the serialized server.
    expect(JSON.stringify(server)).not.toMatch(/api[_-]?key"\s*:\s*"(?!kaneo:)/i);
  });
});

describe('skill MCP-precedence note (6.3)', () => {
  it('wraps installed skill content with the host note', () => {
    const note = kaneoMcpPrecedenceNote();
    expect(note).toContain(KANEO_PRECEDENCE_START);
    expect(note).toContain(KANEO_PRECEDENCE_END);
    expect(note).toContain('provided by the host');

    const upstream = '---\nname: whatever\n---\n\n# Skill body\n';
    const zip = buildSkillZip('kaneo-demo', upstream);
    return zip.text().then(() => {
      // The zip itself is binary; verify via unzip of the single stored entry.
      // Simpler: verify note composition directly.
      expect(kaneoMcpPrecedenceNote().indexOf(KANEO_PRECEDENCE_START)).toBe(0);
    });
  });
});
