// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { loadServerSummary, MAX_SPACES, type SummaryApi } from '../src/summary/load.ts';

const api = (over: Partial<SummaryApi> = {}): SummaryApi => ({
  spaces: async () => [{ id: 's1' }],
  rooms: async () => [{ id: 'r1', name: 'geral' }],
  chat: async () => ({ rooms: { r1: 3 }, mentions: { r1: 1 } }),
  streams: async () => [
    { streamId: 'st', roomId: 'r1', userId: 'u', userName: 'Ana', startedAt: 5 },
  ],
  ...over,
});

describe('loadServerSummary', () => {
  it('combines the three reads of a space', async () => {
    const s = await loadServerSummary('https://a', 'A', api(), 1);
    expect(s.items.map((i) => i.kind)).toEqual(['stream', 'mentions', 'unread']);
  });

  it('asks the streams since the given time', async () => {
    const seen: number[] = [];
    await loadServerSummary(
      'https://a',
      'A',
      api({
        streams: async (_s, since) => {
          seen.push(since);
          return [];
        },
      }),
      1234,
    );
    expect(seen).toEqual([1234]);
  });

  it('leaves out what fails: the chat, the streams, a whole space, the list of spaces', async () => {
    const boom = async () => {
      throw new Error('down');
    };
    expect(
      (await loadServerSummary('https://a', 'A', api({ chat: boom, streams: boom }), 1)).items,
    ).toEqual([]);
    const some = await loadServerSummary(
      'https://a',
      'A',
      api({
        spaces: async () => [{ id: 'bad' }, { id: 's1' }],
        rooms: async (id) => (id === 'bad' ? boom() : [{ id: 'r1', name: 'geral' }]),
      }),
      1,
    );
    expect(some.items).toHaveLength(3);
    expect((await loadServerSummary('https://a', 'A', api({ spaces: boom }), 1)).items).toEqual([]);
  });

  it('reads a bounded number of spaces', async () => {
    let calls = 0;
    await loadServerSummary(
      'https://a',
      'A',
      api({
        spaces: async () => Array.from({ length: 30 }, (_, i) => ({ id: `s${i}` })),
        rooms: async () => {
          calls += 1;
          return [];
        },
      }),
      1,
    );
    expect(calls).toBe(MAX_SPACES);
  });
});
