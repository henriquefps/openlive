// SPDX-License-Identifier: AGPL-3.0-only
import { useTranslation } from 'react-i18next';
import { Page } from '../../components/Page.tsx';
import { StatusBadge, type StatusTone } from '../../components/StatusBadge.tsx';
import { StreamGrid } from '../../components/StreamGrid.tsx';
import { STREAM_FIXTURES } from './fixtures.ts';

const TONES: readonly StatusTone[] = ['ok', 'live', 'warning', 'failed', 'idle'];

/** Design system fixtures; the route exists only outside production builds (see router.tsx). */
export function ComponentsPage() {
  const { t } = useTranslation();
  return (
    <Page title={t('dev.title')} description={t('dev.intro')}>
      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">{t('dev.streamCards')}</h2>
        <StreamGrid streams={STREAM_FIXTURES} />
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">{t('dev.statusBadges')}</h2>
        <div className="flex flex-wrap gap-2">
          {TONES.map((tone) => (
            <StatusBadge key={tone} tone={tone}>
              {t(`status.${tone}`)}
            </StatusBadge>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">{t('dev.emptyGrid')}</h2>
        <StreamGrid streams={[]} />
      </section>
    </Page>
  );
}
