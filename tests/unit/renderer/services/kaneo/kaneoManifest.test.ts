/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the Kaneo project environment manifest client
 * (services/kaneo/kaneoManifest.ts): endpoint parsing, 404/405 fallback,
 * auth failures, version tolerance, and project binding.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SUPPORTED_MANIFEST_VERSION,
  fetchKaneoBootstrap,
  isManifestVersionNewer,
  isProjectBoundManifest,
  primaryRepository,
} from '@/renderer/services/kaneo/kaneoManifest';
import { KaneoConnectionError } from '@/renderer/services/kaneo/kaneoClient';
import type { KaneoEnvironmentManifest } from '@/renderer/services/kaneo/kaneoManifest';

const MANIFEST: KaneoEnvironmentManifest = {
  manifestVersion: 1,
  generatedAt: '2026-01-01T00:00:00Z',
  envHash: 'abc123',
  identity: {
    agentRole: 'coding',
    project: {
      id: 'p1',
      teamId: 't1',
      name: 'Aion UI',
      slug: 'aion-ui',
      description: null,
    },
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchKaneoBootstrap', () => {
  it('parses a bare-object manifest response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 }))
    );
    const result = await fetchKaneoBootstrap('http://kaneo', 'key');
    expect(result.kind).toBe('manifest');
    if (result.kind === 'manifest') {
      expect(result.manifest.envHash).toBe('abc123');
      expect(result.manifest.identity.agentRole).toBe('coding');
    }
  });

  it('parses a {success, data}-wrapped manifest response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: true, data: MANIFEST }), { status: 200 }))
    );
    const result = await fetchKaneoBootstrap('http://kaneo', 'key');
    expect(result.kind).toBe('manifest');
  });

  it('sends the API key as a bearer token to the bootstrap endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchKaneoBootstrap('http://kaneo/', 'secret-key');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://kaneo/api/agent/agents-config/bootstrap',
      expect.objectContaining({ headers: { Authorization: 'Bearer secret-key' } })
    );
  });

  it('returns unavailable on 404 (older Kaneo) for fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 }))
    );
    const result = await fetchKaneoBootstrap('http://kaneo', 'key');
    expect(result).toEqual({ kind: 'unavailable' });
  });

  it('returns unavailable on 405 (endpoint exists but wrong method) for fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 405 }))
    );
    const result = await fetchKaneoBootstrap('http://kaneo', 'key');
    expect(result).toEqual({ kind: 'unavailable' });
  });

  it('throws unauthorized on 401/403 instead of falling back', async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status }))
      );
      await expect(fetchKaneoBootstrap('http://kaneo', 'key')).rejects.toMatchObject({
        kind: 'unauthorized',
      });
      vi.unstubAllGlobals();
    }
  });

  it('throws unreachable on network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('ECONNREFUSED')))
    );
    await expect(fetchKaneoBootstrap('http://kaneo', 'key')).rejects.toBeInstanceOf(KaneoConnectionError);
  });

  it('throws unsupported on a non-JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 200 }))
    );
    await expect(fetchKaneoBootstrap('http://kaneo', 'key')).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('throws unsupported on an unexpected JSON shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ hello: 'world' }), { status: 200 }))
    );
    await expect(fetchKaneoBootstrap('http://kaneo', 'key')).rejects.toMatchObject({ kind: 'unsupported' });
  });
});

describe('version tolerance and helpers', () => {
  it('flags manifests with a newer major as newer', () => {
    expect(isManifestVersionNewer(2)).toBe(true);
    expect(isManifestVersionNewer(10)).toBe(true);
  });

  it('accepts the supported version and lower', () => {
    expect(isManifestVersionNewer(SUPPORTED_MANIFEST_VERSION)).toBe(false);
    expect(isManifestVersionNewer(1)).toBe(false);
  });

  it('detects project-bound vs unbound manifests', () => {
    expect(isProjectBoundManifest(MANIFEST)).toBe(true);
    expect(isProjectBoundManifest({ ...MANIFEST, identity: { ...MANIFEST.identity, project: null } })).toBe(false);
  });

  it('returns the primary repository when present', () => {
    expect(primaryRepository(MANIFEST)?.cloneUrl).toBe('https://github.com/aion/ui.git');
  });

  it('falls back to the first repository when no primary is marked', () => {
    const manifest: KaneoEnvironmentManifest = {
      ...MANIFEST,
      repositories: [{ ...MANIFEST.repositories[0], role: 'secondary' }],
    };
    expect(primaryRepository(manifest)?.role).toBe('secondary');
  });

  it('returns undefined when the project has no repositories (no VCS)', () => {
    expect(primaryRepository({ ...MANIFEST, repositories: [] })).toBeUndefined();
  });
});
