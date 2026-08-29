// Anda — optional email/password persistence (PRD §16, §17, §44, §51).
//
// Authentication is an UPGRADE to an identity that already exists, never a
// precondition for using Anda, and never a way to create a second person.
//
// The key mechanism is Supabase's in-place anonymous upgrade: calling
// updateUser({ email, password }) on an anonymous session converts that same
// auth user into a permanent one. The uid does not change, so
// members.auth_user_id keeps pointing at the same row — same member, same
// room, same history, same balances. That is PRD §44's outcome by construction,
// with no data migration at all.
//
// The other case is a device with no local state (new phone, cleared storage).
// There is nothing there to upgrade, so the user signs in normally and
// `my_memberships()` (migration 0007) recovers their rooms from the server.

import type { SupabaseClient, User } from '@supabase/supabase-js';

export type AuthState =
  /** No session at all — fresh device, nothing to upgrade. */
  | { kind: 'none' }
  /** Anonymous session: fully usable, not yet recoverable. */
  | { kind: 'anonymous' }
  /** Permanent session: survives browser restarts and new devices. */
  | { kind: 'permanent'; email: string | null };

export async function readAuthState(
  client: SupabaseClient,
): Promise<AuthState> {
  const { data } = await client.auth.getSession();
  const user = data.session?.user;
  if (!user) return { kind: 'none' };
  return isAnonymousUser(user)
    ? { kind: 'anonymous' }
    : { kind: 'permanent', email: user.email ?? null };
}

/** Supabase flags converted-anonymous users with `is_anonymous`. */
function isAnonymousUser(user: User): boolean {
  return (user as User & { is_anonymous?: boolean }).is_anonymous === true;
}

/** Anonymous session bootstrap. Core usage works without it (PRD §16). */
export async function ensureAnonymousSession(
  client: SupabaseClient,
): Promise<void> {
  const { data } = await client.auth.getSession();
  if (data.session) return;
  const { error } = await client.auth.signInAnonymously();
  if (error) throw new Error(friendlyAuthError(error.message));
}

/**
 * Add email + password to the CURRENT anonymous identity.
 * Preserves member, membership, history and balances (PRD §44).
 */
export async function upgradeAnonymousIdentity(
  client: SupabaseClient,
  email: string,
  password: string,
): Promise<{ email: string | null }> {
  const { data, error } = await client.auth.updateUser({ email, password });
  if (error) throw new Error(friendlyAuthError(error.message));
  return { email: data.user?.email ?? email };
}

/** Sign in as an existing permanent identity (new/cleared device recovery). */
export async function signInWithPassword(
  client: SupabaseClient,
  email: string,
  password: string,
): Promise<{ email: string | null }> {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(friendlyAuthError(error.message));
  return { email: data.user?.email ?? email };
}

/**
 * Sign out. A fresh anonymous session is issued immediately so the app stays
 * usable in the room (PRD §16: authentication is never required).
 */
export async function signOut(client: SupabaseClient): Promise<void> {
  const { error } = await client.auth.signOut();
  if (error) throw new Error(friendlyAuthError(error.message));
}

/**
 * PRD §39: never surface raw database or auth errors to a flatmate.
 * Auth failures are mapped to plain copy; detail stays in the console.
 */
export function friendlyAuthError(message: string): string {
  const raw = message.toLowerCase();
  if (raw.includes('invalid login credentials')) {
    return 'That email and password did not match.';
  }
  if (raw.includes('email_exists') || raw.includes('already registered')) {
    return 'That email is already used. Sign in with it instead.';
  }
  if (raw.includes('password should be') || raw.includes('password must be')) {
    return 'Use a password of at least 6 characters.';
  }
  if (raw.includes('unable to validate email') || raw.includes('invalid email')) {
    return 'That email address does not look right.';
  }
  if (raw.includes('email rate limit') || raw.includes('over_email_send_rate_limit')) {
    return 'Too many attempts. Try again in a little while.';
  }
  if (raw.includes('signups not allowed')) {
    return 'New sign-ins are turned off right now.';
  }
  if (raw.includes('failed to fetch') || raw.includes('networkerror')) {
    return 'No connection. Check your internet and try again.';
  }
  return 'Could not sign in. Try again.';
}
