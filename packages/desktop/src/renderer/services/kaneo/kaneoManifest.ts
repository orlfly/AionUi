/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Kaneo project environment manifest client.
//
// Talks to GET /api/agent/agents-config/bootstrap (Kaneo instances that ship
// the project-scoped environment endpoint). The manifest is the single source
// of truth for a project-bound key's environment: identity (role + project),
// repositories, workflow, and an envHash fingerprint used for drift detection.
//
// Fallback-first: when the endpoint is absent (older Kaneo returns 404/405),
// callers fall back to the legacy templates flow with legacy naming. Manifest
// versions above the supported major are tolerated — known sections render,
// unknown ones are ignored, with a non-blocking notice.

import { KaneoConnectionError, normalizeKaneoBaseUrl } from './kaneoClient';

/** Highest manifest major version this client fully understands. */
export const SUPPORTED_MANIFEST_VERSION = 1;

export type KaneoManifestProject = {
  id: string;
  teamId: string;
  name: string;
  slug: string;
  description: string | null;
};

export type KaneoManifestRepository = {
  id: string;
  role: 'primary' | 'secondary';
  type: string;
  owner: string;
  name: string;
  cloneUrl: string;
  /** Null when Kaneo does not know the branch; never fabricate one. */
  defaultBranch: string | null;
  isActive: boolean;
};

export type KaneoEnvironmentManifest = {
  manifestVersion: number;
  generatedAt: string;
  envHash: string;
  identity: {
    agentRole: string;
    project: KaneoManifestProject | null;
    server: { baseUrl: string };
  };
  repositories: KaneoManifestRepository[];
  workflow: {
    statuses: string[];
    reviewHandoff?: string;
    mergePolicy?: string;
  };
  /** True when part of the environment could not be resolved server-side. */
  degraded?: boolean;
};

/** The bootstrap outcome: either a manifest or an explicit fallback signal. */
export type KaneoBootstrapResult =
  | { kind: 'manifest'; manifest: KaneoEnvironmentManifest }
  | { kind: 'unavailable' };

function isManifestShape(value: unknown): value is KaneoEnvironmentManifest {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.manifestVersion === 'number' &&
    typeof m.envHash === 'string' &&
    typeof m.generatedAt === 'string' &&
    typeof m.identity === 'object' &&
    m.identity !== null &&
    typeof (m.identity as Record<string, unknown>).agentRole === 'string' &&
    Array.isArray(m.repositories)
  );
}

/**
 * Fetch the project environment manifest. Returns `unavailable` when the
 * endpoint does not exist (404/405 on older Kaneo) so the caller can fall back
 * to the templates flow without surfacing an error; throws on other failures.
 */
export async function fetchKaneoBootstrap(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<KaneoBootstrapResult> {
  const base = normalizeKaneoBaseUrl(baseUrl);
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/agent/agents-config/bootstrap`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    throw new KaneoConnectionError(
      'unreachable',
      `Kaneo instance unreachable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  // 404/405 = the instance does not ship the endpoint: legacy fallback.
  if (response.status === 404 || response.status === 405) {
    return { kind: 'unavailable' };
  }
  if (response.status === 401 || response.status === 403) {
    throw new KaneoConnectionError('unauthorized', `Kaneo instance rejected the API key (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new KaneoConnectionError('unknown', `Kaneo bootstrap endpoint failed: HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new KaneoConnectionError('unsupported', 'Kaneo bootstrap endpoint returned non-JSON content');
  }
  // Kaneo may wrap in {success, data} or return the object directly.
  const data = (body as { data?: unknown }).data ?? body;
  if (!isManifestShape(data)) {
    throw new KaneoConnectionError('unsupported', 'Kaneo bootstrap response has unexpected shape');
  }
  return { kind: 'manifest', manifest: data };
}

/**
 * Whether a manifest's major version exceeds what this client supports.
 * Unknown-major manifests still render known sections; callers show a notice.
 */
export function isManifestVersionNewer(manifestVersion: number): boolean {
  return Math.trunc(manifestVersion) > SUPPORTED_MANIFEST_VERSION;
}

/** True when the manifest binds the key to a project. */
export function isProjectBoundManifest(manifest: KaneoEnvironmentManifest): boolean {
  return manifest.identity.project !== null;
}

/** The primary repository, or undefined when the project has no VCS integration. */
export function primaryRepository(manifest: KaneoEnvironmentManifest): KaneoManifestRepository | undefined {
  return manifest.repositories.find((r) => r.role === 'primary') ?? manifest.repositories[0];
}