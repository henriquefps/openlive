// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataCard, DataCardActions, DataList, RelativeDate } from '../src/components/data-list.tsx';
import { DropdownMenuItem } from '../src/components/ui/dropdown-menu.tsx';

const wide = vi.hoisted(() => ({ value: true }));
vi.mock('@/hooks/use-container-width', () => ({
  useIsContainerAtLeast: () => wide.value,
}));

const ITEMS = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
];

function renderList(onOpen = vi.fn()) {
  return render(
    <DataList
      items={ITEMS}
      getKey={(i) => i.id}
      data-tour="list"
      renderTable={(items) => (
        <table>
          <thead>
            <tr>
              <th>Name</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{i.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      renderCard={(i) => (
        <DataCard
          title={i.name}
          badge={<span>ok</span>}
          meta={['id-' + i.id, false, 'two']}
          selected={i.id === 'b'}
          onOpen={() => onOpen(i.id)}
          actions={
            <DataCardActions label={`Actions for ${i.name}`}>
              <DropdownMenuItem onSelect={() => onOpen(`menu-${i.id}`)}>Remove</DropdownMenuItem>
            </DataCardActions>
          }
        />
      )}
    />,
  );
}

describe('DataList', () => {
  beforeEach(() => {
    wide.value = true;
  });

  it('renders the table with its header when the container is wide', () => {
    renderList();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(document.querySelector('[data-tour="list"]')).toHaveAttribute('data-mode', 'table');
  });

  it('renders cards without a column header when the container is narrow', () => {
    wide.value = false;
    renderList();
    expect(screen.queryByRole('columnheader')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /^Alpha/ })).toHaveTextContent('id-a · two');
    expect(document.querySelector('[data-tour="list"]')).toHaveAttribute('data-mode', 'cards');
  });

  it('marks the selected card and opens an item on tap', async () => {
    wide.value = false;
    const onOpen = vi.fn();
    renderList(onOpen);
    expect(document.querySelectorAll('[data-state="selected"]')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: /^Alpha/ }));
    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('puts row actions behind a labelled menu button', async () => {
    wide.value = false;
    const onOpen = vi.fn();
    renderList(onOpen);
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Beta' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    expect(onOpen).toHaveBeenCalledWith('menu-b');
    expect(onOpen).not.toHaveBeenCalledWith('b');
  });
});

describe('RelativeDate', () => {
  it('shows a relative day with the full date and time in the title', () => {
    render(<RelativeDate value={Date.now()} locale="en" />);
    const el = screen.getByText('today');
    expect(el).toHaveAttribute('title');
    expect(el.getAttribute('title')).toMatch(/\d/);
  });
});
