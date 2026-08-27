// React context for the AndaStore (PRD §22/§23).

import { createContext, useContext } from 'react';
import type { AndaStore } from './store';

export const AndaContext = createContext<AndaStore | null>(null);

export function useAnda(): AndaStore {
  const store = useContext(AndaContext);
  if (!store) throw new Error('useAnda must be used within <AndaContext.Provider>');
  return store;
}