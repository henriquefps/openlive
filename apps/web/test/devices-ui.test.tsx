// SPDX-License-Identifier: AGPL-3.0-only
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, renderApp, signedIn } from './app-helpers.tsx';

// /link (approve a helper's pairing) and Settings > Devices.

afterEach(() => {
  vi.unstubAllGlobals();
});

const INFO = {
  userCode: 'K7F-2QM',
  name: 'desk',
  os: 'linux',
  arch: 'amd64',
  helperVersion: '0.1.0',
  expiresAt: Date.now() + 600_000,
};

describe('/link', () => {
  it('shows what asks to pair, and approves it with the chosen name', async () => {
    const calls = fakeApi({
      'GET /api/me': signedIn(),
      'GET /api/devices/code/K7F-2QM': () => Response.json(INFO),
      'POST /api/devices/approve': () => Response.json({ userCode: 'K7F-2QM' }),
    });
    renderApp('/link?code=k7f2qm');
    expect(
      await screen.findByText(/A helper on Linux \(amd64, version 0\.1\.0\) asked to pair/),
    ).toBeInTheDocument();
    const name = screen.getByLabelText('Device name');
    expect(name).toHaveValue('desk');
    await userEvent.clear(name);
    await userEvent.type(name, "Ana's PC");
    await userEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect(await screen.findByRole('heading', { name: 'Helper paired' })).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      userCode: 'K7F-2QM',
      name: "Ana's PC",
    });
  });

  it('asks for the code when there is none, and explains a wrong one', async () => {
    fakeApi({
      'GET /api/me': signedIn(),
      'GET /api/devices/code/ZZZ-ZZZ': () =>
        Response.json({ code: 'device_code_invalid' }, { status: 404 }),
    });
    renderApp('/link');
    const input = await screen.findByLabelText('Pairing code');
    await userEvent.type(input, 'zzz-zzz');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByText(
        'This pairing code is wrong or expired. Check the code in the helper.',
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Enter another code' }));
    expect(await screen.findByLabelText('Pairing code')).toHaveValue('');
  });
});

describe('Settings > Devices', () => {
  it('lists paired helpers with last activity and revokes one', async () => {
    let devices = [
      {
        deviceId: 'd_1',
        name: 'Desk',
        os: 'linux',
        arch: 'amd64',
        helperVersion: '0.1.0',
        createdAt: Date.UTC(2026, 9, 20),
        lastSeenAt: Date.UTC(2026, 9, 27, 12),
      },
    ];
    const calls = fakeApi({
      'GET /api/me': signedIn(),
      'GET /api/me/sessions': () => Response.json({ sessions: [] }),
      'GET /api/me/devices': () => Response.json({ devices }),
      'DELETE /api/me/devices/d_1': () => {
        devices = [];
        return new Response(null, { status: 204 });
      },
    });
    renderApp('/settings');
    expect(await screen.findByText('Desk')).toBeInTheDocument();
    expect(screen.getByText('Linux (amd64), helper 0.1.0')).toBeInTheDocument();
    expect(screen.getByText(/^Last active /)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Revoke Desk' }));
    await waitFor(() => expect(screen.getByText(/No helper is paired yet/)).toBeInTheDocument());
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/me/devices/d_1')).toBe(true);
  });
});
