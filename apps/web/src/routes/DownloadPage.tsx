// SPDX-License-Identifier: AGPL-3.0-only
import {
  AndroidLogoIcon,
  AppleLogoIcon,
  CopyIcon,
  DownloadSimpleIcon,
  LinuxLogoIcon,
  WindowsLogoIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { meQuery } from '../api/auth.ts';
import { type HelperFile, type HelperRelease, helperReleaseQuery } from '../api/helper.ts';
import { Page } from '../components/Page.tsx';
import { QueryError } from '../components/QueryError.tsx';
import { formatDate, formatMB } from '../i18n/format.ts';
import { ANDROID_RELEASES_URL } from '../lib/android-app.ts';
import { DESKTOP_OSES, detectDesktopOs } from '../lib/os.ts';

// The helper download. Linux and macOS are served from the instance's
// private bucket (GET /api/helper/latest, published with `pnpm run helper:publish`). The macOS
// disk image is built and notarized on a Mac. Windows comes later.

/** The encoder notes and `doctor` (helper/README.md, "Encoders"). */
const ENCODER_NOTES = 'https://github.com/henriquefps/openlive/blob/main/helper/README.md#encoders';
const FLATPAK_APP = 'dev.hfps.OpenliveHelper';
/** From the official GitHub release, with the macOS disk image when it has one (packaging/RELEASING.md). */
const PUBLISH_COMMAND = 'pnpm run helper:publish -- --env production --from-release latest';
/** A build from source with a disk image made on a Mac, for a release that has none. */
const MAC_PUBLISH_COMMAND =
  'pnpm run helper:publish -- --env production --mac-dmg dist/openlive-helper-<version>-macos.dmg';

/** The install and pairing commands of each kind of file, for this instance. */
function installSteps(file: HelperFile, instance: string): string[] {
  return file.kind === 'tarball'
    ? [
        `tar xzf ${file.name}`,
        `cd ${file.name.replace(/\.tar\.gz$/, '')}`,
        './install.sh',
        `openlive-helper pair --instance ${instance}`,
      ]
    : [
        `flatpak install --user ${file.name}`,
        `flatpak run ${FLATPAK_APP} pair --instance ${instance}`,
      ];
}

export function DownloadPage() {
  const { t } = useTranslation();
  const current = detectDesktopOs(navigator.userAgent);
  const isAndroid = /Android/i.test(navigator.userAgent);
  const linux = (
    <Card key="linux" data-current={current === 'linux' || undefined}>
      <CardHeader>
        <LinuxLogoIcon className="mb-2 size-6" aria-hidden />
        <CardTitle>
          <h2>{t('download.os.linux')}</h2>
        </CardTitle>
        <CardDescription>{t('download.linux.intro')}</CardDescription>
        {current === 'linux' && (
          <CardAction>
            <Badge>{t('download.yourSystem')}</Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <LinuxRelease />
      </CardContent>
    </Card>
  );
  const macos = (
    <Card key="macos" data-current={current === 'macos' || undefined}>
      <CardHeader>
        <AppleLogoIcon className="mb-2 size-6" aria-hidden />
        <CardTitle>
          <h2>{t('download.os.macos')}</h2>
        </CardTitle>
        <CardDescription>{t('download.macos.intro')}</CardDescription>
        {current === 'macos' && (
          <CardAction>
            <Badge>{t('download.yourSystem')}</Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <MacRelease />
      </CardContent>
    </Card>
  );
  return (
    <Page title={t('download.title')} description={t('download.intro')}>
      <div className="flex flex-col gap-4">
        {current === 'macos' ? [macos, linux] : [linux, macos]}
        <Card id="android" data-current={isAndroid || undefined}>
          <CardHeader>
            <AndroidLogoIcon className="mb-2 size-6" aria-hidden />
            <CardTitle>
              <h2>{t('download.android.title')}</h2>
            </CardTitle>
            <CardDescription>{t('download.android.intro')}</CardDescription>
            {isAndroid && (
              <CardAction>
                <Badge>{t('download.yourSystem')}</Badge>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div>
              <Button asChild>
                <a href={ANDROID_RELEASES_URL} target="_blank" rel="noreferrer">
                  <DownloadSimpleIcon data-icon="inline-start" />
                  {t('download.android.action')}
                </a>
              </Button>
            </div>
            <p className="text-[0.8125rem] text-muted-foreground">
              {t('download.android.install')}
            </p>
          </CardContent>
        </Card>
        <ul className="grid gap-4 md:grid-cols-2">
          {DESKTOP_OSES.filter((os) => os === 'windows').map((os) => (
            <li key={os} className="flex flex-col *:flex-1">
              <Card data-current={os === current || undefined}>
                <CardHeader>
                  <WindowsLogoIcon className="mb-2 size-6" aria-hidden />
                  <CardTitle>
                    <h2>{t(`download.os.${os}`)}</h2>
                  </CardTitle>
                  <CardDescription>{t('download.comingLater')}</CardDescription>
                  {os === current && (
                    <CardAction>
                      <Badge>{t('download.yourSystem')}</Badge>
                    </CardAction>
                  )}
                </CardHeader>
              </Card>
            </li>
          ))}
        </ul>
      </div>
    </Page>
  );
}

/**
 * The macOS disk image of the release. Signed out, outside a space or on a failed load the Linux
 * card already says why, so this one stays quiet.
 */
function MacRelease() {
  const { t } = useTranslation();
  const me = useQuery(meQuery);
  const latest = useQuery(helperReleaseQuery);
  if (latest.isPending) return <Skeleton className="h-24 w-full" />;
  if (latest.isError) return null;
  const state = latest.data;
  if (state.kind === 'signedOut' || state.kind === 'noSpace') return null;
  const dmg = state.kind === 'release' && state.release.files.find((f) => f.kind === 'dmg');
  if (dmg) return <MacImage file={dmg} />;
  return me.data?.user.isPlatformAdmin ? (
    <Alert>
      <AlertTitle>{t('download.macos.unpublished')}</AlertTitle>
      <AlertDescription>
        <p>{t('download.macos.adminHint')}</p>
        <code className="font-mono break-all">{MAC_PUBLISH_COMMAND}</code>
      </AlertDescription>
    </Alert>
  ) : (
    <p className="text-muted-foreground">{t('download.macos.unpublishedMember')}</p>
  );
}

function MacImage({ file }: { file: HelperFile }) {
  const { t } = useTranslation();
  const instance = window.location.origin;
  const title = t('download.macos.dmg.title');
  return (
    <section
      aria-label={title}
      className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
      data-kind={file.kind}
    >
      <h3 className="font-medium">{title}</h3>
      <p className="text-muted-foreground">{t('download.macos.dmg.description')}</p>
      <FileDownload file={file} />
      <div className="flex flex-col gap-1">
        <h4 className="text-[0.8125rem] font-medium">{t('download.linux.install')}</h4>
        <ol className="list-decimal space-y-1 ps-5 text-[0.8125rem]">
          <li>{t('download.macos.steps.open', { name: file.name })}</li>
          <li>{t('download.macos.steps.launch')}</li>
          <li>
            {t('download.macos.steps.pair')}{' '}
            <code className="font-mono break-all select-all">{instance}</code>
          </li>
          <li>{t('download.macos.steps.screen')}</li>
          <li>{t('download.macos.steps.goLive')}</li>
        </ol>
      </div>
    </section>
  );
}

function LinuxRelease() {
  const { t } = useTranslation();
  const location = useLocation();
  const me = useQuery(meQuery);
  const latest = useQuery(helperReleaseQuery);
  if (latest.isPending) return <Skeleton className="h-40 w-full" />;
  if (latest.isError) {
    return <QueryError error={latest.error} onRetry={() => void latest.refetch()} />;
  }
  const state = latest.data;
  switch (state.kind) {
    case 'release':
      return <ReleaseDetails release={state.release} />;
    case 'signedOut':
      return (
        <div className="flex flex-col items-start gap-3">
          <p className="text-muted-foreground">{t('download.linux.signedOut')}</p>
          <Button asChild>
            <Link to="/" search={{ returnTo: location.href }}>
              {t('auth.signIn')}
            </Link>
          </Button>
        </div>
      );
    case 'noSpace':
      return <p className="text-muted-foreground">{t('download.linux.noSpace')}</p>;
    case 'unpublished':
      return me.data?.user.isPlatformAdmin ? (
        <Alert>
          <AlertTitle>{t('download.linux.unpublished')}</AlertTitle>
          <AlertDescription>
            <p>{t('download.linux.adminHint')}</p>
            <code className="font-mono">{PUBLISH_COMMAND}</code>
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-muted-foreground">{t('download.linux.unpublishedMember')}</p>
      );
  }
}

function ReleaseDetails({ release }: { release: HelperRelease }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const instance = window.location.origin;
  const tarball = release.files.find((f) => f.kind === 'tarball');
  const flatpak = release.files.find((f) => f.kind === 'flatpak');
  return (
    <div className="flex flex-col gap-4">
      <p>
        {t('download.linux.version', {
          version: release.version,
          date: formatDate(new Date(release.publishedAt), locale),
        })}
        {release.releaseNotesUrl && (
          <>
            {' · '}
            <a className="underline underline-offset-4" href={release.releaseNotesUrl}>
              {t('download.linux.releaseNotes')}
            </a>
          </>
        )}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {tarball && (
          <Variant
            file={tarball}
            title={t('download.linux.tarball.title')}
            badge={t('download.linux.tarball.recommended')}
            description={t('download.linux.tarball.description')}
            steps={installSteps(tarball, instance)}
          />
        )}
        {flatpak && (
          <Variant
            file={flatpak}
            title={t('download.linux.flatpak.title')}
            description={t('download.linux.flatpak.description')}
            steps={installSteps(flatpak, instance)}
          />
        )}
      </div>
      <p className="text-muted-foreground">
        {t('download.linux.doctor')}{' '}
        <a className="underline underline-offset-4" href={ENCODER_NOTES}>
          {t('download.linux.encoderNotes')}
        </a>
      </p>
    </div>
  );
}

function Variant({
  file,
  title,
  badge,
  description,
  steps,
}: {
  file: HelperFile;
  title: string;
  badge?: string;
  description: string;
  steps: string[];
}) {
  const { t } = useTranslation();
  const copy = useCopy();
  const commands = steps.join('\n');
  return (
    <section
      aria-label={title}
      className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
      data-kind={file.kind}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{title}</h3>
        {badge && <Badge variant="secondary">{badge}</Badge>}
      </div>
      <p className="text-muted-foreground">{description}</p>
      <FileDownload file={file} />
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[0.8125rem] font-medium">{t('download.linux.install')}</h4>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('download.copyCommands', { name: title })}
            title={t('download.copyCommands', { name: title })}
            onClick={() => void copy(commands, t('download.copied'))}
          >
            <CopyIcon />
          </Button>
        </div>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-[0.8125rem]">
          {commands}
        </pre>
      </div>
    </section>
  );
}

function useCopy() {
  const { t } = useTranslation();
  return async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(done);
    } catch {
      toast.error(t('download.copyFailed'));
    }
  };
}

/** The download button, the file's name and size, and its SHA-256 to copy. */
function FileDownload({ file }: { file: HelperFile }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const copy = useCopy();
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild>
          <a href={file.url} download={file.name}>
            <DownloadSimpleIcon data-icon="inline-start" />
            {t('download.action')}
          </a>
        </Button>
        <span className="text-[0.8125rem] text-muted-foreground">
          {file.name} · {formatMB(file.size, locale)}
        </span>
      </div>
      <div className="flex items-start gap-1">
        <p className="min-w-0 flex-1 text-[0.8125rem]">
          <span className="text-muted-foreground">{t('download.sha256')} </span>
          <span className="font-mono break-all select-all">{file.sha256}</span>
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('download.copySha', { name: file.name })}
          title={t('download.copySha', { name: file.name })}
          onClick={() => void copy(file.sha256, t('download.copied'))}
        >
          <CopyIcon />
        </Button>
      </div>
    </>
  );
}
