// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { joinLink, roomMenu } from '../src/lib/room-menu.ts';
import { describeUserAgent } from '../src/lib/user-agent.ts';

const fixed = { kind: 'fixed', createdBy: 'u1', visibility: 'space', code: null } as const;
const restricted = { ...fixed, visibility: 'restricted' } as const;
const quick = {
  kind: 'quick',
  createdBy: 'me',
  visibility: 'space',
  code: 'OL-4821-0937',
} as const;

describe('roomMenu', () => {
  it('gives managers everything of a restricted fixed room', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(roomMenu({ role, selfId: 'me', room: restricted, ended: false })).toEqual({
        code: false,
        features: true,
        access: true,
        close: true,
        empty: false,
      });
    }
  });
  it('shows access only for restricted rooms', () => {
    expect(roomMenu({ role: 'owner', selfId: 'me', room: fixed, ended: false }).access).toBe(false);
  });
  it('lets a member end their own quick room, but not change its features', () => {
    expect(roomMenu({ role: 'member', selfId: 'me', room: quick, ended: false })).toEqual({
      code: true,
      features: false,
      access: false,
      close: true,
      empty: false,
    });
    const others = roomMenu({ role: 'member', selfId: 'other', room: quick, ended: false });
    expect(others.close).toBe(false);
    expect(others.code).toBe(true);
  });
  it('has nothing for guests of a fixed room and for an ended room', () => {
    expect(roomMenu({ role: 'guest', selfId: 'me', room: fixed, ended: false }).empty).toBe(true);
    expect(roomMenu({ role: 'owner', selfId: 'me', room: quick, ended: true }).empty).toBe(true);
  });
});

describe('joinLink', () => {
  it('is the server address and /join/<code>', () => {
    expect(joinLink('https://live.example.com/', 'OL-4821-0937')).toBe(
      'https://live.example.com/join/OL-4821-0937',
    );
  });
});

describe('describeUserAgent', () => {
  it('names the browser and system', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      ),
    ).toEqual({ browser: 'Chrome', os: 'Linux' });
    expect(describeUserAgent(null)).toEqual({ browser: null, os: null });
  });
});

import { TEMPLATES } from '../src/lib/capabilities.ts';
import { chatFormOf, endsStreams, featuresPatch, templateOf } from '../src/lib/room-menu.ts';

describe('features sheet rules', () => {
  const all = { stream: true, voice: true, camera: true, text: true };
  const chat = { retention: 30, guestsCanWrite: true } as const;
  it('reads the stored chat settings with the web defaults', () => {
    expect(chatFormOf({})).toEqual({ retention: 30, guestsCanWrite: true });
    expect(chatFormOf({ chatRetentionDays: 7, guestsCanWrite: false })).toEqual({
      retention: 7,
      guestsCanWrite: false,
    });
    expect(chatFormOf({ chatRetentionDays: 12 }).retention).toBe(30);
  });
  it('finds the template of some capabilities', () => {
    expect(templateOf(TEMPLATES.voice)).toBe('voice');
    expect(templateOf({ stream: true, voice: false, camera: false, text: true })).toBe('custom');
  });
  it('saves nothing when nothing changed', () => {
    expect(
      featuresPatch({ stored: all, value: all, storedChat: chat, chat, ceiling: all }),
    ).toBeNull();
  });
  it('sends capabilities, and chat settings only with text', () => {
    const value = { ...TEMPLATES.streamOnly };
    expect(
      featuresPatch({
        stored: all,
        value,
        storedChat: chat,
        chat: { retention: 7, guestsCanWrite: false },
        ceiling: all,
      }),
    ).toEqual({ settings: { capabilities: value } });
    expect(
      featuresPatch({
        stored: TEMPLATES.streamOnly,
        value: all,
        storedChat: chat,
        chat: { retention: 7, guestsCanWrite: true },
        ceiling: all,
      }),
    ).toEqual({ settings: { capabilities: all, chatRetentionDays: 7, guestsCanWrite: true } });
    expect(
      featuresPatch({
        stored: all,
        value: all,
        storedChat: chat,
        chat: { retention: 0, guestsCanWrite: true },
        ceiling: all,
      }),
    ).toEqual({ settings: { capabilities: all, chatRetentionDays: 0, guestsCanWrite: true } });
  });
  it('refuses invalid capabilities and ones above the space', () => {
    const none = { stream: false, voice: false, camera: false, text: false };
    expect(
      featuresPatch({ stored: all, value: none, storedChat: chat, chat, ceiling: all }),
    ).toBeNull();
    expect(
      featuresPatch({
        stored: TEMPLATES.streamOnly,
        value: all,
        storedChat: chat,
        chat,
        ceiling: TEMPLATES.streamOnly,
      }),
    ).toBeNull();
  });
  it('warns when stream goes off while streams are live', () => {
    expect(endsStreams(all, TEMPLATES.voice, 1)).toBe(true);
    expect(endsStreams(all, TEMPLATES.voice, 0)).toBe(false);
    expect(endsStreams(TEMPLATES.voice, all, 2)).toBe(false);
  });
});
