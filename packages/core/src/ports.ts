import type { LatticeEvent } from './types.js';

/**
 * Ports. The core never touches storage, clocks or randomness directly; adapters
 * (browser worker / Node CLI / tests) provide them.
 */

export interface Clock {
  now(): Date;
}

export interface EventStore {
  /** All events, in any order (the core sorts them). */
  loadAll(): Promise<LatticeEvent[]>;
  /** Must be atomic: either every event lands or none does. */
  appendBatch(events: LatticeEvent[]): Promise<void>;
  /** Hard delete. Used by "delete all data"; there is no undo at this layer. */
  clear(): Promise<void>;
}

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

export const systemClock: Clock = { now: () => new Date() };
