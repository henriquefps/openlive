// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/i18n/index.ts';
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogForm,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from '../src/components/ui/responsive-dialog.tsx';

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('../src/hooks/use-mobile.ts', () => ({ useIsMobile: () => mobile.value }));

afterEach(() => {
  mobile.value = false;
});

function Example() {
  return (
    <ResponsiveDialog>
      <ResponsiveDialogTrigger asChild>
        <button type="button">Open</button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ResponsiveDialogForm>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Create</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>Fill it in</ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            <input aria-label="Name" />
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <button type="submit">Save</button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogForm>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

describe('ResponsiveDialog', () => {
  it('renders the centered Dialog on desktop, with no grab handle or Cancel', async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create' });
    expect(dialog).toHaveAttribute('data-slot', 'dialog-content');
    expect(dialog.className).toContain('top-1/2');
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(document.querySelector('[data-slot="responsive-dialog-handle"]')).toBeNull();
    expect(document.querySelector('[data-slot="responsive-dialog-body"]')).toHaveClass('contents');
  });

  it('renders a bottom sheet on phones: handle, scrolling body, pinned footer with Cancel last', async () => {
    mobile.value = true;
    render(<Example />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Create' });
    expect(dialog).toHaveAttribute('data-slot', 'responsive-dialog-content');
    expect(dialog).toHaveAttribute('data-side', 'bottom');
    expect(dialog).toHaveClass('rounded-t-xl', 'max-h-[92dvh]');
    expect(document.querySelector('[data-slot="responsive-dialog-handle"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="responsive-dialog-body"]')).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto',
      'overscroll-contain',
    );
    const footer = document.querySelector('[data-slot="sheet-footer"]');
    expect(footer?.className).toContain('env(safe-area-inset-bottom)');
    const buttons = Array.from(footer?.querySelectorAll('button') ?? []).map((b) => b.textContent);
    expect(buttons).toEqual(['Save', 'Cancel']);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('can drop the Cancel button', async () => {
    mobile.value = true;
    render(
      <ResponsiveDialog defaultOpen>
        <ResponsiveDialogContent>
          <ResponsiveDialogTitle>Done</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>All set</ResponsiveDialogDescription>
          <ResponsiveDialogFooter cancel={false}>
            <button type="button">Done</button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>,
    );
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});
