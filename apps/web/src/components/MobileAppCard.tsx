// SPDX-License-Identifier: AGPL-3.0-only
import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** Light modules around the code, as the QR specification asks. */
const QUIET_ZONE = 4;

/**
 * Settings > Use the mobile app: this instance's address and its QR code, which the app scans on
 * its first screen. Drawn here, from the address alone.
 */
export function MobileAppCard() {
  const { t } = useTranslation();
  const origin = window.location.origin;
  const qr = useMemo(() => qrPath(origin), [origin]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.mobileApp.title')}</CardTitle>
        <CardDescription>{t('settings.mobileApp.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <svg
          viewBox={`0 0 ${qr.size} ${qr.size}`}
          className="size-40 shrink-0 rounded-md"
          role="img"
          aria-label={t('settings.mobileApp.qrLabel', { address: origin })}
          shapeRendering="crispEdges"
        >
          {/* Always dark on white: scanners need the contrast whatever the theme. */}
          <rect width={qr.size} height={qr.size} fill="#fff" />
          <path d={qr.path} fill="#000" />
        </svg>
        <p className="text-[0.9375rem]">
          {t('settings.mobileApp.address')} <span className="font-mono break-all">{origin}</span>
        </p>
      </CardContent>
    </Card>
  );
}

/** One square per dark module, as an SVG path, plus the side of the whole code. */
function qrPath(text: string): { path: string; size: number } {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  const count = code.getModuleCount();
  let path = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (code.isDark(row, col)) path += `M${col + QUIET_ZONE},${row + QUIET_ZONE}h1v1h-1z`;
    }
  }
  return { path, size: count + QUIET_ZONE * 2 };
}
