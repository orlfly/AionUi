/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the Kaneo context store (services/kaneo/kaneoContexts.ts)
 * and the context-based assistant filter (kaneoSync.ts): one-time legacy
 * migration, upsert keyed by (baseUrl, projectId, role), and multi-project
 * Guide filtering.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory config store backing configService.
const store = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const listeners = new Set<(key: string) => void>();
  return {
    values,
    listeners,
    service: {
      get: vi.fn((key: string) => values.get(key)),
      set: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
        for (const l of listeners) l(key);
      }),
      setLocal: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
        for (const l of listeners) l(key);
      }),
      remove: vi.fn(async (key: string) => {
        values.delete(key);
        for (const l of listeners) l(key);
      }),
      subscribe: vi.fn((_key: string, listener: (key: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    },
  };
});

vi.mock('@/common/config/configService', () => ({ configService: store.service }));

import {
  contextFromManifest,
  getActiveKaneoContextId,
  getKaneoContexts,
  migrateKaneoContexts,
  removeKaneoContext,
  setActiveKaneoContextId,
  setKaneoContexts,
  upsertKaneoContext,
  updateKaneoContext,
} from '@/renderer/services/kaneo/kaneoContexts';
import {
  filterAssistantsForKaneoContext,
  kaneoAssistantName,
  kaneoProjectAssistantName,
} from '@/renderer/services/kaneo/kaneoSync';
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
  repositories: [],
  workflow: { statuses: [] },
};

const mkAssistant = (id: string, name: string): { id: string; name: string } => ({ id, name });

beforeEach(() => {
  store.values.clear();
  vi.clearAllMocks();
});

describe('legacy migration', () => {
  it('migrates kaneo.activeRole into a project-less context and removes the legacy key', async () => {
    store.values.set('kaneo.activeRole', 'coding');
    await migrateKaneoContexts();

    const contexts = store.values.get('kaneo.contexts') as Array<Record<string, unknown>>;
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ agentRole: 'coding', projectId: null, baseUrl: '' });
    expect(store.values.get('kaneo.activeContextId')).toBe(contexts[0]['id']);
    expect(store.values.has('kaneo.activeRole')).toBe(false);
  });

  it('writes an empty list once when there is nothing to migrate', async () => {
    await migrateKaneoContexts();
    expect(store.values.get('kaneo.contexts')).toEqual([]);
    expect(store.values.has('kaneo.activeRole')).toBe(false);
  });

  it('is idempotent: existing contexts are never overwritten', async () => {
    const existing = [{ id: 'kctx-a', agentRole: 'coding' }];
    await setKaneoContexts(existing as never);
    await migrateKaneoContexts();
    expect(store.values.get('kaneo.contexts')).toEqual(existing);
  });
});

describe('upsert and context bookkeeping', () => {
  it('creates a context from a manifest with manifest summary fields', () => {
    const context = contextFromManifest(MANIFEST, 'http://kaneo');
    expect(context).toMatchObject({
      baseUrl: 'http://kaneo',
      agentRole: 'coding',
      projectId: 'p1',
      projectName: 'Aion UI',
      projectSlug: 'aion-ui',
      manifestSummary: { envHash: 'h1', manifestVersion: 1 },
      degraded: false,
    });
  });

  it('upsert matches on (baseUrl, projectId, role) and preserves id and assistantId', async () => {
    const first = contextFromManifest(MANIFEST, 'http://kaneo');
    const { context: created, created: wasCreated } = await upsertKaneoContext({ ...first, assistantId: 'a1' });
    expect(wasCreated).toBe(true);

    // Reconnect with a new envHash: same binding, updated summary.
    const reconnect = contextFromManifest({ ...MANIFEST, envHash: 'h2' }, 'http://kaneo');
    reconnect.id = 'brand-new-id';
    const { context: merged, created: createdAgain } = await upsertKaneoContext(reconnect);

    expect(createdAgain).toBe(false);
    expect(merged.id).toBe(created.id);
    expect(merged.manifestSummary?.envHash).toBe('h2');
    expect(store.values.get('kaneo.contexts')).toHaveLength(1);
  });

  it('does not merge contexts from different projects or roles', async () => {
    const a = contextFromManifest(MANIFEST, 'http://kaneo');
    await upsertKaneoContext(a);
    const other = contextFromManifest(
      { ...MANIFEST, identity: { ...MANIFEST.identity, project: { ...MANIFEST.identity.project!, id: 'p2' } } },
      'http://kaneo'
    );
    const { created } = await upsertKaneoContext(other);
    expect(created).toBe(true);
    expect(store.values.get('kaneo.contexts')).toHaveLength(2);
  });

  it('removeKaneoContext clears the active pointer when it pointed at the removed context', async () => {
    const context = contextFromManifest(MANIFEST, 'http://kaneo');
    await upsertKaneoContext(context);
    await removeKaneoContext(context.id);
    expect(store.values.get('kaneo.contexts')).toEqual([]);
    expect(getActiveKaneoContextId()).toBeUndefined();
  });

  it('updateKaneoContext patches only the target context', async () => {
    const a = contextFromManifest(MANIFEST, 'http://kaneo');
    await upsertKaneoContext(a);
    await updateKaneoContext(a.id, { workspace: '/tmp/ws', assistantId: 'a9' });
    const contexts = await getKaneoContexts();
    expect(contexts[0]).toMatchObject({ workspace: '/tmp/ws', assistantId: 'a9' });
  });

  it('setActiveKaneoContextId(null) removes the pointer', async () => {
    await setActiveKaneoContextId('kctx-x');
    expect(getActiveKaneoContextId()).toBe('kctx-x');
    await setActiveKaneoContextId(null);
    expect(getActiveKaneoContextId()).toBeUndefined();
  });
});

describe('filterAssistantsForKaneoContext', () => {
  const assistants = [
    mkAssistant('a1', kaneoProjectAssistantName('Aion UI', 'coding')),
    mkAssistant('a2', kaneoProjectAssistantName('Aion UI', 'testing')),
    mkAssistant('a3', kaneoProjectAssistantName('Other Project', 'coding')),
    mkAssistant('a4', kaneoAssistantName('coding')),
    mkAssistant('a5', 'My plain assistant'),
  ];

  it('hides other Kaneo assistants in the same project, keeps everything else', () => {
    const filtered = filterAssistantsForKaneoContext(assistants, { projectName: 'Aion UI', agentRole: 'coding' });
    const ids = filtered.map((a) => a.id);
    expect(ids).toContain('a1'); // the bound role
    expect(ids).toContain('a3'); // other project's Kaneo assistant
    expect(ids).toContain('a4'); // legacy Kaneo assistant
    expect(ids).toContain('a5'); // non-Kaneo assistant
    expect(ids).not.toContain('a2'); // other role, same project
  });

  it('applies the legacy role filter when the active context has no project', () => {
    // Migrated project-less context keeps the legacy role-filter behavior:
    // hide every other Kaneo assistant, keep non-Kaneo ones.
    const filtered = filterAssistantsForKaneoContext(assistants, { projectName: null, agentRole: 'coding' });
    const ids = filtered.map((a) => a.id);
    expect(ids).toContain('a4'); // the bound legacy role
    expect(ids).toContain('a5'); // non-Kaneo assistant stays
    expect(ids).not.toContain('a1'); // project-bound Kaneo assistant hidden by the legacy rule
    expect(ids).not.toContain('a2');
    expect(ids).not.toContain('a3');
  });

  it('returns the full list when there is no active context', () => {
    expect(filterAssistantsForKaneoContext(assistants, undefined)).toEqual(assistants);
  });

  it('returns the full list when the bound assistant does not exist yet (first sync)', () => {
    const withoutTarget = assistants.filter((a) => a.id !== 'a1');
    expect(filterAssistantsForKaneoContext(withoutTarget, { projectName: 'Aion UI', agentRole: 'coding' })).toEqual(
      withoutTarget
    );
  });
});
