// SPDX-License-Identifier: AGPL-3.0-only
import { DesktopIcon } from '@phosphor-icons/react';
import type { Device } from '@openlive/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { errorBodyOf } from '../api/client.ts';
import { devicesQuery, revokeDevice } from '../api/devices.ts';
import { translateError } from '../i18n/errors.ts';
import { formatDate } from '../i18n/format.ts';
import type { HubState } from '../hub/connection.ts';
import { useHub } from '../hub/use-hub.ts';
import { isActive } from '../golive/state.ts';

/**
 * Settings > Devices: the paired helpers, whether each is online and streaming now (the user hub),
 * last activity and a revoke button.
 */
export function DevicesCard() {
  const { t } = useTranslation();
  const devices = useQuery(devicesQuery);
  const { state: hub } = useHub();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.devices.title')}</CardTitle>
        <CardDescription>{t('settings.devices.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {devices.isPending ? (
          <Skeleton className="h-14 w-full" />
        ) : devices.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {translateError(errorBodyOf(devices.error), t)}
          </p>
        ) : devices.data.devices.length === 0 ? (
          <p className="text-[0.9375rem] text-muted-foreground">{t('settings.devices.empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {devices.data.devices.map((device) => (
              <DeviceRow key={device.deviceId} device={device} hub={hub} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function DeviceRow({ device, hub }: { device: Device; hub: HubState }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => revokeDevice(device.deviceId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: devicesQuery.queryKey }),
  });
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const when = (ms: number) => formatDate(ms, locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <li className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
      <DesktopIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate text-[0.9375rem]">{device.name}</span>
          {hub.status === 'open' && <Presence deviceId={device.deviceId} hub={hub} />}
        </span>
        <span className="text-[0.8125rem] text-muted-foreground">
          {t('settings.devices.system', {
            os: t(`download.os.${device.os}`),
            arch: device.arch,
            version: device.helperVersion,
          })}
        </span>
        <span className="text-[0.8125rem] text-muted-foreground">
          {device.lastSeenAt !== undefined
            ? t('settings.devices.lastSeen', { date: when(device.lastSeenAt) })
            : t('settings.devices.pairedAt', { date: when(device.createdAt) })}
        </span>
        {revoke.isError && (
          <span className="text-[0.8125rem] text-destructive" role="alert">
            {translateError(errorBodyOf(revoke.error), t)}
          </span>
        )}
      </div>
      <Button
        variant="outline"
        disabled={revoke.isPending}
        onClick={() => revoke.mutate()}
        aria-label={t('settings.devices.revokeLabel', { name: device.name })}
      >
        {t('settings.devices.revoke')}
      </Button>
    </li>
  );
}

/** Online, offline or streaming now; unknown (nothing shown) while the hub is not connected. */
function Presence({ deviceId, hub }: { deviceId: string; hub: HubState }) {
  const { t } = useTranslation();
  if (!(deviceId in hub.helpers)) {
    return <Badge variant="outline">{t('settings.devices.offline')}</Badge>;
  }
  const status = hub.statuses[deviceId];
  if (status && isActive(status)) {
    return (
      <Badge className="border-transparent bg-live text-live-foreground">
        {t('settings.devices.liveIn')}
      </Badge>
    );
  }
  return <Badge variant="secondary">{t('settings.devices.online')}</Badge>;
}
