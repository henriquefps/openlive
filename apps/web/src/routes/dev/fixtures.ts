// SPDX-License-Identifier: AGPL-3.0-only
import type { StreamCardProps } from '../../components/StreamCard.tsx';

// Fixture data for /dev/components (development builds only); never shown in production.
export const STREAM_FIXTURES: readonly (StreamCardProps & { id: string })[] = [
  {
    id: 'live',
    name: 'Ana',
    source: 'Hades II',
    height: 1440,
    fps: 60,
    bitrateBps: 12_000_000,
    viewers: { used: 4, limit: 6 },
    status: 'live',
  },
  {
    id: 'full',
    name: 'Bruno',
    source: 'Visual Studio Code',
    height: 1080,
    fps: 30,
    bitrateBps: 4_500_000,
    viewers: { used: 6, limit: 6 },
    status: 'live',
  },
  {
    id: 'paused',
    name: 'Carolina Albuquerque de Mendonça',
    source: 'Entire screen 2 (DELL U2723QE)',
    height: 2160,
    fps: 60,
    bitrateBps: 20_000_000,
    viewers: { used: 2, limit: 6 },
    status: 'paused',
  },
  {
    id: 'failed',
    name: 'Diego',
    height: 720,
    fps: 30,
    bitrateBps: 850_000,
    viewers: { used: 0, limit: 4 },
    status: 'failed',
  },
];
