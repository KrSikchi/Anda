// Anda — financial calculation boundary (PRD §22, §45).
//
// Every money rule the UI needs lives here: parsing, formatting, and the
// shaping of the Account balance view. Components never do arithmetic on
// money and never format it themselves.
//
// This module is PURE and framework-free on purpose. PRD §46 defers the final
// settlement mathematics; when it lands, it replaces the shaping functions
// below and the Account screen does not change.

import type { LedgerMemberRow, Minor } from './types';

/** Largest amount accepted from user input (₹1 crore), keeps maths in range. */
const MAX_MINOR = 100_000_000_00;

/**
 * Parse a user-entered rupee amount straight into integer paise.
 *
 * Deliberately string-based: `parseFloat` would introduce a binary float into
 * the authoritative path, which PRD §22 forbids. Returns null for anything
 * that is not a plain positive amount with at most two decimal places.
 */
export function parseMoneyToMinor(raw: string): Minor | null {
  const cleaned = raw.trim().replace(/[₹,\s]/g, '');
  if (cleaned === '' || cleaned === '.') return null;
  if (!/^\d*(\.\d{0,2})?$/.test(cleaned)) return null;

  const [whole = '', frac = ''] = cleaned.split('.');
  if (whole === '' && frac === '') return null;

  const paisePart = (frac + '00').slice(0, 2);
  const minor = Number(whole || '0') * 100 + Number(paisePart);

  if (!Number.isSafeInteger(minor) || minor < 0 || minor > MAX_MINOR) return null;
  return minor;
}

/** Render integer paise as ₹ with exactly two decimals (en-IN grouping). */
export function formatMinor(
  minor: Minor,
  opts: { sign?: boolean; bare?: boolean } = {},
): string {
  const rounded = Math.round(minor);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  const rupees = Math.trunc(abs / 100);
  const paise = abs % 100;
  const body = `${rupees.toLocaleString('en-IN')}.${String(paise).padStart(2, '0')}`;
  const prefix = negative ? '−' : opts.sign ? '+' : '';
  return opts.bare ? `${prefix}${body}` : `${prefix}₹${body}`;
}

/** Paise back into an editable field value (no currency symbol, 2 decimals). */
export function minorToInput(minor: Minor): string {
  const abs = Math.abs(Math.round(minor));
  return `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Total value of a purchase: quantity × unit price, in paise. */
export function purchaseTotalMinor(quantity: number, unitPriceMinor: Minor): Minor {
  return quantity * unitPriceMinor;
}

// ---------------------------------------------------------------------------
// Account view (PRD §27, §29, §45)
// ---------------------------------------------------------------------------

export type BalanceState = 'owes' | 'settled' | 'even';

export interface MemberBalance {
  memberId: string;
  displayName: string;
  isHost: boolean;
  isActive: boolean;
  isCurrentMember: boolean;
  consumed: number;
  /** FIFO cost of the eggs they have eaten. */
  liabilityMinor: Minor;
  /** How much of that they have settled. */
  settledMinor: Minor;
  /** What is still outstanding. */
  outstandingMinor: Minor;
  state: BalanceState;
}

export interface AccountView {
  /** Total still outstanding across the room — the flat's egg debt. */
  overallMinor: Minor;
  /** The signed-in member's own outstanding amount. */
  yourOutstandingMinor: Minor;
  members: MemberBalance[];
  /** A room where nothing has been consumed yet has nothing to settle. */
  hasAnyBalance: boolean;
}

function toMemberBalance(row: LedgerMemberRow, currentMemberId: string): MemberBalance {
  const state: BalanceState =
    row.outstanding_minor > 0 ? 'owes' : row.liability_minor > 0 ? 'settled' : 'even';

  return {
    memberId: row.member_id,
    displayName: row.display_name,
    isHost: row.is_host,
    isActive: row.is_active,
    isCurrentMember: row.member_id === currentMemberId,
    consumed: row.consumed,
    liabilityMinor: row.liability_minor,
    settledMinor: row.settled_minor,
    outstandingMinor: row.outstanding_minor,
    state,
  };
}

/**
 * Shape authoritative ledger rows into what Account renders.
 *
 * "Overall Balance" is the room's total outstanding amount — the sum of what
 * every member still owes. That matches the supplied design, where the overall
 * figure equals the sum of the per-member rows beneath it.
 */
export function buildAccountView(
  rows: LedgerMemberRow[],
  currentMemberId: string,
): AccountView {
  const members = rows.map((row) => toMemberBalance(row, currentMemberId));
  const active = members.filter((m) => m.isActive);

  const overallMinor = active.reduce((sum, m) => sum + m.outstandingMinor, 0);
  const you = members.find((m) => m.isCurrentMember);

  return {
    overallMinor,
    yourOutstandingMinor: you?.outstandingMinor ?? 0,
    members,
    hasAnyBalance: rows.some((r) => r.liability_minor > 0),
  };
}

/**
 * Who a settlement is recorded against.
 *
 * The PRD does not fix the counterparty rule (§29: "do not invent complex
 * financial semantics"), so the choice lives here, behind the boundary, and
 * can be replaced without touching the Account screen or the schema.
 *
 * Rule: settle with the flatmate who fronted the most money for eggs. If
 * nobody has bought anything yet, fall back to the room host. Returns null
 * when there is nobody else in the room to settle with.
 */
export function settlementCounterparty(
  rows: LedgerMemberRow[],
  currentMemberId: string,
): LedgerMemberRow | null {
  const others = rows.filter(
    (r) => r.member_id !== currentMemberId && r.is_active,
  );
  if (others.length === 0) return null;

  const withOutlay = others
    .filter((r) => r.purchased_minor > 0)
    .sort(
      (a, b) =>
        b.purchased_minor - a.purchased_minor ||
        Number(b.is_host) - Number(a.is_host),
    );

  if (withOutlay.length > 0) return withOutlay[0];

  return others.find((r) => r.is_host) ?? others[0];
}

/** Avatar initials from a display name (never a UUID — PRD §15). */
export function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
