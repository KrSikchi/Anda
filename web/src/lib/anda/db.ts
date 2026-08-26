// Anda — IndexedDB offline repository (PRD §14, §15).
//
// Stores, under one database:
//   meta    — device-bound member identity + room binding (§4, §14)
//   cache   — last authoritative room state & recent history (read-only cache)
//   pending — FIFO queue of mutations made while offline
//
// The queue is durable on-device and survives app reload; it is flushed when
// connectivity returns and every item is re-validated by the server (§15).
// No CRDT, no local authority — the server stays the single source of truth.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { OfflineRepo, PendingMutation } from './types';

interface AndaDBSchema extends DBSchema {
  meta: { key: string; value: unknown };
  cache: { key: string; value: unknown };
  pending: { key: number; value: PendingMutation };
}

const DEFAULT_DB_NAME = 'anda';

export class IdbRepo implements OfflineRepo {
  private dbPromise: Promise<IDBPDatabase<AndaDBSchema>> | null = null;
  private readonly dbName: string;

  constructor(dbName: string = DEFAULT_DB_NAME) {
    this.dbName = dbName;
  }

  private db(): Promise<IDBPDatabase<AndaDBSchema>> {
    this.dbPromise ??= openDB<AndaDBSchema>(this.dbName, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache');
        if (!db.objectStoreNames.contains('pending')) {
          db.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
        }
      },
    });
    return this.dbPromise;
  }

  // -- meta ----------------------------------------------------------------

  async saveMeta(key: string, value: unknown): Promise<void> {
    await (await this.db()).put('meta', value, key);
  }

  async loadMeta<T>(key: string): Promise<T | undefined> {
    return (await (await this.db()).get('meta', key)) as T | undefined;
  }

  // -- cache -----------------------------------------------------------------

  async cacheSet<T>(key: string, value: T): Promise<void> {
    await (await this.db()).put('cache', value, key);
  }

  async cacheGet<T>(key: string): Promise<T | undefined> {
    return (await (await this.db()).get('cache', key)) as T | undefined;
  }

  // -- pending queue --------------------------------------------------------

  async enqueue(mutation: PendingMutation): Promise<number> {
    return await (await this.db()).add('pending', mutation);
  }

  async listPending(): Promise<PendingMutation[]> {
    const all = await (await this.db()).getAll('pending');
    return all.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  }

  async removePending(id: number): Promise<void> {
    await (await this.db()).delete('pending', id);
  }
}