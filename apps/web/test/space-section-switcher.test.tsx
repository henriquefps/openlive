// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import i18n from '../src/i18n/index.ts';
import { SpaceSectionSwitcher } from '../src/routes/space/SpaceSectionSwitcher.tsx';
import type { SpaceTab } from '../src/routes/space/tabs.ts';

// The phone-width section switcher of the space page: a Select with the allowed tabs and the
// pending join-requests count.

// jsdom lacks the pointer and scroll APIs Radix Select calls.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(current: SpaceTab, tabs: SpaceTab[], pending: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ joinRequests: Array.from({ length: pending }, (_, i) => ({ id: `r${i}` })) }),
    ),
  );
  const onChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <Tabs value={current}>
          <SpaceSectionSwitcher tabs={tabs} current={current} spaceId="s_1" onChange={onChange} />
        </Tabs>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return onChange;
}

describe('SpaceSectionSwitcher', () => {
  it('lists the allowed tabs and navigates with the chosen one', async () => {
    const onChange = setup('rooms', ['rooms', 'members', 'settings'], 0);
    const user = userEvent.setup();
    const trigger = screen.getByRole('combobox', { name: 'Section' });
    expect(trigger).toHaveTextContent('Rooms');
    await user.click(trigger);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Rooms',
      'Members',
      'Settings',
    ]);
    await user.click(screen.getByRole('option', { name: 'Members' }));
    expect(onChange).toHaveBeenCalledWith('members');
  });

  it('shows the pending count in the requests item and a dot on the trigger', async () => {
    setup('rooms', ['rooms', 'requests'], 3);
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByTestId('space-section-pending-dot')).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('combobox', { name: 'Section' }));
    expect(screen.getByRole('option', { name: /Requests\s*3/ })).toBeInTheDocument();
  });

  it('shows the count in the trigger when requests is selected, without the dot', async () => {
    setup('requests', ['rooms', 'requests'], 2);
    const trigger = screen.getByRole('combobox', { name: 'Section' });
    await waitFor(() => expect(trigger).toHaveTextContent(/Requests\s*2/));
    expect(screen.queryByTestId('space-section-pending-dot')).not.toBeInTheDocument();
  });
});
