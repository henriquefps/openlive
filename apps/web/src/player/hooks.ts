// SPDX-License-Identifier: AGPL-3.0-only
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { type AutoState, initialAuto, judge, startLayer, stepAuto } from './automatic.ts';
import type { PlayerSource, Rid, SourceState } from './source.ts';
import { readStats, type StatsCounters, type StatsSample } from './stats.ts';
import { initialWatchdog, stepWatchdog, type WatchdogState } from './watchdog.ts';

const NO_SOURCE: SourceState = { kind: 'connecting' };
const noop = () => () => undefined;

/** The source's state, layers and current layer, re-rendering on every change. */
export function useSourceSnapshot(source: PlayerSource | null): {
  state: SourceState;
  layer: Rid | null;
} {
  const subscribe = source?.subscribe ?? noop;
  const state = useSyncExternalStore(subscribe, () => source?.state ?? NO_SOURCE);
  const layer = useSyncExternalStore(subscribe, () => source?.layer ?? null);
  return { state, layer };
}

export type Quality = 'auto' | Rid;

/** A cellular connection, where Automatic starts on the middle layer. */
export function isCellular(): boolean {
  const connection = (navigator as Navigator & { connection?: { type?: string } }).connection;
  return connection?.type === 'cellular';
}

/**
 * Once a second while there is a source: read getStats(), feed the watchdog (stall → retry with
 * backoff) and, on Automatic, the layer policy. Returns the last sample for stats for nerds and
 * whether the network looks unstable.
 */
export function usePlaybackLoop({
  source,
  quality,
  active,
  economy = false,
  intervalMs = 1000,
}: {
  source: PlayerSource | null;
  quality: Quality;
  /** Frames are expected now (live, not paused, track not muted). */
  active: boolean;
  /** Economy mode caps the stream: Automatic starts on the middle layer. */
  economy?: boolean;
  intervalMs?: number;
}): { sample: StatsSample | null; unstable: boolean } {
  const [sample, setSample] = useState<StatsSample | null>(null);
  const [unstable, setUnstable] = useState(false);
  const activeRef = useRef(active);
  const qualityRef = useRef(quality);
  const economyRef = useRef(economy);
  useEffect(() => {
    activeRef.current = active;
    qualityRef.current = quality;
    economyRef.current = economy;
  });

  useEffect(() => {
    if (!source) return;
    let counters: StatsCounters | null = null;
    let watchdog: WatchdogState = initialWatchdog(performance.now());
    let auto: AutoState | null = null;
    let start: Rid | null = null;
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      source
        .getStats()
        .then((report) => {
          const now = performance.now();
          const next = readStats(report, counters, now);
          counters = next.counters;
          setSample(next);

          const step = stepWatchdog(watchdog, {
            now,
            framesDecoded: next.framesDecoded,
            active: activeRef.current && source.state.kind === 'live',
          });
          watchdog = step.state;
          if (step.retry) source.retry({ framesDecoded: next.framesDecoded });

          const rids = source.layers.map((l) => l.rid);
          const nominalFps = source.layers.find((l) => l.rid === source.layer)?.fps ?? null;
          if (qualityRef.current !== 'auto' || source.state.kind !== 'live' || rids.length < 2) {
            auto = null;
            setUnstable(judge(next, nominalFps) === 'bad');
            return;
          }
          if (!auto) {
            start = startLayer(rids, isCellular() || economyRef.current);
            const first = start ?? rids[0] ?? 'f';
            auto = initialAuto(first, now);
            if (source.layer !== first) source.setLayer(first);
          }
          auto = stepAuto(auto, next, { layers: rids, nominalFps });
          if (auto.layer !== source.layer) source.setLayer(auto.layer);
          const dropped = start !== null && rids.indexOf(auto.layer) > rids.indexOf(start);
          setUnstable(dropped || judge(next, nominalFps) === 'bad');
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [source, intervalMs]);

  // A fixed layer: ask for it whenever the source is (back) live.
  const { state } = useSourceSnapshot(source);
  useEffect(() => {
    if (source && quality !== 'auto' && state.kind === 'live') source.setLayer(quality);
  }, [source, quality, state.kind]);

  return { sample: source ? sample : null, unstable: source ? unstable : false };
}

/** Whether the stream's video track is muted (the sender stopped), following added tracks. */
export function useTrackMuted(stream: MediaStream | null): boolean {
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    if (!stream) return;
    let track: MediaStreamTrack | null = null;
    const update = () => setMuted(track?.muted ?? false);
    const attach = () => {
      track?.removeEventListener('mute', update);
      track?.removeEventListener('unmute', update);
      track = stream.getVideoTracks()[0] ?? null;
      track?.addEventListener('mute', update);
      track?.addEventListener('unmute', update);
      update();
    };
    attach();
    stream.addEventListener('addtrack', attach);
    stream.addEventListener('removetrack', attach);
    return () => {
      stream.removeEventListener('addtrack', attach);
      stream.removeEventListener('removetrack', attach);
      track?.removeEventListener('mute', update);
      track?.removeEventListener('unmute', update);
    };
  }, [stream]);
  return stream ? muted : false;
}

/**
 * Keeps the screen on while `active`: the Wake Lock API, taken again when the
 * page becomes visible, or, where there is none, a tiny muted video playing in a loop (the
 * app-share trick for older Safari and Firefox).
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let sentinel: WakeLockSentinel | null = null;
    let video: HTMLVideoElement | null = null;
    let cancelled = false;
    const fallback = () => {
      if (!video) {
        video = document.createElement('video');
        video.src = '/keep-awake.mp4';
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('aria-hidden', 'true');
        video.style.cssText =
          'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
        document.body.append(video);
      }
      void video.play().catch(() => undefined);
    };
    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      if ('wakeLock' in navigator) {
        try {
          const lock = await navigator.wakeLock.request('screen');
          if (cancelled) void lock.release();
          else sentinel = lock;
          return;
        } catch {
          // Refused (battery saver, no gesture yet): try the video.
        }
      }
      fallback();
    };
    void acquire();
    const onVisible = () => void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => undefined);
      if (video) {
        video.pause();
        video.remove();
      }
    };
  }, [active]);
}

type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
type LockableOrientation = ScreenOrientation & { lock?: (orientation: string) => Promise<void> };

/**
 * Fullscreen on the player element (so the controls stay), turning a phone to landscape where the
 * browser allows it. iPhone Safari has no element fullscreen: its native video fullscreen instead.
 */
export function useFullscreen(
  root: RefObject<HTMLElement | null>,
  video: RefObject<HTMLVideoElement | null>,
): { fullscreen: boolean; toggle: () => void; supported: boolean } {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const update = () => {
      const active =
        document.fullscreenElement !== null && document.fullscreenElement === root.current;
      setFullscreen(active);
      if (!active) screen.orientation?.unlock?.();
    };
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, [root]);
  // Phones: turning the phone sideways while watching goes fullscreen, upright leaves it. Browsers
  // may refuse without a recent tap; then the fullscreen button is still there.
  useEffect(() => {
    const orientation = typeof screen === 'undefined' ? undefined : screen.orientation;
    if (!orientation || !window.matchMedia('(pointer: coarse)').matches) return;
    const onChange = () => {
      const element = root.current;
      if (!element || !document.fullscreenEnabled) return;
      const landscape = orientation.type.startsWith('landscape');
      if (landscape && document.fullscreenElement === null) {
        void element.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
      } else if (!landscape && document.fullscreenElement === element) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
    orientation.addEventListener('change', onChange);
    return () => orientation.removeEventListener('change', onChange);
  }, [root]);
  const supported =
    typeof document !== 'undefined' &&
    (document.fullscreenEnabled ||
      typeof (document.createElement('video') as WebkitVideo).webkitEnterFullscreen === 'function');
  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    const element = root.current;
    if (element && document.fullscreenEnabled) {
      void element
        .requestFullscreen({ navigationUI: 'hide' })
        .then(() => (screen.orientation as LockableOrientation | undefined)?.lock?.('landscape'))
        .catch(() => undefined);
      return;
    }
    (video.current as WebkitVideo | null)?.webkitEnterFullscreen?.();
  }, [root, video]);
  return { fullscreen, toggle, supported };
}
