// SPDX-License-Identifier: AGPL-3.0-only
import type {
  BrowserFamily,
  HelperAudioApp,
  HelperInfo,
  HelperStatusPayload,
  VoiceSink,
} from '@openlive/protocol';

// Voice out of a shared browser window's audio (docs/PROTOCOL.md 8.4). Sharing a browser window with its audio captures everything that browser
// plays, the voice channel included, so the people in voice would hear themselves on the stream.
// A Linux helper keeps a virtual speaker, "Openlive – voice", that app-audio capture never takes
// and that plays on the user's speakers; this tab plays voice into it (setSinkId) and warns the
// streamer when it cannot.

/** The first protocol minor with the voice sink and helper.setVoiceOutput. */
export const VOICE_SINK_MINOR = 16;

/** The voice sink one of the user's online helpers reports, if any. */
export function voiceSinkOf(
  helpers: Record<string, HelperInfo>,
  statuses: Record<string, HelperStatusPayload>,
): VoiceSink | null {
  for (const deviceId of Object.keys(helpers).sort()) {
    const sink = statuses[deviceId]?.voiceSink;
    if (sink) return sink;
  }
  return null;
}

/** The helpers to tell which speakers the voice sink plays on (1.16 or later, with a sink). */
export function voiceSinkHelpers(
  helpers: Record<string, HelperInfo>,
  statuses: Record<string, HelperStatusPayload>,
): string[] {
  return Object.values(helpers)
    .filter(
      (h) =>
        statuses[h.deviceId]?.voiceSink !== undefined &&
        (h.protocol.major > 1 || h.protocol.minor >= VOICE_SINK_MINOR),
    )
    .map((h) => h.deviceId)
    .sort();
}

/**
 * The browser's output that is the voice sink: its label is the sink's description. Labels are
 * empty until the microphone was allowed; some browsers add a suffix ("… (Virtual)").
 */
export function findVoiceSinkDevice(
  devices: readonly Pick<MediaDeviceInfo, 'kind' | 'label' | 'deviceId'>[],
  label: string,
): string | null {
  const want = label.trim();
  if (!want) return null;
  const outputs = devices.filter(
    (d) => d.kind === 'audiooutput' && d.deviceId !== '' && d.deviceId !== 'default',
  );
  const exact = outputs.find((d) => d.label.trim() === want);
  const prefixed = outputs.find((d) => d.label.trim().startsWith(`${want} (`));
  return (exact ?? prefixed)?.deviceId ?? null;
}

/** Products that tell browsers of one family apart, where both sides can name them. */
type Product = 'brave' | 'edge' | 'opera' | 'vivaldi';

export interface OwnBrowser {
  family: BrowserFamily | null;
  /** Only the products the user agent names for sure; null for Chrome, Chromium, Firefox and forks. */
  product: Product | null;
}

/** This browser, from its user agent (and `navigator.brave`, which Brave's UA hides). */
export function ownBrowser(userAgent: string, extras: { brave?: unknown } = {}): OwnBrowser {
  const ua = userAgent;
  if (/Firefox\//.test(ua)) return { family: 'firefox', product: null };
  if (/Chrome\/|Chromium\//.test(ua)) {
    const product: Product | null =
      extras.brave !== undefined
        ? 'brave'
        : /Edg\//.test(ua)
          ? 'edge'
          : /OPR\//.test(ua)
            ? 'opera'
            : /Vivaldi\//.test(ua)
              ? 'vivaldi'
              : null;
    return { family: 'chromium', product };
  }
  if (/AppleWebKit\//.test(ua)) return { family: 'webkit', product: null };
  return { family: null, product: null };
}

export function currentBrowser(): OwnBrowser {
  if (typeof navigator === 'undefined') return { family: null, product: null };
  return ownBrowser(navigator.userAgent, navigator as { brave?: unknown });
}

const PRODUCTS: [RegExp, Product][] = [
  [/brave/i, 'brave'],
  [/msedge|microsoft-edge/i, 'edge'],
  [/opera/i, 'opera'],
  [/vivaldi/i, 'vivaldi'],
];

function productOf(names: readonly (string | undefined)[]): Product | null {
  for (const name of names) {
    if (!name) continue;
    const hit = PRODUCTS.find(([pattern]) => pattern.test(name));
    if (hit) return hit[1];
  }
  return null;
}

/**
 * The browser family of an app by its window class or app id, as the helper names it
 * (helper/internal/audio/browser.go), for the source picker before the stream starts.
 */
export function browserFamilyOfName(name: string | undefined): BrowserFamily | null {
  const n = (name ?? '').toLowerCase();
  if (!n) return null;
  if (
    /firefox|librewolf|floorp|waterfox|zen-browser|zen_browser|mullvad|tor-?browser|icecat/.test(n)
  )
    return 'firefox';
  if (/chrome|chromium|brave|msedge|microsoft-edge|opera|vivaldi|thorium|yandex|helium/.test(n))
    return 'chromium';
  if (/epiphany|webkit/.test(n)) return 'webkit';
  return null;
}

/**
 * Whether the app a stream captures looks like this very browser: same family, and the same
 * product where both sides know it (sharing Chrome while in voice in Brave is fine). A heuristic
 * that leans to warning: Firefox forks and Chrome versus Chromium count as the same.
 */
export function isThisBrowser(
  app: Pick<HelperAudioApp, 'name' | 'binary' | 'browser'>,
  own: OwnBrowser,
): boolean {
  const family = app.browser ?? browserFamilyOfName(app.name);
  if (!family || family !== own.family) return false;
  return productOf([app.binary, app.name]) === own.product;
}

export interface EchoRiskInput {
  /** This tab is in voice (joined). */
  inVoice: boolean;
  /** This tab plays voice into the voice sink. */
  routed: boolean;
  /** Whose audio the stream captures (or is about to). */
  captured: Pick<HelperAudioApp, 'name' | 'binary' | 'browser'> | null | undefined;
  own: OwnBrowser;
}

/** "People in voice will hear themselves in your stream." */
export function echoRisk({ inVoice, routed, captured, own }: EchoRiskInput): boolean {
  return inVoice && !routed && captured != null && isThisBrowser(captured, own);
}
