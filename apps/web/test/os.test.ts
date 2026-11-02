// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { detectDesktopOs } from '../src/lib/os.ts';

describe('detectDesktopOs', () => {
  it('detects the three desktop systems', () => {
    expect(detectDesktopOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(detectDesktopOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macos');
    expect(detectDesktopOs('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });

  it('returns undefined for phones and tablets', () => {
    expect(detectDesktopOs('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(
      undefined,
    );
    expect(detectDesktopOs('Mozilla/5.0 (Linux; Android 15; Pixel 9)')).toBe(undefined);
  });
});
