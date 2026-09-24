/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Kaneo Guide integration hook: resolves the context matching the selected
// assistant, auto-preselects its workspace, and derives badge/expiry state.

import { configService } from '@/common/config/configService';
import { getKaneoContexts, updateKaneoContext, type KaneoContext } from '@/renderer/services/kaneo/kaneoContexts';
import { useEffect, useMemo, useState } from 'react';

/** Re-render trigger for context config changes. */
let contextsVersion = 0;
export function bumpKaneoContextsVersion(): void {
  contextsVersion += 1;
}

export const KANEO_EXPIRY_WARN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type KaneoGuideContextState = {
  /** The context bound to the selected assistant (undefined when none). */
  context: KaneoContext | undefined;
  /** True when the active context (not necessarily the matched one) is degraded. */
  activeContextDegraded: boolean;
  /** Expiry within the 7-day warning window. */
  expiringSoon: boolean;
  /** Expiry already passed. */
  expired: boolean;
};

function readContexts(): KaneoContext[] {
  const contexts = configService.get('kaneo.contexts');
  return Array.isArray(contexts) ? contexts : [];
}

/**
 * Resolve the Kaneo context for the selected assistant and the Guide-facing
 * badge state. Also preselects the workspace: when the selected assistant is
 * the matched context's assistant, the workspace dir defaults to the context
 * workspace unless the user has already picked a different one this session.
 */
export function useKaneoGuideContext(options: {
  selectedAssistantId: string | null;
  /** Current workspace dir value + setter from useGuidInput. */
  dir: string;
  setDir: (dir: string) => void;
}): KaneoGuideContextState {
  const { selectedAssistantId, dir, setDir } = options;
  const [version, setVersion] = useState(contextsVersion);
  useEffect(() => {
    // Poll-free refresh: contexts change on import/sync; a storage-event style
    // signal is not available for config, so subscribe if exposed later.
    const timer = setInterval(() => {
      if (contextsVersion !== version) setVersion(contextsVersion);
    }, 1000);
    return () => clearInterval(timer);
  }, [version]);

  const contexts = useMemo(() => readContexts(), [version]);

  const context = useMemo(
    () => (selectedAssistantId ? contexts.find((c) => c.assistantId === selectedAssistantId) : undefined),
    [contexts, selectedAssistantId]
  );

  // Workspace preselection (D3): when the selected assistant belongs to a
  // Kaneo context, default the workspace to the context's workspace. Never
  // overrides an explicit user choice: only applied when the dir is empty or
  // still equals another Kaneo context workspace (auto value).
  const kaneoWorkspaces = useMemo(
    () => new Set(contexts.map((c) => c.workspace).filter((w): w is string => Boolean(w))),
    [contexts]
  );
  useEffect(() => {
    if (!context?.workspace) return;
    if (dir && !kaneoWorkspaces.has(dir)) return; // user override preserved
    setDir(context.workspace);
  }, [context?.workspace, dir, kaneoWorkspaces, setDir]);

  const activeContextId = configService.get('kaneo.activeContextId');
  const activeContext = useMemo(() => contexts.find((c) => c.id === activeContextId), [activeContextId, contexts]);

  const expiry = useMemo(() => {
    if (!context?.keyExpiresAt) return { expiringSoon: false, expired: false };
    const ts = new Date(context.keyExpiresAt).getTime();
    if (Number.isNaN(ts)) return { expiringSoon: false, expired: false };
    return {
      expiringSoon: ts - Date.now() < KANEO_EXPIRY_WARN_WINDOW_MS,
      expired: ts <= Date.now(),
    };
  }, [context?.keyExpiresAt]);

  return {
    context,
    activeContextDegraded: Boolean(activeContext?.degraded),
    expiringSoon: expiry.expiringSoon,
    expired: expiry.expired,
  };
}

/**
 * Mark a context degraded (403 bound-project / 401 expired-key semantics, D7).
 * Clearing happens automatically on the next successful sync (upsert refreshes
 * `degraded` from the manifest).
 */
export async function markKaneoContextDegraded(contextId: string, reason: string): Promise<void> {
  await updateKaneoContext(contextId, { degraded: true, degradedReason: reason });
  bumpKaneoContextsVersion();
}

/** Context lookup by assistant id for error handling paths. */
export function findKaneoContextByAssistant(assistantId: string | null): KaneoContext | undefined {
  if (!assistantId) return undefined;
  return getKaneoContexts().find((c) => c.assistantId === assistantId);
}
