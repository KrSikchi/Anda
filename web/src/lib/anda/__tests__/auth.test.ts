// Anda — identity/auth surface tests (PRD §16, §17, §28, §44, §51).
//
// The identity rules are the part of the migration that cannot be fudged: the
// difference between "same member, same history" and "a duplicate person" is
// one call. These tests pin the client-side half of that contract against a
// stub auth client, so the behaviour is checked without a live Supabase project.

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ensureAnonymousSession,
  friendlyAuthError,
  readAuthState,
  signInWithPassword,
  signOut,
  upgradeAnonymousIdentity,
} from '../auth';

interface StubAuth {
  user?: { id: string; email?: string | null; is_anonymous?: boolean } | null;
  updateUser?: ReturnType<typeof vi.fn>;
  signInWithPassword?: ReturnType<typeof vi.fn>;
  signInAnonymously?: ReturnType<typeof vi.fn>;
  signOut?: ReturnType<typeof vi.fn>;
}

function stubClient(auth: StubAuth): SupabaseClient {
  return {
    auth: {
      getSession: async () => ({
        data: { session: auth.user ? { user: auth.user } : null },
      }),
      updateUser: auth.updateUser ?? vi.fn(async () => ({ data: { user: null }, error: null })),
      signInWithPassword:
        auth.signInWithPassword ?? vi.fn(async () => ({ data: { user: null }, error: null })),
      signInAnonymously: auth.signInAnonymously ?? vi.fn(async () => ({ error: null })),
      signOut: auth.signOut ?? vi.fn(async () => ({ error: null })),
    },
  } as unknown as SupabaseClient;
}

describe('readAuthState', () => {
  it('reports no session on a device with nothing saved', async () => {
    await expect(readAuthState(stubClient({ user: null }))).resolves.toEqual({
      kind: 'none',
    });
  });

  it('recognises an anonymous session — fully usable, not yet recoverable', async () => {
    const state = await readAuthState(
      stubClient({ user: { id: 'u1', is_anonymous: true } }),
    );
    expect(state).toEqual({ kind: 'anonymous' });
  });

  it('recognises a permanent identity and surfaces its email', async () => {
    const state = await readAuthState(
      stubClient({ user: { id: 'u1', email: 'alex@example.com', is_anonymous: false } }),
    );
    expect(state).toEqual({ kind: 'permanent', email: 'alex@example.com' });
  });
});

describe('optional persistence never blocks core use (§16)', () => {
  it('bootstraps an anonymous session only when there is none', async () => {
    const signInAnonymously = vi.fn(async () => ({ error: null }));

    // Already signed in: no needless call.
    await ensureAnonymousSession(
      stubClient({ user: { id: 'u1', is_anonymous: true }, signInAnonymously }),
    );
    expect(signInAnonymously).not.toHaveBeenCalled();

    await ensureAnonymousSession(stubClient({ user: null, signInAnonymously }));
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });
});

describe('in-place upgrade keeps the same identity (§44)', () => {
  it('upgrades the CURRENT anonymous user rather than creating another', async () => {
    const updateUser = vi.fn(async () => ({
      data: { user: { id: 'same-uid', email: 'alex@example.com' } },
      error: null,
    }));

    const client = stubClient({
      user: { id: 'same-uid', is_anonymous: true },
      updateUser,
    });

    const result = await upgradeAnonymousIdentity(client, 'alex@example.com', 'secret123');

    // updateUser (not signUp) is what preserves auth.uid() — and therefore the
    // member row, its history and its balances.
    expect(updateUser).toHaveBeenCalledWith({
      email: 'alex@example.com',
      password: 'secret123',
    });
    expect(result.email).toBe('alex@example.com');
  });

  it('surfaces a taken email as plain copy, not raw auth text', async () => {
    const client = stubClient({
      user: { id: 'u1', is_anonymous: true },
      updateUser: vi.fn(async () => ({
        data: { user: null },
        error: { message: 'User already registered (email_exists)' },
      })),
    });

    await expect(
      upgradeAnonymousIdentity(client, 'alex@example.com', 'secret123'),
    ).rejects.toThrow('That email is already used. Sign in with it instead.');
  });
});

describe('signing in on a device with no local state (§17)', () => {
  it('signs in with the password path', async () => {
    const signIn = vi.fn(async () => ({
      data: { user: { id: 'u1', email: 'alex@example.com' } },
      error: null,
    }));

    const result = await signInWithPassword(
      stubClient({ user: null, signInWithPassword: signIn }),
      'alex@example.com',
      'secret123',
    );

    expect(signIn).toHaveBeenCalledWith({
      email: 'alex@example.com',
      password: 'secret123',
    });
    expect(result.email).toBe('alex@example.com');
  });

  it('leaves the app usable after signing out', async () => {
    const signOutFn = vi.fn(async () => ({ error: null }));
    await signOut(stubClient({ user: { id: 'u1' }, signOut: signOutFn }));
    expect(signOutFn).toHaveBeenCalledTimes(1);
  });
});

describe('friendlyAuthError — no raw auth text reaches a flatmate (§39)', () => {
  const cases: Array<[string, string]> = [
    ['Invalid login credentials', 'That email and password did not match.'],
    ['User already registered', 'That email is already used. Sign in with it instead.'],
    ['Password should be at least 6 characters', 'Use a password of at least 6 characters.'],
    ['Unable to validate email address: invalid format', 'That email address does not look right.'],
    ['over_email_send_rate_limit', 'Too many attempts. Try again in a little while.'],
    ['JWT expired', 'Your session ended. Sign in again to keep your history.'],
    ['Failed to fetch', 'No connection. Check your internet and try again.'],
  ];

  it.each(cases)('maps %s to plain copy', (raw, expected) => {
    expect(friendlyAuthError(raw)).toBe(expected);
  });

  it('has a safe fallback for anything unmapped', () => {
    expect(friendlyAuthError('something unexpected')).toBe('Could not sign in. Try again.');
  });
});
