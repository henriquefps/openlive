// SPDX-License-Identifier: AGPL-3.0-only
import {
  ArrowsInIcon,
  ArrowsOutIcon,
  ChartBarIcon,
  CursorClickIcon,
  GearSixIcon,
  PictureInPictureIcon,
  RectangleIcon,
  SpeakerHighIcon,
  SpeakerLowIcon,
  SpeakerSlashIcon,
  SpeakerXIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import type { PauseReason, PointerStyle, StreamEndReason } from '@openlive/protocol';
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useId,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { elementPercent, framePoint } from '../pointer/geometry.ts';
import { PingIndicator } from '../pointer/PingIndicator.tsx';
import { pointerStyle } from '../pointer/style.ts';
import type { WatchAccess } from '../room/connection.ts';
import { useDisplayCadence } from './display.ts';
import {
  type Quality,
  useFullscreen,
  usePlaybackLoop,
  useSourceSnapshot,
  useTrackMuted,
  useWakeLock,
} from './hooks.ts';
import { type ScreenInput, screenFor, VIDEO_SCREENS } from './screens.ts';
import type { Layer, PlayerSource, Rid } from './source.ts';
import { StateScreen } from './StateScreen.tsx';
import { StatsOverlay } from './StatsOverlay.tsx';
import { useViewerMetrics, type WatchStart } from './metrics.ts';
import { watchStartOf } from './ttff.ts';
import { streamDucking } from '../voice/ducking.ts';
import { loadVolume, saveVolume, stepVolume, type VolumeSetting } from './volume.ts';

export interface PlayerProps {
  /** The pulled media: video plus, when the streamer shares app audio, audio. */
  stream: MediaStream | null;
  source: PlayerSource | null;
  /** What the room knows; the player adds what the media says (screens.ts). */
  room: ScreenInput['room'];
  streamInfo: ScreenInput['stream'];
  endedReason: StreamEndReason | null;
  access: WatchAccess | null;
  streamer: { userId: string; name: string };
  hasAudio: boolean;
  viewers: { used: number; limit: number; queueLength: number } | null;
  theater: boolean;
  onTheaterChange: (theater: boolean) => void;
  onJoinQueue: () => void;
  onLeaveQueue: () => void;
  onAccept: () => void;
  /** Ask for the slot again (after a refused request); the source's retry runs as well. */
  onRetry: () => void;
  /** Shown on dead-end screens (ended, no permission...), e.g. a "back to the room" button. */
  exit?: ReactNode;
  /** Where playback metrics go (player/metrics.ts); none are sent without it. */
  metrics?: { roomId: string; start: WatchStart } | null;
  /**
   * Visual clicks (PROTOCOL 7.9), while the streamer allows them on this stream: `onPing` sends
   * one (x and y 0..1 over the frame) and says whether it went out (false: rate limit).
   */
  pointer?: { onPing: (x: number, y: number, style: PointerStyle) => boolean } | null;
}

const HIDE_CONTROLS_MS = 3_000;
/** How long the viewer's own click shows on the player, as long as the helper draws it. */
export const PING_SHOW_MS = 2_000;
/** Arrow keys move the keyboard click target by this much of the frame (Shift: a fifth). */
const PING_KEY_STEP = 0.05;

interface PingMark {
  id: number;
  left: number;
  top: number;
  style: PointerStyle;
}

/**
 * The watch view's video: always black, controls in a dark overlay, a screen
 * of its own for every state. Transport-agnostic: it plays `stream` and talks to `source`.
 */
export default function Player(props: PlayerProps) {
  const { stream, source, streamer, hasAudio, theater, onTheaterChange } = props;
  const { t } = useTranslation();
  const keyHintId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const snapshot = useSourceSnapshot(source);
  const trackMuted = useTrackMuted(stream);
  const [firstFrame, setFirstFrame] = useState(false);
  const [quality, setQuality] = useState<Quality>('auto');
  const [statsOpen, setStatsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [controlsShown, setControlsShown] = useState(true);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  // The browser let this stream play with sound: an unmuted play() resolved while it had an
  // audio track, or the viewer unmuted it with a tap.
  const soundAllowed = useRef(false);
  const [pip, setPip] = useState(false);
  const [volume, setVolumeState] = useState<VolumeSetting>(() => loadVolume(streamer.userId));
  const [announcement, setAnnouncement] = useState('');
  // Click → first presented frame (ttff.ts); the player's mount when nothing marked a click.
  const [watchStart] = useState(
    () => watchStartOf(props.streamInfo?.streamId ?? '') ?? performance.now(),
  );
  const [ttffMs, setTtffMs] = useState<number | null>(null);
  // Click mode (PROTOCOL 7.9): a click or tap on the frame shows on the streamer's screen.
  const [clickMode, setClickMode] = useState(false);
  const [marks, setMarks] = useState<PingMark[]>([]);
  /** The keyboard's click target, 0..1 over the frame; shown once an arrow key moved it. */
  const [keyTarget, setKeyTarget] = useState<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const markSeq = useRef(0);
  const markTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const clickLayerRef = useRef<HTMLDivElement>(null);
  const clickButtonRef = useRef<HTMLButtonElement>(null);
  const style = useSyncExternalStore(pointerStyle.subscribe, pointerStyle.get);
  const {
    fullscreen,
    toggle: toggleFullscreen,
    supported: fullscreenSupported,
  } = useFullscreen(rootRef, videoRef);

  // A new connect or retry must show a frame again before the player says "live".
  const [epoch, setEpoch] = useState({ kind: snapshot.state.kind, source });
  if (epoch.kind !== snapshot.state.kind || epoch.source !== source) {
    setEpoch({ kind: snapshot.state.kind, source });
    if (snapshot.state.kind !== 'live') setFirstFrame(false);
  }

  const streamPaused = props.streamInfo?.paused ?? false;
  const active =
    snapshot.state.kind === 'live' && !streamPaused && !trackMuted && props.room.status === 'open';
  const economy = props.streamInfo?.qualityCap !== undefined;
  const { sample, unstable } = usePlaybackLoop({ source, quality, active, economy });
  const display = useDisplayCadence(videoRef, statsOpen);
  const metricsStreamId = props.streamInfo?.streamId ?? null;
  useViewerMetrics({
    target:
      props.metrics && metricsStreamId !== null && source
        ? { ...props.metrics, streamId: metricsStreamId }
        : null,
    sample,
    state: source ? snapshot.state : null,
    live: active,
    layer: snapshot.layer,
    ttffMs,
    video: videoRef,
  });

  const kind = screenFor({
    room: props.room,
    stream: props.streamInfo,
    endedReason: props.endedReason,
    access: props.access,
    source: source ? snapshot.state : null,
    trackMuted,
    firstFrame,
    unstable,
  });
  const playing = VIDEO_SCREENS.has(kind);
  useWakeLock(playing && !pip);

  // Click mode ends when pings go away (turned off, paused, not playing).
  const pointer = playing ? (props.pointer ?? null) : null;
  if (clickMode && !pointer) {
    setClickMode(false);
    setKeyTarget(null);
  }
  useEffect(() => {
    const timers = markTimers.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  useEffect(() => {
    if (clickMode) clickLayerRef.current?.focus({ preventScroll: true });
  }, [clickMode]);

  const leaveClickMode = () => {
    setClickMode(false);
    setKeyTarget(null);
    clickButtonRef.current?.focus({ preventScroll: true });
  };

  /** Sends a ping at a frame point and shows it here at once. */
  const ping = (point: { x: number; y: number }) => {
    const video = videoRef.current;
    if (!pointer || !video) return;
    if (!pointer.onPing(point.x, point.y, style)) return;
    const box = video.getBoundingClientRect();
    const at = elementPercent(point, box, video.videoWidth, video.videoHeight);
    const id = ++markSeq.current;
    setMarks((list) => [...list, { id, ...at, style }]);
    const timer = setTimeout(() => {
      markTimers.current.delete(timer);
      setMarks((list) => list.filter((m) => m.id !== id));
    }, PING_SHOW_MS);
    markTimers.current.add(timer);
  };

  const onFrameClick = (event: MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const box = video.getBoundingClientRect();
    setKeyTarget(null);
    // Clicks on the black bars are not on the streamer's screen.
    const point = framePoint(
      event.clientX - box.left,
      event.clientY - box.top,
      box,
      video.videoWidth,
      video.videoHeight,
    );
    if (point) ping(point);
  };

  const onClickLayerKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? PING_KEY_STEP / 5 : PING_KEY_STEP;
    const from = keyTarget ?? { x: 0.5, y: 0.5 };
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const moveTo = (point: { x: number; y: number }) => {
      const video = videoRef.current;
      if (!video) return;
      const at = elementPercent(
        point,
        video.getBoundingClientRect(),
        video.videoWidth,
        video.videoHeight,
      );
      setKeyTarget({ ...point, ...at });
    };
    switch (event.key) {
      case 'ArrowLeft':
        moveTo({ x: clamp(from.x - step), y: from.y });
        break;
      case 'ArrowRight':
        moveTo({ x: clamp(from.x + step), y: from.y });
        break;
      case 'ArrowUp':
        moveTo({ x: from.x, y: clamp(from.y - step) });
        break;
      case 'ArrowDown':
        moveTo({ x: from.x, y: clamp(from.y + step) });
        break;
      case 'Enter':
      case ' ':
        moveTo(from);
        ping({ x: from.x, y: from.y });
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  // Media element wiring: the stream, autoplay with sound when allowed, the first frame.
  //
  // The tracks join the stream after play() (rtc/source.ts adds them once the subscription is
  // up). WebKit, the engine of every iOS browser, lets an unmuted element play while its stream
  // has no audio track and then *pauses* it, rejecting nothing, when the audio track arrives
  // without a gesture: the video stopped on its first frame on an iPhone for every stream with
  // sound (a window with its app's audio), while silent ones (a monitor) played. So playback
  // starts again on every track change, and an unmuted element that pauses before sound was
  // allowed falls back to muted with "tap to unmute", as a refused play() does.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    if (!stream) return;
    soundAllowed.current = false;
    let stopped = false;
    const blocked = () => {
      if (stopped) return;
      setAutoplayBlocked(true);
      video.muted = true;
      void video.play().catch(() => undefined);
    };
    const start = () => {
      const audible = !video.muted && stream.getAudioTracks().length > 0;
      video.play().then(
        () => {
          if (audible && !video.muted) soundAllowed.current = true;
        },
        (error: unknown) => {
          // Autoplay with sound refused (no gesture yet, typical on phones).
          if (error instanceof DOMException && error.name === 'NotAllowedError') blocked();
        },
      );
    };
    const paused = () => {
      if (!soundAllowed.current && !video.muted && !video.ended) blocked();
    };
    video.muted = false;
    start();
    stream.addEventListener('addtrack', start);
    video.addEventListener('pause', paused);
    return () => {
      stopped = true;
      stream.removeEventListener('addtrack', start);
      video.removeEventListener('pause', paused);
    };
  }, [stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || firstFrame || !stream) return;
    let cancelled = false;
    const done = (now: number = performance.now()) => {
      if (cancelled) return;
      setFirstFrame(true);
      setTtffMs((measured) => measured ?? Math.max(0, Math.round(now - watchStart)));
    };
    // Older Firefox has no requestVideoFrameCallback: `playing` is close enough there.
    if (typeof video.requestVideoFrameCallback === 'function') {
      const handle = video.requestVideoFrameCallback((now) => done(now));
      return () => {
        cancelled = true;
        video.cancelVideoFrameCallback(handle);
      };
    }
    const element: HTMLVideoElement = video;
    const playing = () => done();
    element.addEventListener('playing', playing, { once: true });
    return () => {
      cancelled = true;
      element.removeEventListener('playing', playing);
    };
  }, [firstFrame, stream, epoch, watchStart]);

  const effectiveMuted = volume.muted || autoplayBlocked || !hasAudio;
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = effectiveMuted;
    // Quieter while someone speaks in voice (voice/ducking.ts): set on the element as the ramp
    // goes, without a render.
    const apply = () => {
      video.volume = volume.volume * streamDucking.gain();
    };
    apply();
    return streamDucking.subscribe(apply);
  }, [volume.volume, effectiveMuted]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const enter = () => setPip(true);
    const leave = () => setPip(false);
    video.addEventListener('enterpictureinpicture', enter);
    video.addEventListener('leavepictureinpicture', leave);
    return () => {
      video.removeEventListener('enterpictureinpicture', enter);
      video.removeEventListener('leavepictureinpicture', leave);
    };
  }, []);

  const setVolume = useCallback(
    (next: VolumeSetting) => {
      setVolumeState(next);
      saveVolume(streamer.userId, next);
      setAnnouncement(
        next.muted
          ? t('player.muted')
          : t('player.volumeAt', { percent: Math.round(next.volume * 100) }),
      );
    },
    [streamer.userId, t],
  );

  const unmuteFromTap = () => {
    soundAllowed.current = true;
    setAutoplayBlocked(false);
    const next = { ...volume, muted: false };
    setVolume(next);
    const video = videoRef.current;
    if (video) {
      video.muted = !hasAudio;
      void video.play().catch(() => undefined);
    }
  };

  const toggleMute = () => {
    if (!hasAudio) return;
    if (autoplayBlocked) {
      unmuteFromTap();
      return;
    }
    if (volume.muted) soundAllowed.current = true;
    setVolume({ ...volume, muted: !volume.muted });
  };

  const togglePip = () => {
    const video = videoRef.current;
    if (!video) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture();
    else void video.requestPictureInPicture().catch(() => undefined);
  };
  const pipSupported = typeof document !== 'undefined' && document.pictureInPictureEnabled === true;

  // Controls fade out while playing and idle; any pointer move, tap or focus brings them back.
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reveal = useCallback(() => {
    setControlsShown(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsShown(false), HIDE_CONTROLS_MS);
  }, []);
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );
  const controlsVisible = controlsShown || menuOpen || !playing;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    const onSlider = target.closest('[role="slider"]') !== null;
    const inMenu = target.closest('[role="menu"]') !== null;
    if (inMenu) return;
    switch (event.key) {
      case 'Escape':
        if (!clickMode) return;
        leaveClickMode();
        break;
      case 'p':
      case 'P':
        if (!pointer) return;
        if (clickMode) leaveClickMode();
        else setClickMode(true);
        break;
      case 'm':
      case 'M':
        toggleMute();
        break;
      case 'ArrowUp':
      case 'ArrowDown':
        if (onSlider || !hasAudio) return;
        setVolume(stepVolume(volume, event.key === 'ArrowUp' ? 1 : -1));
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      case 't':
      case 'T':
        onTheaterChange(!theater);
        break;
      case 'i':
      case 'I':
        setStatsOpen((open) => !open);
        break;
      default:
        return;
    }
    event.preventDefault();
    reveal();
  };

  const layerLabel = (layer: Layer | undefined): string =>
    layer ? t('stream.resolution', { height: layer.height, fps: layer.fps }) : '';
  const layers = source?.layers ?? [];
  const current = layers.find((l) => l.rid === snapshot.layer);
  const VolumeIcon = !hasAudio
    ? SpeakerSlashIcon
    : effectiveMuted
      ? SpeakerXIcon
      : volume.volume < 0.5
        ? SpeakerLowIcon
        : SpeakerHighIcon;

  return (
    <div
      ref={(element) => {
        rootRef.current = element;
        setContainer(element);
      }}
      tabIndex={0}
      role="region"
      aria-label={t('player.label', { name: streamer.name })}
      aria-keyshortcuts={pointer ? 'M ArrowUp ArrowDown F T I P' : 'M ArrowUp ArrowDown F T I'}
      data-screen={kind}
      data-ttff-ms={ttffMs ?? undefined}
      data-fullscreen={fullscreen || undefined}
      onKeyDown={onKeyDown}
      onPointerMove={reveal}
      onPointerDown={reveal}
      onFocus={reveal}
      className={cn(
        // `dark` scopes the dark tokens: the video area is black in both themes.
        'dark group/player relative isolate w-full overflow-hidden bg-player text-player-foreground outline-none select-none',
        'focus-visible:ring-3 focus-visible:ring-ring/50',
        fullscreen ? 'h-full' : 'aspect-video rounded-xl',
        // A state screen (queue offer, ended...) needs more room than 16:9 gives on a phone.
        !playing && !fullscreen && 'min-h-80',
        theater && !fullscreen && 'max-h-[calc(100dvh-8rem)]',
        playing && !controlsVisible && 'cursor-none',
      )}
    >
      <video
        ref={videoRef}
        className="size-full object-contain"
        playsInline
        autoPlay
        muted
        disablePictureInPicture={!pipSupported}
        aria-hidden
      />

      {clickMode && pointer && (
        <div
          ref={clickLayerRef}
          tabIndex={0}
          role="application"
          aria-label={t('pointer.layer', { name: streamer.name })}
          aria-describedby={keyHintId}
          data-testid="player-click-layer"
          className="absolute inset-0 cursor-crosshair outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
          onClick={onFrameClick}
          onKeyDown={onClickLayerKey}
        />
      )}
      {(marks.length > 0 || (clickMode && keyTarget)) && (
        <div
          className="pointer-events-none absolute inset-0 overflow-hidden"
          data-slot="ping-marks"
        >
          {marks.map((m) => (
            <PingIndicator
              key={m.id}
              style={m.style}
              name={t('pointer.you')}
              position={{ left: m.left, top: m.top }}
            />
          ))}
          {clickMode && keyTarget && (
            <span
              aria-hidden
              data-testid="player-key-target"
              className="absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed border-white/90 shadow-[0_0_0_1px_rgb(0_0_0/0.6)]"
              style={{ left: `${keyTarget.left}%`, top: `${keyTarget.top}%` }}
            />
          )}
        </div>
      )}

      {!playing && (
        <StateScreen
          kind={kind as Exclude<typeof kind, 'live' | 'unstable'>}
          streamerName={streamer.name}
          pauseReason={(props.streamInfo?.pauseReason as PauseReason | undefined) ?? null}
          endedReason={props.endedReason}
          access={props.access}
          viewers={props.viewers}
          onRetry={() => {
            props.onRetry();
            source?.retry();
          }}
          onJoinQueue={props.onJoinQueue}
          onLeaveQueue={props.onLeaveQueue}
          onAccept={props.onAccept}
          exit={props.exit}
        />
      )}

      {playing && (
        <div className="pointer-events-none absolute top-2 left-2 flex flex-wrap gap-1.5 sm:top-3 sm:left-3">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md bg-player/70 px-2 py-0.5 text-xs font-medium transition-opacity',
              controlsVisible ? 'opacity-100' : 'opacity-0',
            )}
          >
            <span aria-hidden className="size-1.5 rounded-full bg-live" />
            {t('stream.status.live')}
          </span>
          {kind === 'unstable' && (
            <span
              role="status"
              className="inline-flex items-center gap-1.5 rounded-md bg-player/70 px-2 py-0.5 text-xs font-medium"
            >
              <WarningIcon aria-hidden className="text-warning" />
              {t('player.unstable')}
            </span>
          )}
        </div>
      )}

      {clickMode && pointer && (
        <div
          className={cn(
            'pointer-events-none absolute left-1/2 flex max-w-[calc(100%-1rem)] -translate-x-1/2 flex-col items-center gap-0.5 rounded-md bg-player/80 px-3 py-1.5 text-center shadow-md',
            autoplayBlocked && hasAudio ? 'top-14 sm:top-16' : 'top-2 sm:top-3',
          )}
          role="status"
          data-testid="player-click-banner"
        >
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <CursorClickIcon aria-hidden />
            {t('pointer.banner', { name: streamer.name })}
          </span>
          <span id={keyHintId} className="hidden text-xs text-player-foreground/75 sm:block">
            {t('pointer.keyHint')}
          </span>
        </div>
      )}

      {playing && autoplayBlocked && hasAudio && (
        <Button
          variant="secondary"
          className="absolute top-2 left-1/2 -translate-x-1/2 shadow-md sm:top-3"
          onClick={unmuteFromTap}
        >
          <SpeakerXIcon data-icon="inline-start" />
          {t('player.tapToUnmute')}
        </Button>
      )}

      {statsOpen && (
        <StatsOverlay
          sample={sample}
          layer={current}
          quality={quality}
          ttffMs={ttffMs}
          display={display}
          onClose={() => setStatsOpen(false)}
        />
      )}

      <div
        className={cn(
          'absolute inset-x-0 bottom-0 flex items-center gap-1 bg-linear-to-t from-player/90 via-player/60 to-transparent px-2 pt-8 pb-2 transition-opacity sm:gap-2 sm:px-3',
          controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        data-slot="player-controls"
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleMute}
          disabled={!hasAudio}
          aria-label={
            !hasAudio ? t('player.noAudio') : effectiveMuted ? t('player.unmute') : t('player.mute')
          }
          aria-keyshortcuts="M"
          title={!hasAudio ? t('player.noAudioHint') : undefined}
        >
          <VolumeIcon />
        </Button>
        {hasAudio ? (
          <Slider
            className="hidden w-24 sm:flex"
            min={0}
            max={100}
            step={5}
            value={[effectiveMuted ? 0 : Math.round(volume.volume * 100)]}
            onValueChange={([value = 0]) => {
              setAutoplayBlocked(false);
              setVolume({ volume: value / 100, muted: value === 0 });
            }}
            aria-label={t('player.volume')}
          />
        ) : (
          <span className="text-xs text-player-foreground/75" title={t('player.noAudioHint')}>
            {t('player.noAudio')}
          </span>
        )}
        <span role="status" className="sr-only">
          {announcement}
        </span>

        <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
          {pointer && (
            <Button
              ref={clickButtonRef}
              variant="ghost"
              size="icon"
              onClick={() => (clickMode ? leaveClickMode() : setClickMode(true))}
              aria-pressed={clickMode}
              aria-label={clickMode ? t('pointer.leave') : t('pointer.enter')}
              aria-keyshortcuts="P"
              title={clickMode ? t('pointer.leave') : t('pointer.enter')}
              data-testid="player-click-mode"
            >
              <CursorClickIcon />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setStatsOpen((open) => !open)}
            aria-pressed={statsOpen}
            aria-label={t('player.stats.toggle')}
            aria-keyshortcuts="I"
          >
            <ChartBarIcon />
          </Button>
          {layers.length > 1 && (
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('player.quality.label')}>
                  <GearSixIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                container={container}
                align="end"
                side="top"
                className="dark w-56"
              >
                <DropdownMenuLabel>{t('player.quality.label')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={quality}
                  onValueChange={(value) => setQuality(value as Quality)}
                >
                  <DropdownMenuRadioItem value="auto">
                    {quality === 'auto' && current
                      ? t('player.quality.autoAt', { layer: layerLabel(current) })
                      : t('player.quality.auto')}
                  </DropdownMenuRadioItem>
                  {layers.map((layer) => (
                    <DropdownMenuRadioItem key={layer.rid} value={layer.rid as Rid}>
                      {layerLabel(layer)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {pipSupported && (
            <Button
              variant="ghost"
              size="icon"
              onClick={togglePip}
              aria-pressed={pip}
              aria-label={t('player.pip')}
            >
              <PictureInPictureIcon />
            </Button>
          )}
          {!fullscreen && (
            <Button
              variant="ghost"
              size="icon"
              className="hidden md:inline-flex"
              onClick={() => onTheaterChange(!theater)}
              aria-pressed={theater}
              aria-label={theater ? t('player.theaterExit') : t('player.theater')}
              aria-keyshortcuts="T"
            >
              <RectangleIcon />
            </Button>
          )}
          {fullscreenSupported && (
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleFullscreen}
              aria-pressed={fullscreen}
              aria-label={fullscreen ? t('player.fullscreenExit') : t('player.fullscreen')}
              aria-keyshortcuts="F"
            >
              {fullscreen ? <ArrowsInIcon /> : <ArrowsOutIcon />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
