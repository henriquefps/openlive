// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { ProxyOptions } from 'vite';
import { defineConfig } from 'vitest/config';

// apps/api's `pnpm dev` (wrangler dev) listens on 8790. Both ports can be moved, so two checkouts
// can run side by side: OPENLIVE_API=http://localhost:8796 OPENLIVE_WEB_PORT=5185.
const API = process.env['OPENLIVE_API'] ?? 'http://localhost:8790';
const WEB_PORT = Number(process.env['OPENLIVE_WEB_PORT'] ?? 5179);

/**
 * Development only: a `openlive_dev_user=<userId>` cookie becomes the X-Openlive-Dev-User header
 * on proxied requests, so two browser profiles can act as two users without signing in. The API
 * honours the header only with DEV_AUTH=1 on localhost (apps/api/src/room/identity.ts).
 */
function devUser(req: IncomingMessage): string | undefined {
  return /(?:^|;\s*)openlive_dev_user=([A-Za-z0-9_-]{1,64})(?:;|$)/.exec(
    req.headers.cookie ?? '',
  )?.[1];
}

/**
 * The headers of public/_headers' `/*` rule (CSP and the rest, apps/api/src/security/headers.ts),
 * so `vite preview` serves the build the way Workers Static Assets does. Not for `vite dev`: its
 * hot reload needs an inline script the policy refuses.
 */
function staticHeaders(): Record<string, string> {
  const text = readFileSync(path.resolve(import.meta.dirname, 'public/_headers'), 'utf8');
  const out: Record<string, string> = {};
  let inAll = false;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      inAll = line.trim() === '/*';
      continue;
    }
    const at = line.indexOf(':');
    if (inAll && at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

const withDevUser: ProxyOptions['configure'] = (proxy) => {
  proxy.on('proxyReq', (proxyReq, req) => {
    const user = devUser(req);
    if (user) proxyReq.setHeader('X-Openlive-Dev-User', user);
  });
  proxy.on('proxyReqWs', (proxyReq, req) => {
    const user = devUser(req);
    if (user) proxyReq.setHeader('X-Openlive-Dev-User', user);
  });
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: {
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      '/api': { target: API, configure: withDevUser },
      '/ws': { target: API, ws: true, configure: withDevUser },
      '/.well-known/openlive.json': { target: API },
    },
  },
  preview: { port: WEB_PORT, strictPort: true, headers: staticHeaders() },
  build: {
    rolldownOptions: {
      output: {
        // Pages are split per route (router.tsx). Libraries that change rarely get their own
        // chunks, so a release that only changes app code keeps them cached in the browser.
        codeSplitting: {
          groups: [
            { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'tanstack', test: /[\\/]node_modules[\\/]@tanstack[\\/]/ },
            { name: 'radix', test: /[\\/]node_modules[\\/](radix-ui|@radix-ui)[\\/]/ },
            { name: 'i18n', test: /[\\/]node_modules[\\/](i18next|react-i18next)[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
});
