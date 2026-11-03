// SPDX-License-Identifier: AGPL-3.0-only

// How the room's SFU session is doing, for the cameras: @openlive/client's (voice/network.ts).

export {
  NETWORK_BAD as BAD,
  NETWORK_POOR as POOR,
  NetworkMeter,
  type NetworkSample,
  qualityOf,
  RECOVER_SAMPLES,
} from '@openlive/client';
