// Anda — money and account-shaping tests (PRD §21, §22, §45).
//
// The financial boundary has to be right before the Account screen can be
// trusted: one wrong unit or one float in the authoritative path silently
// misreports how much a flatmate owes.

import { describe, expect, it } from 'vitest';
import {
  buildAccountView,
  formatMinor,
  initials,
  minorToInput,
  parseMoneyToMinor,
  purchaseTotalMinor,
  settlementCounterparty,
} from '../finance';
import type { LedgerMemberRow } from '../types';

describe('parseMoneyToMinor — integer paise, never a float (§22)', () => {
  it('parses plain rupees', () => {
    expect(parseMoneyToMinor('6')).toBe(600);
    expect(parseMoneyToMinor('0')).toBe(0);
    expect(parseMoneyToMinor('12.00')).toBe(1200);
  });

  it('parses paise without floating point drift', () => {
    // 0.1 + 0.2 style drift is the whole reason for integer minor units.
    expect(parseMoneyToMinor('0.10')).toBe(10);
    expect(parseMoneyToMinor('1.10')).toBe(110);
    expect(parseMoneyToMinor('9.99')).toBe(999);
  });

  it('tolerates currency symbols, commas and padding', () => {
    expect(parseMoneyToMinor(' ₹1,234.50 ')).toBe(123450);
    expect(parseMoneyToMinor('₹7')).toBe(700);
  });

  it('rejects junk rather than guessing', () => {
    expect(parseMoneyToMinor('')).toBeNull();
    expect(parseMoneyToMinor('.')).toBeNull();
    expect(parseMoneyToMinor('-5')).toBeNull();
    expect(parseMoneyToMinor('1.234')).toBeNull();
    expect(parseMoneyToMinor('abc')).toBeNull();
    expect(parseMoneyToMinor('1e3')).toBeNull();
  });
});

describe('formatting', () => {
  it('renders two decimals and en-IN grouping', () => {
    expect(formatMinor(1200)).toBe('₹12.00');
    expect(formatMinor(0)).toBe('₹0.00');
    expect(formatMinor(5)).toBe('₹0.05');
    expect(formatMinor(123456789)).toBe('₹12,34,567.89');
  });

  it('supports an explicit sign for overall balances', () => {
    expect(formatMinor(1200, { sign: true })).toBe('+₹12.00');
    expect(formatMinor(-1200)).toBe('−₹12.00');
  });

  it('round-trips through an editable field value', () => {
    expect(minorToInput(650)).toBe('6.50');
    expect(parseMoneyToMinor(minorToInput(650))).toBe(650);
  });
});

describe('purchase value (§21) — unit price is the input', () => {
  it('derives the total from quantity × unit price', () => {
    // The PRD's own example: 12 eggs at ₹6.00 per egg is ₹72.00 total.
    const unit = parseMoneyToMinor('6.00');
    expect(unit).toBe(600);
    expect(purchaseTotalMinor(12, unit!)).toBe(7200);
    expect(formatMinor(purchaseTotalMinor(12, unit!))).toBe('₹72.00');
  });

  it('does not divide a total back into a unit price', () => {
    // 10 eggs for ₹100 is ₹10.00 each; 3 eggs for ₹10 is ₹3.33 each and the
    // remainder is real, not a rounding artefact introduced in the UI.
    expect(purchaseTotalMinor(3, 333)).toBe(999);
  });
});

function row(over: Partial<LedgerMemberRow> & { member_id: string }): LedgerMemberRow {
  return {
    room_id: 'room',
    room_name: 'Flat',
    inventory: 0,
    low_stock_threshold: 10,
    low_stock_notified: false,
    display_name: over.member_id,
    is_active: true,
    is_host: false,
    consumed: 0,
    purchased_minor: 0,
    liability_minor: 0,
    settled_minor: 0,
    outstanding_minor: 0,
    ...over,
  };
}

describe('buildAccountView (§27, §45)', () => {
  it('sums per-member outstanding into the overall balance', () => {
    const view = buildAccountView(
      [
        row({ member_id: 'a', liability_minor: 800, outstanding_minor: 800, consumed: 4 }),
        row({ member_id: 'b', liability_minor: 400, outstanding_minor: 400, consumed: 2 }),
      ],
      'a',
    );

    expect(view.overallMinor).toBe(1200);
    expect(view.yourOutstandingMinor).toBe(800);
    expect(view.hasAnyBalance).toBe(true);
  });

  it('treats a cleared balance as settled and an untouched one as even', () => {
    const view = buildAccountView(
      [
        row({ member_id: 'a', liability_minor: 800, settled_minor: 800, outstanding_minor: 0 }),
        row({ member_id: 'b' }),
      ],
      'a',
    );

    expect(view.members[0].state).toBe('settled');
    expect(view.members[1].state).toBe('even');
    expect(view.overallMinor).toBe(0);
  });

  it('reports nothing outstanding for a room that has not eaten yet', () => {
    const view = buildAccountView([row({ member_id: 'a' })], 'a');
    expect(view.hasAnyBalance).toBe(false);
    expect(view.overallMinor).toBe(0);
  });
});

describe('settlementCounterparty', () => {
  it('settles with whoever fronted the egg money', () => {
    const rows = [
      row({ member_id: 'me', is_host: true }),
      row({ member_id: 'sam', purchased_minor: 5000 }),
      row({ member_id: 'ada', purchased_minor: 1200 }),
    ];
    expect(settlementCounterparty(rows, 'me')?.member_id).toBe('sam');
  });

  it('falls back to the host when nobody has bought anything', () => {
    const rows = [
      row({ member_id: 'me' }),
      row({ member_id: 'sam', is_host: true }),
    ];
    expect(settlementCounterparty(rows, 'me')?.member_id).toBe('sam');
  });

  it('returns null rather than letting a member settle with themselves', () => {
    expect(settlementCounterparty([row({ member_id: 'me' })], 'me')).toBeNull();
  });
});

describe('initials — never a UUID', () => {
  it('uses the display name', () => {
    expect(initials('Alex Chen')).toBe('AC');
    expect(initials('Sam')).toBe('SA');
    expect(initials('')).toBe('?');
  });
});
