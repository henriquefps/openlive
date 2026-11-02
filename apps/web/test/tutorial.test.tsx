// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../src/api/query-client.ts';
import i18n from '../src/i18n/index.ts';
import en from '../src/locales/en/translation.json';
import ptBR from '../src/locales/pt-BR/translation.json';
import { useTutorialScreen } from '../src/tutorial/context.ts';
import { registerTutorialSteps, stepsFor } from '../src/tutorial/steps.ts';
import { TutorialProvider } from '../src/tutorial/TutorialProvider.tsx';
import { fakeApi, renderApp, USER } from './app-helpers.tsx';

// The tutorial engine: first visit only, missing anchors skipped, skip and "don't show
// again" saved, Settings → Replay.

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

interface Progress {
  seen: string[];
  disabled: boolean;
}

/** /api/me and a stateful /api/me/tutorial; returns the PUT bodies. */
function tutorialApi(start: Progress = { seen: [], disabled: false }, extra = {}) {
  let progress = start;
  const calls = fakeApi({
    'GET /api/me': () => Response.json({ user: USER, memberships: [] }),
    'GET /api/me/tutorial': () => Response.json({ tutorial: progress }),
    'PUT /api/me/tutorial': ({ body }) => {
      progress = body as Progress;
      return Response.json({ tutorial: progress });
    },
    'GET /api/spaces': () => Response.json({ spaces: [] }),
    ...extra,
  });
  const puts = () =>
    calls.filter((c) => c.method === 'PUT' && c.path === '/api/me/tutorial').map((c) => c.body);
  return { puts };
}

// A test screen: steps a and c have anchors, b's anchor is never rendered.
registerTutorialSteps(
  ['a', 'b', 'c'].map((id) => ({
    id,
    screen: 'test',
    anchor: `test-${id}`,
    // Real keys, so the copy renders: a/b/c reuse the Spaces and Space steps.
    titleKey:
      {
        a: 'tutorial.spaces.what.title',
        b: 'tutorial.room.presence.title',
        c: 'tutorial.spaces.create.title',
      }[id] ?? '',
    bodyKey: 'tutorial.spaces.what.body',
    placement: 'bottom' as const,
  })),
);

function TestScreen() {
  useTutorialScreen('test', true);
  return (
    <div>
      <button type="button" data-tour="test-a">
        A
      </button>
      <button type="button" data-tour="test-c">
        C
      </button>
    </div>
  );
}

function renderTestScreen() {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  render(
    <QueryClientProvider client={queryClient}>
      <TutorialProvider>
        <TestScreen />
      </TutorialProvider>
    </QueryClientProvider>,
  );
}

const tour = (name: string) => screen.findByRole('dialog', { name });

describe('the tutorial engine', () => {
  it('runs a screen on its first visit, skips steps whose anchor is missing, and saves it', async () => {
    const { puts } = tutorialApi();
    renderTestScreen();
    const user = userEvent.setup();
    const first = await tour('Spaces');
    expect(first).toHaveAccessibleDescription(/A space is a private group/);
    // Two steps: b has no anchor on the page.
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await tour('Create a space')).toBeInTheDocument();
    expect(screen.getByText('Step 2 of 2')).toBeInTheDocument();
    await user.keyboard('{ArrowLeft}');
    expect(await tour('Spaces')).toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(puts()).toEqual([{ seen: ['test'], disabled: false }]);
  });

  it('does not run a screen that was seen, nor anything once disabled', async () => {
    tutorialApi({ seen: ['test'], disabled: false });
    renderTestScreen();
    await screen.findByText('A');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    tutorialApi({ seen: [], disabled: true });
    renderTestScreen();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Esc skips the screen', async () => {
    const { puts } = tutorialApi();
    renderTestScreen();
    const user = userEvent.setup();
    await tour('Spaces');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(puts()).toEqual([{ seen: ['test'], disabled: false }]);
  });

  it('keeps a local copy, which the API answer replaces', async () => {
    tutorialApi({ seen: [], disabled: false });
    localStorage.setItem(
      `openlive.tutorial.${USER.id}`,
      JSON.stringify({ seen: ['test'], disabled: false }),
    );
    renderTestScreen();
    // The API (not seen) replaces the cached copy (seen), then the tour runs.
    expect(await tour('Spaces')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(`openlive.tutorial.${USER.id}`) ?? '')).toEqual({
      seen: [],
      disabled: false,
    });
  });
});

describe('the tutorial in the app', () => {
  it('runs the Spaces steps, then the top bar; "Don\'t show again" turns it off', async () => {
    const { puts } = tutorialApi();
    renderApp('/spaces');
    const user = userEvent.setup();
    expect(await tour('Spaces')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip tutorial' }));
    // The page's tour first, the top bar's after it.
    expect(await tour('Language and theme')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Don't show tutorials again" }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(puts()).toEqual([
      { seen: ['spaces'], disabled: false },
      { seen: ['spaces', 'topbar'], disabled: true },
    ]);
  });

  it('Settings → Replay tutorial resets it', async () => {
    const { puts } = tutorialApi(
      { seen: ['spaces', 'topbar', 'settings'], disabled: true },
      { 'GET /api/me/sessions': () => Response.json({ sessions: [] }) },
    );
    renderApp('/settings');
    const user = userEvent.setup();
    expect(
      await screen.findByText('Tutorials are off. Replay turns them back on.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Replay tutorial' }));
    await waitFor(() => expect(puts()).toEqual([{ seen: [], disabled: false }]));
    // On again: the top bar's tour runs.
    expect(await tour('Language and theme')).toBeInTheDocument();
  });
});

describe('the steps', () => {
  type Tree = { [key: string]: string | Tree };
  const lookup = (tree: Tree, key: string) =>
    key
      .split('.')
      .reduce<string | Tree | undefined>(
        (node, part) => (typeof node === 'object' ? node[part] : undefined),
        tree,
      );

  it('have copy in both locales for every registered step', () => {
    for (const screenId of ['spaces', 'space', 'room', 'topbar']) {
      const steps = stepsFor(screenId);
      expect(steps.length).toBeGreaterThan(0);
      for (const s of steps) {
        for (const tree of [en, ptBR] as Tree[]) {
          expect(typeof lookup(tree, s.titleKey), s.titleKey).toBe('string');
          expect(typeof lookup(tree, s.bodyKey), s.bodyKey).toBe('string');
        }
      }
    }
  });
});
