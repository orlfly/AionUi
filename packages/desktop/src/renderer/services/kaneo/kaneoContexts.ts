/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Kaneo context store.
//
// A "context" is one imported Kaneo binding: (baseUrl, projectId, role). The
// renderer persists contexts (no key material — keys live encrypted in the
// main process, addressed by contextId) and an activeContextId pointer the
// Guide uses to scope the assistant list and workspace preselection.
//
// Migration: installs upgraded from the single-role model carry
// `kaneo.activeRole` and no contexts; migrateKaneoContexts runs once (guarded
// by a contexts read — presence of the key itself is the done flag) and turns
// the legacy role into a project-less context, preserving role-based
// filtering. The legacy key is removed only after the context exists.

import { configService } from '@/common/config/configService';
import type { KaneoEnvironmentManifest, KaneoManifestRepository } from './kaneoManifest';

/** Structured repository info persisted on a context (no credentials). */
export type KaneoContextRepository = KaneoManifestRepository;

/** Repo facts sourced outside the bootstrap manifest (e.g. a VCS integration endpoint). */
export type KaneoRepoIntegration = {
  /** VCS kind (e.g. `github`/`gitea`/`gitlab`) as reported or endpoint-derived. */
  type: string;
  source: 'vcs-integration';
  baseUrl: string;
  repositoryOwner: string;
  repositoryName: string;
  /** Clone URL when the integration reports one; null → render owner/name only. */
  cloneUrl: string | null;
  /** Branch pattern reported by the integration; null when absent — never fabricated. */
  branchPattern: string | null;
};

export type KaneoContext = {
  /** Stable id; also the address for the stored credential ref. */
  id: string;
  baseUrl: string;
  agentRole: string;
  /** Null for project-less (legacy/unbound) contexts. */
  projectId: string | null;
  projectName: string | null;
  projectSlug: string | null;
  /** Absolute workspace dir for project-bound contexts; null when unbound. */
  workspace: string | null;
  /** Assistant id this context last synced (rename/upsert stability). */
  assistantId: string | null;
  manifestSummary: {
    envHash: string;
    manifestVersion: number;
  } | null;
  /** Structured repository facts, persisted so later flows need no refetch. */
  repositories: KaneoContextRepository[] | null;
  /** Repo facts from a non-manifest source; null when none was available. */
  repoIntegration: KaneoRepoIntegration | null;
  /** Key expiry as reported by Kaneo, ISO string; null when none. */
  keyExpiresAt: string | null;
  /** Set when Kaneo reports the binding unusable (archived/deleted/expired). */
  degraded: boolean;
  /** Human-readable degradation reason for badges. */
  degradedReason: string | null;
};

export function newKaneoContextId(): string {
  return `kctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Build a context from a freshly fetched manifest (import or reconnect). */
export function contextFromManifest(manifest: KaneoEnvironmentManifest, baseUrl: string): KaneoContext {
  const project = manifest.identity.project;
  return {
    id: newKaneoContextId(),
    baseUrl,
    agentRole: manifest.identity.agentRole,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    projectSlug: project?.slug ?? null,
    workspace: null,
    assistantId: null,
    manifestSummary: { envHash: manifest.envHash, manifestVersion: manifest.manifestVersion },
    repositories: manifest.repositories.length > 0 ? [...manifest.repositories] : [],
    repoIntegration: null,
    keyExpiresAt: null,
    degraded: Boolean(manifest.degraded),
    degradedReason: manifest.degraded ? 'manifest-degraded' : null,
  };
}

/** Read all contexts (empty array when none). */
export function getKaneoContexts(): KaneoContext[] {
  const contexts = configService.get('kaneo.contexts');
  return Array.isArray(contexts) ? contexts : [];
}

/** Write contexts back. */
export async function setKaneoContexts(contexts: KaneoContext[]): Promise<void> {
  await configService.set('kaneo.contexts', contexts);
}

/** Read the active context id (or undefined). */
export function getActiveKaneoContextId(): string | undefined {
  return configService.get('kaneo.activeContextId');
}

/** Set the active context id. */
export async function setActiveKaneoContextId(contextId: string | null): Promise<void> {
  if (contextId === null) {
    await configService.remove('kaneo.activeContextId');
    return;
  }
  await configService.set('kaneo.activeContextId', contextId);
}

/** The currently active context, or undefined when none/no match. */
export function getActiveKaneoContext(): KaneoContext | undefined {
  const id = getActiveKaneoContextId();
  if (!id) return undefined;
  return getKaneoContexts().find((c) => c.id === id);
}

/**
 * Upsert a context by (baseUrl, projectId, role). When an existing context
 * matches, it is updated in place (preserving id, assistantId, workspace and
 * credential binding) so rotation/reconnect never duplicates.
 */
export async function upsertKaneoContext(context: KaneoContext): Promise<{ context: KaneoContext; created: boolean }> {
  const contexts = getKaneoContexts();
  const index = contexts.findIndex(
    (c) =>
      c.baseUrl === context.baseUrl &&
      (c.projectId ?? null) === (context.projectId ?? null) &&
      c.agentRole === context.agentRole
  );
  if (index >= 0) {
    const existing = contexts[index];
    const merged: KaneoContext = {
      ...existing,
      // Refreshable fields from a new manifest.
      projectName: context.projectName,
      projectSlug: context.projectSlug,
      manifestSummary: context.manifestSummary,
      // Repo facts refresh with each sync; null keeps prior facts (explicit
      // binding without a manifest must not erase manifest-sourced facts).
      repositories: context.repositories ?? existing.repositories,
      repoIntegration: context.repoIntegration ?? existing.repoIntegration,
      degraded: context.degraded,
      degradedReason: context.degradedReason,
    };
    contexts[index] = merged;
    await setKaneoContexts(contexts);
    await setActiveKaneoContextId(merged.id);
    return { context: merged, created: false };
  }
  contexts.push(context);
  await setKaneoContexts(contexts);
  await setActiveKaneoContextId(context.id);
  return { context, created: true };
}

/** Persist a context update (workspace, assistantId, degraded state...). */
export async function updateKaneoContext(contextId: string, patch: Partial<KaneoContext>): Promise<void> {
  const contexts = getKaneoContexts();
  const index = contexts.findIndex((c) => c.id === contextId);
  if (index < 0) return;
  contexts[index] = { ...contexts[index], ...patch };
  await setKaneoContexts(contexts);
}

/** Remove a context (does not touch the assistant or the workspace dir). */
export async function removeKaneoContext(contextId: string): Promise<void> {
  const contexts = getKaneoContexts();
  const next = contexts.filter((c) => c.id !== contextId);
  await setKaneoContexts(next);
  if (getActiveKaneoContextId() === contextId) {
    await setActiveKaneoContextId(next[0]?.id ?? null);
  }
}

/**
 * One-time migration from the legacy single-role model.
 *
 * When `kaneo.activeRole` exists and no contexts list does, create a
 * project-less context preserving the role (so role-based Guide filtering
 * keeps working), point activeContextId at it, and drop the legacy key.
 * Idempotent: a second run is a no-op.
 */
export async function migrateKaneoContexts(): Promise<void> {
  const existing = configService.get('kaneo.contexts');
  if (Array.isArray(existing)) return; // already migrated (or empty on purpose)
  const legacyRole = configService.get('kaneo.activeRole');
  if (!legacyRole || typeof legacyRole !== 'string') {
    // Nothing to migrate; write the empty list so this only runs once.
    await setKaneoContexts([]);
    return;
  }
  const context: KaneoContext = {
    id: newKaneoContextId(),
    baseUrl: '',
    agentRole: legacyRole,
    projectId: null,
    projectName: null,
    projectSlug: null,
    workspace: null,
    assistantId: null,
    manifestSummary: null,
    repositories: null,
    repoIntegration: null,
    keyExpiresAt: null,
    degraded: false,
    degradedReason: null,
  };
  await setKaneoContexts([context]);
  await setActiveKaneoContextId(context.id);
  // Dual-read window per design D6/Migration plan: the legacy key stays in the
  // type map but is no longer read once contexts exist. Remove it on migration.
  await configService.remove('kaneo.activeRole');
}
