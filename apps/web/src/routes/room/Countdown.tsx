// SPDX-License-Identifier: AGPL-3.0-only
import { useTranslation } from 'react-i18next';
import { useNow } from '../../hooks/use-now.ts';
import { formatRemaining } from '../../i18n/format.ts';

/** Time left until a quick room closes, ticking every second. */
export function Countdown({ expiresAt }: { expiresAt: number }) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const remaining = expiresAt - now;
  const date = new Date(expiresAt);
  return (
    <time dateTime={date.toISOString()} className="tabular-nums">
      {remaining > 0
        ? t('room.expiresIn', {
            time: formatRemaining(remaining, i18n.resolvedLanguage ?? i18n.language),
          })
        : t('room.expired')}
    </time>
  );
}
