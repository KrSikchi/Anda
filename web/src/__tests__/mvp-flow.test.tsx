// Anda — the MVP journey, end to end (PRD §57).
//
// One test walks the complete path a real user takes: open Anda, create a
// room, get a code, enter the room, buy eggs, see the inventory change, eat
// eggs, see Activity record it, and see Account report the financial state.
//
// It runs against the local in-memory backend (no Supabase env in CI), which
// mirrors the server's rules: derived inventory, no negative stock, FIFO
// liability, unit-price purchases. Every value asserted is produced by the
// flow itself — nothing is seeded, so no prototype data can leak in (§48).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import { clearIdentity } from '../lib/anda/identity';

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

async function fill(label: RegExp | string, value: string) {
  const input = await screen.findByLabelText(label);
  fireEvent.change(input, { target: { value } });
}

async function clickText(name: string | RegExp) {
  const el = await screen.findByText(name);
  fireEvent.click(el);
}

async function createRoom(roomName: string, memberName: string) {
  await clickText('Create a room');
  await fill(/^Room name$/, roomName);
  await fill(/Your display name/, memberName);
  fireEvent.click(screen.getByRole('button', { name: 'Create room' }));

  const heading = await screen.findByRole('heading', { name: 'Room code' });
  expect(heading).toBeTruthy();
  return heading;
}

describe('Anda MVP journey (§57)', () => {
  beforeEach(async () => {
    localStorage.clear();
    // The room identity lives in IndexedDB, which survives `unmount` — without
    // this the next test boots straight back into the previous room.
    await clearIdentity();
  });

  afterEach(() => {
    cleanup();
  });

  it('walks create room → buy → eat → activity → account with no mock data', async () => {
    renderApp('/');

    // 1. Landing — entry point, not the room. Sign in stays secondary.
    expect(await screen.findByText('Eggs, sorted.')).toBeTruthy();
    const createButton = screen.getByRole('button', { name: 'Create a room' });
    const joinButton = screen.getByRole('button', { name: 'Join a room' });
    expect(createButton).toBeTruthy();
    expect(joinButton).toBeTruthy();

    // 2. Create a room — no account required (§16).
    await createRoom('Flat 42', 'Alex');

    // 3. A room code is shown, with a copy action and a way in (§13).
    const code = document.querySelector('.sharecode__value')?.textContent ?? '';
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    expect(screen.getByText("This is the room's join code")).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Go to Flat 42$/ }));

    // 4. Home: room name, egg count, Eat and Buy — and no money (§18).
    await waitFor(() => expect(screen.getByText('Flat 42')).toBeTruthy());
    expect(await screen.findByText('Eggs Remaining')).toBeTruthy();
    expect(document.querySelector('.inventory__count')?.textContent).toBe('0');
    expect(screen.queryByText(/Overall Balance/)).toBeNull();

    // 5. Buy: quantity first, then price PER EGG (§21) — total is derived.
    fireEvent.click(screen.getByRole('button', { name: /Buy/ }));
    expect(await screen.findByText('How many eggs?')).toBeTruthy();
    expect(document.querySelector('.stepper__value')?.textContent).toBe('12');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('What is the price per egg?')).toBeTruthy();

    await fill(/Price per egg/, '6.00');
    // 12 eggs × ₹6.00 = ₹72.00, derived, not entered.
    expect(await screen.findByText('₹72.00')).toBeTruthy();
    expect(screen.getByText('₹6.00 per egg × 12')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Stock' }));

    // 6. Inventory updates from the authoritative ledger (§23).
    await waitFor(() =>
      expect(document.querySelector('.inventory__count')?.textContent).toBe('12'),
    );

    // 7. Eat: stepper → confirm.
    fireEvent.click(screen.getByRole('button', { name: /Eat/ }));
    expect(await screen.findByText('How many eggs did you use?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(document.querySelector('.inventory__count')?.textContent).toBe('11'),
    );

    // 8. Activity records both transactions, newest first (§25).
    fireEvent.click(screen.getByRole('link', { name: 'Activity' }));
    await waitFor(() => expect(screen.getByText('Today')).toBeTruthy());

    const entries = await screen.findAllByRole('listitem');
    const text = entries.map((e) => e.textContent ?? '').join(' | ');
    expect(text).toContain('Alex (you)');
    expect(text).toContain('+12');
    expect(text).toContain('−1');

    // 9. Account reports the financial state from real data (§27).
    fireEvent.click(screen.getByRole('link', { name: 'Account' }));

    await waitFor(() => expect(screen.getByText('Overall Balance')).toBeTruthy());
    expect(screen.getByText('Alex')).toBeTruthy();
    expect(screen.getByText('Not signed in')).toBeTruthy();
    expect(screen.getByText('Room code')).toBeTruthy();

    // One egg eaten from a ₹6.00 purchase ⇒ ₹6.00 owed.
    await waitFor(() => {
      const balances = screen.getAllByText('₹6.00');
      expect(balances.length).toBeGreaterThan(0);
    });

    // 10. The room code shown in Account is the one we created (§13, §27).
    const accountCode = document.querySelector('.sharecode__value')?.textContent ?? '';
    expect(accountCode).toBe(code);
  });

  it('never lets the counter go below zero and disables Eat on an empty room (§19, §24)', async () => {
    renderApp('/');
    await createRoom('Empty Flat', 'Sam');
    fireEvent.click(screen.getByRole('button', { name: /^Go to Empty Flat$/ }));

    await waitFor(() => expect(screen.getByText('Eggs Remaining')).toBeTruthy());
    expect(document.querySelector('.inventory__count')?.textContent).toBe('0');

    // Nothing to eat yet — the primary action is unavailable, not broken.
    const eatTile = screen
      .getAllByRole('button')
      .find((b) => (b.textContent ?? '').includes('Eat')) as HTMLButtonElement;
    expect(eatTile.disabled).toBe(true);

    // Buy a dozen.
    fireEvent.click(screen.getByRole('button', { name: /Buy/ }));
    await screen.findByText('How many eggs?');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await fill(/Price per egg/, '5');
    fireEvent.click(screen.getByRole('button', { name: 'Stock' }));

    await waitFor(() =>
      expect(document.querySelector('.inventory__count')?.textContent).toBe('12'),
    );

    // Take two.
    fireEvent.click(screen.getByRole('button', { name: /Eat/ }));
    await screen.findByText('How many eggs did you use?');
    expect(screen.getByText('12 eggs remaining')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Increase by 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(document.querySelector('.inventory__count')?.textContent).toBe('10'),
    );
  });

  it('keeps the room across a reload and rejects an unknown join code (§14, §39, §51)', async () => {
    const first = renderApp('/');
    await createRoom('Persisted Flat', 'Ada');
    fireEvent.click(screen.getByRole('button', { name: /^Go to Persisted Flat$/ }));
    await waitFor(() => expect(screen.getByText('Eggs Remaining')).toBeTruthy());

    const code = document.querySelector('.sharecode__value')?.textContent ?? '';
    first.unmount();

    // Re-mount: the local identity restores the room (PRD §11).
    renderApp('/');
    await waitFor(() => expect(screen.getByText('Eggs Remaining')).toBeTruthy(), {
      timeout: 3000,
    });
    expect(screen.getByText('Persisted Flat')).toBeTruthy();

    // An unknown code is rejected with plain copy, never a raw error.
    localStorage.clear();
    location.hash = '';
    const second = renderApp('/join-room');
    await fill(/Room code/, 'ZZZZZZ');
    await fill(/Your name/, 'Nobody');
    fireEvent.click(screen.getByRole('button', { name: 'Join Room' }));

    await waitFor(() =>
      expect(
        screen.getByText(/does not match an active room/i),
      ).toBeTruthy(),
    );
    second.unmount();

    // And the real code still works.
    const third = renderApp('/join-room');
    await fill(/Room code/, code);
    await fill(/Your name/, 'Bea');
    fireEvent.click(screen.getByRole('button', { name: 'Join Room' }));
    await waitFor(() => expect(screen.getByText('Eggs Remaining')).toBeTruthy(), {
      timeout: 3000,
    });
    expect(screen.getByText('Persisted Flat')).toBeTruthy();
    third.unmount();
  });

  it('has exactly three bottom-navigation destinations (§6)', async () => {
    renderApp('/');
    await createRoom('Nav Flat', 'Kai');
    fireEvent.click(screen.getByRole('button', { name: /^Go to Nav Flat$/ }));
    await waitFor(() => expect(screen.getByText('Eggs Remaining')).toBeTruthy());

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const links = within(nav).getAllByRole('link');

    expect(links).toHaveLength(3);
    // Each destination resolves by its accessible name — the icon ligature
    // sits in an aria-hidden span and must not pollute it.
    expect(within(nav).getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Activity' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Account' })).toBeTruthy();
    expect(links[0].getAttribute('href')).toMatch(/\/room\/[^/]+$/);
    expect(links[1].getAttribute('href')).toMatch(/\/activity$/);
    expect(links[2].getAttribute('href')).toMatch(/\/account$/);
  });
});
