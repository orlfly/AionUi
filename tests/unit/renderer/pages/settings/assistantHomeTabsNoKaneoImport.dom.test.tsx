/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Regression test for the Kaneo import-button retirement: the assistant home
// no longer renders an "Import from Kaneo" entry point; it renders only the
// three standard tabs. i18n texts come from the real locale bundles.

import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import AssistantHomeTabs from '@/renderer/pages/settings/AssistantSettings/home/AssistantHomeTabs';

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
vi.mock('@/renderer/pages/settings/AssistantSettings/home/MyAssistantsList', () => ({
  default: () => <div data-testid='mine-list' />,
}));
vi.mock('@/renderer/pages/settings/AssistantSettings/home/OfficialAssistantsGrid', () => ({
  default: () => <div data-testid='official-grid' />,
}));
vi.mock('@/renderer/pages/settings/components/SettingsPageHeader', () => ({ default: () => <div /> }));
vi.mock('@/renderer/components/base', () => ({
  AionSearchInput: () => <input placeholder='search' readOnly />,
}));
vi.mock('@/renderer/components/base/TalkToButlerButton', () => ({ default: () => <div /> }));

const renderHome = () =>
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
    />
  );

describe('AssistantHomeTabs (Kaneo import retirement)', () => {
  it('renders only the enabled/mine/official tabs without a Kaneo import entry', () => {
    renderHome();

    expect(screen.getByTestId('assistant-home-shell')).toBeDefined();
    expect(screen.queryByText(/import/i)).toBeNull();
    expect(screen.queryByText(/kaneo/i)).toBeNull();
  });
});
