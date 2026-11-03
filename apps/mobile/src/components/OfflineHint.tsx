// SPDX-License-Identifier: AGPL-3.0-only
import { useTranslation } from 'react-i18next';
import { useOnline } from '../queries.ts';
import { Banner } from './ui.tsx';

/** "Showing saved data" while the phone has no network and the screen has something saved. */
export function OfflineHint({ hasData }: { hasData: boolean }) {
  const { t } = useTranslation();
  const online = useOnline();
  if (online || !hasData) return null;
  return <Banner tone="muted">{t('mobile.offline.saved')}</Banner>;
}
