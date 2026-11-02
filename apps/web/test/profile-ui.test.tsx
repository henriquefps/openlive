// SPDX-License-Identifier: AGPL-3.0-only
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { avatarFileProblem, MAX_AVATAR_INPUT_BYTES, squareCrop } from '../src/lib/avatar-image.ts';
import { fakeApi, renderApp, USER } from './app-helpers.tsx';

// Settings → Profile (docs/PROTOCOL.md 11.5): the display name and the photo. jsdom has no
// canvas, so decoding and drawing the photo are stood in for; squareCrop is tested on its own.

const PHOTO = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });

vi.mock('../src/lib/avatar-image.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/avatar-image.ts')>()),
  loadImage: vi.fn(async () => ({ width: 640, height: 480 }) as ImageBitmap),
  renderAvatar: vi.fn(async () => PHOTO),
}));

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:preview' }));
  URL.revokeObjectURL = () => undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const me = (
  user: Partial<typeof USER> = {},
  avatar = { source: 'discord', discordAvailable: false },
) => ({ user: { ...USER, ...user }, avatar, memberships: [] });

function settings(routes: Parameters<typeof fakeApi>[0], initial = me()) {
  const calls = fakeApi({
    'GET /api/me': () => Response.json(initial),
    'GET /api/me/sessions': () => Response.json({ sessions: [] }),
    'GET /api/me/devices': () => Response.json({ devices: [] }),
    ...routes,
  });
  renderApp('/settings');
  return { calls };
}

const card = async () => within(await screen.findByTestId('profile-card'));

describe('Settings → Profile: name', () => {
  it('no longer shows a "Coming soon" card', async () => {
    settings({});
    await card();
    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument();
    expect(screen.queryByText('Change your name and avatar.')).not.toBeInTheDocument();
  });

  it('renames: trims the name, saves it with PUT /api/me and shows it in the header', async () => {
    const { calls } = settings({
      'PUT /api/me': ({ body }) =>
        Response.json({
          user: { ...USER, displayName: (body as { displayName: string }).displayName },
        }),
    });
    const profile = await card();
    const input = profile.getByLabelText('Display name');
    expect(input).toHaveValue('Ana');
    const save = profile.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, '  Ana Clara  ');
    await userEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ displayName: 'Ana Clara' });
    expect(await screen.findByText('Name saved.')).toBeInTheDocument();
    expect(input).toHaveValue('Ana Clara');
    // The /api/me cache holds the new name: the user menu in the header shows it.
    expect(screen.getByRole('button', { name: /Ana Clara/ })).toBeInTheDocument();
  });

  it('refuses an empty or too long name before calling the API', async () => {
    const { calls } = settings({});
    const profile = await card();
    const input = profile.getByLabelText('Display name');
    await userEvent.clear(input);
    await userEvent.type(input, '   ');
    expect(profile.getByText('Enter a name.')).toBeInTheDocument();
    expect(profile.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, 'x'.repeat(81));
    expect(profile.getByText('Use at most 80 characters.')).toBeInTheDocument();
    expect(profile.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('Settings → Profile: photo', () => {
  it('uploads: preview, then PUT /api/me/avatar with the 256 px photo', async () => {
    const uploaded = { ...USER, avatarUrl: '/api/avatars/u_ana/abc' };
    const { calls } = settings({
      'PUT /api/me/avatar': () =>
        Response.json({ user: uploaded, avatar: { source: 'upload', discordAvailable: false } }),
    });
    const profile = await card();
    expect(profile.queryByRole('button', { name: 'Remove photo' })).toBeNull();
    const file = new File([new Uint8Array(10)], 'me.png', { type: 'image/png' });
    await userEvent.upload(screen.getByTestId('avatar-file'), file);
    expect(await profile.findByRole('img', { name: 'Preview of your new photo' })).toHaveAttribute(
      'src',
      'blob:preview',
    );
    expect(profile.getByText('Zoom')).toBeInTheDocument();
    await userEvent.click(profile.getByRole('button', { name: 'Save photo' }));
    expect(await screen.findByText('Photo saved.')).toBeInTheDocument();
    const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/me/avatar');
    expect(put?.body).toBe(PHOTO);
    // Back to the normal view, now with a photo to remove.
    expect(await profile.findByRole('button', { name: 'Remove photo' })).toBeInTheDocument();
    expect(profile.getByRole('button', { name: 'Change photo' })).toBeInTheDocument();
  });

  it('cancels a chosen photo without uploading it', async () => {
    const { calls } = settings({});
    const profile = await card();
    await userEvent.upload(
      screen.getByTestId('avatar-file'),
      new File([new Uint8Array(10)], 'me.webp', { type: 'image/webp' }),
    );
    await profile.findByRole('img', { name: 'Preview of your new photo' });
    await userEvent.click(profile.getByRole('button', { name: 'Cancel' }));
    expect(profile.getByRole('button', { name: 'Upload photo' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/me/avatar')).toBe(false);
  });

  it('refuses other file types and files over 5 MB', async () => {
    settings({});
    const profile = await card();
    const input = screen.getByTestId('avatar-file');
    await userEvent.upload(input, new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }), {
      applyAccept: false,
    });
    expect(await profile.findByText('Choose a PNG, JPEG or WebP image.')).toBeInTheDocument();
    const big = new File([new Uint8Array(MAX_AVATAR_INPUT_BYTES + 1)], 'big.jpg', {
      type: 'image/jpeg',
    });
    await userEvent.upload(input, big);
    expect(await profile.findByText('This file is over 5 MB.')).toBeInTheDocument();
    expect(profile.queryByRole('img', { name: 'Preview of your new photo' })).toBeNull();
  });

  it('removes the photo (back to initials)', async () => {
    const { calls } = settings(
      {
        'DELETE /api/me/avatar': () =>
          Response.json({ user: USER, avatar: { source: 'none', discordAvailable: false } }),
      },
      me({ avatarUrl: '/api/avatars/u_ana/abc' }, { source: 'upload', discordAvailable: false }),
    );
    const profile = await card();
    await userEvent.click(await profile.findByRole('button', { name: 'Remove photo' }));
    expect(await screen.findByText('Photo removed.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/me/avatar')).toBe(true);
    expect(profile.getByTestId('profile-avatar')).toHaveTextContent('A');
    expect(profile.queryByRole('button', { name: 'Remove photo' })).toBeNull();
  });

  it('offers the Discord photo only when the account has one that is not shown', async () => {
    const discordPhoto = 'https://cdn.discordapp.com/avatars/1/a.png?size=128';
    const { calls } = settings(
      {
        'POST /api/me/avatar/discord': () =>
          Response.json({
            user: { ...USER, avatarUrl: discordPhoto },
            avatar: { source: 'discord', discordAvailable: true },
          }),
      },
      me({ avatarUrl: null }, { source: 'none', discordAvailable: true }),
    );
    const profile = await card();
    await userEvent.click(await profile.findByRole('button', { name: 'Use my Discord photo' }));
    expect(await screen.findByText('Now using your Discord photo.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/me/avatar/discord')).toBe(
      true,
    );
    expect(profile.queryByRole('button', { name: 'Use my Discord photo' })).toBeNull();
  });

  it('has no Discord button for an e-mail account', async () => {
    settings({});
    const profile = await card();
    expect(profile.getByRole('button', { name: 'Upload photo' })).toBeInTheDocument();
    expect(profile.queryByRole('button', { name: 'Use my Discord photo' })).toBeNull();
  });
});

describe('avatar-image', () => {
  it('crops the centred square, smaller as the zoom grows', () => {
    expect(squareCrop(640, 480, 1)).toEqual({ sx: 80, sy: 0, size: 480 });
    expect(squareCrop(480, 640, 2)).toEqual({ sx: 120, sy: 200, size: 240 });
    expect(squareCrop(100, 100, 9)).toEqual(squareCrop(100, 100, 3));
  });

  it('checks the type and size of the chosen file', () => {
    expect(avatarFileProblem({ type: 'image/png', size: 1 })).toBeNull();
    expect(avatarFileProblem({ type: 'image/gif', size: 1 })).toBe('type');
    expect(avatarFileProblem({ type: 'image/webp', size: MAX_AVATAR_INPUT_BYTES + 1 })).toBe(
      'size',
    );
  });
});
