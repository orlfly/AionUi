/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';

let mockLanguage = 'en-US';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (mockLanguage === 'zh-CN' ? `zh:${key}` : key),
    i18n: { language: mockLanguage },
  }),
}));

import DocumentTitle, { titleForPath } from '@/renderer/components/layout/DocumentTitle';

describe('titleForPath', () => {
  const t = (key: string) => `t(${key})`;

  it('always returns the global app title (no login route anymore)', () => {
    expect(titleForPath('/guid', t)).toBe('AionUi');
    expect(titleForPath('/conversation/abc', t)).toBe('AionUi');
    expect(titleForPath('/settings/agent', t)).toBe('AionUi');
  });
});

describe('DocumentTitle', () => {
  it('sets the global app title', () => {
    document.title = 'AionUi - stale title';
    render(
      <MemoryRouter initialEntries={['/guid']}>
        <DocumentTitle />
      </MemoryRouter>
    );
    expect(document.title).toBe('AionUi');
  });

  it('keeps the global title regardless of language', () => {
    mockLanguage = 'zh-CN';
    render(
      <MemoryRouter initialEntries={['/guid']}>
        <DocumentTitle />
      </MemoryRouter>
    );
    expect(document.title).toBe('AionUi');
    mockLanguage = 'en-US';
  });
});
