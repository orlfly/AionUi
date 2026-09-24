/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// DOM tests for the Kaneo Guide integration hook: context matching by
// assistant id, workspace preselection (user override preserved), badge state
// (degradation, expiry window) and the degraded-marking error path.

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KaneoContext } from '@/renderer/services/kaneo/kaneoContexts';
import {
  KANEO_EXPIRY_WARN_WINDOW_MS,
  bumpKaneoContextsVersion,
  findKaneoContextByAssistant,
  markKaneoContextDegraded,
  useKaneoGuideContext,
} from '@/renderer/pages/guid/hooks/useKaneoGuideContext';

const configValues = new Map<string, unknown>();

const configServiceMock = vi.hoisted(() => ({
  get: vi.fn((key: string) => configValues.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    configValues.set(key, value);
  }),
  setLocal: vi.fn(async (key: string, value: unknown) => {
    configValues.set(key, value);
  }),
  remove: vi.fn(async (key: string) => {
    configValues.delete(key);
  }),
  subscribe: vi.fn(() => () => {}),
}));

vi.mock('@/common/config/configService', () => ({ configService: configServiceMock }));

function baseContext(overrides: Partial<KaneoContext>): KaneoContext {
  return {
    id: 'kctx-1',
    baseUrl: 'http://kaneo',
    agentRole: 'coding',
    projectId: 'p1',
    projectName: 'Aion UI',
    projectSlug: 'aion-ui',
    workspace: '/managed/kaneo-workspaces/aion-ui/coding',
    assistantId: 'ast-1',
    manifestSummary: { envHash: 'h1', manifestVersion: 1 },
    keyExpiresAt: null,
    degraded: false,
    degradedReason: null,
    ...overrides,
  };
}

function setContexts(contexts: KaneoContext[]): void {
  configValues.set('kaneo.contexts', contexts);
  bumpKaneoContextsVersion();
}

type HookOptions = {
  selectedAssistantId: string | null;
  dir: string;
  setDir: (dir: string) => void;
};

function renderKaneoGuide(options: HookOptions) {
  return renderHook((opts: HookOptions) => useKaneoGuideContext(opts), {
    initialProps: options,
  });
}

describe('useKaneoGuideContext', () => {
  beforeEach(() => {
    configValues.clear();
  });

  it('matches the selected assistant to its context', () => {
    const context = baseContext({});
    setContexts([context]);
    const { result } = renderKaneoGuide({ selectedAssistantId: 'ast-1', dir: '', setDir: vi.fn() });
    expect(result.current.context?.id).toBe('kctx-1');
    expect(result.current.activeContextDegraded).toBe(false);
    expect(result.current.expired).toBe(false);
    expect(result.current.expiringSoon).toBe(false);
  });

  it('returns no context for an assistant without a Kaneo binding', () => {
    setContexts([baseContext({})]);
    const { result } = renderKaneoGuide({ selectedAssistantId: 'other-ast', dir: '', setDir: vi.fn() });
    expect(result.current.context).toBeUndefined();
  });

  it('preselects the context workspace when dir is empty', () => {
    setContexts([baseContext({})]);
    const setDir = vi.fn();
    renderKaneoGuide({ selectedAssistantId: 'ast-1', dir: '', setDir });
    expect(setDir).toHaveBeenCalledWith('/managed/kaneo-workspaces/aion-ui/coding');
  });

  it('preserves an explicit user workspace override', () => {
    setContexts([baseContext({})]);
    const setDir = vi.fn();
    // The user picked a non-Kaneo dir before the assistant resolved.
    renderKaneoGuide({ selectedAssistantId: 'ast-1', dir: '/home/user/other-project', setDir });
    expect(setDir).not.toHaveBeenCalled();
  });

  it('keeps the preselection when the current dir is another Kaneo workspace (auto value)', () => {
    setContexts([baseContext({}), baseContext({ id: 'kctx-2', assistantId: 'ast-2', workspace: '/ws/other' })]);
    const setDir = vi.fn();
    renderKaneoGuide({ selectedAssistantId: 'ast-1', dir: '/ws/other', setDir });
    expect(setDir).toHaveBeenCalledWith('/managed/kaneo-workspaces/aion-ui/coding');
  });

  it('flags degraded from the active context', () => {
    setContexts([baseContext({ degraded: true, degradedReason: 'key-expired-or-revoked' })]);
    configValues.set('kaneo.activeContextId', 'kctx-1');
    const { result } = renderKaneoGuide({ selectedAssistantId: 'ast-1', dir: '', setDir: vi.fn() });
    expect(result.current.activeContextDegraded).toBe(true);
  });

  it('warns within the 7-day expiry window and flags expired keys', async () => {
    const soon = new Date(Date.now() + KANEO_EXPIRY_WARN_WINDOW_MS - 24 * 60 * 60 * 1000).toISOString();
    setContexts([baseContext({ keyExpiresAt: soon })]);
    const { result } = renderKaneoGuide({ selectedAssistantId: 'ast-1', dir: '', setDir: vi.fn() });
    await waitFor(() => expect(result.current?.expiringSoon).toBe(true));
    expect(result.current?.expired).toBe(false);

    const past = new Date(Date.now() - 1000).toISOString();
    setContexts([baseContext({ keyExpiresAt: past })]);
    // Context refresh is poll-based (1s interval); allow a full cycle.
    await waitFor(() => expect(result.current?.expired).toBe(true), { timeout: 3000, interval: 200 });
    expect(result.current?.expiringSoon).toBe(true);
  });

  it('ignores invalid expiry values', () => {
    setContexts([baseContext({ keyExpiresAt: 'not-a-date' })]);
    const { result } = renderKaneoGuide({ selectedAssistantId: 'ast-1', dir: '', setDir: vi.fn() });
    expect(result.current.expiringSoon).toBe(false);
    expect(result.current.expired).toBe(false);
  });
});

describe('markKaneoContextDegraded', () => {
  beforeEach(() => {
    configValues.clear();
  });

  it('persists the degraded flag with a reason', async () => {
    setContexts([baseContext({})]);
    await markKaneoContextDegraded('kctx-1', 'key-expired-or-revoked');
    const stored = configValues.get('kaneo.contexts') as KaneoContext[];
    expect(stored[0].degraded).toBe(true);
    expect(stored[0].degradedReason).toBe('key-expired-or-revoked');
  });

  it('findKaneoContextByAssistant resolves by assistant id', () => {
    setContexts([baseContext({})]);
    expect(findKaneoContextByAssistant('ast-1')?.id).toBe('kctx-1');
    expect(findKaneoContextByAssistant('nope')).toBeUndefined();
  });

  it('bumpKaneoContextsVersion triggers hook refresh within the poll interval', async () => {
    setContexts([]);
    const { result } = renderKaneoGuide({ selectedAssistantId: 'ast-1', dir: '', setDir: vi.fn() });
    expect(result.current.context).toBeUndefined();
    setContexts([baseContext({})]);
    await waitFor(
      () => {
        expect(result.current.context?.id).toBe('kctx-1');
      },
      { timeout: 2500 }
    );
  });
});
