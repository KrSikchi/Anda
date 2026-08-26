// Anda — vitest setup: provide IndexedDB via fake-indexeddb so the real
// idb-backed offline repository can run in Node (PRD Phase 7 tests).
import 'fake-indexeddb/auto';

// Keep the global store test timers deterministic.
import { vi } from 'vitest';
vi.useRealTimers();