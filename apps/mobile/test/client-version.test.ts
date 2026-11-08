// SPDX-License-Identifier: AGPL-3.0-only
import { parseMessage } from '@openlive/protocol';
import { describe, expect, it } from 'vitest';
import { helloClientVersion } from '../src/lib/client-version.ts';

describe('helloClientVersion', () => {
  it('is semver with build metadata, so the room accepts the hello', () => {
    expect(helloClientVersion('0.1.0')).toBe('0.1.0+mobile');
    const frame = {
      type: 'hello',
      id: '1',
      payload: {
        protocol: { major: 1, minor: 22 },
        client: 'web',
        clientVersion: helloClientVersion('0.1.0'),
        tabId: '00000000-0000-0000-0000-000000000001',
      },
    };
    expect(parseMessage(frame).ok).toBe(true);
  });

  it('falls back when the app version is missing or not semver', () => {
    expect(helloClientVersion(undefined)).toBe('0.0.0+mobile');
    expect(helloClientVersion('dev')).toBe('0.0.0+mobile');
  });
});
