/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// DOM tests for the Kaneo home tab component: assistant instances group under
// their agent role cards (both disconnected and connected), and the connect
// form keeps its base URL / API key fields. The controller is stubbed; the
// kaneo services and i18n come from the real locale bundles.

import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantKaneoCreateTab, {
  type AssistantKaneoCreateTabProps,
} from '@/renderer/pages/settings/AssistantSettings/AssistantKaneoCreateTab';
import type { KaneoCreateTabController } from '@/renderer/pages/settings/AssistantSettings/useKaneoCreateTab';
import type { KaneoInstanceEntry } from '@/renderer/pages/settings/AssistantSettings/home/KaneoInstanceCard';
import { getKaneoContexts, setKaneoContexts, type KaneoContext } from '@/renderer/services/kaneo/kaneoContexts';

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

// Interpolation-capable i18n stub (real bundles would work too, but the
// workspace row asserts on the interpolated value).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string } & Record<string, unknown>) => {
      let text = options?.defaultValue ?? key;
      for (const [k, v] of Object.entries(options ?? {})) {
        if (k === 'defaultValue') continue;
        text = text.replaceAll(`{{${k}}}`, String(v));
      }
      return text;
    },
  }),
}));

vi.mock('@/renderer/services/kaneo/kaneoClient', () => ({}));

// In-memory config store backing configService (same pattern as
// kaneoContexts.test.ts) so setKaneoContexts never hits fetch.
const store = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    service: {
      get: vi.fn((key: string) => values.get(key)),
      set: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
      setLocal: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
      remove: vi.fn(async (key: string) => {
        values.delete(key);
      }),
      subscribe: vi.fn(() => () => undefined),
    },
  };
});

vi.mock('@/common/config/configService', () => ({ configService: store.service }));

const baseContext: KaneoContext = {
  id: 'ctx-1',
  baseUrl: 'http://localhost:1337',
  agentRole: 'coding',
  projectId: 'proj-1',
  projectName: 'AionUI',
  projectSlug: 'aionui',
  workspace: '/tmp/user/kaneo-workspaces/aionui/coding',
  assistantId: 'a-1',
  manifestSummary: null,
  keyExpiresAt: null,
  degraded: false,
  degradedReason: null,
};

const instance = (
  assistantId: string,
  role: string,
  contextOverrides: Partial<KaneoContext> = {}
): KaneoInstanceEntry => ({
  assistant: {
    id: assistantId,
    source: 'user',
    name: `Kaneo ${role}`,
    name_i18n: {},
    description: '',
    description_i18n: {},
    avatar: '',
    enabled: true,
    sort_order: 0,
    agent_id: 'gemini',
    agent: { type: 'gemini' },
    enabled_skills: [],
    custom_skill_names: [],
    disabled_builtin_skills: [],
    context: '',
    context_i18n: {},
    prompts: [],
    prompts_i18n: {},
    models: [],
    agent_status: 'online',
    team_selectable: true,
    deletable: true,
  } as KaneoInstanceEntry['assistant'],
  context: { ...baseContext, agentRole: role, assistantId, ...contextOverrides },
});

const fakeController = (overrides: Partial<KaneoCreateTabController> = {}): KaneoCreateTabController =>
  ({
    baseUrl: 'http://localhost:1337',
    setBaseUrl: () => undefined,
    apiKey: '',
    setApiKey: () => undefined,
    phase: 'idle',
    connectError: null,
    manifestNewerVersion: false,
    roles: [],
    projects: [],
    teamsLoading: false,
    projectsError: null,
    selectedRole: null,
    selectedProjectId: null,
    engines: [],
    selectedEngineId: null,
    selectRole: () => undefined,
    selectProject: () => undefined,
    selectEngine: () => undefined,
    connect: () => undefined,
    disconnect: () => undefined,
    canCreate: false,
    creating: false,
    lastResult: null,
    create: () => undefined,
    releaseSecrets: () => undefined,
    ...overrides,
  }) as unknown as KaneoCreateTabController;

const renderTab = (props: Partial<AssistantKaneoCreateTabProps> = {}) => {
  const merged: AssistantKaneoCreateTabProps = {
    kaneo: props.kaneo ?? fakeController(),
    instances: props.instances ?? [],
    localeKey: 'en',
    onOpenInstance: props.onOpenInstance,
    onToggleInstance: props.onToggleInstance,
    onStartInstanceChat: props.onStartInstanceChat,
  };
  return render(<AssistantKaneoCreateTab {...merged} />);
};

describe('AssistantKaneoCreateTab (home hosting)', () => {
  beforeEach(() => {
    void setKaneoContexts([]);
    expect(getKaneoContexts()).toEqual([]);
  });

  it('renders the connect form with base URL and API key fields', () => {
    renderTab();

    expect(screen.getByTestId('assistant-card-kaneo')).toBeDefined();
    expect(screen.getByTestId('input-kaneo-create-base-url')).toBeDefined();
    expect(screen.getByTestId('input-kaneo-create-api-key')).toBeDefined();
    expect(screen.getByTestId('btn-kaneo-create-connect')).toBeDefined();
  });

  it('lists existing instances grouped by role while disconnected', () => {
    renderTab({ instances: [instance('a-1', 'coding'), instance('a-2', 'code-review')] });

    expect(screen.getByTestId('kaneo-instances-unconnected')).toBeDefined();
    expect(screen.getByTestId('kaneo-instance-a-1')).toBeDefined();
    expect(screen.getByTestId('kaneo-instance-a-2')).toBeDefined();
    expect(screen.getByText('coding')).toBeDefined();
    expect(screen.getByText('code-review')).toBeDefined();
  });

  it('renders instance rows with the project binding and opens them on click', () => {
    const onOpenInstance = vi.fn();
    renderTab({ instances: [instance('a-1', 'coding')], onOpenInstance });

    const row = screen.getByTestId('kaneo-instance-a-1');
    expect(row.textContent).toContain('AionUI');
    expect(row.textContent).toContain('/tmp/user/kaneo-workspaces/aionui/coding');

    fireEvent.click(row);
    expect(onOpenInstance).toHaveBeenCalledWith('a-1');
  });

  it('groups instances under their role card after connect', () => {
    const kaneo = fakeController({
      phase: 'connected',
      roles: [
        {
          name: 'coding',
          description: 'Coder',
          selectable: true,
          hasInstance: true,
          existingAssistantName: 'Kaneo coding',
        },
        {
          name: 'coordinator',
          description: 'Coord',
          selectable: true,
          hasInstance: false,
          existingAssistantName: null,
        },
      ],
      projects: [{ id: 'proj-1', name: 'AionUI', slug: 'aionui' }],
      selectedProjectId: 'proj-1',
    });
    renderTab({ kaneo, instances: [instance('a-1', 'coding')] });

    expect(screen.getByTestId('grid-kaneo-create-role-coding')).toBeDefined();
    expect(screen.getByTestId('grid-kaneo-create-role-coordinator')).toBeDefined();
    // The coding instance shows up under its role card; coordinator has none.
    expect(screen.getByTestId('kaneo-role-instances-coding')).toBeDefined();
    expect(screen.getByTestId('kaneo-instance-a-1')).toBeDefined();
    expect(screen.queryByTestId('kaneo-role-instances-coordinator')).toBeNull();
  });

  it('shows an unknown-role group for instances whose role is empty', () => {
    renderTab({ instances: [instance('a-9', '', { agentRole: '' })] });

    expect(screen.getByTestId('kaneo-instances-unconnected')).toBeDefined();
    expect(screen.getByTestId('kaneo-instance-a-9')).toBeDefined();
  });

  it('keeps Create disabled until role and project are selected', () => {
    const kaneo = fakeController({
      phase: 'connected',
      roles: [{ name: 'coding', description: '', selectable: true, hasInstance: false, existingAssistantName: null }],
      projects: [{ id: 'proj-1', name: 'AionUI', slug: 'aionui' }],
      canCreate: false,
    });
    renderTab({ kaneo });

    const createButton = screen.getByTestId('btn-kaneo-create-assistant') as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);
  });
});
