// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ErrorPayload,
  HelperInfo,
  HelperStartStreamPayload,
  HelperStatusPayload,
  Preset,
  RoomSettings,
  SourceDescriptor,
} from '@openlive/protocol';
import {
  isBrowserPreset,
  isHighFrameRate,
  type PresetLayer,
  presetSendKbps,
  QUALITY_PRESET_ORDER,
  QUALITY_PRESETS,
} from '@openlive/usage';
import { PROTOCOL } from '../room/connection.ts';

// The "Go live" flow: pick a helper, a source, a preset and the
// app audio, then start. Pure functions and a reducer, so the screen stays thin and testable.

/** The top layer of each preset, as the helper encodes it (helper/internal/media/presets.go). */
export const PRESETS: Record<Preset, PresetLayer> = QUALITY_PRESETS;
export const PRESET_ORDER: readonly Preset[] = QUALITY_PRESET_ORDER;
/** Upload headroom over the send rate. */
const UPLOAD_HEADROOM = 1.3;
/** The first protocol minor that has the 120 fps presets (PROTOCOL.md 1.8). */
const HIGH_FPS_MINOR = 8;

/** What the helper sends for a preset: every layer, plus audio. */
export function sendKbps(preset: Preset, audio: boolean): number {
  return presetSendKbps(preset, audio);
}

/** Whether a helper knows the 120 fps presets: an older one would reject them. */
export function knowsHighFrameRate(helper: Pick<HelperInfo, 'protocol'> | undefined): boolean {
  return (
    !!helper &&
    (helper.protocol.major > 1 ||
      (helper.protocol.major === 1 && helper.protocol.minor >= HIGH_FPS_MINOR))
  );
}

/** The upload a preset needs, with headroom (1440p60 needs about 22 Mb/s). */
export function uploadNeededKbps(preset: Preset, audio: boolean): number {
  return Math.round(sendKbps(preset, audio) * UPLOAD_HEADROOM);
}

/** The room's bitrate cap when it is below what the preset would send, else null. */
export function roomCapKbps(settings: RoomSettings, preset: Preset, audio: boolean): number | null {
  const cap = settings.maxBitrateKbps;
  return cap > 0 && sendKbps(preset, audio) > cap ? cap : null;
}

/**
 * The presets to offer: text, game and max always (greyed out when the room does not allow them);
 * native and the 120 fps ones only where the room allows them, and the 120 fps ones only to a
 * helper that knows them.
 */
export function offeredPresets(
  settings: RoomSettings,
  helper?: Pick<HelperInfo, 'protocol'>,
): PresetOffer[] {
  const allowed = (p: Preset) => settings.allowedPresets.includes(p);
  return PRESET_ORDER.filter((p) => {
    if (isHighFrameRate(p)) return allowed(p) && knowsHighFrameRate(helper);
    return p !== 'native' || allowed(p);
  }).map((preset) => ({ preset, allowed: allowed(preset) }));
}

/** The frame rates the presets come in, as the FPS select lists them. */
export type FrameRate = number;
/** A preset's resolution by its height: 1080, 1440 or 2160 (the last is the source's own size). */
export type Resolution = number;

export type PresetOffer = { preset: Preset; allowed: boolean };

export const resolutionOf = (preset: Preset): Resolution => PRESETS[preset].height;
export const frameRateOf = (preset: Preset): FrameRate => PRESETS[preset].fps;

/** The resolutions among the offered presets, lowest first, each allowed when any of its presets is. */
export function resolutionOptions(
  offers: readonly PresetOffer[],
): { resolution: Resolution; allowed: boolean }[] {
  const out = new Map<Resolution, boolean>();
  for (const { preset, allowed } of offers) {
    const r = resolutionOf(preset);
    out.set(r, (out.get(r) ?? false) || allowed);
  }
  return [...out].map(([resolution, allowed]) => ({ resolution, allowed })).sort(byResolution);
}

/** The frame rates a resolution has a preset for among the offered ones, lowest first. */
export function frameRateOptions(
  offers: readonly PresetOffer[],
  resolution: Resolution,
): { fps: FrameRate; preset: Preset; allowed: boolean }[] {
  return offers
    .filter((o) => resolutionOf(o.preset) === resolution)
    .map((o) => ({ fps: frameRateOf(o.preset), preset: o.preset, allowed: o.allowed }))
    .sort((a, b) => a.fps - b.fps);
}

const byResolution = (a: { resolution: Resolution }, b: { resolution: Resolution }) =>
  a.resolution - b.resolution;

/**
 * The preset after the streamer picks a resolution: the same frame rate when that resolution has
 * it, else the nearest allowed one (60 on a tie). Null when the resolution has none allowed.
 */
export function presetForResolution(
  offers: readonly PresetOffer[],
  current: Preset,
  resolution: Resolution,
): Preset | null {
  const options = frameRateOptions(offers, resolution).filter((o) => o.allowed);
  const fps = frameRateOf(current);
  const distance = (o: { fps: FrameRate }) => Math.abs(o.fps - fps);
  const best = [...options].sort(
    (a, b) => distance(a) - distance(b) || Number(b.fps === 60) - Number(a.fps === 60),
  )[0];
  return best?.preset ?? null;
}

/** The preset for a resolution and frame rate, if one exists. */
export function presetFor(resolution: Resolution, fps: FrameRate): Preset | null {
  return PRESET_ORDER.find((p) => resolutionOf(p) === resolution && frameRateOf(p) === fps) ?? null;
}

/** The best allowed preset up to game, the usual default. */
export function defaultPreset(settings: RoomSettings): Preset | null {
  for (const p of ['game', 'text', 'max', 'native'] as const) {
    if (settings.allowedPresets.includes(p)) return p;
  }
  return null;
}

/**
 * Whether a helper can take a stream for this room:
 * - `outdated`: older protocol minor, still usable (warns, refuses only below the minimum);
 * - `unsupported`: another protocol major;
 * - `busy`: streaming elsewhere (another room, or another instance);
 * - `live_here`: already streaming in this room.
 */
export type HelperFit = 'ready' | 'outdated' | 'unsupported' | 'busy' | 'live_here';

export function helperFit(
  helper: HelperInfo,
  status: HelperStatusPayload | undefined,
  roomId: string,
): HelperFit {
  if (helper.protocol.major !== PROTOCOL.major) return 'unsupported';
  if (status && isActive(status)) {
    return status.stream?.roomId === roomId ? 'live_here' : 'busy';
  }
  return helper.protocol.minor < HELPER_PROTOCOL_MINOR ? 'outdated' : 'ready';
}

/**
 * The newest protocol minor that changed what a helper does (1.21, global voice shortcuts). 1.22
 * (streaming from the browser) is web and Worker only, so a 1.21 helper is not outdated.
 */
export const HELPER_PROTOCOL_MINOR = Math.min(PROTOCOL.minor, 21);

export const isActive = (status: HelperStatusPayload): boolean =>
  status.state === 'starting' ||
  status.state === 'live' ||
  status.state === 'paused' ||
  status.state === 'stopping';

/** The helper streaming in this room, if one of the user's is. */
export function liveHere(
  statuses: Record<string, HelperStatusPayload>,
  roomId: string,
): HelperStatusPayload | null {
  return Object.values(statuses).find((s) => isActive(s) && s.stream?.roomId === roomId) ?? null;
}

/** What stops the flow before it starts. */
export type Blocker = 'no_permission' | 'hub_down' | 'no_helper';

export function blockerOf(input: {
  canStream: boolean;
  hubOpen: boolean;
  helpers: HelperInfo[];
}): Blocker | null {
  if (!input.canStream) return 'no_permission';
  if (!input.hubOpen) return 'hub_down';
  if (input.helpers.length === 0) return 'no_helper';
  return null;
}

/** How a failed start is shown: its own screen for the known cases, else the error. */
export type StartFailure = 'quota' | 'no_permission' | 'busy' | 'offline' | 'other';

export function failureOf(error: ErrorPayload): StartFailure {
  switch (error.code) {
    case 'quota_exhausted':
      return 'quota';
    case 'stream_permission_required':
    case 'forbidden':
      return 'no_permission';
    case 'helper_busy':
      return 'busy';
    case 'helper_offline':
      return 'offline';
    default:
      return 'other';
  }
}

/** Audio to send: none, the chosen source's own app, or another app's (with a whole screen). */
export type AudioChoice = { kind: 'none' } | { kind: 'source' } | { kind: 'app'; sourceId: string };

/** The app whose audio the choice captures, as far as the source list names it. */
export function capturedAppName(
  sources: SourceDescriptor[],
  sourceId: string | null,
  audio: AudioChoice,
): string | undefined {
  if (audio.kind === 'none') return undefined;
  const id = audio.kind === 'app' ? audio.sourceId : sourceId;
  return sources.find((s) => s.sourceId === id)?.appName;
}

export const audioKey = (a: AudioChoice): string =>
  a.kind === 'app' ? `app:${a.sourceId}` : a.kind;

export function audioChoices(sources: SourceDescriptor[], sourceId: string | null): AudioChoice[] {
  const source = sources.find((s) => s.sourceId === sourceId);
  const out: AudioChoice[] = [{ kind: 'none' }];
  if (!source) return out;
  if (source.hasAudio) out.push({ kind: 'source' });
  if (source.kind === 'screen') {
    for (const s of sources) {
      if (s.kind === 'window' && s.hasAudio) out.push({ kind: 'app', sourceId: s.sourceId });
    }
  }
  return out;
}

/** The wizard: helper → source → options → starting. */
export type Step = 'helper' | 'source' | 'options' | 'starting';

export interface WizardState {
  step: Step;
  deviceId: string | null;
  /** null while loading. */
  sources: SourceDescriptor[] | null;
  sourceId: string | null;
  preset: Preset | null;
  audio: AudioChoice;
  /** The last failure: listing sources or starting. */
  error: ErrorPayload | null;
}

export const INITIAL_WIZARD: WizardState = {
  step: 'helper',
  deviceId: null,
  sources: null,
  sourceId: null,
  preset: null,
  audio: { kind: 'none' },
  error: null,
};

export type WizardAction =
  | { type: 'chooseHelper'; deviceId: string }
  | { type: 'sourcesLoaded'; sources: SourceDescriptor[] }
  | { type: 'failed'; error: ErrorPayload }
  | { type: 'chooseSource'; sourceId: string; preset: Preset | null }
  | { type: 'choosePreset'; preset: Preset }
  | { type: 'chooseAudio'; audio: AudioChoice }
  | { type: 'start' }
  | { type: 'back' };

export function wizard(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'chooseHelper':
      return { ...INITIAL_WIZARD, step: 'source', deviceId: action.deviceId };
    case 'sourcesLoaded':
      return { ...state, sources: action.sources, error: null };
    case 'failed':
      // A failed start goes back to the options, with the reason shown.
      return {
        ...state,
        step: state.step === 'starting' ? 'options' : state.step,
        error: action.error,
      };
    case 'chooseSource': {
      const choices = audioChoices(state.sources ?? [], action.sourceId);
      // A window's own audio is the natural default; a screen starts silent.
      const audio = choices.find((c) => c.kind === 'source') ?? { kind: 'none' as const };
      return {
        ...state,
        step: 'options',
        sourceId: action.sourceId,
        preset: state.preset ?? action.preset,
        audio,
        error: null,
      };
    }
    case 'choosePreset':
      return { ...state, preset: action.preset };
    case 'chooseAudio':
      return { ...state, audio: action.audio };
    case 'start':
      return state.step === 'options' && startPayload(state, '') !== null
        ? { ...state, step: 'starting', error: null }
        : state;
    case 'back':
      if (state.step === 'options') return { ...state, step: 'source', error: null };
      if (state.step === 'source') return INITIAL_WIZARD;
      return state;
  }
}

/** The helper.startStream payload for the wizard's choices, or null when incomplete. */
export function startPayload(state: WizardState, roomId: string): HelperStartStreamPayload | null {
  if (!state.deviceId || !state.sourceId || !state.preset) return null;
  const a = state.audio;
  return {
    deviceId: state.deviceId,
    roomId,
    sourceId: state.sourceId,
    preset: state.preset,
    audio: a.kind !== 'none',
    ...(a.kind === 'app' ? { audioSourceId: a.sourceId } : {}),
  };
}

/** Wayland's portal pseudo-sources (helper/internal/media/source.go): the system shows a picker. */
export const isPortalPicker = (sourceId: string): boolean =>
  sourceId === 'portal:screen' || sourceId === 'portal:window';

/**
 * What the Go live panel leads with (no stored preference, chosen each time):
 * - `helper`: a helper is paired and online: today's flow, plus a discreet link to the browser;
 * - `install`: none is: "Install the helper (recommended)" first, the browser as the second
 *   choice. `download` is false on Windows, where there is no helper yet.
 * `browser` is false where the browser cannot capture a screen (phones): the option is hidden.
 */
export type GoLiveChoice =
  { kind: 'helper'; browser: boolean } | { kind: 'install'; browser: boolean; download: boolean };

export function goLiveChoice(input: {
  helpers: number;
  displayMedia: boolean;
  os: 'windows' | 'macos' | 'linux' | undefined;
}): GoLiveChoice {
  if (input.helpers > 0) return { kind: 'helper', browser: input.displayMedia };
  return { kind: 'install', browser: input.displayMedia, download: input.os !== 'windows' };
}

/**
 * After a browser stream ends, a short nudge to install the helper: not on Windows (no helper
 * yet) and not on an unknown or mobile system.
 */
export function showHelperNudge(
  ended: boolean,
  os: 'windows' | 'macos' | 'linux' | undefined,
): boolean {
  return ended && (os === 'linux' || os === 'macos');
}

/** The presets a browser stream offers: 1080p30 and 1080p60, greyed out where the room forbids them. */
export function browserOffers(settings: RoomSettings): PresetOffer[] {
  return offeredPresets(settings).filter((o) => isBrowserPreset(o.preset));
}
