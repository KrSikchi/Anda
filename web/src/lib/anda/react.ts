// Anda — React hook that re-renders on store changes (useSyncExternalStore).

import { useSyncExternalStore, useCallback } from 'react';
import type { AndaStore } from './store';

function getSnapshot(store: AndaStore): number {
  return store._version;
}

function subscribe(store: AndaStore, cb: () => void): () => void {
  store._notify = cb;
  return () => { store._notify = undefined; };
}

/** Subscribe a React component to store state. Re-renders on every change. */
export function useAndaStore(store: AndaStore): AndaStore {
  const sub = useCallback((cb: () => void) => subscribe(store, cb), [store]);
  const snap = useCallback(() => getSnapshot(store), [store]);
  useSyncExternalStore(sub, snap, snap);
  return store;
}