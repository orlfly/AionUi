/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the project environment segment rendering
 * (renderProjectEnvironmentSegment + appendEnvironmentSegment in
 * services/kaneo/kaneoSync.ts): repo guidance with nullable defaultBranch,
 * no-VCS case, status machine, boundaries, and atomic segment replacement.
 */
import { describe, expect, it } from 'vitest';

import {
  KANEO_ENV_SEGMENT_END,
  KANEO_ENV_SEGMENT_START,
  appendEnvironmentSegment,
  kaneoProjectAssistantName,
  renderProjectEnvironmentSegment,
} from '@/renderer/services/kaneo/kaneoSync';
import type { KaneoEnvironmentManifest } from '@/renderer/services/kaneo/kaneoManifest';

const BASE_MANIFEST: KaneoEnvironmentManifest = {
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
  workflow: { statuses: ['todo', 'in-progress', 'in-review'], mergePolicy: 'human-only' },
};

describe('renderProjectEnvironmentSegment', () => {
  it('renders project identity, primary repo, and clone guidance', () => {
    const segment = renderProjectEnvironmentSegment(BASE_MANIFEST);
    expect(segment).toContain('Aion UI (aion-ui)');
    expect(segment).toContain('https://github.com/aion/ui.git');
    expect(segment).toContain('never clone repositories outside this manifest');
  });

  it('never fabricates a default branch: renders detection guidance for null', () => {
    const segment = renderProjectEnvironmentSegment(BASE_MANIFEST);
    expect(segment).toContain('The default branch is not provided by Kaneo');
    expect(segment).toMatch(/detect the primary branch/);
    expect(segment).not.toMatch(/The default branch is `/);
  });

  it('renders a known default branch verbatim when provided', () => {
    const manifest: KaneoEnvironmentManifest = {
      ...BASE_MANIFEST,
      repositories: [{ ...BASE_MANIFEST.repositories[0], defaultBranch: 'main' }],
    };
    const segment = renderProjectEnvironmentSegment(manifest);
    expect(segment).toContain('The default branch is `main`.');
  });

  it('renders the no-repository case without clone guidance', () => {
    const segment = renderProjectEnvironmentSegment({ ...BASE_MANIFEST, repositories: [] });
    expect(segment).toContain('no connected version-control repository');
    expect(segment).toContain('Do not clone anything');
    expect(segment).not.toContain('Primary repository');
  });

  it('renders the task status machine and human-only merge policy', () => {
    const segment = renderProjectEnvironmentSegment(BASE_MANIFEST);
    expect(segment).toContain('todo → in-progress → in-review');
    expect(segment).toContain('never merge or self-approve your own PR');
  });

  it('renders review handoff as the last status by default', () => {
    const segment = renderProjectEnvironmentSegment(BASE_MANIFEST);
    expect(segment).toContain('in-review');
  });

  it('warns on a newer manifest major', () => {
    const segment = renderProjectEnvironmentSegment({ ...BASE_MANIFEST, manifestVersion: 2 });
    expect(segment).toContain('environment manifest v2');
  });

  it('does not warn on the supported version', () => {
    const segment = renderProjectEnvironmentSegment(BASE_MANIFEST);
    expect(segment).not.toContain('environment manifest v1');
  });

  it('handles an unbound manifest with a no-project statement', () => {
    const manifest: KaneoEnvironmentManifest = {
      ...BASE_MANIFEST,
      identity: { ...BASE_MANIFEST.identity, project: null },
    };
    const segment = renderProjectEnvironmentSegment(manifest);
    expect(segment).toContain('not bound to a Kaneo project');
    expect(segment).toContain(KANEO_ENV_SEGMENT_START);
    expect(segment).toContain(KANEO_ENV_SEGMENT_END);
  });

  it('is deterministic for a given manifest (same envHash ⇒ same segment)', () => {
    expect(renderProjectEnvironmentSegment(BASE_MANIFEST)).toBe(renderProjectEnvironmentSegment(BASE_MANIFEST));
  });
});

describe('appendEnvironmentSegment', () => {
  const AGENTS_MD = '# Coding role\n\nBe diligent.\n';
  const SEGMENT = renderProjectEnvironmentSegment(BASE_MANIFEST);

  it('appends the segment to a fresh rules document', () => {
    const rules = appendEnvironmentSegment(AGENTS_MD, SEGMENT);
    expect(rules).toContain('# Coding role');
    expect(rules.trimEnd().endsWith(KANEO_ENV_SEGMENT_END)).toBe(true);
  });

  it('replaces an existing segment atomically, preserving the rest of the document', () => {
    const rules = appendEnvironmentSegment(AGENTS_MD, SEGMENT);
    const newSegment = renderProjectEnvironmentSegment({ ...BASE_MANIFEST, envHash: 'h2' });
    const updated = appendEnvironmentSegment(rules, newSegment);
    expect(updated).toContain('# Coding role');
    expect(updated).toContain(newSegment);
    expect(updated).not.toContain('envHash');
    // Exactly one segment.
    expect(updated.split(KANEO_ENV_SEGMENT_START)).toHaveLength(2);
  });

  it('is idempotent: re-appending the same segment yields one copy', () => {
    const rules = appendEnvironmentSegment(AGENTS_MD, SEGMENT);
    const again = appendEnvironmentSegment(rules, SEGMENT);
    expect(again.split(KANEO_ENV_SEGMENT_START)).toHaveLength(2);
  });

  it('collapses multiple prior segments into one', () => {
    const seg1 = renderProjectEnvironmentSegment({
      ...BASE_MANIFEST,
      repositories: [{ ...BASE_MANIFEST.repositories[0], defaultBranch: 'main' }],
    });
    const seg2 = renderProjectEnvironmentSegment({
      ...BASE_MANIFEST,
      repositories: [{ ...BASE_MANIFEST.repositories[0], defaultBranch: 'develop' }],
    });
    const seg3 = renderProjectEnvironmentSegment({
      ...BASE_MANIFEST,
      repositories: [{ ...BASE_MANIFEST.repositories[0], defaultBranch: 'trunk' }],
    });
    let rules = appendEnvironmentSegment(AGENTS_MD, seg1);
    rules = appendEnvironmentSegment(rules, seg2);
    rules = appendEnvironmentSegment(rules, seg3);
    expect(rules.split(KANEO_ENV_SEGMENT_START)).toHaveLength(2);
    expect(rules).toContain('`trunk`');
    expect(rules).not.toContain('`main`');
    expect(rules).not.toContain('`develop`');
  });

  it('works on an empty rules document', () => {
    const rules = appendEnvironmentSegment('', SEGMENT);
    expect(rules).toBe(`${SEGMENT}\n`);
  });
});

describe('project-bound assistant naming', () => {
  it('formats as Kaneo · <projectName> · <role>', () => {
    expect(kaneoProjectAssistantName('Aion UI', 'coding')).toBe('Kaneo · Aion UI · coding');
  });
});
