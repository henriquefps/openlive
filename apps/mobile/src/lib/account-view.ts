// SPDX-License-Identifier: AGPL-3.0-only
import type { Session } from '@openlive/client';
import type { TFunction } from 'i18next';
import { describeUserAgent } from './user-agent.ts';

/** "Chrome on Linux", or "Openlive app · Ana's iPhone" for the mobile app (the web's SessionsCard). */
export function sessionName(session: Session, t: TFunction): string {
  if (session.kind === 'app') return t('settings.sessions.app', { device: session.deviceName });
  const { browser, os } = describeUserAgent(session.userAgent);
  return browser && os
    ? t('settings.sessions.device', { browser, os })
    : (browser ?? os ?? t('settings.sessions.unknownDevice'));
}

/** When a session was last used (an app's token) or signed in, as the line under its name. */
export function sessionWhen(session: Session, t: TFunction, date: (at: number) => string): string {
  return session.kind === 'app' && session.lastUsedAt !== null
    ? t('settings.sessions.lastUsedAt', { date: date(session.lastUsedAt) })
    : t('settings.sessions.signedInAt', { date: date(session.createdAt) });
}

/** A date and time in the interface language. */
export const formatWhen = (at: number, locale: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
