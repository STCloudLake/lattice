import { describe, expect, it } from 'vitest';
import {
  assertChain,
  assertCue,
  assertInterest,
  assertProposition,
  buildFeed,
  createEventFactory,
  exposureShown,
  exposureSkipped,
  rateReview,
  replay,
  type LatticeEvent,
} from '../src/index.js';

const AT = '2026-11-24T09:00:00.000Z';
const NOW = '2026-11-24T12:00:00.000Z';

function ctx() {
  let n = 0;
  const newId = () => 'id' + String(++n).padStart(4, '0');
  const factory = createEventFactory({ deviceId: 'feed-test', newId, now: () => new Date(AT) });
  return { newId, factory };
}

function prop(factory: ReturnType<typeof ctx>['factory'], newId: () => string, statement: string, domain?: string) {
  const p = assertProposition(factory, newId, { statement, ...(domain ? { domain } : {}) });
  const c = assertCue(factory, newId, { propositionId: p.propositionId, front: '问？', back: statement });
  return { propositionId: p.propositionId, cueId: c.cueId, events: [p.event, c.event] as LatticeEvent[] };
}

describe('buildFeed', () => {
  it('caps the daily dose and marks foundation material', () => {
    const { factory, newId } = ctx();
    const events: LatticeEvent[] = [];
    for (let i = 0; i < 10; i++) {
      const p = prop(factory, newId, `命题 ${i}`);
      events.push(...p.events);
    }
    const feed = buildFeed(replay(events), { now: NOW, dose: 3 });
    expect(feed).toHaveLength(3);
    expect(feed.every((item) => item.kind === 'new')).toBe(true);
    expect(feed.every((item) => item.reason === 'foundation')).toBe(true);
    expect(new Set(feed.map((item) => item.propositionId)).size).toBe(3);
  });

  it('withholds material whose prerequisites are not understood', () => {
    const { factory, newId } = ctx();
    const a = prop(factory, newId, '前提 A');
    const b = prop(factory, newId, '结论 B');
    const chain = assertChain(factory, newId, {
      premiseIds: [a.propositionId],
      conclusionId: b.propositionId,
      strength: 0.9,
    });
    const state = replay([...a.events, ...b.events, chain.event]);
    const feed = buildFeed(state, { now: NOW, dose: 5 });
    const ids = feed.map((item) => item.propositionId);
    expect(ids).toContain(a.propositionId);
    expect(ids).not.toContain(b.propositionId);

    const advanced = replay([
      ...a.events,
      ...b.events,
      chain.event,
      rateReview(factory, { propositionId: a.propositionId, cueId: a.cueId, grade: 4 }, { at: AT }),
    ]);
    // A single review only seeds mastery; force it high with additional evidence.
    const mastered = replay([
      ...a.events,
      ...b.events,
      chain.event,
      rateReview(factory, { propositionId: a.propositionId, cueId: a.cueId, grade: 4 }, { at: AT }),
      rateReview(factory, { propositionId: a.propositionId, cueId: a.cueId, grade: 4 }, { at: AT }),
      rateReview(factory, { propositionId: a.propositionId, cueId: a.cueId, grade: 4 }, { at: AT }),
      rateReview(factory, { propositionId: a.propositionId, cueId: a.cueId, grade: 4 }, { at: AT }),
      rateReview(factory, { propositionId: a.propositionId, cueId: a.cueId, grade: 4 }, { at: AT }),
      rateReview(factory, { propositionId: a.propositionId, cueId: a.cueId, grade: 4 }, { at: AT }),
    ]);
    expect(advanced.reviews.length).toBe(1);
    expect(buildFeed(mastered, { now: NOW, dose: 5 }).map((i) => i.propositionId)).toContain(b.propositionId);
  });

  it('includes due reviews and caps their share of the dose', () => {
    const { factory, newId } = ctx();
    const props = [];
    for (let i = 0; i < 4; i++) props.push(prop(factory, newId, `复习命题 ${i}`));
    const events = props.flatMap((p) => p.events);
    // Fresh material exists, so the review cap actually binds.
    const fresh = [prop(factory, newId, '新命题 1'), prop(factory, newId, '新命题 2')];
    events.push(...fresh.flatMap((p) => p.events));
    const reviews = props.map((p) =>
      rateReview(factory, { propositionId: p.propositionId, cueId: p.cueId, grade: 3 }, { at: AT }),
    );
    const later = '2026-12-20T12:00:00.000Z';
    const feed = buildFeed(replay([...events, ...reviews]), { now: later, dose: 3, reviewShare: 0.4 });
    expect(feed.length).toBeGreaterThan(0);
    expect(feed.filter((item) => item.kind === 'review').length).toBeLessThanOrEqual(1);
  });

  it('never repeats a proposition on the same day', () => {
    const { factory, newId } = ctx();
    const p = prop(factory, newId, '只出现一次');
    const state = replay([...p.events]);
    const first = buildFeed(state, { now: NOW, dose: 3 });
    expect(first.map((i) => i.propositionId)).toContain(p.propositionId);
    const shown = exposureShown(factory, { propositionId: p.propositionId, day: '2026-11-24' }, { at: NOW });
    const second = buildFeed(replay([...p.events, shown]), { now: NOW, dose: 3 });
    expect(second.map((i) => i.propositionId)).not.toContain(p.propositionId);
  });

  it('drops material the user skipped twice', () => {
    const { factory, newId } = ctx();
    const p = prop(factory, newId, '不感兴趣');
    const skips = [
      exposureSkipped(factory, { propositionId: p.propositionId }, { at: NOW }),
      exposureSkipped(factory, { propositionId: p.propositionId }, { at: NOW }),
    ];
    const feed = buildFeed(replay([...p.events, ...skips]), { now: NOW, dose: 3 });
    expect(feed.map((i) => i.propositionId)).not.toContain(p.propositionId);
  });

  it('lets captured interest reorder the feed', () => {
    const { factory, newId } = ctx();
    const economics = prop(factory, newId, '经济学命题', '经济学');
    const cooking = prop(factory, newId, '烹饪命题', '烹饪');
    const interest = assertInterest(factory, { domain: '经济学', weight: 5 }, { at: AT });
    const feed = buildFeed(replay([...economics.events, ...cooking.events, interest.event]), { now: NOW, dose: 2 });
    expect(feed[0]?.propositionId).toBe(economics.propositionId);
    expect(feed[0]?.domain).toBe('经济学');
  });

  it('is deterministic for the same state', () => {
    const { factory, newId } = ctx();
    const events: LatticeEvent[] = [];
    for (let i = 0; i < 5; i++) events.push(...prop(factory, newId, `命题 ${i}`).events);
    const state = replay(events);
    expect(buildFeed(state, { now: NOW, dose: 3 })).toEqual(buildFeed(state, { now: NOW, dose: 3 }));
  });
});
