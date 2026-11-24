import { describe, expect, it } from 'vitest';
import {
  assertCue,
  assertProposition,
  buildQueue,
  pickCue,
  rateReview,
  replay,
  type LatticeEvent,
} from '../src/index.js';
import { testContext } from './helpers.js';

function threePropositions() {
  const ctx = testContext();
  const events: LatticeEvent[] = [];
  const ids: { propositionId: string; cueId: string }[] = [];
  for (let i = 0; i < 3; i++) {
    ctx.advanceMs(1000);
    const p = assertProposition(ctx.factory, ctx.newId, { statement: `命题 ${i}` });
    const c = assertCue(ctx.factory, ctx.newId, {
      propositionId: p.propositionId,
      front: `问题 ${i}`,
      back: `答案 ${i}`,
    });
    events.push(p.event, c.event);
    ids.push({ propositionId: p.propositionId, cueId: c.cueId });
  }
  return { ctx, events, ids };
}

describe('queue', () => {
  it('offers all new propositions up to the limit', () => {
    const { events } = threePropositions();
    const state = replay(events);
    const queue = buildQueue(state, '2026-11-02T00:00:00.000Z', { newLimit: 2 });
    expect(queue).toHaveLength(2);
    expect(queue.every((q) => q.kind === 'new')).toBe(true);
  });

  it('reviews come before new material', () => {
    const { ctx, events, ids } = threePropositions();
    ctx.advanceMs(1000);
    const review = rateReview(ctx.factory, {
      propositionId: ids[0]!.propositionId,
      cueId: ids[0]!.cueId,
      grade: 3,
    });
    const state = replay([...events, review]);
    const queue = buildQueue(state, '2036-01-01T00:00:00.000Z', { newLimit: 5 });
    expect(queue[0]?.kind).toBe('review');
    expect(queue[0]?.propositionId).toBe(ids[0]!.propositionId);
    expect(queue.filter((q) => q.kind === 'new')).toHaveLength(2);
  });

  it('does not offer a reviewed proposition before it is due', () => {
    const { ctx, events, ids } = threePropositions();
    const reviewedAt = new Date(ctx.now().getTime() + 1000).toISOString();
    const review = rateReview(
      ctx.factory,
      { propositionId: ids[0]!.propositionId, cueId: ids[0]!.cueId, grade: 3 },
      { at: reviewedAt },
    );
    const state = replay([...events, review]);
    const dueAt = state.schedule[ids[0]!.propositionId]!.dueAt;
    const justBefore = new Date(new Date(dueAt).getTime() - 1000).toISOString();
    const queue = buildQueue(state, justBefore);
    expect(queue.find((q) => q.propositionId === ids[0]!.propositionId)).toBeUndefined();
  });

  it('rotates cues before repeating one', () => {
    const { ctx, events, ids } = threePropositions();
    ctx.advanceMs(500);
    const extraCue = assertCue(ctx.factory, ctx.newId, {
      propositionId: ids[0]!.propositionId,
      front: '另一种问法',
      back: '同一个答案',
    });
    const state = replay([...events, extraCue.event]);
    const first = pickCue(state, ids[0]!.propositionId);
    expect(first).toBeDefined();
    // Review the picked cue, then the other one should be preferred.
    const review = rateReview(
      ctx.factory,
      { propositionId: ids[0]!.propositionId, cueId: first!, grade: 3 },
      { at: new Date(ctx.now().getTime() + 1000).toISOString() },
    );
    const next = replay([...events, extraCue.event, review]);
    expect(pickCue(next, ids[0]!.propositionId)).not.toBe(first);
  });
});
