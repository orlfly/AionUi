/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Single owner of `document.title`.
 *
 * Auth/registration was removed, so there is no login route to title anymore.
 * The app always uses the same global title regardless of path or language.
 */
export function titleForPath(_pathname: string, _t: (key: string) => string): string {
  return 'AionUi';
}

const DocumentTitle: React.FC = () => {
  const { pathname } = useLocation();

  useEffect(() => {
    document.title = titleForPath(pathname, () => '');
  }, [pathname]);

  return null;
};

export default DocumentTitle;
