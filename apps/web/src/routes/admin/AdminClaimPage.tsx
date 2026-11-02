// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { meQuery } from '../../api/auth.ts';
import { ClaimForm } from '../../components/admin/ClaimForm.tsx';
import { Page } from '../../components/Page.tsx';

/** /admin/claim: a signed-in user turns the install code into the platform admin role. */
export function AdminClaimPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const me = useQuery(meQuery);
  // Straight into the onboarding wizard.
  const toSetup = () => void navigate({ to: '/admin/setup' });
  return (
    <Page title={t('admin.claim.title')} description={t('admin.claim.intro')}>
      <div className="flex max-w-2xl flex-col gap-4">
        {me.data && !me.data.adminClaimable ? (
          <Alert>
            <AlertDescription>{t('admin.claim.taken')}</AlertDescription>
          </Alert>
        ) : (
          <Card>
            <CardContent>
              <ClaimForm onClaimed={toSetup} />
            </CardContent>
          </Card>
        )}
      </div>
    </Page>
  );
}
