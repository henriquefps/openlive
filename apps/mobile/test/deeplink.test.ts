// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parseAppLink, parseScanned } from '../src/lib/deeplink.ts';

const INVITE = 'A'.repeat(21) + '_-' + 'b'.repeat(20);

/** The link the invite page's "Open in app" builds (apps/web/src/api/app.ts, appJoinLink). */
function appJoinLink(origin: string, inviteToken: string): string {
  return `openlive://join?${new URLSearchParams({ instance: origin, invite: inviteToken })}`;
}

describe('parseAppLink', () => {
  it("reads the invite page's Open in app link", () => {
    expect(parseAppLink(appJoinLink('https://openlive.example.com', INVITE))).toEqual({
      kind: 'join',
      instance: 'https://openlive.example.com',
      invite: INVITE,
    });
  });

  it('reads a join link without an invite', () => {
    expect(parseAppLink('openlive://join?instance=https%3A%2F%2Fopenlive.example.com%2F')).toEqual({
      kind: 'join',
      instance: 'https://openlive.example.com',
    });
  });

  it('drops an invite token that is not one', () => {
    expect(
      parseAppLink('openlive://join?instance=https://openlive.example.com&invite=short'),
    ).toEqual({ kind: 'join', instance: 'https://openlive.example.com' });
  });

  it('refuses a join link without a full https address', () => {
    for (const url of [
      'openlive://join',
      'openlive://join?instance=openlive.example.com',
      'openlive://join?instance=http://openlive.example.com',
      'openlive://join?instance=javascript:alert(1)',
      'openlive://joinx?instance=https://openlive.example.com',
    ]) {
      expect(parseAppLink(url)).toEqual({ kind: 'unknown' });
    }
  });

  it('recognises the end of a login', () => {
    expect(parseAppLink('openlive://auth?code=c&state=s')).toEqual({
      kind: 'auth',
      url: 'openlive://auth?code=c&state=s',
    });
  });

  it('ignores other links', () => {
    expect(parseAppLink('https://openlive.example.com')).toEqual({ kind: 'unknown' });
    expect(parseAppLink('openlive://')).toEqual({ kind: 'unknown' });
  });
});

describe('parseScanned', () => {
  it('reads an instance address', () => {
    expect(parseScanned('openlive.example.com')).toEqual({
      kind: 'join',
      instance: 'https://openlive.example.com',
    });
  });

  it('reads an invite page', () => {
    expect(parseScanned(`https://openlive.example.com/invite/${INVITE}`)).toEqual({
      kind: 'join',
      instance: 'https://openlive.example.com',
      invite: INVITE,
    });
  });

  it('reads an app link', () => {
    expect(parseScanned(appJoinLink('https://openlive.example.com', INVITE))).toMatchObject({
      invite: INVITE,
    });
  });

  it('never takes a login redirect from a QR code', () => {
    expect(parseScanned('openlive://auth?code=c&state=s')).toEqual({ kind: 'unknown' });
    expect(parseScanned('just some text')).toEqual({ kind: 'unknown' });
  });
});
