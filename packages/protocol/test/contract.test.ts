// SPDX-License-Identifier: AGPL-3.0-only
// Contract tests: the fixtures in fixtures/ must be judged the same way here and in go/
// (protocol_test.go). Valid fixtures pass the strict schema and the runtime parser unchanged;
// invalid fixtures fail the strict schema. Fixtures named *.unknown-field.json only carry
// unknown properties, which the lenient runtime parser strips instead of rejecting.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAjv, messageSchemas, packageRoot, type Schema } from '../scripts/schemas.ts';
import {
  encodeMessage,
  ErrorCode,
  MESSAGE_INFO,
  MessageType,
  parseMessage,
  PING_FRAME,
  PONG_FRAME,
  PROTOCOL_VERSION,
  REST_BODIES,
} from '../src/index.js';

const fixturesDir = join(packageRoot, 'fixtures');

function loadFixtures(kind: 'valid' | 'invalid'): { name: string; data: unknown }[] {
  return readdirSync(join(fixturesDir, kind))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({
      name: f,
      data: JSON.parse(readFileSync(join(fixturesDir, kind, f), 'utf8')) as unknown,
    }));
}

const strict = createAjv('strict');
const envelopeId = 'https://openlive.invalid/protocol/v1/envelope.json';
const schemaIdByType = new Map<string, string>(
  messageSchemas.map(({ schema }) => [
    (schema['properties'] as Record<string, Schema>)['type']?.['const'] as string,
    schema['$id'] as string,
  ]),
);

function strictlyValid(data: unknown): boolean {
  if (!strict.validate(envelopeId, data)) return false;
  const id = schemaIdByType.get((data as { type: string }).type);
  return id !== undefined && strict.validate(id, data);
}

const valid = loadFixtures('valid');
const invalid = loadFixtures('invalid');

describe('valid fixtures', () => {
  it.each(valid)('$name passes the strict schema', ({ data }) => {
    expect(strictlyValid(data)).toBe(true);
  });

  it.each(valid)('$name is accepted unchanged by parseMessage', ({ data }) => {
    const frame = JSON.stringify(data);
    const result = parseMessage(frame);
    expect(result).toEqual({ ok: true, message: data });
  });

  it('cover every message type', () => {
    const covered = new Set(valid.map(({ data }) => (data as { type: string }).type));
    expect([...Object.values(MessageType)].filter((t) => !covered.has(t))).toEqual([]);
  });
});

describe('invalid fixtures', () => {
  it.each(invalid)('$name fails the strict schema', ({ data }) => {
    expect(strictlyValid(data)).toBe(false);
  });

  it.each(invalid)('$name is handled by parseMessage per the receiver rules', ({ name, data }) => {
    const result = parseMessage(structuredClone(data));
    if (name.endsWith('.unknown-field.json')) {
      expect(result.ok).toBe(true);
      expect(strictlyValid(result.ok && result.message)).toBe(true);
    } else {
      expect(result.ok).toBe(false);
    }
  });
});

describe('parseMessage', () => {
  it('rejects non-JSON as invalid_message', () => {
    expect(parseMessage('{nope')).toEqual({
      ok: false,
      error: { code: ErrorCode.InvalidMessage, path: '' },
    });
  });

  it('reports unknown types with the id so the receiver can answer', () => {
    expect(parseMessage('{"type":"stream.rewind","id":"5","payload":{}}')).toEqual({
      ok: false,
      id: '5',
      error: { code: ErrorCode.UnknownMessageType, messageType: 'stream.rewind' },
    });
  });

  it('points at the offending field', () => {
    const result = parseMessage('{"type":"slot.request","id":"7","payload":{"streamId":"a b"}}');
    expect(result).toEqual({
      ok: false,
      id: '7',
      error: { code: ErrorCode.InvalidMessage, path: '/payload/streamId' },
    });
  });
});

describe('encodeMessage', () => {
  it('round-trips through parseMessage', () => {
    const frame = encodeMessage(MessageType.SlotRequest, { streamId: 'st_1' }, '7');
    expect(frame).toBe('{"type":"slot.request","id":"7","payload":{"streamId":"st_1"}}');
    expect(parseMessage(frame).ok).toBe(true);
  });

  it('produces the exact ping and pong frames used for hibernation auto-response', () => {
    expect(encodeMessage(MessageType.Ping, {})).toBe(PING_FRAME);
    expect(encodeMessage(MessageType.Pong, {})).toBe(PONG_FRAME);
  });
});

describe('catalogue', () => {
  const doc = readFileSync(join(packageRoot, '..', '..', 'docs', 'PROTOCOL.md'), 'utf8');

  it.each(Object.values(MessageType))('docs/PROTOCOL.md documents %s', (type) => {
    expect(doc).toContain(`\`${type}\``);
  });

  it.each(Object.values(ErrorCode))('docs/PROTOCOL.md documents error code %s', (code) => {
    expect(doc).toContain(`\`${code}\``);
  });

  it('docs/PROTOCOL.md states the protocol version', () => {
    expect(doc).toContain(
      `Protocol version: **${String(PROTOCOL_VERSION.major)}.${String(PROTOCOL_VERSION.minor)}**`,
    );
  });

  it("the catalogue in docs/PROTOCOL.md section 9 has the schema's phase for every type", () => {
    const catalogue = doc.slice(doc.indexOf('## 9. Message catalogue'), doc.indexOf('## 10.'));
    // Table rows: | `type` | phase | direction | payload | reply |
    const phases = new Map(
      catalogue
        .split('\n')
        .map((line) => line.split('|').map((cell) => cell.trim()))
        .filter((cells) => /^`[a-zA-Z.]+`$/.test(cells[1] ?? ''))
        .map((cells) => [cells[1]?.slice(1, -1), Number(cells[2])]),
    );
    for (const [type, info] of Object.entries(MESSAGE_INFO)) {
      expect(phases.get(type), `catalogue row for ${type}`).toBe(info.phase);
    }
    expect(phases.size).toBe(Object.keys(MESSAGE_INFO).length);
  });
});

describe('REST fixtures', () => {
  // fixtures/rest/<Body>[.<label>].json: one valid example per body of rest.json, also decoded
  // into the generated Go types by protocol_test.go.
  const restId = 'https://openlive.invalid/protocol/v1/rest.json';
  const rest = readdirSync(join(fixturesDir, 'rest'))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({
      name: f,
      body: f.split('.')[0] ?? '',
      data: JSON.parse(readFileSync(join(fixturesDir, 'rest', f), 'utf8')) as unknown,
    }));

  it.each(rest)('$name passes the strict schema of its body', ({ body, data }) => {
    expect(REST_BODIES as readonly string[]).toContain(body);
    expect(strict.validate(`${restId}#/$defs/${body}`, data), JSON.stringify(strict.errors)).toBe(
      true,
    );
  });

  it('cover every REST body', () => {
    const covered = new Set(rest.map((r) => r.body));
    expect(REST_BODIES.filter((b) => !covered.has(b))).toEqual([]);
  });

  it('refuse unknown fields and bad values', () => {
    const v = (body: string, data: unknown) => strict.validate(`${restId}#/$defs/${body}`, data);
    expect(v('DeviceTokenRequest', { deviceCode: 'x', extra: 1 })).toBe(false);
    expect(v('DeviceCodeRequest', { os: 'beos', arch: 'amd64', helperVersion: '0.1.0' })).toBe(
      false,
    );
    expect(v('DeviceApproveRequest', { userCode: 'K7F2Q', name: 'PC' })).toBe(false);
    expect(
      v('PublishRequest', { sessionDescription: { type: 'offer', sdp: 'v=0' }, tracks: [] }),
    ).toBe(false);
  });

  it.each(REST_BODIES)('docs/PROTOCOL.md documents %s', (body) => {
    const doc = readFileSync(join(packageRoot, '..', '..', 'docs', 'PROTOCOL.md'), 'utf8');
    expect(doc).toContain(`\`${body}\``);
  });
});
