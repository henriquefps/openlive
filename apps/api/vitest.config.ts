// SPDX-License-Identifier: AGPL-3.0-only
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // Development identity for the REST and WebSocket tests (src/room/identity.ts); the
          // tests call http://localhost so it applies.
          DEV_AUTH: '1',
          // Login (test/auth.test.ts). Test-only values: Discord and Resend are never called,
          // the tests replace fetch and the e-mail sender.
          APP_ORIGIN: 'https://openlive.example',
          SESSION_SECRET: 'test-session-secret',
          DISCORD_CLIENT_ID: 'test-client-id',
          DISCORD_CLIENT_SECRET: 'test-client-secret',
          INSTALL_CODE: 'test-install-code',
          // SFU proxy (test/rtc.test.ts). Test-only values: Realtime is never called, the tests
          // replace fetch with a fake SFU.
          REALTIME_APP_ID: 'test-app',
          REALTIME_APP_TOKEN: 'test-app-token',
          TURN_KEY_ID: 'test-turn-key',
          TURN_KEY_TOKEN: 'test-turn-token',
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
        },
      },
    })),
  ],
  test: {
    globalSetup: ['./test/global-setup.ts'],
  },
});
