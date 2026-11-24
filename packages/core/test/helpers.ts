import {
  createEventFactory,
  type EventFactory,
  type Id,
  type LatticeEvent,
} from '../src/index.js';

export interface TestContext {
  factory: EventFactory;
  newId: () => Id;
  now: () => Date;
  setNow: (iso: string) => void;
  advanceMs: (ms: number) => void;
}

/** Deterministic ids and clock so replay digests are reproducible. */
export function testContext(startAt = '2026-11-01T00:00:00.000Z'): TestContext {
  let t = new Date(startAt).getTime();
  let n = 0;
  const newId = () => 'id' + String(++n).padStart(4, '0');
  const now = () => new Date(t);
  const factory = createEventFactory({ deviceId: 'test-device', newId, now });
  return {
    factory,
    newId,
    now,
    setNow: (iso) => {
      t = new Date(iso).getTime();
    },
    advanceMs: (ms) => {
      t += ms;
    },
  };
}

export function appendAll(events: LatticeEvent[]): LatticeEvent[] {
  return events;
}
