/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for repository-facts plumbing added to the Kaneo create flow:
 * parseKaneoProjectRepo / fetchKaneoProjectRepo (kaneoClient.ts) and
 * renderRepoIntegrationSegment (kaneoSync.ts). Covers the GitHub/Gitea/GitLab
 * providers alike: the integration endpoints are probed in order, the VCS
 * kind is honored when reported, and nothing manifest-sourced is fabricated.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchKaneoProjectRepo, parseKaneoProjectRepo } from '@/renderer/services/kaneo/kaneoClient';
import {
  KANEO_ENV_SEGMENT_END,
  KANEO_ENV_SEGMENT_START,
  renderRepoIntegrationSegment,
} from '@/renderer/services/kaneo/kaneoSync';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseKaneoProjectRepo', () => {
  it('parses the canonical payload shape', () => {
    const repo = parseKaneoProjectRepo({
      type: 'gitlab',
      repositoryOwner: 'aion',
      repositoryName: 'ui',
      cloneUrl: 'https://gitlab.com/aion/ui.git',
      branchPattern: 'feat/*',
    });
    expect(repo).toEqual({
      type: 'gitlab',
      cloneUrl: 'https://gitlab.com/aion/ui.git',
      repositoryOwner: 'aion',
      repositoryName: 'ui',
      branchPattern: 'feat/*',
    });
  });

  it('accepts alternative field spellings (owner/name, snake_case, provider)', () => {
    const repo = parseKaneoProjectRepo({
      owner: 'aion',
      name: 'ui',
      http_url_to_repo: 'https://gitlab.com/aion/ui.git',
      branch_pattern: 'fix/*',
    });
    expect(repo).toMatchObject({
      type: 'git',
      cloneUrl: 'https://gitlab.com/aion/ui.git',
      repositoryOwner: 'aion',
      repositoryName: 'ui',
      branchPattern: 'fix/*',
    });
  });

  it('honors the reported VCS kind (github, gitea) over the fallback', () => {
    expect(parseKaneoProjectRepo({ provider: 'github', owner: 'aion', name: 'ui' })?.type).toBe('github');
    expect(parseKaneoProjectRepo({ vcsType: 'gitea', owner: 'aion', name: 'ui' })?.type).toBe('gitea');
    expect(parseKaneoProjectRepo({ owner: 'aion', name: 'ui' }, 'gitea')?.type).toBe('gitea');
  });

  it('derives an empty cloneUrl (owner/name still render) when no URL field exists', () => {
    const repo = parseKaneoProjectRepo({ repositoryOwner: 'aion', repositoryName: 'ui' });
    expect(repo).toMatchObject({ cloneUrl: '', repositoryOwner: 'aion', repositoryName: 'ui' });
    expect(repo?.branchPattern).toBeNull();
  });

  it('returns null without enough facts to identify a repository', () => {
    expect(parseKaneoProjectRepo({ branchPattern: 'x' })).toBeNull();
    expect(parseKaneoProjectRepo(null)).toBeNull();
    expect(parseKaneoProjectRepo('nope')).toBeNull();
  });
});

describe('fetchKaneoProjectRepo', () => {
  const stubFetch = (impl: (url: string) => Response | Promise<Response>): void => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => impl(String(input))) as unknown as typeof fetch);
  };

  it('fetches and parses the gitlab-integration project payload', async () => {
    stubFetch((url) =>
      url.includes('/api/gitlab-integration/project/p1')
        ? new Response(JSON.stringify({ data: { repositoryOwner: 'aion', repositoryName: 'ui' } }), { status: 200 })
        : new Response('nope', { status: 404 })
    );
    const repo = await fetchKaneoProjectRepo('http://kaneo/', 'key', 'p1');
    expect(repo).toMatchObject({ type: 'gitlab', repositoryOwner: 'aion', repositoryName: 'ui', cloneUrl: '' });
  });

  it('probes the github-integration endpoint when gitlab answers 404', async () => {
    stubFetch((url) =>
      url.includes('/api/github-integration/project/p1')
        ? new Response(
            JSON.stringify({ data: { repositoryOwner: 'aion', repositoryName: 'ui', provider: 'github' } }),
            { status: 200 }
          )
        : new Response(null, { status: 404 })
    );
    const repo = await fetchKaneoProjectRepo('http://kaneo', 'key', 'p1');
    expect(repo).toMatchObject({ type: 'github', repositoryOwner: 'aion', repositoryName: 'ui' });
  });

  it('probes the gitea-integration endpoint and derives its type from the endpoint', async () => {
    stubFetch((url) =>
      url.includes('/api/gitea-integration/project/p1')
        ? new Response(
            JSON.stringify({ repositoryOwner: 'aion', repositoryName: 'ui', cloneUrl: 'https://gitea/aion/ui.git' }),
            { status: 200 }
          )
        : new Response(null, { status: 404 })
    );
    const repo = await fetchKaneoProjectRepo('http://kaneo', 'key', 'p1');
    expect(repo).toMatchObject({ type: 'gitea', cloneUrl: 'https://gitea/aion/ui.git' });
  });

  it('degrades to null when every integration endpoint is absent (404/405)', async () => {
    stubFetch(() => new Response(null, { status: 404 }));
    await expect(fetchKaneoProjectRepo('http://kaneo', 'key', 'p1')).resolves.toBeNull();
  });

  it('degrades to null on a hard HTTP failure or network error', async () => {
    stubFetch(() => new Response(null, { status: 500 }));
    await expect(fetchKaneoProjectRepo('http://kaneo', 'key', 'p1')).resolves.toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      }) as unknown as typeof fetch
    );
    await expect(fetchKaneoProjectRepo('http://kaneo', 'key', 'p1')).resolves.toBeNull();
  });
});

describe('renderRepoIntegrationSegment', () => {
  const REPO = {
    type: 'gitlab',
    cloneUrl: 'https://gitlab.example/aion/ui.git',
    repositoryOwner: 'aion',
    repositoryName: 'ui',
    branchPattern: null,
  };

  it('renders the VCS kind, owner/name, clone URL, and boundaries', () => {
    const segment = renderRepoIntegrationSegment(REPO);
    expect(segment).toContain(KANEO_ENV_SEGMENT_START);
    expect(segment).toContain(KANEO_ENV_SEGMENT_END);
    expect(segment).toContain('gitlab aion/ui');
    expect(segment).toContain('https://gitlab.example/aion/ui.git');
    expect(segment).toContain('Clone it into this workspace');
  });

  it('renders github and gitea kinds with the same shape', () => {
    const github = renderRepoIntegrationSegment({ ...REPO, type: 'github' });
    expect(github).toContain('github aion/ui');
    expect(github).not.toContain('gitlab aion/ui');

    const gitea = renderRepoIntegrationSegment({ ...REPO, type: 'gitea', cloneUrl: 'https://gitea/aion/ui.git' });
    expect(gitea).toContain('gitea aion/ui');
    expect(gitea).toContain('https://gitea/aion/ui.git');
  });

  it('omits clone guidance when no clone URL is reported (owner/name only)', () => {
    const segment = renderRepoIntegrationSegment({ ...REPO, cloneUrl: '' });
    expect(segment).toContain('gitlab aion/ui');
    expect(segment).not.toContain('Clone it into this workspace');
    expect(segment).not.toContain('clone URL');
  });

  it('renders the branch pattern verbatim only when reported', () => {
    expect(renderRepoIntegrationSegment({ ...REPO, branchPattern: 'feat/*' })).toContain('`feat/*`');
    expect(renderRepoIntegrationSegment(REPO)).not.toContain('Branch pattern');
  });

  it('never fabricates the manifest-sourced status machine', () => {
    expect(renderRepoIntegrationSegment(REPO)).not.toContain('Task status machine');
  });

  it('is deterministic for a given payload', () => {
    expect(renderRepoIntegrationSegment(REPO)).toBe(renderRepoIntegrationSegment(REPO));
  });
});
