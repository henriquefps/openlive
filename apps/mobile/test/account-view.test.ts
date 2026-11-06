// SPDX-License-Identifier: AGPL-3.0-only
import type { Session } from '@openlive/client';
import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { sessionName, sessionWhen } from '../src/lib/account-view.ts';

const t = ((key: string, options?: Record<string, unknown>) =>
  `${key}${options ? JSON.stringify(options) : ''}`) as unknown as TFunction;
const browser: Session = {
  id: 's1',
  kind: 'browser',
  createdAt: 1000,
  expiresAt: 9000,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36',
  current: false,
};
const app: Session = {
  id: 's2',
  kind: 'app',
  createdAt: 1000,
  deviceName: 'Pixel 9',
  lastUsedAt: 5000,
  current: true,
};

describe('sessionName', () => {
  it('names a browser by browser and system, an app by its device', () => {
    expect(sessionName(browser, t)).toBe(
      'settings.sessions.device{"browser":"Chrome","os":"Windows"}',
    );
    expect(sessionName(app, t)).toBe('settings.sessions.app{"device":"Pixel 9"}');
    expect(sessionName({ ...browser, userAgent: null }, t)).toBe('settings.sessions.unknownDevice');
  });
});

describe('sessionWhen', () => {
  const date = (at: number) => `@${at}`;
  it('says last used for an app that was used, signed in otherwise', () => {
    expect(sessionWhen(app, t, date)).toBe('settings.sessions.lastUsedAt{"date":"@5000"}');
    expect(sessionWhen({ ...app, lastUsedAt: null }, t, date)).toBe(
      'settings.sessions.signedInAt{"date":"@1000"}',
    );
    expect(sessionWhen(browser, t, date)).toBe('settings.sessions.signedInAt{"date":"@1000"}');
  });
});
