/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Integration test 5.1/5.2: full Kaneo → AionUi sync against a live local
// Kaneo instance and a live AionUi backend (aioncore). Skips automatically
// when either backend is unreachable, so plain `bun run test` stays green.
//
// Env:
//   KANEO_TEST_URL  default http://localhost:1337
//   KANEO_TEST_KEY  default '' (open local instance)
//   AIONUI_TEST_URL e.g. http://127.0.0.1:<port>; required for the full sync

import { describe, expect, it, vi } from 'vitest';
import { fetchKaneoTemplates } from '../../packages/desktop/src/renderer/services/kaneo/kaneoClient';
import { syncKaneoAssistants } from '../../packages/desktop/src/renderer/services/kaneo/kaneoSync';

const KANEO_URL = process.env.KANEO_TEST_URL ?? 'http://localhost:1337';
const KANEO_KEY = process.env.KANEO_TEST_KEY ?? '';
const AIONUI_URL = process.env.AIONUI_TEST_URL ?? '';

// getBaseUrl() (used by the skill staging upload) resolves the backend port
// from globalThis; window.__backendPort is absent in the node test env.
if (AIONUI_URL) {
  const port = new URL(AIONUI_URL).port || '80';
  (globalThis as { __backendPort?: number }).__backendPort = Number(port);
}

async function aionui<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${AIONUI_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { success?: boolean; data?: T; error?: string };
  if (!res.ok || json.success === false) {
    throw new Error(`${method} ${path} failed: HTTP ${res.status} ${json.error ?? ''}`);
  }
  return json.data as T;
}

let kaneoAvailable = false;
try {
  await fetchKaneoTemplates(KANEO_URL, KANEO_KEY);
  kaneoAvailable = true;
} catch {
  kaneoAvailable = false;
}

describe.skipIf(!kaneoAvailable)('live Kaneo templates', () => {
  it('exposes the 7 agent roles', async () => {
    const templates = await fetchKaneoTemplates(KANEO_URL, KANEO_KEY);
    expect(templates.roles.map((r) => r.name).sort()).toEqual(
      ['architecture-design', 'code-review', 'coding', 'devops', 'product-design', 'testing', 'ui-design'].sort()
    );
  });
});

describe.skipIf(!kaneoAvailable || !AIONUI_URL)('full sync round trip (5.1/5.2)', () => {
  // Point the sync service's ipcBridge usage at the live backend over HTTP.
  vi.mock('@/common', () => {
    const wrap = <T>(fn: (args: never) => Promise<T>) => ({ invoke: (args: never) => fn(args) });
    return {
      ipcBridge: {
        assistants: {
          list: wrap(async () => {
            const res = await fetch(`${AIONUI_URL}/api/assistants`);
            const json = (await res.json()) as { data: Array<Record<string, unknown>> };
            return json.data;
          }),
          create: wrap(async (req: Record<string, unknown>) =>
            aionui<Record<string, unknown>>('POST', '/api/assistants', req)
          ),
          update: wrap(async (req: { id: string } & Record<string, unknown>) =>
            aionui<Record<string, unknown>>('PUT', `/api/assistants/${req.id}`, req)
          ),
        },
        fs: {
          listAvailableSkills: wrap(async () => {
            const res = await fetch(`${AIONUI_URL}/api/skills`);
            const json = (await res.json()) as { data: Array<{ name: string }> };
            return json.data;
          }),
          importSkills: wrap(async ({ skill_path }: { skill_path: string }) =>
            aionui<{ skill_name: string; skill_names?: string[]; failed?: unknown[] }>('POST', '/api/skills/import', {
              skill_path,
            })
          ),
          writeAssistantRule: wrap(async ({ assistant_id, content }: { assistant_id: string; content: string }) =>
            aionui<boolean>('POST', '/api/skills/assistant-rule/write', { assistant_id, content })
          ),
        },
        acpConversation: {
          getManagedAgents: wrap(async () => {
            const res = await fetch(`${AIONUI_URL}/api/agents/management`);
            const json = (await res.json()) as { data: Array<{ id: string }> };
            return json.data;
          }),
        },
      },
    };
  });

  const listAssistants = async (): Promise<Array<Record<string, unknown>>> => {
    const res = await fetch(`${AIONUI_URL}/api/assistants`);
    const json = (await res.json()) as { data: Array<Record<string, unknown>> };
    return json.data;
  };

  const kaneoAssistants = async (): Promise<Array<Record<string, unknown>>> => {
    const all = await listAssistants();
    return all.filter((a) => typeof a['name'] === 'string' && (a['name'] as string).startsWith('Kaneo · '));
  };

  it('5.1: first sync creates all 7 role assistants with rules and skills', async () => {
    const templates = await fetchKaneoTemplates(KANEO_URL, KANEO_KEY);
    const roles = templates.roles.map((r) => r.name);
    const existing = await kaneoAssistants();

    const result = await syncKaneoAssistants(KANEO_URL, KANEO_KEY, roles, existing as never);
    const failed = result.results.filter((r) => r.status === 'failed');
    expect(failed).toEqual([]);

    const after = await kaneoAssistants();
    const names = after.map((a) => a['name']).sort();
    expect(names).toEqual(roles.map((r) => `Kaneo · ${r}`).sort());

    // Every role must have at least the universal kaneo-claim-task skill
    // enabled, and only kaneo- prefixed custom skills.
    const detailPromises = after.map(async (a) => {
      const detail = await aionui<{ capabilities: { custom_skill_names?: string[] } }>(
        'GET',
        `/api/assistants/${a['id']}`
      );
      return { name: a['name'], skills: detail.capabilities?.custom_skill_names ?? [] };
    });
    const details = await Promise.all(detailPromises);
    for (const d of details) {
      expect(d.skills).toContain('kaneo-claim-task');
      for (const s of d.skills) expect(s.startsWith('kaneo-')).toBe(true);
    }
  }, 120_000);

  it('5.2: second sync updates in place — assistant count unchanged', async () => {
    const templates = await fetchKaneoTemplates(KANEO_URL, KANEO_KEY);
    const roles = templates.roles.map((r) => r.name);
    const before = await kaneoAssistants();

    const result = await syncKaneoAssistants(KANEO_URL, KANEO_KEY, roles, before as never);
    const failed = result.results.filter((r) => r.status === 'failed');
    expect(failed).toEqual([]);
    expect(result.results.every((r) => r.status === 'updated')).toBe(true);

    const after = await kaneoAssistants();
    expect(after.length).toBe(before.length);
  }, 120_000);
});
