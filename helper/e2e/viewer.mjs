// SPDX-License-Identifier: AGPL-3.0-only
// Local end-to-end viewer for the helper (helper/README.md, "Local end-to-end loop").
//
// Pulls a live stream through the real Worker routes the web player uses (PROTOCOL.md §11.2):
// POST .../ice → POST .../session (data-channel offer) → slot.request on the room socket →
// POST .../subscribe → PUT .../renegotiate, then reports framesDecoded, resolution and fps per
// simulcast layer and how long each PUT .../layer switch takes to show on the decoder.
//
// The viewer is the DEV_AUTH identity (X-Openlive-Dev-User), so it only works against
// `wrangler dev` on localhost. Signaling runs in Node (a browser cannot set that header on a
// WebSocket); the RTCPeerConnection runs in headless Chrome through playwright-core.
//
// CODEC=av1 asks for the stream's AV1 track (protocol 1.14), CODEC=h264 forces
// H.264; without it the viewer asks for nothing and gets H.264. EXPECT_CODEC fails the run unless
// getStats reports that codec (video/AV1, video/H264) for the decoded video.
//
//   INSTANCE=http://localhost:8790 ROOM=rm_… DEV_USER=u_… \
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME=/usr/bin/google-chrome-stable \
//   node helper/e2e/viewer.mjs

/* global window, document, RTCPeerConnection, MediaStream */
import { createRequire } from 'node:module';

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
};
const INSTANCE = env('INSTANCE', 'http://localhost:8790');
const ROOM = env('ROOM');
const DEV_USER = env('DEV_USER');
const CHROME = env('CHROME', '/usr/bin/google-chrome-stable');
const SAMPLE_MS = Number(env('SAMPLE_MS', '5000'));
const LAYERS = env('LAYERS', 'f,h,q,f').split(',');
const CODEC = process.env.CODEC;
const EXPECT_CODEC = process.env.EXPECT_CODEC;
const require = createRequire(import.meta.url);
const { chromium } = require(env('PLAYWRIGHT_CORE', 'playwright-core'));

const headers = { 'X-Openlive-Dev-User': DEV_USER, Origin: INSTANCE };
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

async function rest(method, path, body) {
  const res = await fetch(INSTANCE + path, {
    method,
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const rtc = (method, route, body) => rest(method, `/api/rtc/rooms/${ROOM}/${route}`, body);

/** The room socket as a web tab (PROTOCOL.md §4): requests by id, events by type. */
async function roomSocket() {
  const url = INSTANCE.replace(/^http/, 'ws') + `/ws/rooms/${ROOM}`;
  const ws = new WebSocket(url, { headers });
  const pending = new Map();
  const waiters = [];
  let next = 0;
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    for (const w of waiters.splice(0)) if (!w(msg)) waiters.push(w);
  });
  await new Promise((ok, fail) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', fail, { once: true });
  });
  const request = (type, payload) =>
    new Promise((ok, fail) => {
      const id = String(++next);
      pending.set(id, (msg) =>
        msg.type === 'error' ? fail(new Error(`${type}: ${JSON.stringify(msg.payload)}`)) : ok(msg),
      );
      ws.send(JSON.stringify({ type, id, payload }));
    });
  const event = (type, match = () => true, timeoutMs = 30000) =>
    new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error(`no ${type} in ${timeoutMs} ms`)), timeoutMs);
      waiters.push((msg) => {
        if (msg.type !== type || !match(msg.payload)) return false;
        clearTimeout(t);
        ok(msg.payload);
        return true;
      });
    });
  const ping = setInterval(() => ws.send('{"type":"ping","payload":{}}'), 30000);
  const close = () => {
    clearInterval(ping);
    ws.close(1000);
  };
  return { request, event, close };
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
let room;
let session;
let streamId;
let slotId;
let renew;
try {
  room = await roomSocket();
  const welcome = (
    await room.request('hello', {
      protocol: { major: 1, minor: 1 },
      client: 'web',
      clientVersion: '0.1.0-e2e',
      tabId: 'e2e-viewer',
    })
  ).payload;
  let stream = welcome.streams[0];
  if (!stream) {
    log('no stream yet, waiting for stream.started');
    stream = (await room.event('stream.started', () => true, 60000)).stream;
  }
  streamId = stream.streamId;
  log('stream', streamId, 'preset', stream.preset, 'device', stream.deviceId);

  const page = await browser.newPage();
  const { iceServers } = await rtc('POST', 'ice');
  log(
    'ice servers',
    iceServers
      .map((s) => s.urls)
      .flat()
      .map((u) => u.split('?')[0])
      .join(' '),
  );

  // 1. Pre-connect: one viewer session with a data-channel offer.
  const offer = await page.evaluate(async (ice) => {
    const pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle' });
    window.pc = pc;
    pc.createDataChannel('pre');
    pc.ontrack = (e) => {
      if (e.track.kind !== 'video') return;
      const v = document.createElement('video');
      v.muted = true;
      v.autoplay = true;
      v.srcObject = new MediaStream([e.track]);
      document.body.append(v);
    };
    await pc.setLocalDescription(await pc.createOffer());
    return { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
  }, iceServers);
  const t0 = Date.now();
  const s = await rtc('POST', 'session', { sessionDescription: offer });
  session = s.sessionId;
  await page.evaluate((answer) => window.pc.setRemoteDescription(answer), s.sessionDescription);
  await page.waitForFunction(() => window.pc.connectionState === 'connected', null, {
    timeout: 15000,
  });
  log('session', session.slice(0, 12) + '…', 'DTLS connected in', Date.now() - t0, 'ms');

  // 2. Slot, subscribe, answer the SFU's offer.
  const t1 = Date.now();
  slotId = (await room.request('slot.request', { streamId })).payload.slotId;
  renew = setInterval(
    () => room.request('slot.renew', { slotId }).catch((e) => log('renew', e.message)),
    10000,
  );
  // POST .../subscribe, then the SFU's offer answered through PUT .../renegotiate. The stats
  // follow the pulled video's mid: a pull again leaves the old m-section on the session.
  let videoMid = null;
  const subscribe = async (rid) => {
    const res = await rtc('POST', 'subscribe', {
      sessionId: session,
      slotId,
      streamId,
      ...(rid ? { rid } : {}),
      ...(CODEC ? { codec: CODEC } : {}),
    });
    log(
      'subscribe',
      JSON.stringify({
        codec: res.codec,
        rid: res.rid,
        tracks: res.tracks,
        requiresImmediateRenegotiation: res.requiresImmediateRenegotiation,
      }),
    );
    if (res.sessionDescription) {
      const answer = await page.evaluate(async (o) => {
        await window.pc.setRemoteDescription(o);
        await window.pc.setLocalDescription(await window.pc.createAnswer());
        return { type: 'answer', sdp: window.pc.localDescription.sdp };
      }, res.sessionDescription);
      await rtc('PUT', 'renegotiate', { sessionId: session, sessionDescription: answer });
    }
    videoMid = res.tracks.find((t) => t.kind === 'video')?.mid ?? null;
    return res;
  };
  const sub = await subscribe();

  const video = () =>
    page.evaluate(async (mid) => {
      const stats = await window.pc.getStats();
      for (const r of stats.values()) {
        if (r.type === 'inbound-rtp' && r.kind === 'video' && (mid === null || r.mid === mid)) {
          return {
            codec: stats.get(r.codecId)?.mimeType ?? null,
            decoder: r.decoderImplementation ?? null,
            framesDecoded: r.framesDecoded ?? 0,
            width: r.frameWidth ?? 0,
            height: r.frameHeight ?? 0,
            fps: r.framesPerSecond ?? 0,
            keyFramesDecoded: r.keyFramesDecoded ?? 0,
            bytes: r.bytesReceived ?? 0,
            lost: r.packetsLost ?? 0,
            received: r.packetsReceived ?? 0,
            freezes: r.freezeCount ?? 0,
          };
        }
      }
      return null;
    }, videoMid);
  const until = async (pred, timeoutMs) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await video();
      if (v && pred(v)) return v;
      if (Date.now() > end) throw new Error(`timeout; last ${JSON.stringify(v)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const first = await until((v) => v.framesDecoded > 0, 15000);
  log(
    'first frame decoded',
    Date.now() - t1,
    'ms after slot.request',
    `${first.width}x${first.height}`,
    'codec',
    first.codec,
    'decoder',
    first.decoder,
  );
  if (EXPECT_CODEC && first.codec?.toLowerCase() !== EXPECT_CODEC.toLowerCase()) {
    throw new Error(`getStats codec ${first.codec}, expected ${EXPECT_CODEC}`);
  }

  // Layer sizes: the ones the helper announced (protocol 1.19: the source's aspect ratio, so a
  // native stream of a 3440x1440 monitor is 3440x1440), else the presets'
  // (internal/media/presets.go; F_SIZE for f, 1080p60 by default). A switch is recognised by
  // the height alone.
  const want = {
    f: env('F_SIZE', '1920x1080').split('x').map(Number),
    h: [1280, 720],
    q: [854, 480],
  };
  for (const l of stream.layers ?? []) want[l.rid] = [l.width, l.height];
  if (stream.layers)
    log(
      'announced layers',
      stream.layers.map((l) => `${l.rid}=${l.width}x${l.height}@${l.fps}/${l.kbps}k`).join(' '),
    );
  const sample = async (rid) => {
    const a = await video();
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
    const b = await video();
    const secs = SAMPLE_MS / 1000;
    const row = {
      rid,
      codec: b.codec,
      resolution: `${b.width}x${b.height}`,
      fps: +((b.framesDecoded - a.framesDecoded) / secs).toFixed(1),
      statsFps: b.fps,
      kbps: Math.round(((b.bytes - a.bytes) * 8) / secs / 1000),
      framesDecoded: `${a.framesDecoded} → ${b.framesDecoded}`,
      lostPct: +(
        (100 * (b.lost - a.lost)) /
        Math.max(1, b.received - a.received + b.lost - a.lost)
      ).toFixed(2),
      freezes: b.freezes - a.freezes,
    };
    log('layer', JSON.stringify(row));
    return row;
  };
  const rows = [];
  let current = sub.rid ?? 'f';
  let codec = sub.codec ?? 'h264';
  rows.push({ ...(await sample(current)), switchMs: null });
  for (const rid of LAYERS.slice(1)) {
    const target = want[rid];
    const start = Date.now();
    if (codec === 'av1') {
      // The AV1 track is the top layer alone: another layer is a new pull,
      // which the Worker answers with the H.264 track (and the top layer with AV1 again).
      codec = (await subscribe(rid)).codec ?? 'h264';
      await until((v) => v.height === target[1] && v.framesDecoded > 0, 15000);
      const switchMs = Date.now() - start;
      log(`layer ${current} → ${rid}: pulled again in ${codec}, decoded after ${switchMs} ms`);
      current = rid;
      rows.push({ ...(await sample(rid)), switchMs, putMs: null });
      continue;
    }
    const before = await video();
    await rtc('PUT', 'layer', { sessionId: session, streamId, rid });
    const putMs = Date.now() - start;
    await until((v) => v.height === target[1] && v.framesDecoded > before.framesDecoded, 10000);
    const switchMs = Date.now() - start;
    log(`layer ${current} → ${rid}: PUT ${putMs} ms, new resolution decoded after ${switchMs} ms`);
    current = rid;
    rows.push({ ...(await sample(rid)), switchMs, putMs });
  }
  console.table(rows);
  if (!rows.every((r) => r.fps > 0)) throw new Error('framesDecoded did not grow on every layer');
  log('OK: framesDecoded grows on every layer');
} finally {
  clearInterval(renew);
  if (session) {
    await rtc('POST', 'unsubscribe', { sessionId: session, streamId }).catch((e) =>
      log('unsubscribe', e.message),
    );
    if (slotId) await room.request('slot.release', { slotId }).catch(() => {});
    await rest('POST', '/api/rtc/leave', { roomId: ROOM, sessionId: session }).catch((e) =>
      log('leave', e.message),
    );
  }
  room?.close();
  await browser.close();
}
