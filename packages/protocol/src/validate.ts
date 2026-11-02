// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorObject } from 'ajv';
import { ErrorCode, MessageType } from './generated/types.js';
import type { ErrorPayload, Message, MessageId, PayloadOf } from './generated/types.js';
import { envelopeValidator, messageValidators } from './generated/validators.js';

export type ParseResult =
  | { ok: true; message: Message }
  | {
      ok: false;
      /** Ready to send back as the payload of an error message. */
      error: ErrorPayload;
      /** The id of the offending message, when it had a readable one. */
      id?: MessageId;
    };

const knownTypes = new Set<string>(Object.values(MessageType));

export function isMessageType(type: string): type is MessageType {
  return knownTypes.has(type);
}

function invalid(errors: ErrorObject[] | null | undefined, id?: MessageId): ParseResult {
  const path = errors?.[0]?.instancePath ?? '';
  return {
    ok: false,
    error: { code: ErrorCode.InvalidMessage, path: path.slice(0, 256) },
    ...(id ? { id } : {}),
  };
}

/**
 * Parses and validates one received frame (a JSON string or an already parsed value).
 *
 * Follows the receiver rules of docs/PROTOCOL.md: unknown properties are removed, not rejected;
 * an unknown message type yields unknown_message_type (ignore it unless it carried an id).
 * A parsed value is modified in place.
 */
export function parseMessage(frame: unknown): ParseResult {
  let data: unknown = frame;
  if (typeof frame === 'string') {
    try {
      data = JSON.parse(frame);
    } catch {
      return invalid(null);
    }
  }
  if (!envelopeValidator(data)) return invalid(envelopeValidator.errors);
  const envelope = data as { type: string; id?: MessageId };
  if (!isMessageType(envelope.type)) {
    const error: ErrorPayload = { code: ErrorCode.UnknownMessageType, messageType: envelope.type };
    return { ok: false, error, ...(envelope.id ? { id: envelope.id } : {}) };
  }
  const validate = messageValidators[envelope.type];
  if (!validate(data)) return invalid(validate.errors, envelope.id);
  return { ok: true, message: data as Message };
}

/** Serializes a message. Types are checked at compile time; nothing is validated at runtime. */
export function encodeMessage<T extends MessageType>(
  type: T,
  payload: PayloadOf<T>,
  id?: MessageId,
): string {
  return JSON.stringify(id === undefined ? { type, payload } : { type, id, payload });
}

/**
 * The exact ping and pong frames. The Durable Objects answer ping with
 * state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME)),
 * which matches the request byte for byte, so clients must send exactly PING_FRAME.
 */
export const PING_FRAME = '{"type":"ping","payload":{}}';
export const PONG_FRAME = '{"type":"pong","payload":{}}';
