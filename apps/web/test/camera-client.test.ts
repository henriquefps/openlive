// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { cameraConstraints } from '../src/voice/camera.ts';
import { NetworkMeter, qualityOf, RECOVER_SAMPLES } from '../src/voice/network.ts';
import { camera, setupCamera } from './camera-fakes.ts';
import { participant } from './voice-fakes.ts';

// The camera client (voice/camera.ts, PROTOCOL 7.7): on only in voice and with canUseCamera, the
// room's refusals, the room turning it off, pulling the others' cameras on the strip's layer and
// the enlarged one on the high layer, lip-sync links, and voice first on a bad network.

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('CameraClient: on and off', () => {
  it('only turns on in voice, asks for 640×360 at 30 fps, publishes and shows the preview', async () => {
    const { client, signal, media, devices, cam } = setupCamera();
    await client.turnOn();
    expect(devices.devices.getUserMedia).not.toHaveBeenCalled();
    signal.admit();
    await client.turnOn();
    expect(devices.devices.getUserMedia).toHaveBeenCalledWith(cameraConstraints('', 'user'));
    expect(cameraConstraints('', 'user').video).toMatchObject({
      width: { ideal: 640 },
      height: { ideal: 360 },
      frameRate: { ideal: 30, max: 30 },
      facingMode: 'user',
    });
    expect(media.media.publish).toHaveBeenCalledWith(cam());
    expect(client.getState()).toMatchObject({ phase: 'on', preview: cam(), error: null });

    client.turnOff();
    expect(media.media.unpublish).toHaveBeenCalledWith(media.publications[0]);
    expect(cam()?.readyState).toBe('ended');
    expect(client.getState()).toMatchObject({ phase: 'off', preview: null });
  });

  it('stays off without canUseCamera', async () => {
    const { client, signal, devices } = setupCamera();
    signal.admit();
    signal.update({ canUseCamera: false });
    await client.turnOn();
    expect(devices.devices.getUserMedia).not.toHaveBeenCalled();
    expect(client.getState().phase).toBe('off');
  });

  it('says why when the room refuses (camera limit) and lets go of the device', async () => {
    const { client, signal, media, cam } = setupCamera();
    signal.admit();
    media.refuse('camera_limit_reached', { limit: 6 });
    await client.turnOn();
    expect(client.getState()).toMatchObject({
      phase: 'off',
      refused: { code: 'camera_limit_reached', limit: 6 },
      preview: null,
    });
    expect(cam()?.readyState).toBe('ended');
  });

  it('reports a denied camera and stays in voice', async () => {
    const { client, signal, media, devices } = setupCamera();
    signal.admit();
    devices.fail('NotAllowedError');
    await client.turnOn();
    expect(client.getState()).toMatchObject({ phase: 'off', error: 'denied' });
    expect(media.media.publish).not.toHaveBeenCalled();
    expect(signal.sent.filter((m) => m.type === 'voice.leave')).toEqual([]);
  });

  it('turns off when the device goes away', async () => {
    const { client, signal, media, cam } = setupCamera();
    signal.admit();
    await client.turnOn();
    cam()?.unplug();
    expect(client.getState()).toMatchObject({ phase: 'off', error: 'device_lost' });
    expect(media.media.unpublish).toHaveBeenCalledTimes(1);
  });

  it('stops when the room turns it off (voice.cameraStopped), without unpublishing again', async () => {
    const { client, signal, media, cam } = setupCamera();
    signal.admit();
    await client.turnOn();
    signal.update({ cameraStopped: { reason: 'moderator', seq: 1 } });
    expect(client.getState()).toMatchObject({ phase: 'off', stopped: 'moderator' });
    expect(cam()?.readyState).toBe('ended');
    expect(media.media.unpublish).not.toHaveBeenCalled();
    expect(media.media.drop).toHaveBeenCalledWith(media.publications[0]);
    // The same event again changes nothing; the person may turn it on again.
    signal.update({ participants: [...signal.voice.participants] });
    await client.turnOn();
    expect(client.getState().phase).toBe('on');
  });

  it('turns off on leaving voice, and comes back after a reconnect', async () => {
    const { client, signal, media } = setupCamera();
    signal.admit();
    await client.turnOn();
    // The socket dropped: the room closed the camera; back in voice, it is published again.
    signal.update({ self: 'joining' });
    expect(client.getState().phase).toBe('off');
    signal.update({ self: 'in' });
    await settle();
    expect(media.media.publish).toHaveBeenCalledTimes(2);
    expect(client.getState().phase).toBe('on');
    // Leaving for good: off, and not again.
    signal.update({ self: 'out', left: 'left' });
    signal.update({ self: 'in' });
    await settle();
    expect(media.media.publish).toHaveBeenCalledTimes(2);
  });

  it('switches devices on the same publication and flips front and back', async () => {
    const { client, signal, media, devices, saved } = setupCamera();
    signal.admit();
    await client.turnOn();
    await client.setInput('cam-a');
    expect(devices.devices.getUserMedia).toHaveBeenLastCalledWith(
      cameraConstraints('cam-a', 'user'),
    );
    expect(media.publications[0]?.replaceTrack).toHaveBeenCalledWith(devices.cams[1]);
    expect(devices.cams[0]?.readyState).toBe('ended');
    await client.flip();
    expect(devices.devices.getUserMedia).toHaveBeenLastCalledWith(
      cameraConstraints('', 'environment'),
    );
    expect(saved.at(-1)).toEqual({ inputId: '', facing: 'environment' });
    expect(client.getState().inputs).toEqual([{ deviceId: 'cam-a', label: 'Webcam' }]);
  });
});

describe('CameraClient: the others’ cameras', () => {
  it('pulls the strip, links each camera to its owner’s microphone, and drops who turned off', async () => {
    const { client, signal, media } = setupCamera();
    signal.admit([participant('u_bia'), participant('u_caio')]);
    signal.update({
      tracks: [{ trackId: 'vt_bia', userId: 'u_bia' }],
      cameras: [camera('u_bia'), camera('u_caio')],
    });
    await settle();
    expect(media.media.link).toHaveBeenLastCalledWith([{ video: 'ct_u_bia', audio: 'vt_bia' }]);
    expect(media.media.pull).toHaveBeenCalledWith(
      [camera('u_bia'), camera('u_caio')],
      expect.anything(),
    );
    expect(Object.keys(client.getState().remote)).toEqual(['u_bia', 'u_caio']);
    signal.update({ cameras: [camera('u_caio')] });
    await settle();
    expect(media.media.unpull).toHaveBeenCalledWith(['ct_u_bia'], expect.anything());
    expect(Object.keys(client.getState().remote)).toEqual(['u_caio']);
  });

  it('enlarges on the high layer and back to the strip’s low layer', async () => {
    const { client, signal, media } = setupCamera();
    signal.admit([participant('u_bia')]);
    signal.update({ cameras: [camera('u_bia'), camera('u_caio', [])] });
    await settle();
    client.enlarge('u_bia');
    expect(media.media.setLayer).toHaveBeenLastCalledWith('ct_u_bia', 'h');
    // A camera without layers has nothing to switch.
    client.enlarge('u_caio');
    expect(media.media.setLayer).toHaveBeenLastCalledWith('ct_u_bia', 'l');
    expect(media.media.setLayer).toHaveBeenCalledTimes(2);
    client.enlarge(null);
    expect(client.getState().enlarged).toBeNull();
    // The enlarged camera turned off: nothing is enlarged any more.
    client.enlarge('u_bia');
    signal.update({ cameras: [] });
    expect(client.getState().enlarged).toBeNull();
  });

  it('puts the cameras the stage shows large on the high layer, on a good network only', async () => {
    const { client, signal, media } = setupCamera();
    signal.admit([participant('u_bia'), participant('u_caio')]);
    signal.update({ cameras: [camera('u_bia'), camera('u_caio')] });
    await settle();
    client.setHighLayers(['u_bia']);
    expect(client.getState().high).toEqual(['u_bia']);
    expect(media.media.setLayer).toHaveBeenLastCalledWith('ct_u_bia', 'h');
    expect(media.media.setLayer).toHaveBeenCalledTimes(1);
    // The same set again changes nothing (no tracks/update).
    client.setHighLayers(['u_bia']);
    expect(media.media.setLayer).toHaveBeenCalledTimes(1);
    // The enlarged one is high too, and stays high when the set moves on.
    client.enlarge('u_caio');
    expect(media.media.setLayer).toHaveBeenLastCalledWith('ct_u_caio', 'h');
    client.setHighLayers([]);
    expect(media.media.setLayer).toHaveBeenLastCalledWith('ct_u_bia', 'l');
    expect(media.media.setLayer).toHaveBeenCalledTimes(3);
    // A poor network keeps everyone low, whatever the stage asks for.
    client.enlarge(null);
    client.setHighLayers(['u_bia', 'u_caio']);
    client.setNetwork('poor');
    await settle();
    expect(media.media.setLayer).toHaveBeenLastCalledWith('ct_u_caio', 'l');
    const layerOf = (trackId: string) =>
      media.media.setLayer.mock.calls.filter(([id]) => id === trackId).at(-1)?.[1];
    expect([layerOf('ct_u_bia'), layerOf('ct_u_caio')]).toEqual(['l', 'l']);
    client.setNetwork('good');
    await settle();
    expect([layerOf('ct_u_bia'), layerOf('ct_u_caio')]).toEqual(['h', 'h']);
  });

  it('gives way to the voice on a bad network: low layer, then no camera at all', async () => {
    const { client, signal, media } = setupCamera();
    signal.admit([participant('u_bia')]);
    signal.update({ cameras: [camera('u_bia')] });
    await client.turnOn();
    await settle();
    client.enlarge('u_bia');
    const own = media.publications[0];

    client.setNetwork('poor');
    await settle();
    expect(media.media.setLayer).toHaveBeenLastCalledWith('ct_u_bia', 'l');
    const poor = own?.layers.at(-1);
    expect([poor?.('h'), poor?.('l')]).toEqual([false, true]);

    client.setNetwork('bad');
    await settle();
    const bad = own?.layers.at(-1);
    expect([bad?.('h'), bad?.('l')]).toEqual([false, false]);
    expect(media.media.unpull).toHaveBeenCalledWith(['ct_u_bia'], expect.anything());
    expect(client.getState().remote).toEqual({});

    client.setNetwork('good');
    await settle();
    expect(media.media.pull).toHaveBeenCalledTimes(2);
    expect(media.media.setLayer).toHaveBeenLastCalledWith('ct_u_bia', 'h');
    const good = own?.layers.at(-1);
    expect([good?.('h'), good?.('l')]).toEqual([true, true]);
  });

  it('publishes and pulls again after a session reset', async () => {
    const { client, signal, media } = setupCamera();
    signal.admit([participant('u_bia')]);
    signal.update({ cameras: [camera('u_bia')] });
    await client.turnOn();
    await settle();
    media.reset();
    await settle();
    expect(media.media.publish).toHaveBeenCalledTimes(2);
    expect(media.media.pull).toHaveBeenCalledTimes(2);
    expect(client.getState().phase).toBe('on');
  });
});

describe('network quality', () => {
  it('reads loss and round trip into good, poor and bad', () => {
    expect(qualityOf({ lossPct: 0, rttMs: 50 })).toBe('good');
    expect(qualityOf({ lossPct: 4, rttMs: 50 })).toBe('poor');
    expect(qualityOf({ lossPct: 0, rttMs: 500 })).toBe('poor');
    expect(qualityOf({ lossPct: 12, rttMs: 50 })).toBe('bad');
  });

  it('measures loss between samples, gets worse at once and better slowly', () => {
    const meter = new NetworkMeter();
    const stats = (lost: number, received: number) => ({
      forEach: (fn: (r: Record<string, unknown> & { type: string; id: string }) => void) => {
        fn({ id: 'A', type: 'inbound-rtp', packetsLost: lost, packetsReceived: received });
        fn({
          id: 'P',
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          currentRoundTripTime: 0.05,
        });
      },
    });
    expect(meter.sample(stats(0, 1000))).toEqual({ lossPct: 0, rttMs: 50 });
    expect(meter.update(meter.sample(stats(200, 1800)))).toBe('bad');
    for (let i = 1; i < RECOVER_SAMPLES; i++) {
      expect(meter.update({ lossPct: 0, rttMs: 50 })).toBe('bad');
    }
    expect(meter.update({ lossPct: 0, rttMs: 50 })).toBe('poor');
  });
});
