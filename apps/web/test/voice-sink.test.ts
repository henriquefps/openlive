// SPDX-License-Identifier: AGPL-3.0-only
import type { HelperInfo, HelperStatusPayload } from '@openlive/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capturedAppName } from '../src/golive/state.ts';
import { WebAudioSounds } from '../src/notices/sounds.ts';
import { capturedApps } from '../src/voice/VoiceEchoWarning.tsx';
import {
  browserFamilyOfName,
  echoRisk,
  findVoiceSinkDevice,
  isThisBrowser,
  ownBrowser,
  voiceSinkHelpers,
  voiceSinkOf,
} from '../src/voice/voice-sink.ts';
import { setupVoice } from './voice-fakes.ts';
import { PC } from './hub-fakes.ts';

// Voice into the helper's voice sink: finding it among the outputs, routing voice and
// the notice sounds into it, and when the streamer is warned instead.

const CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0';
const EDGE = `${CHROME} Edg/141.0.0.0`;
const EPIPHANY =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const SINK_LABEL = 'Openlive – voice';

const device = (deviceId: string, label: string, kind: MediaDeviceKind = 'audiooutput') =>
  ({ deviceId, label, kind, groupId: '' }) as MediaDeviceInfo;

const WITH_SINK = [
  device('default', 'Default', 'audioinput'),
  device('mic-a', 'Headset', 'audioinput'),
  device('default', 'Default'),
  device('spk-a', 'Speakers'),
  device('sink-1', SINK_LABEL),
];

describe('finding the voice sink', () => {
  it('matches the output by label, never an input or the default alias', () => {
    expect(findVoiceSinkDevice(WITH_SINK, SINK_LABEL)).toBe('sink-1');
    expect(findVoiceSinkDevice([device('x', `${SINK_LABEL} (Virtual)`)], SINK_LABEL)).toBe('x');
    expect(findVoiceSinkDevice([device('mic', SINK_LABEL, 'audioinput')], SINK_LABEL)).toBeNull();
    expect(findVoiceSinkDevice([device('default', SINK_LABEL)], SINK_LABEL)).toBeNull();
    // Before the microphone was allowed, labels are empty.
    expect(findVoiceSinkDevice([device('x', '')], SINK_LABEL)).toBeNull();
    expect(findVoiceSinkDevice(WITH_SINK, '')).toBeNull();
  });

  it('reads the sink from the helpers online, and which of them to tell the output', () => {
    const old: HelperInfo = { ...PC, deviceId: 'd_old', protocol: { major: 1, minor: 15 } };
    const pc: HelperInfo = { ...PC, protocol: { major: 1, minor: 16 } };
    const sink = { name: 'openlive-voice', label: SINK_LABEL };
    const statuses: Record<string, HelperStatusPayload> = {
      d_pc: { deviceId: 'd_pc', state: 'idle', voiceSink: sink },
      d_old: { deviceId: 'd_old', state: 'idle', voiceSink: sink },
      d_gone: { deviceId: 'd_gone', state: 'idle', voiceSink: sink },
    };
    expect(voiceSinkOf({ d_pc: pc }, statuses)).toEqual(sink);
    expect(voiceSinkOf({ d_pc: pc }, { d_pc: { deviceId: 'd_pc', state: 'idle' } })).toBeNull();
    // Offline helpers count for nothing; helpers before 1.16 do not know the command.
    expect(voiceSinkHelpers({ d_pc: pc, d_old: old }, statuses)).toEqual(['d_pc']);
  });
});

describe('VoiceClient routes voice into the voice sink', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const settle = () => vi.advanceTimersByTimeAsync(0);

  function withSink(options: Parameters<typeof setupVoice>[0] = {}) {
    const v = setupVoice(options);
    v.devices.devices.enumerateDevices.mockResolvedValue(WITH_SINK);
    return v;
  }

  it('plays into the sink once the helper reports it, and back on the output when it goes', async () => {
    const v = withSink({ prefs: { outputId: 'spk-a' } });
    await settle();
    expect(v.output.sink).toBe('spk-a');
    v.client.setVoiceSinkLabel(SINK_LABEL);
    await settle();
    expect(v.output.sink).toBe('sink-1');
    expect(v.client.getState().voiceSinkId).toBe('sink-1');
    v.client.setVoiceSinkLabel(null);
    await settle();
    expect(v.output.sink).toBe('spk-a');
    expect(v.client.getState().voiceSinkId).toBeNull();
  });

  it('keeps the voice in the sink when another output is picked (the helper moves the sink)', async () => {
    const v = withSink();
    v.client.setVoiceSinkLabel(SINK_LABEL);
    await settle();
    await v.client.setOutput('spk-a');
    await settle();
    expect(v.output.sink).toBe('sink-1');
    expect(v.saved.at(-1)?.outputId).toBe('spk-a');
  });

  it('does not list the sink among the speakers to pick', async () => {
    const v = withSink();
    v.client.setVoiceSinkLabel(SINK_LABEL);
    await v.client.refreshDevices();
    expect(v.client.getState().outputs).toEqual([{ deviceId: 'spk-a', label: 'Speakers' }]);
  });

  it('finds the sink when its label appears (after the microphone was allowed)', async () => {
    const v = setupVoice();
    v.devices.devices.enumerateDevices.mockResolvedValue([device('sink-1', '')]);
    v.client.setVoiceSinkLabel(SINK_LABEL);
    await settle();
    expect(v.client.getState().voiceSinkId).toBeNull();
    v.devices.devices.enumerateDevices.mockResolvedValue(WITH_SINK);
    v.devices.change();
    await settle();
    expect(v.client.getState().voiceSinkId).toBe('sink-1');
    expect(v.output.sink).toBe('sink-1');
  });

  it('without setSinkId (Firefox, Safari) voice stays where it was and is not routed', async () => {
    const v = withSink();
    (v.output as { canPickSink: boolean }).canPickSink = false;
    v.client.setVoiceSinkLabel(SINK_LABEL);
    await settle();
    expect(v.output.sink).toBe('');
    expect(v.client.getState().voiceSinkId).toBeNull();
  });
});

describe('notice sounds follow the voice', () => {
  it('play into the sink through AudioContext.setSinkId, where there is one', () => {
    const setSinkId = vi.fn(() => Promise.resolve());
    class FakeContext {
      setSinkId = setSinkId;
      resume = () => Promise.resolve();
      close = () => Promise.resolve();
    }
    vi.stubGlobal('AudioContext', FakeContext);
    try {
      const sounds = new WebAudioSounds();
      sounds.setSink('sink-1');
      sounds.unlock();
      expect(setSinkId).toHaveBeenLastCalledWith('sink-1');
      sounds.setSink('');
      expect(setSinkId).toHaveBeenLastCalledWith('');
      sounds.setSink('');
      expect(setSinkId).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the echo warning', () => {
  it('knows the browser it runs in', () => {
    expect(ownBrowser(CHROME)).toEqual({ family: 'chromium', product: null });
    expect(ownBrowser(CHROME, { brave: {} })).toEqual({ family: 'chromium', product: 'brave' });
    expect(ownBrowser(EDGE)).toEqual({ family: 'chromium', product: 'edge' });
    expect(ownBrowser(FIREFOX)).toEqual({ family: 'firefox', product: null });
    expect(ownBrowser(EPIPHANY)).toEqual({ family: 'webkit', product: null });
    expect(ownBrowser('curl/8')).toEqual({ family: null, product: null });
  });

  it('names a browser by its window class like the helper does', () => {
    expect(browserFamilyOfName('brave-browser')).toBe('chromium');
    expect(browserFamilyOfName('org.mozilla.firefox')).toBe('firefox');
    expect(browserFamilyOfName('org.gnome.Epiphany')).toBe('webkit');
    expect(browserFamilyOfName('steam_app_570')).toBeNull();
    expect(browserFamilyOfName(undefined)).toBeNull();
  });

  it('compares the captured app with this browser', () => {
    const chrome = ownBrowser(CHROME);
    const brave = ownBrowser(CHROME, { brave: {} });
    const braveApp = { name: 'brave-browser', binary: 'brave', browser: 'chromium' as const };
    const chromeApp = { name: 'google-chrome', binary: 'chrome', browser: 'chromium' as const };
    expect(isThisBrowser(braveApp, brave)).toBe(true);
    expect(isThisBrowser(chromeApp, chrome)).toBe(true);
    // Brave shared while in voice in Chrome, and the other way round: two processes.
    expect(isThisBrowser(braveApp, chrome)).toBe(false);
    expect(isThisBrowser(chromeApp, brave)).toBe(false);
    expect(isThisBrowser({ name: 'firefox', browser: 'firefox' }, chrome)).toBe(false);
    expect(isThisBrowser({ name: 'librewolf' }, ownBrowser(FIREFOX))).toBe(true);
    expect(isThisBrowser({ name: 'Steam' }, chrome)).toBe(false);
  });

  it('warns only in voice, unrouted, capturing this browser', () => {
    const own = ownBrowser(CHROME);
    const captured = { name: 'chromium', browser: 'chromium' as const };
    expect(echoRisk({ inVoice: true, routed: false, captured, own })).toBe(true);
    expect(echoRisk({ inVoice: true, routed: true, captured, own })).toBe(false);
    expect(echoRisk({ inVoice: false, routed: false, captured, own })).toBe(false);
    expect(echoRisk({ inVoice: true, routed: false, captured: null, own })).toBe(false);
  });

  it('knows, before the start, whose audio the choice takes', () => {
    const sources = [
      { sourceId: 's', kind: 'screen' as const, label: 'Screen', hasAudio: false },
      { sourceId: 'w', kind: 'window' as const, label: 'Tab', appName: 'chromium', hasAudio: true },
    ];
    expect(capturedAppName(sources, 'w', { kind: 'source' })).toBe('chromium');
    expect(capturedAppName(sources, 's', { kind: 'app', sourceId: 'w' })).toBe('chromium');
    expect(capturedAppName(sources, 'w', { kind: 'none' })).toBeUndefined();
    expect(capturedAppName(sources, 's', { kind: 'source' })).toBeUndefined();
  });

  it('reads what the live helpers capture', () => {
    const app = { name: 'chromium', browser: 'chromium' as const };
    const stream = { roomId: 'r_1', sourceId: 'w', preset: 'game' as const, audioApp: app };
    expect(
      capturedApps({
        a: { deviceId: 'a', state: 'live', stream },
        b: { deviceId: 'b', state: 'idle' },
        c: { deviceId: 'c', state: 'stopping', stream },
      }),
    ).toEqual([app]);
  });
});
