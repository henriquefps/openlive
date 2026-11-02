// SPDX-License-Identifier: AGPL-3.0-only
// Real Realtime egress from Cloudflare's GraphQL Analytics API: `callsUsageAdaptiveGroups` (SFU) and
// `callsTurnUsageAdaptiveGroups` (TURN), per day. The data is sampled and the
// SFU dataset is Beta, so it checks the estimate rather than replacing the
// invoice. SFU + TURN is an upper bound (relayed bytes are billed once).
// The token is a parameter: nothing here reads secrets.

export const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

/** The datasets keep 32 days, and one query may span at most 32 days. */
export const MAX_WINDOW_MS = 32 * 24 * 60 * 60 * 1000;

export interface UsageQueryParams {
  accountId: string;
  /** The Realtime SFU app. */
  appId: string;
  /** Restrict TURN to these keys; all keys of the account when omitted. */
  turnKeyIds?: readonly string[];
  /** Window start, inclusive. */
  start: Date;
  /** Window end, exclusive. */
  end: Date;
}

export interface GraphQLRequest {
  query: string;
  variables: Record<string, unknown>;
}

export function buildUsageQuery(p: UsageQueryParams): GraphQLRequest {
  const span = p.end.getTime() - p.start.getTime();
  if (!(span > 0 && span <= MAX_WINDOW_MS)) {
    throw new RangeError('usage window must be positive and at most 32 days');
  }
  const turnFilter = p.turnKeyIds ? ', keyId_in: $turnKeyIds' : '';
  const turnVar = p.turnKeyIds ? ', $turnKeyIds: [string!]' : '';
  const query = `query Usage($account: string!, $appIds: [string!], $start: Time!, $end: Time!${turnVar}) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      sfuByDay: callsUsageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end, appId_in: $appIds }, orderBy: [date_ASC]) {
        dimensions { appId date }
        sum { egressBytes }
      }
      turnByDay: callsTurnUsageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end${turnFilter} }, orderBy: [date_ASC]) {
        dimensions { keyId date }
        sum { egressBytes }
      }
    }
  }
}`;
  const variables: Record<string, unknown> = {
    account: p.accountId,
    appIds: [p.appId],
    start: p.start.toISOString(),
    end: p.end.toISOString(),
  };
  if (p.turnKeyIds) variables.turnKeyIds = [...p.turnKeyIds];
  return { query, variables };
}

export type UsageService = 'sfu' | 'turn';

/** Egress of one SFU app or TURN key on one UTC day. */
export interface DailyUsageRow {
  day: string;
  service: UsageService;
  /** The SFU appId or the TURN keyId. */
  resourceId: string;
  egressBytes: number;
}

export interface RealtimeUsage {
  rows: DailyUsageRow[];
  sfuEgressBytes: number;
  turnEgressBytes: number;
  /** SFU + TURN (an upper bound). */
  totalEgressBytes: number;
  /** Totals per SFU app. */
  byApp: Record<string, number>;
  /** SFU + TURN per UTC day. */
  byDay: Record<string, number>;
}

interface Group {
  dimensions?: { appId?: string; keyId?: string; date?: string };
  sum?: { egressBytes?: number };
}

interface UsageResponse {
  data?: { viewer?: { accounts?: { sfuByDay?: Group[]; turnByDay?: Group[] }[] } } | null;
  errors?: { message: string }[] | null;
}

export class RealtimeUsageError extends Error {
  constructor(
    readonly code: 'http_error' | 'graphql_error' | 'bad_response',
    message: string,
  ) {
    super(message);
    this.name = 'RealtimeUsageError';
  }
}

export function parseUsageResponse(json: unknown): RealtimeUsage {
  const resp = json as UsageResponse;
  if (resp.errors && resp.errors.length > 0) {
    throw new RealtimeUsageError('graphql_error', resp.errors.map((e) => e.message).join('; '));
  }
  const account = resp.data?.viewer?.accounts?.[0];
  if (!account) throw new RealtimeUsageError('bad_response', 'no account in the response');

  const rows: DailyUsageRow[] = [];
  const collect = (groups: Group[] | undefined, service: UsageService) => {
    for (const g of groups ?? []) {
      const day = g.dimensions?.date;
      const resourceId = service === 'sfu' ? g.dimensions?.appId : g.dimensions?.keyId;
      if (!day || resourceId === undefined) {
        throw new RealtimeUsageError('bad_response', `${service} group without date or id`);
      }
      rows.push({ day, service, resourceId, egressBytes: g.sum?.egressBytes ?? 0 });
    }
  };
  collect(account.sfuByDay, 'sfu');
  collect(account.turnByDay, 'turn');

  const usage: RealtimeUsage = {
    rows,
    sfuEgressBytes: 0,
    turnEgressBytes: 0,
    totalEgressBytes: 0,
    byApp: {},
    byDay: {},
  };
  for (const r of rows) {
    if (r.service === 'sfu') {
      usage.sfuEgressBytes += r.egressBytes;
      usage.byApp[r.resourceId] = (usage.byApp[r.resourceId] ?? 0) + r.egressBytes;
    } else {
      usage.turnEgressBytes += r.egressBytes;
    }
    usage.byDay[r.day] = (usage.byDay[r.day] ?? 0) + r.egressBytes;
  }
  usage.totalEgressBytes = usage.sfuEgressBytes + usage.turnEgressBytes;
  return usage;
}

/**
 * Fetches real usage. The token needs Account → Account Analytics → Read.
 * Error messages never contain the token.
 */
export async function fetchRealtimeUsage(
  token: string,
  params: UsageQueryParams,
  fetchFn: typeof fetch = fetch,
): Promise<RealtimeUsage> {
  const res = await fetchFn(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildUsageQuery(params)),
  });
  if (!res.ok) {
    throw new RealtimeUsageError('http_error', `GraphQL Analytics answered HTTP ${res.status}`);
  }
  return parseUsageResponse(await res.json());
}
