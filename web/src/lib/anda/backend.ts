// Anda — backend selection.
//
// Production is Supabase: room-scoped RPCs, SECURITY DEFINER writes, RLS
// reads, Realtime. When the Supabase env vars are absent there is no backend
// at all, so the app would be a dead shell — a local in-memory backend is used
// instead purely so the UI can run (see lib/demo/demoBackend.ts for what it
// does and does not do). The UI states which one is active.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseApi } from './api';
import { createSupabaseTransport } from './transport';
import {
  ensureAnonymousSession,
  readAuthState,
  signInWithPassword,
  signOut,
  upgradeAnonymousIdentity,
  type AuthState,
} from './auth';
import { createDemoBackend } from '../demo/demoBackend';
import type { AndaApi, RealtimeTransport } from './types';

export interface AndaAuth {
  state(): Promise<AuthState>;
  /** Anonymous session bootstrap; core usage never requires it (PRD §16). */
  ensureSession(): Promise<void>;
  /** Add email + password to the current anonymous identity (PRD §44). */
  upgrade(email: string, password: string): Promise<{ email: string | null }>;
  /** Sign in as an existing identity on a device with no local state. */
  signIn(email: string, password: string): Promise<{ email: string | null }>;
  signOut(): Promise<void>;
}

export interface AndaBackend {
  kind: 'supabase' | 'demo';
  api: AndaApi;
  transport: RealtimeTransport;
  auth: AndaAuth;
}

export function createSupabaseBackend(client: SupabaseClient): AndaBackend {
  return {
    kind: 'supabase',
    api: createSupabaseApi(client),
    transport: createSupabaseTransport(client),
    auth: {
      state: () => readAuthState(client),
      ensureSession: () => ensureAnonymousSession(client),
      upgrade: (email, password) => upgradeAnonymousIdentity(client, email, password),
      signIn: (email, password) => signInWithPassword(client, email, password),
      signOut: () => signOut(client),
    },
  };
}

/**
 * Local-only backend. Authentication is simulated in memory: there is no
 * identity provider to talk to, but every flow that reads auth state has to
 * return something coherent so the Account screen is exercisable.
 */
export function createDemoBackendAdapter(): AndaBackend {
  const demo = createDemoBackend();

  return {
    kind: 'demo',
    api: demo.api,
    transport: demo.transport,
    auth: {
      async state() {
        return demo.auth.getState();
      },
      async ensureSession() {
        /* demo sessions always exist */
      },
      async upgrade(email) {
        demo.auth.setPermanent(email);
        return { email };
      },
      async signIn(email) {
        demo.auth.setPermanent(email);
        return { email };
      },
      async signOut() {
        demo.auth.reset();
      },
    },
  };
}
