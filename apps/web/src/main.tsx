// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { queryClient } from './api/query-client.ts';
import './i18n/index.ts';
import './index.css';
import { removeRetiredKeys } from './lib/storage-cleanup.ts';
import { router } from './router.tsx';
import { initTheme } from './theme/theme.ts';

initTheme();
removeRetiredKeys();

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

// The installable PWA: public/sw.js caches the app shell only. Production
// builds only, so the dev server never serves stale modules.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
