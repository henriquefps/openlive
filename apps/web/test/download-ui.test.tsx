// SPDX-License-Identifier: AGPL-3.0-only
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anonymous, fakeApi, renderApp, signedIn } from './app-helpers.tsx';

// The Download page: the Linux and macOS release this instance serves, and the
// states before it is published or when the caller may not download.

const LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';

function asSystem(userAgent: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TARBALL = 'openlive-helper-0.2.0-linux-amd64.tar.gz';
const FLATPAK = 'openlive-helper-0.2.0.flatpak';
const RELEASE = {
  schema: 1,
  version: '0.2.0',
  publishedAt: '2026-10-28T12:00:00.000Z',
  protocol: { major: 1, minor: 12 },
  releaseNotesUrl: 'https://example.com/notes',
  files: [
    {
      name: TARBALL,
      kind: 'tarball',
      os: 'linux',
      arch: 'amd64',
      size: 12_400_000,
      sha256: 'a'.repeat(64),
      url: `/api/helper/download/0.2.0/${TARBALL}`,
    },
    {
      name: FLATPAK,
      kind: 'flatpak',
      os: 'linux',
      arch: 'amd64',
      size: 15_000_000,
      sha256: 'b'.repeat(64),
      url: `/api/helper/download/0.2.0/${FLATPAK}`,
    },
  ],
  signature: null,
};
const DMG = 'openlive-helper-0.2.0-macos.dmg';
const WITH_MAC = {
  ...RELEASE,
  files: [
    ...RELEASE.files,
    {
      name: DMG,
      kind: 'dmg',
      os: 'macos',
      arch: 'universal',
      size: 21_000_000,
      sha256: 'c'.repeat(64),
      url: `/api/helper/download/0.2.0/${DMG}`,
    },
  ],
};

describe('/download', () => {
  it('offers the tarball and the Flatpak with their hashes and the commands for this instance', async () => {
    asSystem(LINUX);
    fakeApi({
      'GET /api/me': signedIn(),
      'GET /api/helper/latest': () => Response.json(RELEASE),
    });
    renderApp('/download');
    expect(await screen.findByText(/Version 0\.2\.0, published/)).toBeInTheDocument();
    expect(screen.getByText('Your system')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute(
      'href',
      'https://example.com/notes',
    );

    const tarball = screen.getByRole('region', { name: 'Tarball' });
    expect(within(tarball).getByText('Recommended for NVIDIA')).toBeInTheDocument();
    expect(within(tarball).getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      `/api/helper/download/0.2.0/${TARBALL}`,
    );
    expect(within(tarball).getByText('a'.repeat(64))).toBeInTheDocument();
    expect(within(tarball).getByText(/12\.4 MB/)).toBeInTheDocument();
    const origin = window.location.origin;
    expect(tarball.querySelector('pre')?.textContent).toBe(
      [
        `tar xzf ${TARBALL}`,
        'cd openlive-helper-0.2.0-linux-amd64',
        './install.sh',
        `openlive-helper pair --instance ${origin}`,
      ].join('\n'),
    );

    const flatpak = screen.getByRole('region', { name: 'Flatpak' });
    expect(within(flatpak).getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      `/api/helper/download/0.2.0/${FLATPAK}`,
    );
    expect(within(flatpak).getByText('b'.repeat(64))).toBeInTheDocument();
    expect(flatpak.querySelector('pre')?.textContent).toBe(
      [
        `flatpak install --user ${FLATPAK}`,
        `flatpak run dev.hfps.OpenliveHelper pair --instance ${origin}`,
      ].join('\n'),
    );
    expect(screen.getByRole('link', { name: 'Encoder notes' })).toHaveAttribute(
      'href',
      expect.stringContaining('helper/README.md#encoders'),
    );
  });

  it('shows the tarball alone when only it was published', async () => {
    asSystem(LINUX);
    fakeApi({
      'GET /api/me': signedIn(),
      'GET /api/helper/latest': () =>
        Response.json({ ...RELEASE, releaseNotesUrl: null, files: RELEASE.files.slice(0, 1) }),
    });
    renderApp('/download');
    expect(await screen.findByRole('region', { name: 'Tarball' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Flatpak' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Release notes' })).toBeNull();
  });

  it('offers the macOS disk image first on a Mac, with the steps for this instance', async () => {
    asSystem(MAC);
    fakeApi({
      'GET /api/me': signedIn(),
      'GET /api/helper/latest': () => Response.json(WITH_MAC),
    });
    renderApp('/download');
    const image = await screen.findByRole('region', { name: 'Disk image' });
    expect(within(image).getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      `/api/helper/download/0.2.0/${DMG}`,
    );
    expect(within(image).getByText('c'.repeat(64))).toBeInTheDocument();
    expect(within(image).getByText(/21 MB/)).toBeInTheDocument();
    const steps = within(image).getAllByRole('listitem');
    expect(steps).toHaveLength(5);
    expect(steps[0]).toHaveTextContent(`Open ${DMG} and drag Openlive Helper onto Applications.`);
    expect(steps[2]).toHaveTextContent(window.location.origin);
    expect(steps[3]).toHaveTextContent(/Screen Recording/);
    const [first] = screen.getAllByRole('heading', { level: 2 });
    expect(first).toHaveTextContent('macOS');
    const mac = screen.getByRole('heading', { name: 'macOS' }).closest('[data-current]');
    expect(within(mac as HTMLElement).getByText('Your system')).toBeInTheDocument();
    // The Linux files are still offered, for another machine.
    expect(screen.getByRole('region', { name: 'Tarball' })).toBeInTheDocument();
  });

  it('tells the platform admin how to add the macOS image when the release has none', async () => {
    asSystem(MAC);
    fakeApi({
      'GET /api/me': signedIn({ isPlatformAdmin: true }),
      'GET /api/helper/latest': () => Response.json(RELEASE),
    });
    renderApp('/download');
    expect(await screen.findByText('No macOS helper published yet')).toBeInTheDocument();
    expect(
      screen.getByText(/--mac-dmg dist\/openlive-helper-<version>-macos\.dmg/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Disk image' })).toBeNull();
  });

  it('gives members a neutral macOS message when the release has no image', async () => {
    asSystem(MAC);
    fakeApi({
      'GET /api/me': signedIn(),
      'GET /api/helper/latest': () => Response.json(RELEASE),
    });
    renderApp('/download');
    expect(
      await screen.findByText(/The macOS helper is not available on this server yet/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/--mac-dmg/)).toBeNull();
  });

  it('says Windows comes later, and marks the visitor system', async () => {
    asSystem(WINDOWS);
    fakeApi({
      'GET /api/me': signedIn(),
      'GET /api/helper/latest': () => Response.json(WITH_MAC),
    });
    renderApp('/download');
    expect(await screen.findByRole('heading', { name: 'Windows' })).toBeInTheDocument();
    expect(
      screen.getAllByText('Coming later. For now the helper runs on Linux and macOS.'),
    ).toHaveLength(1);
    const windows = screen.getByRole('heading', { name: 'Windows' }).closest('li');
    expect(within(windows as HTMLElement).getByText('Your system')).toBeInTheDocument();
    // Linux and macOS are still offered, for another machine.
    expect(await screen.findByRole('region', { name: 'Tarball' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Disk image' })).toBeInTheDocument();
  });

  it('tells the platform admin how to publish when nothing is', async () => {
    asSystem(LINUX);
    fakeApi({
      'GET /api/me': signedIn({ isPlatformAdmin: true }),
      'GET /api/helper/latest': () => Response.json({ code: 'not_found' }, { status: 404 }),
    });
    renderApp('/download');
    expect(await screen.findByText('No helper published yet')).toBeInTheDocument();
    expect(
      screen.getByText('pnpm run helper:publish -- --env production --from-release latest'),
    ).toBeInTheDocument();
  });

  it('gives others a neutral message when nothing is published', async () => {
    asSystem(LINUX);
    fakeApi({
      'GET /api/me': signedIn(),
      'GET /api/helper/latest': () => Response.json({ code: 'not_found' }, { status: 404 }),
    });
    renderApp('/download');
    expect(
      await screen.findByText(
        'The helper is not available on this server yet. Ask whoever runs it.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/helper:publish/)).toBeNull();
  });

  it('asks a visitor to sign in', async () => {
    asSystem(LINUX);
    fakeApi({ 'GET /api/me': anonymous, 'GET /api/helper/latest': anonymous });
    renderApp('/download');
    expect(await screen.findByText('Sign in to download the helper.')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Sign in' });
    expect(links.map((a) => a.getAttribute('href'))).toContain('/?returnTo=%2Fdownload');
  });

  it('explains that the helper is for space members', async () => {
    asSystem(LINUX);
    fakeApi({
      'GET /api/me': signedIn(),
      'GET /api/helper/latest': () => Response.json({ code: 'forbidden' }, { status: 403 }),
    });
    renderApp('/download');
    expect(await screen.findByText(/The helper is for members of a space/)).toBeInTheDocument();
  });

  it('shows a failed load with a retry', async () => {
    asSystem(LINUX);
    fakeApi({
      'GET /api/me': signedIn(),
      'GET /api/helper/latest': () => Response.json({ code: 'internal_error' }, { status: 500 }),
    });
    renderApp('/download');
    expect(await screen.findByText('Could not load this')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
