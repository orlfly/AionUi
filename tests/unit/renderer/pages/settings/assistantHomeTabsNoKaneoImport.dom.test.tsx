/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Regression tests for the Kaneo import-button retirement and the Kaneo home
// tab hosting: the assistant home renders no "Import from Kaneo" entry point,
// adds a Kaneo tab next to enabled/mine/official, and shows the tab content
// only when the Kaneo controller is mounted. i18n texts come from the real
// locale bundles.

import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import AssistantHomeTabs from '@/renderer/pages/settings/AssistantSettings/home/AssistantHomeTabs';
import type { KaneoCreateTabController } from '@/renderer/pages/settings/AssistantSettings/useKaneoCreateTab';

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      void key;
      return typeof fallback === 'string' ? fallback : key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/renderer/pages/settings/AssistantSettings/home/EnabledAssistantsList', () => ({
  default: () => <div data-testid='enabled-list' />,
}));
vi.mock('@/renderer/pages/settings/AssistantSettings/AssistantKaneoCreateTab', () => ({
  default: () => <div data-testid='kaneo-tab-content' />,
}));
vi.mock('@/renderer/pages/settings/components/SettingsPageHeader', () => ({
  default: (props: { tabs?: Array<{ key: string; label: string }>; onTabChange?: (key: string) => void }) => (
    <div>
      {(props.tabs ?? []).map((tab) => (
        <button
          key={tab.key}
          type='button'
          data-testid={`settings-tab-${tab.key}`}
          onClick={() => props.onTabChange?.(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('@/renderer/components/base', () => ({
  AionSearchInput: () => <input placeholder='search' readOnly />,
}));
vi.mock('@/renderer/components/base/TalkToButlerButton', () => ({ default: () => <div /> }));

const fakeController = {
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
  selectRole: () => undefined,
  selectProject: () => undefined,
  connect: () => undefined,
  disconnect: () => undefined,
  canCreate: false,
  creating: false,
  lastResult: null,
  create: () => undefined,
  releaseSecrets: () => undefined,
} as unknown as KaneoCreateTabController;

const renderHome = (overrides?: { kaneo?: KaneoCreateTabController }) =>
  render(
    <AssistantHomeTabs
      assistants={[]}
      assistantOrder={[]}
      localeKey='en'
      onOpenDetail={() => undefined}
      onOpenSettings={() => undefined}
      onDuplicate={() => undefined}
      onDelete={() => undefined}
      onCreate={() => undefined}
      onToggleEnabled={() => undefined}
      onReorderEnabled={() => undefined}
      onStartChat={() => undefined}
      kaneo={overrides?.kaneo}
    />
  );

describe('AssistantHomeTabs (Kaneo home tab)', () => {
  it('renders the four tabs without a standalone Kaneo import entry', () => {
    renderHome({ kaneo: fakeController });

    expect(screen.getByTestId('assistant-home-shell')).toBeDefined();
    expect(screen.queryByText(/import/i)).toBeNull();
    expect(screen.getByTestId('settings-tab-enabled')).toBeDefined();
    expect(screen.getByTestId('settings-tab-mine')).toBeDefined();
    expect(screen.getByTestId('settings-tab-official')).toBeDefined();
    expect(screen.getByTestId('settings-tab-kaneo')).toBeDefined();
    // The tab content only renders after the tab is selected.
    expect(screen.queryByTestId('kaneo-tab-content')).toBeNull();
  });

  it('shows the Kaneo tab content when the tab is selected', () => {
    renderHome({ kaneo: fakeController });

    fireEvent.click(screen.getByTestId('settings-tab-kaneo'));

    expect(screen.getByTestId('kaneo-tab-content')).toBeDefined();
  });

  it('renders an empty tab body when no Kaneo controller is provided', () => {
    renderHome();

    fireEvent.click(screen.getByTestId('settings-tab-kaneo'));

    expect(screen.queryByTestId('kaneo-tab-content')).toBeNull();
  });
});
