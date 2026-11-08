// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StatusSummary } from '../src/api/status.ts';
import { StatusSummaryView, StatusUnavailableAlert } from '../src/components/status/StatusView.tsx';
import '../src/i18n/index.ts';

// The status numbers as the space status tab and /admin show them.

const ttff = (medianMs: number | null, count: number) => ({ count, medianMs, p90Ms: medianMs });

const SUMMARY: StatusSummary = {
  streamsEnded: 4,
  streamsDropped: 1,
  dropRate: 0.25,
  viewerMinutes: 120,
  freezesPerHour: 1.5,
  reconnects: 2,
  decodeErrors: 0,
  ttff: { ...ttff(412, 20), click: ttff(980, 8), prepull: ttff(120, 12) },
  helper: {
    minutes: 60,
    sentFps: 59.5,
    capturedFps: 60,
    sentKbps: 7_500,
    cpuPct: 10,
    keyframeRequestsPerHour: 30,
    idrMaxBytes: 180_000,
  },
  topErrors: [{ code: 'slot_not_found', count: 5 }],
  breakerTrips: [{ object: 'RoomDO', cause: 'alarm', count: 2 }],
};

const value = (label: string) =>
  screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;

describe('StatusSummaryView', () => {
  it('shows first frame, freezes, viewer minutes, drops, the helpers and the top errors', () => {
    render(<StatusSummaryView summary={SUMMARY} />);
    expect(value('Median first frame')).toBe('412 ms');
    expect(screen.getByText('Pre-pulled 120 ms · on click 980 ms')).toBeInTheDocument();
    expect(value('Freezes per hour')).toBe('1.5');
    expect(value('Viewer minutes')).toBe('120');
    expect(value('Dropped streams')).toBe('25%');
    expect(screen.getByText('1 of 4 ended streams')).toBeInTheDocument();
    expect(value('Largest keyframe')).toBe('180 KB');
    expect(screen.getByText('slot_not_found')).toBeInTheDocument();
    expect(screen.getByText('RoomDO · alarm')).toBeInTheDocument();
  });

  it('says when there is nothing yet', () => {
    render(
      <StatusSummaryView
        summary={{
          ...SUMMARY,
          streamsEnded: 0,
          streamsDropped: 0,
          dropRate: null,
          viewerMinutes: 0,
          freezesPerHour: null,
          ttff: { ...ttff(null, 0), click: ttff(null, 0), prepull: ttff(null, 0) },
          helper: { ...SUMMARY.helper, minutes: 0 },
          topErrors: [],
          breakerTrips: [],
        }}
      />,
    );
    expect(screen.getByText('No streams or viewers in this period yet.')).toBeInTheDocument();
    expect(value('Median first frame')).toBe('—');
    expect(screen.getByText('No helper reports in this period.')).toBeInTheDocument();
    expect(screen.getByText('No object was stopped in this period.')).toBeInTheDocument();
  });
});

describe('StatusUnavailableAlert', () => {
  it('names the missing secrets', () => {
    render(
      <StatusUnavailableAlert
        status={{ available: false, reason: 'not_configured', missing: ['CLOUDFLARE_API_TOKEN'] }}
      />,
    );
    expect(screen.getByText(/Set CLOUDFLARE_API_TOKEN on the Worker/)).toBeInTheDocument();
  });

  it('names the permission the token needs', () => {
    render(
      <StatusUnavailableAlert
        status={{ available: false, reason: 'permission', permission: 'Account Analytics: Read' }}
      />,
    );
    expect(screen.getByText(/Account Analytics: Read/)).toBeInTheDocument();
  });
});
