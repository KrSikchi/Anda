// Anda — Supabase browser client and anonymous session bootstrap.

import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export function hasSupabaseEnv(): boolean {
  return Boolean(url && anonKey);
}

export const supabase = hasSupabaseEnv() ? createClient(url!, anonKey!) : null;

export async function ensureAnonymousSession(): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured');
  const { data } = await supabase.auth.getSession();
  if (data.session) return;
  const { error } = await supabase.auth.signInAnonymously();
  if (error) throw new Error(error.message);
}
