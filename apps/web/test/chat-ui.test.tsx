// SPDX-License-Identifier: AGPL-3.0-only
import type { Member, You } from '@openlive/protocol';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import { describe, expect, it } from 'vitest';
import { ChatPanel } from '../src/chat/ChatPanel.tsx';
import type { ChatClient } from '../src/chat/client.ts';
import { chatSettings, message, SELF, setupChat, you } from './chat-fakes.ts';

// The chat panel (chat/ChatPanel.tsx) over the chat client and a fake room socket: safe rendering,
// sending, the mention autocomplete, edit and delete, moderation and the read-only state.

const MEMBERS: Member[] = [
  { userId: SELF, displayName: 'Ana', role: 'member', canStream: false },
  { userId: 'u_bia', displayName: 'Bia', role: 'member', canStream: false },
  { userId: 'u_bruno', displayName: 'Bruno', role: 'guest', canStream: false },
  { userId: 'u_owner', displayName: 'Olga', role: 'owner', canStream: false },
];

function Panel({ client, me }: { client: ChatClient; me: You }) {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  return (
    <ChatPanel
      client={client}
      state={state}
      you={me}
      members={MEMBERS}
      settings={chatSettings()}
      quick={false}
      online
      variant="panel"
    />
  );
}

function renderPanel(page = [message(1)], me: You = you()) {
  const chat = setupChat(page, { you: me });
  const user = userEvent.setup();
  render(<Panel client={chat.client} me={me} />);
  return { ...chat, user };
}

describe('ChatPanel', () => {
  it('renders message text as text: markup never becomes elements; links are safe', () => {
    renderPanel([
      message(1, {
        text: '<script>alert(1)</script><img src=x onerror=alert(1)> https://example.com/x',
      }),
      message(2, { text: 'javascript:alert(1)' }),
    ]);
    const log = screen.getByRole('log');
    expect(log.querySelector('script')).toBeNull();
    expect(log.querySelector('img[src="x"]')).toBeNull();
    expect(within(log).getByText(/<script>alert\(1\)<\/script><img src=x/)).toBeInTheDocument();
    const links = within(log).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://example.com/x');
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(links[0]?.getAttribute('rel')).toContain('noopener');
    expect(links[0]?.getAttribute('rel')).toContain('noreferrer');
  });

  it('shows the retention, an edited mark and a removed account', () => {
    const removed = message(2, { authorName: '', text: 'old words' });
    delete removed.userId;
    renderPanel([message(1, { editedAt: 5 }), removed]);
    expect(screen.getByText('Messages kept 30 days')).toBeInTheDocument();
    expect(screen.getByText('(edited)')).toBeInTheDocument();
    expect(screen.getByText('Account removed')).toBeInTheDocument();
  });

  it('sends on Enter, keeps Shift+Enter as a new line', async () => {
    const { socket, user } = renderPanel();
    const input = screen.getByRole('combobox', { name: 'Message' });
    await user.type(input, 'line one{Shift>}{Enter}{/Shift}line two{Enter}');
    expect(socket.last('chat.send').payload).toMatchObject({ text: 'line one\nline two' });
    expect(input).toHaveValue('');
    expect(screen.getByText(/line one/)).toBeInTheDocument();
  });

  it('suggests people after @ and inserts the chosen name with the keyboard', async () => {
    const { socket, user } = renderPanel();
    const input = screen.getByRole('combobox', { name: 'Message' });
    await user.type(input, 'hi @b');
    const list = screen.getByRole('listbox', { name: 'People to mention' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['BBia', 'BBruno']);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(input).toHaveValue('hi @Bruno ');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.keyboard('there{Enter}');
    expect(socket.last('chat.send').payload).toMatchObject({ text: 'hi @Bruno there' });
  });

  it('edits and deletes your own message', async () => {
    const { socket, user } = renderPanel([message(1, { userId: SELF, authorName: 'Ana' })]);
    await user.click(screen.getByRole('button', { name: 'Message actions (Ana)' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    await user.clear(box);
    await user.type(box, 'better{Enter}');
    expect(socket.last('chat.edit').payload).toEqual({ messageId: 'm_1', text: 'better' });

    await user.click(screen.getByRole('button', { name: 'Message actions (Ana)' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(socket.last('chat.delete').payload).toEqual({ messageId: 'm_1' });
  });

  it("offers moderators a delete under the removal rule, members nothing on others' messages", () => {
    const page = [message(1), message(2, { userId: 'u_owner', authorName: 'Olga' })];
    const { unmount } = render(<Panel client={setupChat(page).client} me={you()} />);
    expect(screen.queryByRole('button', { name: /Message actions/ })).not.toBeInTheDocument();
    unmount();

    const admin = you({}, 'admin');
    render(<Panel client={setupChat(page, { you: admin }).client} me={admin} />);
    // Bia (a member): yes; Olga (the owner): no.
    expect(screen.getByRole('button', { name: 'Message actions (Bia)' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Message actions (Olga)' }),
    ).not.toBeInTheDocument();
  });

  it('is read-only without canWriteChat', () => {
    const guest = you({ canWriteChat: false }, 'guest');
    renderPanel([message(1)], guest);
    expect(screen.queryByRole('combobox', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.getByText('Guests can read this chat but not write in it.')).toBeInTheDocument();
    expect(screen.getByText('message 1')).toBeInTheDocument();
  });
});
