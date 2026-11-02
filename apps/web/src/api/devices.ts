// SPDX-License-Identifier: AGPL-3.0-only
import type { DeviceApproveRequest, DeviceCodeInfo, DeviceList } from '@openlive/protocol';
import { queryOptions } from '@tanstack/react-query';
import { apiGet, apiSend } from './client.ts';

// Paired helpers (docs/PROTOCOL.md 11.1): the /link approval and Settings > Devices.
// Only types come from the protocol package, so its validators stay out of the bundle.

export const devicesQuery = queryOptions({
  queryKey: ['me', 'devices'],
  queryFn: () => apiGet<DeviceList>('/api/me/devices'),
});

/** What the helper sent with a pairing code, for the confirmation screen. */
export const deviceCodeQuery = (userCode: string) =>
  queryOptions({
    queryKey: ['devices', 'code', userCode],
    queryFn: () => apiGet<DeviceCodeInfo>(`/api/devices/code/${encodeURIComponent(userCode)}`),
    // Every lookup counts against a rate limit.
    staleTime: Infinity,
    retry: false,
  });

export const approveDevice = (input: DeviceApproveRequest) =>
  apiSend<{ userCode: string }>('POST', '/api/devices/approve', input);

export const revokeDevice = (deviceId: string) =>
  apiSend('DELETE', `/api/me/devices/${encodeURIComponent(deviceId)}`);

/** 'k7f2qm' → 'K7F-2QM' as typed; null while it cannot be a code yet. */
export function normalizeUserCode(text: string): string | null {
  const code = text.replace(/[\s-]/g, '').toUpperCase();
  return /^[0-9A-Z]{6}$/.test(code) ? `${code.slice(0, 3)}-${code.slice(3)}` : null;
}
