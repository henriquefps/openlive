// SPDX-License-Identifier: AGPL-3.0-only

/** A server's address as people type it: host and port, no scheme. */
export const hostOf = (origin: string): string => origin.replace(/^https?:\/\//, '');
