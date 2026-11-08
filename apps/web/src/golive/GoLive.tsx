// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppWindowIcon,
  ArrowLeftIcon,
  BroadcastIcon,
  CheckIcon,
  DesktopIcon,
  DownloadSimpleIcon,
  GlobeIcon,
  EyeClosedIcon,
  EyeIcon,
  MonitorIcon,
  StopIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import type {
  ErrorPayload,
  HelperInfo,
  HelperStatsPayload,
  HelperStatusPayload,
  Preset,
  RoomSettings,
  SourceDescriptor,
  StreamInfo,
} from '@openlive/protocol';
import { cappedTopKbps } from '@openlive/usage';
import { Link } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import { useEffect, useId, useReducer, useState, useSyncExternalStore } from 'react';
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
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { detectDesktopOs } from '../lib/os.ts';
import { TAB_ID } from '../room/connection.ts';
import { browserPublishApi } from './browser-api.ts';
import { defaultBrowserPreset } from './browser-encodings.ts';
import {
  type BrowserLiveState,
  type BrowserStats,
  browserLive,
  canStreamFromBrowser,
  type PublisherSocket,
} from './browser-live.ts';
import { formatBitrate } from '../i18n/format.ts';
import { translateError } from '../i18n/errors.ts';
import { HubError, type HubState, thumbnailKey } from '../hub/connection.ts';
import { useHub } from '../hub/use-hub.ts';
import { helperMayPing, pingsIntent } from '../pointer/intent.ts';
import type { PointerSocket } from '../pointer/socket.ts';
import { useTutorialScreen } from '../tutorial/context.ts';
import {
  type AudioChoice,
  audioChoices,
  audioKey,
  blockerOf,
  browserOffers,
  capturedAppName,
  defaultPreset,
  failureOf,
  goLiveChoice,
  helperFit,
  INITIAL_WIZARD,
  isPortalPicker,
  liveHere,
  offeredPresets,
  PRESETS,
  roomCapKbps,
  showHelperNudge,
  startPayload,
  uploadNeededKbps,
  wizard,
} from './state.ts';
import { BrowserEchoWarning, VoiceEchoWarning } from '../voice/VoiceEchoWarning.tsx';
import { QualitySelects } from './QualitySelects.tsx';

// The room's "Go live" panel and, while one of the user's helpers streams in the room, its live
// controls. Everything goes through the user hub to the helper.

const errorOf = (e: unknown): ErrorPayload =>
  e instanceof HubError ? e.payload : { code: 'internal_error' };

interface RoomContext {
  roomId: string;
  settings: RoomSettings | null;
  canStream: boolean;
}

/** The room's streams and socket, for "Allow visual clicks" (PROTOCOL 7.9). */
export interface PingsContext {
  streams: readonly StreamInfo[];
  selfId: string;
  pointer: PointerSocket;
}

/**
 * What streaming from the browser needs of the room page: the room socket, which the
 * tab announces on, and a way to keep the room's session open while live.
 */
export interface BrowserContext {
  socket: PublisherSocket;
  hold: () => () => void;
}

/** The tab's browser stream, as React state. */
function useBrowserLive(): BrowserLiveState {
  return useSyncExternalStore(browserLive.subscribe, browserLive.getState);
}

/** This user's stream in the room from `deviceId`, as the room knows it. */
const ownStream = (pings: PingsContext | undefined, deviceId: string): StreamInfo | undefined =>
  pings?.streams.find((s) => s.deviceId === deviceId && s.userId === pings.selfId);

/**
 * Whether one of this user's helpers, or this tab's browser stream, streams in the room now (the
 * live controls show).
 */
export function useLiveHere(roomId: string): boolean {
  const { state } = useHub();
  const browser = useBrowserLive();
  const browserHere =
    browser.roomId === roomId && (browser.phase === 'live' || browser.phase === 'starting');
  return browserHere || liveHere(state.statuses, roomId) !== null;
}

/**
 * The room's streaming area: the live controls, or the Go live button and panel. The room page
 * may open the panel from its own button (`open`, `onOpenChange`); then this shows no button.
 */
export function GoLiveArea({
  roomId,
  settings,
  canStream,
  open: controlled,
  onOpenChange,
  pings,
  browser: browserContext,
}: RoomContext & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  pings?: PingsContext;
  browser?: BrowserContext;
}) {
  const { t } = useTranslation();
  const { state, hub } = useHub();
  const browser = useBrowserLive();
  const browserHere = browser.roomId === roomId;
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const live = liveHere(state.statuses, roomId);
  // "Allow visual clicks" chosen in the panel: applied once the stream is in the room, when its
  // helper can draw the clicks; dropped silently otherwise.
  const pointer = pings?.pointer;
  const streams = pings?.streams;
  const selfId = pings?.selfId;
  useEffect(() => {
    if (!pointer || !streams || !selfId) return;
    for (const s of pingsIntent.due(roomId, selfId, streams)) pointer.setPings(s.streamId, true);
  }, [pointer, streams, selfId, roomId]);
  if (browserHere && browser.phase === 'live') {
    return <BrowserLiveControls state={browser} settings={settings} />;
  }
  if (live) {
    return <LiveControls status={live} state={state} settings={settings} hub={hub} pings={pings} />;
  }
  const nudge =
    browserHere &&
    showHelperNudge(browser.phase === 'ended', detectDesktopOs(navigator.userAgent)) ? (
      <HelperNudge onDismiss={() => browserLive.dismiss()} />
    ) : null;
  if (!open) {
    if (controlled !== undefined) return nudge;
    return (
      <div className="flex flex-col gap-4">
        {nudge}
        <div>
          <Button onClick={() => setOpen(true)} data-tour="room-go-live">
            <BroadcastIcon data-icon="inline-start" />
            {t('golive.action')}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <GoLivePanel
      roomId={roomId}
      settings={settings}
      canStream={canStream}
      state={state}
      hub={hub}
      onClose={() => setOpen(false)}
      {...(browserContext ? { browser: browserContext } : {})}
    />
  );
}

type Hub = ReturnType<typeof useHub>['hub'];

export function GoLivePanel({
  roomId,
  settings,
  canStream,
  state,
  hub,
  onClose,
  browser,
}: RoomContext & { state: HubState; hub: Hub; onClose: () => void; browser?: BrowserContext }) {
  const { t } = useTranslation();
  const [w, dispatch] = useReducer(wizard, INITIAL_WIZARD);
  const [allowPings, setAllowPings] = useState(false);
  // "Stream from the browser" chosen: not remembered, the panel starts over each time.
  const [fromBrowser, setFromBrowser] = useState(false);
  const helpers = Object.values(state.helpers);
  const blocker = blockerOf({ canStream, hubOpen: state.status === 'open', helpers });
  const os = detectDesktopOs(navigator.userAgent);
  const choice = goLiveChoice({
    helpers: helpers.length,
    displayMedia: browser !== undefined && canStreamFromBrowser(),
    os,
  });
  const browserMode = fromBrowser && choice.browser && blocker !== 'no_permission';
  const usable = helpers.filter((h) => {
    const fit = helperFit(h, state.statuses[h.deviceId], roomId);
    return fit === 'ready' || fit === 'outdated';
  });

  const chooseHelper = (deviceId: string) => {
    dispatch({ type: 'chooseHelper', deviceId });
    hub
      .request('helper.listSources', { deviceId, thumbnails: true })
      .then((reply) => dispatch({ type: 'sourcesLoaded', sources: reply.sources }))
      .catch((e: unknown) => dispatch({ type: 'failed', error: errorOf(e) }));
  };

  // One helper that can stream: no need to ask which.
  const only = usable.length === 1 && helpers.length === 1 ? usable[0] : undefined;
  useEffect(() => {
    if (!blocker && w.step === 'helper' && only) chooseHelper(only.deviceId);
    // chooseHelper only dispatches and sends; run once per helper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker, w.step, only?.deviceId]);

  // The chosen helper went away.
  const chosenOnline = w.deviceId === null || w.deviceId in state.helpers;
  useEffect(() => {
    if (!chosenOnline && w.step !== 'helper') dispatch({ type: 'back' });
  }, [chosenOnline, w.step]);

  const start = () => {
    const payload = startPayload(w, roomId);
    if (!payload) return;
    dispatch({ type: 'start' });
    const helper = state.helpers[payload.deviceId];
    pingsIntent.set(roomId, payload.deviceId, allowPings && helperMayPing(helper));
    hub
      .request('helper.startStream', payload)
      .then(onClose, (e: unknown) => dispatch({ type: 'failed', error: errorOf(e) }));
  };

  const screen = browserMode ? 'golive-browser' : blocker ? 'golive-blocked' : `golive-${w.step}`;
  useTutorialScreen(
    screen,
    !browserMode &&
      !blocker &&
      w.step !== 'starting' &&
      (w.step !== 'source' || w.sources !== null),
  );
  const browserLink =
    choice.browser && !browserMode && w.step !== 'starting' && blocker !== 'no_permission' ? (
      <div>
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0 text-muted-foreground"
          onClick={() => setFromBrowser(true)}
          data-testid="golive-browser-link"
        >
          <GlobeIcon data-icon="inline-start" />
          {t('golive.browser.link')}
        </Button>
      </div>
    ) : null;

  return (
    <Card data-testid="golive-panel">
      <CardHeader>
        <CardTitle>{t('golive.title')}</CardTitle>
        <CardDescription>{t('golive.description')}</CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('common.close')}>
            <XIcon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {browserMode && browser ? (
          <BrowserStep
            roomId={roomId}
            settings={settings}
            context={browser}
            onBack={() => setFromBrowser(false)}
            onStarted={onClose}
          />
        ) : blocker === 'no_helper' && choice.kind === 'install' ? (
          <InstallView
            download={choice.download}
            browser={choice.browser}
            onBrowser={() => setFromBrowser(true)}
          />
        ) : blocker ? (
          <>
            <BlockerView blocker={blocker} hubStatus={state.status} />
            {browserLink}
          </>
        ) : w.step === 'helper' ? (
          <HelperStep helpers={helpers} state={state} roomId={roomId} onChoose={chooseHelper} />
        ) : w.step === 'source' ? (
          <SourceStep
            deviceId={w.deviceId ?? ''}
            sources={w.sources}
            error={w.error}
            thumbnails={state.thumbnails}
            onChoose={(sourceId) =>
              dispatch({
                type: 'chooseSource',
                sourceId,
                preset: settings ? defaultPreset(settings) : null,
              })
            }
            onBack={() => dispatch({ type: 'back' })}
          />
        ) : (
          <OptionsStep
            settings={settings}
            helper={w.deviceId ? state.helpers[w.deviceId] : undefined}
            sources={w.sources ?? []}
            sourceId={w.sourceId}
            preset={w.preset}
            audio={w.audio}
            error={w.error}
            starting={w.step === 'starting'}
            allowPings={allowPings}
            onAllowPings={setAllowPings}
            onPreset={(preset) => dispatch({ type: 'choosePreset', preset })}
            onAudio={(audio) => dispatch({ type: 'chooseAudio', audio })}
            onBack={() => dispatch({ type: 'back' })}
            onStart={start}
          />
        )}
        {!blocker && !browserMode && browserLink}
      </CardContent>
    </Card>
  );
}

/**
 * No helper online: installing it comes first, with what it gives; the browser is the
 * second choice. On Windows there is no helper to download yet.
 */
function InstallView({
  download,
  browser,
  onBrowser,
}: {
  download: boolean;
  browser: boolean;
  onBrowser: () => void;
}) {
  const { t } = useTranslation();
  const benefits = ['benefitQuality', 'benefitAudio', 'benefitCpu'] as const;
  return (
    <div className="flex flex-col gap-4" data-testid="golive-install">
      <section
        className="flex flex-col gap-3 rounded-xl border p-4"
        aria-labelledby="golive-install-title"
      >
        <h3 id="golive-install-title" className="flex items-center gap-2 text-base font-medium">
          <DesktopIcon className="size-5 text-muted-foreground" aria-hidden />
          {t('golive.browser.install.title')}
        </h3>
        <p className="text-[0.9375rem] text-muted-foreground">{t('golive.browser.install.body')}</p>
        <ul className="flex flex-col gap-1.5 text-[0.9375rem]">
          {benefits.map((b) => (
            <li key={b} className="flex items-start gap-2">
              <CheckIcon className="mt-1 size-4 shrink-0 text-primary" aria-hidden />
              {t(`golive.browser.install.${b}`)}
            </li>
          ))}
        </ul>
        {download ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild>
              <Link to="/download">
                <DownloadSimpleIcon data-icon="inline-start" />
                {t('golive.browser.install.download')}
              </Link>
            </Button>
            <Link to="/settings" className="text-sm underline underline-offset-4">
              {t('golive.browser.install.devices')}
            </Link>
          </div>
        ) : (
          <p
            className="text-[0.9375rem] text-muted-foreground"
            data-testid="golive-no-windows-helper"
          >
            {t('golive.browser.install.windows')}
          </p>
        )}
      </section>
      {browser && (
        <div className="flex flex-col gap-2">
          <div>
            <Button variant="outline" onClick={onBrowser} data-testid="golive-browser-start">
              <GlobeIcon data-icon="inline-start" />
              {t('golive.browser.start')}
            </Button>
          </div>
          <p className="text-[0.8125rem] text-muted-foreground">{t('golive.browser.note')}</p>
        </div>
      )}
    </div>
  );
}

/** The browser's own options: the quality (at most 1080p60), then the browser's picker. */
function BrowserStep({
  roomId,
  settings,
  context,
  onBack,
  onStarted,
}: {
  roomId: string;
  settings: RoomSettings | null;
  context: BrowserContext;
  onBack: () => void;
  onStarted: () => void;
}) {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<Preset | null>(() =>
    settings ? defaultBrowserPreset(settings) : null,
  );
  const [error, setError] = useState<ErrorPayload | null>(null);
  const browser = useBrowserLive();
  const starting = browser.phase === 'starting';
  const offers = settings ? browserOffers(settings) : [];
  const start = () => {
    if (!settings || !preset) return;
    setError(null);
    browserLive
      .start({
        roomId,
        tabId: TAB_ID,
        settings,
        preset,
        socket: context.socket,
        api: browserPublishApi(roomId),
        hold: context.hold,
        labels: {
          monitor: t('golive.browser.label.monitor'),
          window: t('golive.browser.label.window'),
          browser: t('golive.browser.label.browser'),
        },
      })
      .then(() => {
        if (browserLive.getState().phase === 'live') onStarted();
      })
      .catch((e: unknown) => setError(e as ErrorPayload));
  };
  return (
    <section
      className="flex flex-col gap-4"
      aria-labelledby="golive-browser"
      data-testid="golive-browser"
    >
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          disabled={starting}
          aria-label={t('common.back')}
        >
          <ArrowLeftIcon />
        </Button>
        <h3 id="golive-browser" className="eyebrow text-muted-foreground">
          {t('golive.browser.title')}
        </h3>
      </div>
      <p className="text-[0.9375rem] text-muted-foreground">{t('golive.browser.description')}</p>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t('golive.options.preset')}</span>
        <QualitySelects
          labelled
          offers={offers}
          preset={preset}
          onPreset={setPreset}
          disabled={starting}
        />
      </div>
      <Alert>
        <GlobeIcon />
        <AlertDescription>{t('golive.browser.note')}</AlertDescription>
      </Alert>
      {error && <StartError error={error} />}
      <div>
        <Button onClick={start} disabled={starting || !preset} data-testid="golive-browser-go">
          {starting ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <BroadcastIcon data-icon="inline-start" />
          )}
          {starting ? t('golive.browser.starting') : t('golive.options.start')}
        </Button>
      </div>
    </section>
  );
}

/** While this tab streams from the browser: status, stats and controls. */
function BrowserLiveControls({
  state,
  settings,
}: {
  state: BrowserLiveState;
  settings: RoomSettings | null;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const run = (p: Promise<unknown>) => {
    setBusy(true);
    p.catch((e: unknown) => toast.error(translateError(e as ErrorPayload, t))).finally(() =>
      setBusy(false),
    );
  };
  const offers = settings ? browserOffers(settings) : [];
  const paused = state.paused;
  return (
    <Card data-testid="golive-browser-live" data-state={paused ? 'paused' : 'live'}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span
            className={cn('size-2.5 rounded-full', paused ? 'bg-muted-foreground' : 'bg-live')}
            aria-hidden
          />
          {t(paused ? 'golive.state.paused' : 'golive.state.live')}
          <BrowserBadge />
        </CardTitle>
        <CardDescription>
          {t('golive.browser.live.on')} · {t('golive.browser.live.keepOpen')}
          {paused && ` · ${t('golive.live.curtainHint')}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <BrowserEchoWarning systemAudio={state.hasAudio && state.surface === 'monitor'} />
        {!state.hasAudio && (
          <p className="text-[0.8125rem] text-muted-foreground">
            {t('golive.browser.live.noAudio')}
          </p>
        )}
        {state.stats && !paused && <BrowserStatsView stats={state.stats} />}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => run(browserLive.setPaused(!paused))}
          >
            {paused ? (
              <EyeIcon data-icon="inline-start" />
            ) : (
              <EyeClosedIcon data-icon="inline-start" />
            )}
            {paused ? t('golive.live.resume') : t('golive.live.pause')}
          </Button>
          {state.preset && (
            <QualitySelects
              offers={offers}
              preset={state.preset}
              onPreset={(p) => run(browserLive.setPreset(p))}
              disabled={busy || paused}
            />
          )}
          <Button variant="destructive" disabled={busy} onClick={() => run(browserLive.stop())}>
            <StopIcon data-icon="inline-start" />
            {t('golive.live.stop')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function BrowserStatsView({ stats }: { stats: BrowserStats }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const rate = (kbps: number) => formatBitrate(kbps * 1000, locale);
  const reason =
    stats.limitation === 'cpu'
      ? t('golive.browser.live.limitedCpu')
      : stats.limitation === 'bandwidth'
        ? t('golive.browser.live.limitedBandwidth')
        : stats.limitation
          ? t('golive.browser.live.limitedOther', { reason: stats.limitation })
          : null;
  return (
    <div className="flex flex-col gap-2">
      <dl
        className="grid grid-cols-2 gap-x-4 gap-y-1 text-[0.8125rem] sm:grid-cols-4"
        data-testid="golive-browser-stats"
      >
        <dt className="text-muted-foreground">{t('golive.stats.video')}</dt>
        <dd>
          {t('golive.stats.videoValue', {
            width: stats.width,
            height: stats.height,
            fps: Math.round(stats.fps),
          })}
        </dd>
        <dt className="text-muted-foreground">{t('golive.stats.bitrate')}</dt>
        <dd>
          {t('golive.stats.bitrateValue', {
            sent: rate(stats.sentKbps),
            target: rate(stats.targetKbps),
          })}
        </dd>
      </dl>
      {reason && (
        <p className="text-[0.8125rem] text-warning">
          {t('golive.browser.live.limited', { reason })}
        </p>
      )}
    </div>
  );
}

/** "Browser": a stream that a browser tab publishes (StreamInfo.origin, since 1.22). */
function BrowserBadge() {
  const { t } = useTranslation();
  return (
    <Badge variant="outline" title={t('stream.browserHint')}>
      <GlobeIcon aria-hidden />
      {t('stream.browser')}
    </Badge>
  );
}

/** After a browser stream ended: once, dismissible (not on Windows: no helper yet). */
function HelperNudge({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert data-testid="golive-helper-nudge">
      <DesktopIcon />
      <AlertTitle>{t('golive.browser.nudge.title')}</AlertTitle>
      <AlertDescription>
        <p>{t('golive.browser.nudge.body')}</p>
        <p className="flex flex-wrap items-center gap-3">
          <Link to="/download" className="underline underline-offset-4">
            {t('golive.browser.nudge.download')}
          </Link>
          <button type="button" className="underline underline-offset-4" onClick={onDismiss}>
            {t('golive.browser.nudge.dismiss')}
          </button>
        </p>
      </AlertDescription>
    </Alert>
  );
}

function BlockerView({
  blocker,
  hubStatus,
}: {
  blocker: NonNullable<ReturnType<typeof blockerOf>>;
  hubStatus: HubState['status'];
}) {
  const { t } = useTranslation();
  if (blocker === 'no_permission') {
    return (
      <Alert>
        <WarningIcon />
        <AlertTitle>{t('golive.noPermission.title')}</AlertTitle>
        <AlertDescription>{t('golive.noPermission.body')}</AlertDescription>
      </Alert>
    );
  }
  if (blocker === 'hub_down') {
    return hubStatus === 'ended' ? (
      <Alert variant="destructive">
        <WarningIcon />
        <AlertTitle>{t('golive.hubEnded')}</AlertTitle>
      </Alert>
    ) : (
      <p className="flex items-center gap-2 text-[0.9375rem] text-muted-foreground">
        <Spinner aria-hidden />
        {t('golive.connecting')}
      </p>
    );
  }
  return (
    <Alert>
      <DesktopIcon />
      <AlertTitle>{t('golive.offline.title')}</AlertTitle>
      <AlertDescription>
        <p>{t('golive.offline.body')}</p>
        <p className="flex flex-wrap gap-3">
          <Link to="/download" className="underline underline-offset-4">
            {t('golive.offline.download')}
          </Link>
          <Link to="/settings" className="underline underline-offset-4">
            {t('golive.offline.devices')}
          </Link>
        </p>
      </AlertDescription>
    </Alert>
  );
}

function HelperStep({
  helpers,
  state,
  roomId,
  onChoose,
}: {
  helpers: HelperInfo[];
  state: HubState;
  roomId: string;
  onChoose: (deviceId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby="golive-helpers"
      data-tour="golive-helpers"
    >
      <h3 id="golive-helpers" className="eyebrow text-muted-foreground">
        {t('golive.helper.title')}
      </h3>
      <ul className="flex flex-col gap-2">
        {helpers.map((h) => {
          const fit = helperFit(h, state.statuses[h.deviceId], roomId);
          const usable = fit === 'ready' || fit === 'outdated';
          return (
            <li key={h.deviceId}>
              <button
                type="button"
                disabled={!usable}
                onClick={() => onChoose(h.deviceId)}
                className="flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <DesktopIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[0.9375rem]">{h.name}</span>
                  <span className="text-[0.8125rem] text-muted-foreground">
                    {t('settings.devices.system', {
                      os: t(`download.os.${h.os}`),
                      arch: h.arch,
                      version: h.helperVersion,
                    })}
                  </span>
                </span>
                {fit !== 'ready' && (
                  <Badge variant={usable ? 'outline' : 'secondary'}>{t(`golive.fit.${fit}`)}</Badge>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SourceStep({
  deviceId,
  sources,
  error,
  thumbnails,
  onChoose,
  onBack,
}: {
  deviceId: string;
  sources: SourceDescriptor[] | null;
  error: ErrorPayload | null;
  thumbnails: Record<string, string>;
  onChoose: (sourceId: string) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-3" aria-labelledby="golive-sources">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label={t('common.back')}>
          <ArrowLeftIcon />
        </Button>
        <h3 id="golive-sources" className="eyebrow text-muted-foreground">
          {t('golive.source.title')}
        </h3>
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {translateError(error, t)}
        </p>
      ) : sources === null ? (
        <p className="flex items-center gap-2 text-[0.9375rem] text-muted-foreground">
          <Spinner aria-hidden />
          {t('golive.source.loading')}
        </p>
      ) : sources.length === 0 ? (
        <p className="text-[0.9375rem] text-muted-foreground">{t('golive.source.empty')}</p>
      ) : (
        <ul
          className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3"
          data-tour="golive-sources"
        >
          {sources.map((s) => {
            const thumb = thumbnails[thumbnailKey(deviceId, s.sourceId)];
            const Icon = s.kind === 'window' ? AppWindowIcon : MonitorIcon;
            return (
              <li key={s.sourceId}>
                <button
                  type="button"
                  onClick={() => onChoose(s.sourceId)}
                  className="flex w-full flex-col gap-2 rounded-xl border p-2 text-left transition-colors hover:bg-muted"
                >
                  <span className="flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-muted">
                    {thumb ? (
                      <img src={thumb} alt="" className="size-full object-cover" />
                    ) : (
                      <Icon className="size-8 text-muted-foreground" aria-hidden />
                    )}
                  </span>
                  <span className="truncate text-[0.9375rem]">{sourceLabel(s, t)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function sourceLabel(s: SourceDescriptor, t: TFunction): string {
  if (s.sourceId === 'portal:screen') return t('golive.source.portalScreen');
  if (s.sourceId === 'portal:window') return t('golive.source.portalWindow');
  // The portal's earlier choice, shared again without the dialog: the window's caption or the
  // output's name.
  if (s.restored) return t('golive.source.last', { label: s.label });
  return s.appName && s.kind === 'window' ? `${s.appName} · ${s.label}` : s.label;
}

function OptionsStep({
  settings,
  helper,
  sources,
  sourceId,
  preset,
  audio,
  error,
  starting,
  allowPings,
  onAllowPings,
  onPreset,
  onAudio,
  onBack,
  onStart,
}: {
  settings: RoomSettings | null;
  /** The chosen helper: the 120 fps presets need one that knows them. */
  helper: HelperInfo | undefined;
  sources: SourceDescriptor[];
  sourceId: string | null;
  preset: Preset | null;
  audio: AudioChoice;
  error: ErrorPayload | null;
  starting: boolean;
  allowPings: boolean;
  onAllowPings: (allow: boolean) => void;
  onPreset: (p: Preset) => void;
  onAudio: (a: AudioChoice) => void;
  onBack: () => void;
  onStart: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const source = sources.find((s) => s.sourceId === sourceId);
  const choices = audioChoices(sources, sourceId);
  const withAudio = audio.kind !== 'none';
  const capturedName = capturedAppName(sources, sourceId, audio);
  const cap = settings && preset ? roomCapKbps(settings, preset, withAudio) : null;
  const pingsId = useId();
  return (
    <section className="flex flex-col gap-4" aria-labelledby="golive-options">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          disabled={starting}
          aria-label={t('common.back')}
        >
          <ArrowLeftIcon />
        </Button>
        <h3 id="golive-options" className="eyebrow text-muted-foreground">
          {source ? sourceLabel(source, t) : t('golive.options.title')}
        </h3>
      </div>
      {source && isPortalPicker(source.sourceId) && (
        <p className="text-[0.9375rem] text-muted-foreground">{t('golive.source.portalHint')}</p>
      )}
      {source?.restored && (
        <p className="text-[0.9375rem] text-muted-foreground">{t('golive.source.lastHint')}</p>
      )}

      <div className="flex flex-col gap-2" data-tour="golive-preset">
        <span id="golive-preset-label" className="text-sm font-medium">
          {t('golive.options.preset')}
        </span>
        <QualitySelects
          labelled
          offers={settings ? offeredPresets(settings, helper) : []}
          preset={preset}
          onPreset={onPreset}
          disabled={starting}
        />
        {preset && (
          <p className="text-[0.8125rem] text-muted-foreground">
            {t('golive.options.upload', {
              rate: formatBitrate(uploadNeededKbps(preset, withAudio) * 1000, locale),
            })}
            {cap !== null &&
              ` ${t('golive.options.roomCap', { rate: formatBitrate(cap * 1000, locale) })} ${t(
                'golive.options.roomCapTop',
                {
                  rate: formatBitrate(cappedTopKbps(preset, withAudio, cap) * 1000, locale),
                  full: formatBitrate(PRESETS[preset].kbps * 1000, locale),
                },
              )}`}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2" data-tour="golive-audio">
        <span id="golive-audio-label" className="text-sm font-medium">
          {t('golive.options.audio')}
        </span>
        <Select
          value={audioKey(audio)}
          onValueChange={(v) => {
            const next = choices.find((c) => audioKey(c) === v);
            if (next) onAudio(next);
          }}
          disabled={starting}
        >
          <SelectTrigger aria-labelledby="golive-audio-label" className="w-full sm:w-80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectGroup>
              {choices.map((c) => (
                <SelectItem key={audioKey(c)} value={audioKey(c)}>
                  {audioLabel(c, sources, t)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <VoiceEchoWarning captured={capturedName ? { name: capturedName } : null} />

      {helperMayPing(helper) && (
        <Field orientation="horizontal">
          <Switch
            id={pingsId}
            checked={allowPings}
            onCheckedChange={onAllowPings}
            disabled={starting}
            data-testid="golive-pings"
          />
          <FieldContent>
            <FieldLabel htmlFor={pingsId}>{t('pointer.allow')}</FieldLabel>
            <FieldDescription>{t('pointer.allowGoLiveHint')}</FieldDescription>
          </FieldContent>
        </Field>
      )}

      {error && <StartError error={error} />}

      <div>
        <Button onClick={onStart} disabled={starting || !preset} data-tour="golive-start">
          {starting ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <BroadcastIcon data-icon="inline-start" />
          )}
          {starting ? t('golive.options.starting') : t('golive.options.start')}
        </Button>
      </div>
    </section>
  );
}

function audioLabel(c: AudioChoice, sources: SourceDescriptor[], t: TFunction): string {
  if (c.kind === 'none') return t('golive.audio.none');
  if (c.kind === 'source') return t('golive.audio.source');
  const s = sources.find((x) => x.sourceId === c.sourceId);
  return t('golive.audio.app', { app: s?.appName ?? s?.label ?? c.sourceId });
}

/** A failed start: its own message for quota, permission, busy and offline. */
function StartError({ error }: { error: ErrorPayload }) {
  const { t } = useTranslation();
  const kind = failureOf(error);
  return (
    <Alert variant="destructive">
      <WarningIcon />
      <AlertTitle>{t(`golive.failure.${kind}`)}</AlertTitle>
      <AlertDescription>{translateError(error, t)}</AlertDescription>
    </Alert>
  );
}

/** While one of the user's helpers streams in this room: status, stats and controls. */
export function LiveControls({
  status,
  state,
  settings,
  hub,
  pings,
}: {
  status: HelperStatusPayload;
  state: HubState;
  settings: RoomSettings | null;
  hub: Hub;
  pings?: PingsContext | undefined;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const pingsId = useId();
  const { deviceId } = status;
  const helper = state.helpers[deviceId];
  const stats = state.stats[deviceId];
  const paused = status.state === 'paused';
  const settled = status.state === 'live' || status.state === 'paused';
  useTutorialScreen('golive-live', settled);

  const run = (p: Promise<unknown>) => {
    setBusy(true);
    p.catch((e: unknown) => toast.error(translateError(errorOf(e), t))).finally(() =>
      setBusy(false),
    );
  };
  const togglePause = () => run(hub.request('helper.pauseStream', { deviceId, paused: !paused }));
  const setPreset = (preset: Preset) => run(hub.request('helper.setPreset', { deviceId, preset }));
  const stop = () => run(hub.request('helper.stopStream', { deviceId }));
  const stream = ownStream(pings, deviceId);
  const pointer = pings?.pointer;
  useEffect(
    () =>
      pointer?.onRejected((rejection) => {
        if (rejection.kind === 'setPings') {
          toast.error(translateError(rejection.error, t), { id: 'pointer-set-pings' });
        }
      }),
    [pointer, t],
  );

  return (
    <Card data-testid="golive-live" data-state={status.state}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span
            className={cn(
              'size-2.5 rounded-full',
              settled && !paused ? 'bg-live' : 'bg-muted-foreground',
            )}
            aria-hidden
          />
          {t(`golive.state.${status.state}`)}
        </CardTitle>
        <CardDescription>
          {t('golive.live.on', { name: helper?.name ?? deviceId })}
          {paused && ` · ${t('golive.live.curtainHint')}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <VoiceEchoWarning captured={status.stream?.audioApp} />
        {stats && settled && <LiveStats stats={stats} />}
        <div className="flex flex-wrap items-center gap-2" data-tour="golive-controls">
          <Button variant="outline" disabled={!settled || busy} onClick={togglePause}>
            {paused ? (
              <EyeIcon data-icon="inline-start" />
            ) : (
              <EyeClosedIcon data-icon="inline-start" />
            )}
            {paused ? t('golive.live.resume') : t('golive.live.pause')}
          </Button>
          {settings && status.stream && (
            <QualitySelects
              offers={offeredPresets(settings, helper)}
              preset={status.stream.preset}
              onPreset={setPreset}
              disabled={!settled || busy}
            />
          )}
          <Button
            variant="destructive"
            disabled={status.state === 'stopping' || busy}
            onClick={stop}
          >
            <StopIcon data-icon="inline-start" />
            {t('golive.live.stop')}
          </Button>
        </div>
        {stream && pointer && stream.pingOverlay && (
          <Field orientation="horizontal">
            <Switch
              id={pingsId}
              checked={stream.pings === true}
              onCheckedChange={(enabled) => pointer.setPings(stream.streamId, enabled)}
              data-testid="golive-live-pings"
            />
            <FieldContent>
              <FieldLabel htmlFor={pingsId}>{t('pointer.allow')}</FieldLabel>
              <FieldDescription>{t('pointer.allowHint')}</FieldDescription>
            </FieldContent>
          </Field>
        )}
        {stream && !stream.pingOverlay && (
          <p className="text-[0.8125rem] text-muted-foreground">{t('pointer.unsupported')}</p>
        )}
      </CardContent>
    </Card>
  );
}

function LiveStats({ stats }: { stats: HelperStatsPayload }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const rate = (kbps: number) => formatBitrate(kbps * 1000, locale);
  return (
    <dl
      className="grid grid-cols-2 gap-x-4 gap-y-1 text-[0.8125rem] sm:grid-cols-4"
      data-testid="golive-stats"
    >
      <dt className="text-muted-foreground">{t('golive.stats.video')}</dt>
      <dd>
        {t('golive.stats.videoValue', {
          width: stats.width,
          height: stats.height,
          fps: Math.round(stats.fps),
        })}
      </dd>
      <dt className="text-muted-foreground">{t('golive.stats.bitrate')}</dt>
      <dd>
        {t('golive.stats.bitrateValue', {
          sent: rate(stats.sentBitrateKbps),
          target: rate(stats.targetBitrateKbps),
        })}
      </dd>
      <dt className="text-muted-foreground">{t('golive.stats.loss')}</dt>
      <dd>{t('golive.stats.lossValue', { value: stats.packetLossPct.toFixed(1) })}</dd>
      {stats.encoder && (
        <>
          <dt className="text-muted-foreground">{t('golive.stats.encoder')}</dt>
          <dd>{stats.encoder}</dd>
        </>
      )}
      {stats.layers && stats.layers.length > 0 && (
        <>
          <dt className="text-muted-foreground">{t('golive.stats.layers')}</dt>
          <dd className="col-span-1 sm:col-span-3">
            {stats.layers
              .map((l) =>
                t('golive.stats.layer', {
                  rid: l.rid,
                  height: l.height,
                  fps: Math.round(l.fps),
                  rate: rate(l.sentBitrateKbps),
                }),
              )
              .join(' · ')}
          </dd>
        </>
      )}
    </dl>
  );
}
