/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  KaneoConnectionError,
  normalizeKaneoBaseUrl,
  parseSkillForRoles,
  skillAppliesToRole,
  skillsForRoleFromTemplates,
  type KaneoTemplates,
} from '@renderer/services/kaneo/kaneoClient';
import {
  buildClaimPrompt,
  buildSkillZip,
  findKaneoAssistant,
  kaneoAssistantName,
  kaneoSkillName,
} from '@renderer/services/kaneo/kaneoSync';
import type { Assistant } from '@common/types/agent/assistantTypes';

// ── kaneoClient: base URL normalization ─────────────────────────────────────

describe('normalizeKaneoBaseUrl', () => {
  it('trims whitespace and trailing slashes', () => {
    expect(normalizeKaneoBaseUrl('  http://localhost:1337/// ')).toBe('http://localhost:1337');
  });
});

// ── kaneoClient: skill for_roles semantics ──────────────────────────────────

describe('parseSkillForRoles', () => {
  it('returns the role list when for_roles is present', () => {
    const md = '---\nname: x\nfor_roles: [coding, testing]\n---\n\nbody';
    expect(parseSkillForRoles(md)).toEqual(['coding', 'testing']);
  });

  it('returns null when frontmatter is absent', () => {
    expect(parseSkillForRoles('# no frontmatter')).toBeNull();
  });

  it('returns null when for_roles key is absent', () => {
    expect(parseSkillForRoles('---\nname: x\n---\n\nbody')).toBeNull();
  });

  it('returns null for an empty list (universal)', () => {
    expect(parseSkillForRoles('---\nfor_roles: []\n---\n\nbody')).toBeNull();
  });
});

describe('skillAppliesToRole', () => {
  it('matches case-insensitively', () => {
    expect(skillAppliesToRole(['Coding'], 'coding')).toBe(true);
  });
  it('null means universal', () => {
    expect(skillAppliesToRole(null, 'anything')).toBe(true);
  });
  it('non-matching list excludes the role', () => {
    expect(skillAppliesToRole(['coding'], 'testing')).toBe(false);
  });
});

describe('skillsForRoleFromTemplates', () => {
  const templates: KaneoTemplates = {
    roles: [{ name: 'coding', description: 'd' }],
    skills: [
      { name: 'a', description: 'a', forRoles: ['coding'] },
      { name: 'b', description: 'b', forRoles: ['testing'] },
      { name: 'c', description: 'c', forRoles: null },
    ],
  };
  it('returns matching plus universal skills', () => {
    expect(skillsForRoleFromTemplates(templates, 'coding').toSorted()).toEqual(['a', 'c']);
  });
});

// ── kaneoClient: error classification ───────────────────────────────────────

describe('KaneoConnectionError', () => {
  it('carries the kind', () => {
    const e = new KaneoConnectionError('unauthorized', 'nope');
    expect(e.kind).toBe('unauthorized');
    expect(e.name).toBe('KaneoConnectionError');
  });
});

// ── kaneoSync: naming + prompt ──────────────────────────────────────────────

describe('naming conventions', () => {
  it('assistant name uses the Kaneo prefix', () => {
    expect(kaneoAssistantName('coding')).toBe('Kaneo · coding');
  });
  it('skill name uses the kaneo- prefix', () => {
    expect(kaneoSkillName('claim-task')).toBe('kaneo-claim-task');
  });
});

describe('buildClaimPrompt', () => {
  it('renders the base URL and skill name', () => {
    const p = buildClaimPrompt('coding', 'http://kaneo.example/');
    expect(p).toContain('kaneo-claim-task');
    expect(p).toContain('http://kaneo.example');
  });
  it('falls back to the default Kaneo URL when empty', () => {
    expect(buildClaimPrompt('coding', '')).toContain('http://localhost:1337');
  });
});

// ── kaneoSync: assistant upsert matching ────────────────────────────────────

describe('findKaneoAssistant', () => {
  const mk = (name: string, id = name): Assistant => ({ id, name }) as unknown as Assistant;

  it('finds an exact Kaneo-named match', () => {
    const list = [mk('My Assistant'), mk('Kaneo · coding', 'a1')];
    expect(findKaneoAssistant(list, 'coding')?.id).toBe('a1');
  });
  it('never touches non-Kaneo assistants', () => {
    const list = [mk('coding'), mk('kaneo-coding'), mk('Kaneo·coding')];
    expect(findKaneoAssistant(list, 'coding')).toBeUndefined();
  });
});

// ── kaneoSync: zip builder ──────────────────────────────────────────────────

describe('buildSkillZip', () => {
  it('produces a byte-identical entry layout readable as a zip', async () => {
    const blob = buildSkillZip('kaneo-test-skill', '# hello');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    // Local header signature.
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    // EOCD signature at the end.
    const eocdSig = 0x06054b50;
    let found = false;
    for (let i = bytes.length - 22; i >= 0; i -= 1) {
      if (view.getUint32(i, true) === eocdSig) {
        found = true;
        expect(view.getUint16(i + 10, true)).toBe(1); // entry count
        break;
      }
    }
    expect(found).toBe(true);
  });
});
