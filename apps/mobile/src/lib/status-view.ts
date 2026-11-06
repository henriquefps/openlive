// SPDX-License-Identifier: AGPL-3.0-only
import { type StatusSummary } from '@openlive/client';

// The status numbers as the web's StatusSummaryView lays them out; pure formatting rules.

/** The first frame is slow from this median on (the plan's target: under 1 s). */
export const TTFF_TARGET_MS = 1_000;

export const isSlowStart = (medianMs: number | null): boolean =>
  medianMs !== null && medianMs >= TTFF_TARGET_MS;

/** Whether the period has nothing to show (the web's empty notice). */
export const isEmptySummary = (s: StatusSummary): boolean =>
  s.viewerMinutes === 0 && s.streamsEnded === 0 && s.helper.minutes === 0 && s.ttff.count === 0;
