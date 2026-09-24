/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchKaneoTemplates } from '@renderer/services/kaneo/kaneoClient';
import { filterAssistantsForKaneoContext } from '@renderer/services/kaneo/kaneoSync';

// --- fetchKaneoTemplates: optional agentRole parsing -----------------------

describe('fetchKaneoTemplates agentRole parsing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockTemplatesResponse(body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      ) as never
    );
  }

  it('parses a role-scoped agentRole when present', async () => {
    mockTemplatesResponse({
      roles: [{ name: 'coding', description: 'Coding' }],
      skills: [],
      agentRole: 'coding',
    });
    const result = await fetchKaneoTemplates('http://localhost:1337', 'some-key');
    expect(result.agentRole).toBe('coding');
  });

  it('leaves agentRole undefined when the instance does not report a role', async () => {
    mockTemplatesResponse({
      roles: [{ name: 'coding', description: 'Coding' }],
      skills: [],
    });
    const result = await fetchKaneoTemplates('http://localhost:1337', 'some-key');
    expect(result.agentRole).toBeUndefined();
  });

  it('treats a non-string agentRole as absent', async () => {
    mockTemplatesResponse({
      roles: [{ name: 'coding', description: 'Coding' }],
      skills: [],
      agentRole: 123,
    });
    const result = await fetchKaneoTemplates('http://localhost:1337', 'some-key');
    expect(result.agentRole).toBeUndefined();
  });
});

// --- Guide context-scoped assistant filtering (legacy role semantics) ------

describe('filterAssistantsForKaneoContext (project-less legacy context)', () => {
  const list = [
    { name: 'Aion CLI', id: 'a' },
    { name: 'Kaneo · coding', id: 'k-coding' },
    { name: 'Kaneo · devops', id: 'k-devops' },
    { name: 'Kaneo · testing', id: 'k-testing' },
  ];

  it('keeps the whole list when no context is active', () => {
    expect(filterAssistantsForKaneoContext(list, undefined)).toEqual(list);
  });

  it('keeps only the bound-role Kaneo assistant plus non-Kaneo assistants', () => {
    const out = filterAssistantsForKaneoContext(list, { projectName: null, agentRole: 'devops' });
    expect(out.map((a) => a.name)).toEqual(['Aion CLI', 'Kaneo · devops']);
  });

  it('falls back to the full list when the bound role has no assistant yet', () => {
    expect(filterAssistantsForKaneoContext(list, { projectName: null, agentRole: 'ui-design' })).toEqual(list);
  });
});
