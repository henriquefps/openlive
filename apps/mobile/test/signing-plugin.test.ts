// SPDX-License-Identifier: AGPL-3.0-only
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { patch } = require('../plugins/with-openlive-signing.js') as {
  patch: (s: string) => string;
};
const { versionCode, parseVersion } = require('../plugins/version.js') as {
  versionCode: (v: string, b: number) => number;
  parseVersion: (v: string) => number;
};

const TEMPLATE = `apply plugin: "com.android.application"

android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled true
        }
    }
}
`;

describe('signing plugin', () => {
  it('signs release with a release config and keeps debug on the debug key', () => {
    const out = patch(TEMPLATE);
    expect(out).toContain('OPENLIVE_UPLOAD_STORE_FILE');
    expect(out).toMatch(/release \{[\s\S]*?signingConfig signingConfigs\.release/);
    expect(out).toMatch(/debug \{\s*signingConfig signingConfigs\.debug/);
    expect(out).not.toMatch(/release \{[^}]*?\n\s*signingConfig signingConfigs\.debug/);
    expect(out).toContain('GradleException');
  });
  it('is idempotent', () => {
    const once = patch(TEMPLATE);
    expect(patch(once)).toBe(once);
  });
  it('fails loudly on an unknown template', () => {
    expect(() => patch('android {\n}\n')).toThrow();
  });
});

describe('versionCode', () => {
  it('derives from the version and the build number', () => {
    expect(parseVersion('0.1.4')).toBe(104);
    expect(versionCode('0.1.4', 150)).toBe(1040150);
  });
  it('is monotonic across versions and builds', () => {
    expect(versionCode('0.1.5', 0)).toBeGreaterThan(versionCode('0.1.4', 9999));
    expect(versionCode('0.2.0', 0)).toBeGreaterThan(versionCode('0.1.99', 9999));
    expect(versionCode('0.1.4', 151)).toBeGreaterThan(versionCode('0.1.4', 150));
  });
  it('rejects bad input', () => {
    expect(() => versionCode('0.1', 1)).toThrow();
    expect(() => versionCode('0.1.4', -1)).toThrow();
    expect(() => versionCode('0.100.0', 1)).toThrow();
  });
});
