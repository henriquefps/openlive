// SPDX-License-Identifier: AGPL-3.0-only

// Budgets for test/free-tier.test.ts: the most each scenario may cost. A change
// that goes over fails the test; raise a budget only with a reason in the ADR. Derivation: the
// measured cost when they were set (in brackets), plus about 25 % headroom for setup noise.
// Daily limits: src/usage/free-tier.ts.

export interface Budget {
  /** Durable Object rows written, by class. */
  doRowsWrittenBy: Record<string, number>;
  doRowsWritten: number;
  doRowsRead: number;
  /** fetch, RPC, alarms and incoming WebSocket messages (counted 1:1). */
  doRequests: number;
  d1RowsWritten: number;
  d1RowsRead: number;
  workerRequests: number;
  /**
   * Workers Logs events, unsampled: invocations (Worker requests, DO requests and WebSocket
   * messages) plus console lines.
   */
  logEvents: number;
}

export const FREE_TIER_BUDGET = {
  /**
   * One hour of a room: 1 streamer, 3 viewers, 3 in voice, 6 chat messages, sidebar and hub. The
   * total is the ADR's target, a tenth of the 3,218 rows the same hour wrote before it; by class
   * the measured value plus headroom.
   */
  hour: {
    doRowsWrittenBy: { RoomDO: 300 /* [267] */, SpaceDO: 25 /* [18] */, UserHubDO: 8 /* [5] */ },
    doRowsWritten: 321, // [290]; before: 3,218
    doRowsRead: 36_000, // [29,730]; before: 52,597
    doRequests: 600, // [479]; before: 1,249
    d1RowsWritten: 60, // [45]; before: 93
    d1RowsRead: 180, // [141]; before: 285
    workerRequests: 35, // [28]
    logEvents: 640, // [507]
  },
  /** One hour of the normal group: 5 friends, 1 streams, 4 watch, all in voice, 20 messages. */
  groupHour: {
    doRowsWrittenBy: { RoomDO: 650 /* [508] */, SpaceDO: 30 /* [20] */, UserHubDO: 8 /* [6] */ },
    doRowsWritten: 685, // [534]; before: 4,388
    doRowsRead: 88_000, // [71,947]; before: 86,840
    doRequests: 910, // [724]; before: 1,732
    d1RowsWritten: 40, // [29]; before: 77
    d1RowsRead: 225, // [179]; before: 323
    workerRequests: 47, // [37]
    logEvents: 960, // [761]
  },
  /** Three hours of the normal group: the ADR's target is under 20,000 rows written a day. */
  groupDayDoRowsWritten: 20_000,
  /**
   * Workers Logs events of that day at the template's sampling (0.1), cron runs included
   *: [239] of the free 200,000. Unsampled it would be about 2,400.
   */
  groupDayLogEvents: 300,
  /**
   * A web tab left open on a stream for 24 hours, nothing else: the outage's shape. SpaceDO is 146
   * presence refreshes (every 10 minutes) and 49 alarm moves (about every 30 minutes: the space's
   * alarm is never run by the test, so it is moved when it falls due). It was [149] only because
   * the scenario inherited another scenario's presence rows; each scenario now starts clean.
   */
  idleDay: {
    doRowsWrittenBy: {
      RoomDO: 1_720 /* [1,377] */,
      SpaceDO: 250 /* [197] */,
      UserHubDO: 8 /* [6] */,
    },
    doRowsWritten: 1_975, // [1,580]; before: 33,932
    doRowsRead: 139_000, // [111,065]; before: 348,743
    doRequests: 4_200, // [3,348]; before: 10,263
    d1RowsWritten: 370, // [294]; before: 1,448
    d1RowsRead: 1_320, // [1,044]; before: 5,121
    workerRequests: 10, // [8]
    logEvents: 4_200, // [3,356]
  },
} satisfies Record<string, Budget | number>;
