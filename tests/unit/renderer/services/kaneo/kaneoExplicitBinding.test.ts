/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the ipc bridge before importing the module under test. Mirrors
// kaneoSyncFlow.test.ts; additionally stubs the kaneoWorkspace and kaneo
// credentials channels used by the explicit (role, project) binding flow.
const calls = {
  created: [] as Array<Record<string, unknown>>,
  updated: [] as Array<Record<string, unknown>>,
  rules: [] as Array<{ assistant_id: string; content: string }>,
  workspaces: [] as Array<{ project_slug: string; role: string }>,
  credentials: [] as Array<Record<string, unknown>>,
  nextAssistantId: { n: 0 },
};

vi.mock('@/common', () => {
  const invoke = (impl: unknown): unknown => Object.assign(vi.fn(impl as never), { invoke: vi.fn(impl as never) });
  const bridge: Record<string, unknown> = {
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
      listAvailableSkills: invoke(async () => []),
      importSkills: invoke(async () => ({ skill_name: 'imported', skill_names: ['imported'] })),
      writeAssistantRule: invoke(async ({ assistant_id, content }: { assistant_id: string; content: string }) => {
        calls.rules.push({ assistant_id, content });
        return true;
      }),
      // allocateKaneoWorkspace round-trips through the kaneoWorkspace channel.
      upload: invoke(async () => '/tmp/aionui/general/x.zip'),
    },
  };
  // allocateKaneoWorkspace talks to ipcBridge.kaneoWorkspace.ensure.
  bridge.kaneoWorkspace = {
    ensure: invoke(async ({ project_slug, role }: { project_slug: string; role: string }) => {
      calls.workspaces.push({ project_slug, role });
      return { path: `<userData>/kaneo-workspaces/${project_slug}/${role}/`, created: true };
    }),
  };
  bridge.kaneoCredentials = {
    upsert: invoke(async (req: Record<string, unknown>) => {
      calls.credentials.push(req);
      return { ok: true };
    }),
  };
  bridge.acpConversation = {
    getManagedAgents: invoke(async () => [{ id: 'agent-a' }]),
  };
  return { ipcBridge: bridge };
});

vi.mock('@/common/config/configService', () => ({ configService: store.service }));

// In-memory config store backing configService (mirrors kaneoContexts.test.ts).
const store = vi.hoisted(() => {
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
      subscribe: vi.fn(() => () => undefined),
    },
  };
});

import { getKaneoContexts, setKaneoContexts } from '@/renderer/services/kaneo/kaneoContexts';
import { syncKaneoAssistantForBinding } from '@/renderer/services/kaneo/kaneoSync';
import type { Assistant } from '@/common/types/agent/assistantTypes';

// Keep the makeZip helper local and tiny: the config-package endpoint returns
// an empty package because the explicit-binding flow takes the AGENTS.md
// content directly from the caller.
const CONFIG_ZIP = new ArrayBuffer(0);

const stubFetch = (): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/agent/agents-config/download')) {
        return new Response(CONFIG_ZIP, { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch
  );
};

const mkAssistant = (id: string, name: string): Assistant => ({ id, name }) as unknown as Assistant;

const BINDING_BASE = {
  baseUrl: 'http://kaneo',
  project: { id: 'proj-1', name: 'AionUi', slug: 'aionui' },
  role: 'coding',
  agentsMd: 'CODING-AGENTS-MD-BODY',
  description: 'Coding role',
  enabledSkills: ['kaneo-claim-task'],
};

beforeEach(() => {
  calls.created.length = 0;
  calls.updated.length = 0;
  calls.rules.length = 0;
  calls.workspaces.length = 0;
  calls.credentials.length = 0;
  calls.nextAssistantId.n = 0;
  setKaneoContexts([]);
  vi.clearAllMocks();
});

describe('syncKaneoAssistantForBinding', () => {
  it('creates one assistant per explicit (role, project) pair with a workspace record', async () => {
    stubFetch();
    const result = await syncKaneoAssistantForBinding({
      ...BINDING_BASE,
      existing: [],
    });

    expect(result.status).toBe('created');
    expect(calls.created).toHaveLength(1);
    expect(calls.created[0]).toMatchObject({ name: 'Kaneo · AionUi · coding' });
    expect(calls.workspaces).toEqual([{ project_slug: 'aionui', role: 'coding' }]);
    // Role AGENTS.md written as assistant rules, no plaintext key anywhere.
    expect(calls.rules).toEqual([{ assistant_id: result.assistantId, content: 'CODING-AGENTS-MD-BODY' }]);
    // Context recorded with the binding identity.
    const contexts = getKaneoContexts();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      baseUrl: 'http://kaneo',
      agentRole: 'coding',
      projectId: 'proj-1',
      projectName: 'AionUi',
      assistantId: result.assistantId,
    });
  });

  it('different projects for the same role produce distinct contexts and workspaces', async () => {
    stubFetch();
    await syncKaneoAssistantForBinding({
      ...BINDING_BASE,
      existing: [],
    });
    await syncKaneoAssistantForBinding({
      ...BINDING_BASE,
      project: { id: 'proj-2', name: 'Kaneo', slug: 'kaneo' },
      existing: [],
    });

    expect(calls.created).toHaveLength(2);
    expect(calls.created[0]['name']).toBe('Kaneo · AionUi · coding');
    expect(calls.created[1]['name']).toBe('Kaneo · Kaneo · coding');
    const contexts = getKaneoContexts();
    expect(contexts).toHaveLength(2);
    expect(contexts.map((c) => c.projectId).toSorted()).toEqual(['proj-1', 'proj-2']);
  });

  it('updates an existing (role, project) instance in place instead of duplicating', async () => {
    stubFetch();
    const first = await syncKaneoAssistantForBinding({ ...BINDING_BASE, existing: [] });
    const before = getKaneoContexts().length;

    const second = await syncKaneoAssistantForBinding({
      ...BINDING_BASE,
      existing: [mkAssistant(first.assistantId, 'Kaneo · AionUi · coding')],
    });

    expect(second.status).toBe('updated');
    expect(second.assistantId).toBe(first.assistantId);
    expect(calls.created).toHaveLength(1); // only the first create
    expect(calls.updated).toHaveLength(1);
    expect(getKaneoContexts().length).toBe(before); // context reused, not duplicated
  });

  it('rejects a role without AGENTS.md content', async () => {
    await expect(syncKaneoAssistantForBinding({ ...BINDING_BASE, agentsMd: '   ', existing: [] })).rejects.toThrow(
      /no AGENTS\.md/
    );
    expect(calls.created).toHaveLength(0);
  });

  it('renders the manifest environment segment and persists repo facts + envHash when a manifest is passed', async () => {
    stubFetch();
    const manifest = {
      manifestVersion: 1,
      generatedAt: '2026-01-01T00:00:00Z',
      envHash: 'hash-abc',
      identity: {
        agentRole: 'coding',
        project: { id: 'proj-1', teamId: 't1', name: 'AionUi', slug: 'aionui', description: null },
        server: { baseUrl: 'http://kaneo' },
      },
      repositories: [
        {
          id: 'r1',
          role: 'primary',
          type: 'gitlab',
          owner: 'aion',
          name: 'ui',
          cloneUrl: 'https://gitlab.com/aion/ui.git',
          defaultBranch: 'main',
          isActive: true,
        },
      ],
      workflow: { statuses: ['todo', 'in-review'] },
    } as const;

    const result = await syncKaneoAssistantForBinding({ ...BINDING_BASE, existing: [], manifest });

    // Rules carry the rendered segment alongside the role AGENTS.md.
    expect(calls.rules[0]?.content).toContain('CODING-AGENTS-MD-BODY');
    expect(calls.rules[0]?.content).toContain('<!-- kaneo-project-environment -->');
    expect(calls.rules[0]?.content).toContain('https://gitlab.com/aion/ui.git');
    expect(calls.rules[0]?.content).toContain('The default branch is `main`.');

    // Structured repo facts + envHash fingerprint are persisted on the context.
    const contexts = getKaneoContexts();
    expect(contexts[0]?.manifestSummary).toEqual({ envHash: 'hash-abc', manifestVersion: 1 });
    expect(contexts[0]?.repositories).toHaveLength(1);
    expect(contexts[0]?.repositories?.[0]).toMatchObject({
      role: 'primary',
      owner: 'aion',
      name: 'ui',
      cloneUrl: 'https://gitlab.com/aion/ui.git',
      defaultBranch: 'main',
    });
    expect(result.contextId).toBe(contexts[0]?.id);
  });

  it('renders a repo-only segment from GitLab integration facts and persists them when no manifest exists', async () => {
    stubFetch();
    const result = await syncKaneoAssistantForBinding({
      ...BINDING_BASE,
      existing: [],
      repoIntegration: {
        type: 'gitlab',
        cloneUrl: 'https://gitlab.example/aion/ui.git',
        repositoryOwner: 'aion',
        repositoryName: 'ui',
        branchPattern: 'feat/*',
      },
    });

    expect(calls.rules[0]?.content).toContain('CODING-AGENTS-MD-BODY');
    expect(calls.rules[0]?.content).toContain('<!-- kaneo-project-environment -->');
    expect(calls.rules[0]?.content).toContain('gitlab aion/ui');
    expect(calls.rules[0]?.content).toContain('https://gitlab.example/aion/ui.git');
    expect(calls.rules[0]?.content).toContain('`feat/*`');
    // Status machine is manifest-sourced and never fabricated here.
    expect(calls.rules[0]?.content).not.toContain('Task status machine');

    const contexts = getKaneoContexts();
    expect(contexts[0]?.manifestSummary).toBeNull();
    expect(contexts[0]?.repoIntegration).toMatchObject({
      type: 'gitlab',
      source: 'vcs-integration',
      repositoryOwner: 'aion',
      repositoryName: 'ui',
      cloneUrl: 'https://gitlab.example/aion/ui.git',
      branchPattern: 'feat/*',
    });
    expect(result.contextId).toBe(contexts[0]?.id);
  });

  it('without repo facts, keeps any previously stored repo facts on the context', async () => {
    stubFetch();
    const manifest = {
      manifestVersion: 1,
      generatedAt: '2026-01-01T00:00:00Z',
      envHash: 'hash-abc',
      identity: {
        agentRole: 'coding',
        project: { id: 'proj-1', teamId: 't1', name: 'AionUi', slug: 'aionui', description: null },
        server: { baseUrl: 'http://kaneo' },
      },
      repositories: [
        {
          id: 'r1',
          role: 'primary',
          type: 'gitlab',
          owner: 'aion',
          name: 'ui',
          cloneUrl: 'https://gitlab.com/aion/ui.git',
          defaultBranch: null,
          isActive: true,
        },
      ],
      workflow: { statuses: ['todo', 'in-review'] },
    } as const;
    const first = await syncKaneoAssistantForBinding({ ...BINDING_BASE, existing: [], manifest });
    expect(getKaneoContexts()[0]?.repositories).toHaveLength(1);

    // A later sync without any repo facts must not erase stored facts.
    await syncKaneoAssistantForBinding({
      ...BINDING_BASE,
      existing: [mkAssistant(first.assistantId, 'Kaneo · AionUi · coding')],
    });
    const after = getKaneoContexts();
    expect(after).toHaveLength(1);
    expect(after[0]?.repositories).toHaveLength(1);
    expect(after[0]?.manifestSummary).toEqual({ envHash: 'hash-abc', manifestVersion: 1 });
  });
});
