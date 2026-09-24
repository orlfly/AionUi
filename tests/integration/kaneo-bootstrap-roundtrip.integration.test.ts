/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Integration test 3.8: bootstrap-mock round trip for the project-scoped
// Kaneo import. A real local HTTP server plays the Kaneo instance (bootstrap
// manifest + templates + a genuine zip config download served over HTTP), the
// sync service runs against an in-memory ipcBridge store, and the assertions
// verify the full pipeline end to end: project-named assistant, rules with
// the rendered project environment segment, workspace allocation, skills
// filtered by the bound role, and context upsert with drift detection.
//
// Real integration boundaries exercised (beyond the unit suite):
//   - genuine zip bytes parsed by kaneoClient's central-directory reader,
//     including deflate-raw entries via DecompressionStream
//   - HTTP multipart upload of the skill staging zip, whose payload is
//     unpacked by the mock skills importer (as the backend would)
//   - the live aioncore `/api/fs/kaneo-workspace` endpoint (skipped when the
//     backend is not running)
//
// Env:
//   AIONUI_TEST_URL e.g. http://127.0.0.1:<port> for the live workspace check

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { deflateRawSync } from 'node:zlib';

const u16 = (v: number): Uint8Array => new Uint8Array([v & 255, (v >>> 8) & 255]);
const u32 = (v: number): Uint8Array => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);

vi.mock('@/common', () => {
  const store = {
    assistants: new Map<string, Record<string, unknown>>(),
    rules: new Map<string, string>(),
    skills: new Map<string, { location: string; content: string | null }>(),
    uploadedZips: [] as Array<{ path: string; fileName: string; bytes: Uint8Array }>,
    importedPaths: [] as string[],
    workspaces: [] as Array<{ project_slug: string; role: string }>,
    nextAssistantId: { n: 0 },
  };
  const invoke = (impl: unknown): unknown => Object.assign(vi.fn(impl as never), { invoke: vi.fn(impl as never) });
  const bridge = {
    ipcBridge: {
      assistants: {
        create: invoke(async (req: Record<string, unknown>) => {
          store.nextAssistantId.n += 1;
          const id = `ast-${store.nextAssistantId.n}`;
          store.assistants.set(id, { id, ...req });
          return { id, name: req.name };
        }),
        update: invoke(async (req: { id: string } & Record<string, unknown>) => {
          if (!store.assistants.has(req.id)) throw new Error(`assistant ${req.id} not found`);
          store.assistants.set(req.id, { ...store.assistants.get(req.id), ...req });
          return { id: req.id };
        }),
      },
      fs: {
        listAvailableSkills: invoke(async () =>
          Array.from(store.skills.entries()).map(([name, s]) => ({ name, location: s.location }))
        ),
        readFile: invoke(async ({ path }: { path: string }) => {
          for (const s of store.skills.values()) {
            if (`${s.location}/SKILL.md` === path) return s.content;
          }
          return null;
        }),
        importSkills: invoke(async ({ skill_path }: { skill_path: string }) => {
          store.importedPaths.push(skill_path);
          // Unpack the staged zip like the backend would: one stored entry
          // `<name>/SKILL.md`; register the skill under its directory name.
          const uploaded = store.uploadedZips.find((z) => z.path === skill_path);
          if (!uploaded)
            return { skill_name: 'x', skill_names: ['x'], failed: [{ source_name: 'x', code: 'missing' }] };
          const decoded = readStoredZipEntry(uploaded.bytes);
          store.skills.set(decoded.dir, { location: `/skills/${decoded.dir}`, content: decoded.content });
          return { skill_name: decoded.dir, skill_names: [decoded.dir], failed: [] };
        }),
        writeAssistantRule: invoke(async ({ assistant_id, content }: { assistant_id: string; content: string }) => {
          store.rules.set(assistant_id, content);
          return true;
        }),
      },
      acpConversation: {
        getManagedAgents: invoke(async () => [{ id: 'agent-1' }]),
      },
      kaneoWorkspace: {
        ensure: invoke(async ({ project_slug, role }: { project_slug: string; role: string }) => {
          store.workspaces.push({ project_slug, role });
          return `/managed/kaneo-workspaces/${project_slug}/${role}`;
        }),
      },
    },
  };
  return { ipcBridge: bridge.ipcBridge, __store: store };
});

vi.mock('@/common/config/configService', () => {
  const values = new Map<string, unknown>();
  const service = {
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
  };
  return { configService: service, __values: values };
});

/** Read the first local zip entry: stored (method 0), no extra field. */
function readStoredZipEntry(bytes: Uint8Array): { dir: string; content: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const compSize = view.getUint32(18, true);
  const name = new TextDecoder().decode(bytes.subarray(30, 30 + nameLen));
  const data = bytes.subarray(30 + nameLen + extraLen, 30 + nameLen + extraLen + compSize);
  return { dir: name.split('/')[0], content: new TextDecoder().decode(data) };
}

import type { Assistant } from '../../packages/desktop/src/common/types/agent/assistantTypes';
import type {
  KaneoConfigPackage,
  KaneoTemplates,
} from '../../packages/desktop/src/renderer/services/kaneo/kaneoClient';
import type { KaneoEnvironmentManifest } from '../../packages/desktop/src/renderer/services/kaneo/kaneoManifest';
import {
  KANEO_ENV_SEGMENT_END,
  KANEO_ENV_SEGMENT_START,
  kaneoProjectAssistantName,
  syncKaneoAssistantsFromManifest,
} from '../../packages/desktop/src/renderer/services/kaneo/kaneoSync';
import { getKaneoContexts } from '../../packages/desktop/src/renderer/services/kaneo/kaneoContexts';
import { fetchKaneoBootstrap } from '../../packages/desktop/src/renderer/services/kaneo/kaneoManifest';

// Test doubles handed to the sync service; the mocked ipcBridge above stores
// everything in memory so the round trip never leaves the test process
// (except the Kaneo-side HTTP calls, which hit the local mock server).
const store = (await import('@/common')) as unknown as { __store: TestStore };
const values = (await import('@/common/config/configService')) as unknown as { __values: Map<string, unknown> };

type TestStore = {
  assistants: Map<string, Record<string, unknown>>;
  rules: Map<string, string>;
  skills: Map<string, { location: string; content: string | null }>;
  uploadedZips: Array<{ path: string; fileName: string; bytes: Uint8Array }>;
  importedPaths: string[];
  workspaces: Array<{ project_slug: string; role: string }>;
  nextAssistantId: { n: number };
};

// ── Fixtures ────────────────────────────────────────────────────────────────

const MANIFEST: KaneoEnvironmentManifest = {
  manifestVersion: 1,
  generatedAt: '2026-01-01T00:00:00Z',
  envHash: 'env-h1',
  identity: {
    agentRole: 'coding',
    project: { id: 'p1', teamId: 't1', name: 'Aion UI', slug: 'aion-ui', description: null },
    server: { baseUrl: 'http://127.0.0.1:mock' },
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
    {
      id: 'r2',
      role: 'secondary',
      type: 'github',
      owner: 'aion',
      name: 'docs',
      cloneUrl: 'https://github.com/aion/docs.git',
      defaultBranch: 'main',
      isActive: true,
    },
  ],
  workflow: { statuses: ['todo', 'in-progress', 'in-review'], mergePolicy: 'human-only' },
};

const TEMPLATES: KaneoTemplates = {
  roles: [
    { name: 'coding', description: 'Coding role' },
    { name: 'testing', description: 'Testing role' },
  ],
  skills: [
    { name: 'claim-task', description: 'claim', forRoles: null },
    { name: 'test-runner', description: 'run tests', forRoles: ['testing'] },
  ],
  agentRole: 'coding',
};

const ROLE_AGENTS_MD = '# Coding role\n\nFollow the role rules.';

/** Build a genuine zip (stored + deflate-raw entries) served over HTTP. */
function buildConfigZip(entries: Array<{ name: string; content: string; deflate?: boolean }>): Uint8Array {
  const enc = new TextEncoder();
  const table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let b = 0; b < 8; b += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (data: Uint8Array): number => {
    let crc = 0xffffffff;
    for (const byte of data) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const { name, content, deflate } of entries) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(content);
    const data = deflate ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    locals.push(
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(deflate ? 8 : 0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(raw.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      data
    );
    centrals.push(
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(deflate ? 8 : 0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(raw.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(offset),
      u32(0),
      nameBytes
    );
    offset += 30 + nameBytes.length + data.length;
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
  return out;
}

const ROLE_SKILL_MD = '---\nname: kaneo-claim-task\ndescription: claim\n---\n\nclaim body';

const CONFIG_ZIP = buildConfigZip([
  { name: 'roles/coding/AGENTS.md', content: ROLE_AGENTS_MD },
  { name: 'skills/claim-task/SKILL.md', content: ROLE_SKILL_MD },
  {
    name: 'skills/test-runner/SKILL.md',
    content: '---\nname: kaneo-test-runner\ndescription: run tests\n---\n\nrun tests body',
    deflate: true,
  },
]);

const CONFIG: KaneoConfigPackage = {
  roles: { coding: ROLE_AGENTS_MD },
  skills: { 'claim-task': ROLE_SKILL_MD },
};

// ── Mock Kaneo HTTP server ─────────────────────────────────────────────────

let server: Server | null = null;
let serverUrl = '';

async function startKaneoMock(): Promise<void> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      const respond = (status: number, body: Buffer | string, contentType = 'application/json'): void => {
        res.writeHead(status, { 'content-type': contentType });
        res.end(body);
      };
      if (url === '/api/agent/agents-config/bootstrap') {
        respond(200, JSON.stringify({ success: true, data: MANIFEST }));
        return;
      }
      if (url === '/api/agent/agents-config/templates') {
        respond(200, JSON.stringify({ success: true, data: TEMPLATES }));
        return;
      }
      if (url === '/api/agent/agents-config/download') {
        respond(200, Buffer.from(CONFIG_ZIP), 'application/zip');
        return;
      }
      if (url === '/api/fs/upload') {
        // Multipart skill staging upload: capture the zip payload and hand
        // back a staging path, exactly like the backend temp store.
        const boundary = (req.headers['content-type'] ?? '').match(/boundary=([^;]+)/)?.[1] ?? '';
        const body = Buffer.concat(chunks);
        const fileName = body.toString('utf8').match(/filename="([^"]+)"/)?.[1] ?? 'skill.zip';
        const headerEnd = body.indexOf('\r\n\r\n');
        const closing = body.lastIndexOf(Buffer.from(`--${boundary}`));
        const payload = body.subarray(headerEnd + 4, closing - 2);
        const path = `/tmp/aionui/general/${fileName}`;
        store.__store.uploadedZips.push({ path, fileName, bytes: new Uint8Array(payload) });
        respond(200, JSON.stringify({ success: true, data: path }));
        return;
      }
      respond(404, JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  await startKaneoMock();
  // uploadZipForImport targets `${getBaseUrl()}/api/fs/upload`; point the
  // backend port at the mock server so the staging upload lands there.
  const g = globalThis as { __backendPort?: number };
  g.__backendPort = Number(new URL(serverUrl).port);
});

afterAll(() => {
  server?.close();
});

// ── Round trip ──────────────────────────────────────────────────────────────

describe('bootstrap-mock round trip (3.8)', () => {
  it('bootstrap endpoint returns a project-bound manifest', async () => {
    const bootstrap = await fetchKaneoBootstrap(serverUrl, 'test-key');
    expect(bootstrap.kind).toBe('manifest');
    if (bootstrap.kind === 'manifest') {
      expect(bootstrap.manifest.identity.project?.slug).toBe('aion-ui');
      expect(bootstrap.manifest.identity.agentRole).toBe('coding');
    }
  });

  it('sync creates the project-named assistant with rendered env segment, workspace, and role-filtered skills', async () => {
    const result = await syncKaneoAssistantsFromManifest({
      baseUrl: serverUrl,
      apiKey: 'test-key',
      manifest: MANIFEST,
      config: CONFIG,
      templates: TEMPLATES,
      existing: [] as unknown as Assistant[],
    });

    // Assistant result: created, project-named.
    expect(result.results).toEqual([{ role: 'coding', status: 'created' }]);
    const expectedName = kaneoProjectAssistantName('Aion UI', 'coding');
    expect(store.__store.assistants.size).toBe(1);
    const created = Array.from(store.__store.assistants.values())[0];
    expect(created['name']).toBe(expectedName);

    // Skills filtered by the bound role: claim-task (universal) yes,
    // test-runner (testing only) no.
    expect(created['custom_skill_names']).toEqual(['kaneo-claim-task']);

    // Workspace allocated for slug + role.
    expect(store.__store.workspaces).toEqual([{ project_slug: 'aion-ui', role: 'coding' }]);

    // Rules = role AGENTS.md + rendered project environment segment.
    const rules = store.__store.rules.get(created['id'] as string) ?? '';
    expect(rules.startsWith(ROLE_AGENTS_MD)).toBe(true);
    expect(rules).toContain(KANEO_ENV_SEGMENT_START);
    expect(rules).toContain('Kaneo project: Aion UI (aion-ui)');
    expect(rules).toContain('**Primary repository:** github aion/ui');
    // defaultBranch: null renders detection guidance, never a fabricated branch.
    expect(rules).toContain('The default branch is not provided by Kaneo');
    expect(rules).not.toContain('The default branch is `');
    // Secondary repo + merge policy + status machine rendered.
    expect(rules).toContain('**Secondary repository:** github aion/docs');
    expect(rules).toContain('todo → in-progress → in-review');
    expect(rules).toContain('Merging is performed by humans only');
    expect(rules).toContain(KANEO_ENV_SEGMENT_END);

    // Claim prompt attached.
    expect(Array.isArray(created['prompts'])).toBe(true);
    expect((created['prompts'] as string[]).length).toBe(1);

    // Skill zip uploaded over real HTTP multipart and registered by the
    // (mocked) skills importer — installed content matches the rewritten md.
    expect(store.__store.uploadedZips.map((z) => z.fileName)).toEqual(['kaneo-claim-task.zip']);
    expect(store.__store.importedPaths).toEqual(['/tmp/aionui/general/kaneo-claim-task.zip']);
    expect(store.__store.skills.get('kaneo-claim-task')?.content).toContain('claim body');

    // Context persisted with workspace + assistant id, and active.
    const contexts = getKaneoContexts();
    expect(contexts).toHaveLength(1);
    const context = contexts[0];
    expect(context.projectSlug).toBe('aion-ui');
    expect(context.agentRole).toBe('coding');
    expect(context.workspace).toBe('/managed/kaneo-workspaces/aion-ui/coding');
    expect(context.assistantId).toBe(created['id']);
    expect(context.manifestSummary?.envHash).toBe('env-h1');
    expect(values.__values.get('kaneo.activeContextId')).toBe(context.id);
    expect(result.context.id).toBe(context.id);
    expect(result.envDrift).toBe(false);
  });

  it('second sync updates in place; envHash change flags drift and refreshes the fingerprint', async () => {
    const firstContext = getKaneoContexts()[0];

    // Same manifest again: no drift, updated in place, no duplicate assistant.
    const again = await syncKaneoAssistantsFromManifest({
      baseUrl: serverUrl,
      apiKey: 'test-key',
      manifest: MANIFEST,
      config: CONFIG,
      templates: TEMPLATES,
      existing: Array.from(store.__store.assistants.values()) as unknown as Assistant[],
    });
    expect(again.results).toEqual([{ role: 'coding', status: 'updated' }]);
    expect(store.__store.assistants.size).toBe(1);

    // Changed envHash (repo switched): drift detected against stored context.
    const driftedManifest: KaneoEnvironmentManifest = {
      ...MANIFEST,
      envHash: 'env-h2',
      repositories: [
        {
          id: 'r1',
          role: 'primary',
          type: 'github',
          owner: 'aion',
          name: 'ui-next',
          cloneUrl: 'https://github.com/aion/ui-next.git',
          defaultBranch: null,
          isActive: true,
        },
      ],
    };
    const drifted = await syncKaneoAssistantsFromManifest({
      baseUrl: serverUrl,
      apiKey: 'test-key',
      manifest: driftedManifest,
      config: CONFIG,
      templates: TEMPLATES,
      existing: Array.from(store.__store.assistants.values()) as unknown as Assistant[],
    });
    expect(drifted.envDrift).toBe(true);
    expect(drifted.cloneUrlChanged).toBe(true);
    // Same assistant updated in place (rename stability), no duplicate.
    expect(store.__store.assistants.size).toBe(1);
    // Context fingerprint refreshed on the same context id.
    const contexts = getKaneoContexts();
    expect(contexts).toHaveLength(1);
    expect(contexts[0].id).toBe(firstContext.id);
    expect(contexts[0].manifestSummary?.envHash).toBe('env-h2');
  });

  it('skill content collision: identical content idempotent, differing content skipped with drift warning', async () => {
    // claim-task is installed from the first sync; re-syncing with identical
    // content re-imports idempotently, modified content is skipped with a
    // drift warning.
    const uploadsBefore = store.__store.uploadedZips.length;
    const modifiedConfig: KaneoConfigPackage = {
      roles: { coding: ROLE_AGENTS_MD },
      skills: { 'claim-task': `${ROLE_SKILL_MD}\n\nCHANGED-BODY` },
    };
    const result = await syncKaneoAssistantsFromManifest({
      baseUrl: serverUrl,
      apiKey: 'test-key',
      manifest: MANIFEST,
      config: modifiedConfig,
      templates: TEMPLATES,
      existing: Array.from(store.__store.assistants.values()) as unknown as Assistant[],
    });
    expect(result.skillDriftWarnings).toEqual(['claim-task']);
    // No new upload for the drifted skill; the installed copy is kept.
    expect(store.__store.uploadedZips.length).toBe(uploadsBefore);
    // The enabled skill list still contains the kept installed skill.
    const updated = Array.from(store.__store.assistants.values())[0];
    expect(updated['custom_skill_names']).toEqual(['kaneo-claim-task']);
  });
});

// ── Live aioncore workspace endpoint ───────────────────────────────────────

const AIONUI_URL = process.env.AIONUI_TEST_URL ?? '';
let aioncoreAvailable = false;
try {
  if (AIONUI_URL) {
    await fetch(`${AIONUI_URL}/api/assistants`);
    aioncoreAvailable = true;
  }
} catch {
  aioncoreAvailable = false;
}

describe.skipIf(!aioncoreAvailable)('live aioncore kaneo workspace endpoint', () => {
  it('creates and returns the managed kaneo-workspaces path', async () => {
    const res = await fetch(`${AIONUI_URL}/api/fs/kaneo-workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_slug: 'aion-ui', role: 'coding' }),
    });
    const json = (await res.json()) as { success?: boolean; data?: string };
    expect(res.ok).toBe(true);
    expect(json.success).toBe(true);
    expect(json.data).toContain('kaneo-workspaces');
    expect(json.data).toContain('aion-ui');
    expect(json.data).toContain('coding');
  });
});
