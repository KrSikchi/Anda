// Anda — React hook that re-renders on store changes (useSyncExternalStore).
// Null-tolerant: screens render before a room exists, so the hook is always
// called and simply no-ops while there is no store.

import { useSyncExternalStore, useCallback } from 'react';
import type { AndaStore } from './store';

const NOOP = () => () => {};

export function useAndaStore(store: AndaStore | null): AndaStore | null {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!store) return NOOP();
      store._notify = cb;
      return () => {
        store._notify = undefined;
      };
    },
    [store],
  );
  const snapshot = useCallback(() => (store ? store._version : 0), [store]);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return store;
}
