import { describe, expect, it } from 'vitest';
import {
  assertCue,
  assertProposition,
  dedupeAndSort,
  masterySummary,
  mergeProposition,
  answerQuiz,
  rateReview,
  replay,
  stateDigest,
  type LatticeEvent,
} from '../src/index.js';
import { testContext } from './helpers.js';

function seed() {
  const ctx = testContext();
  const p = assertProposition(ctx.factory, ctx.newId, {
    statement: '边际效用递减',
    name: '边际效用递减',
    aliases: ['marginal utility diminishing'],
    domain: 'economics',
  });
  const c = assertCue(ctx.factory, ctx.newId, {
    propositionId: p.propositionId,
    front: '边际效用为什么递减？',
    back: '每增加一单位消费，新增满足感下降。',
  });
  return { ctx, p, c, events: [p.event, c.event] as LatticeEvent[] };
}

describe('replay', () => {
  it('builds the K ledger and seeds M/S ledgers', () => {
    const { events, p, c } = seed();
    const state = replay(events);
    expect(Object.keys(state.propositions)).toHaveLength(1);
    expect(Object.keys(state.cues)).toHaveLength(1);
    expect(state.propositions[p.propositionId]?.aliases).toEqual(['marginal utility diminishing']);
    expect(state.cues[c.cueId]?.propositionId).toBe(p.propositionId);
    // Prior: Beta(2,2) -> 0.5 with a wide interval.
    const summary = masterySummary(state.mastery[p.propositionId]!);
    expect(summary.mean).toBeCloseTo(0.5, 10);
    expect(summary.high - summary.low).toBeGreaterThan(0.4);
    // Never reviewed yet.
    expect(state.schedule[p.propositionId]?.reviewCount).toBe(0);
    expect(state.reviews).toHaveLength(0);
  });

  it('a review moves S and M independently', () => {
    const { ctx, p, c, events } = seed();
    ctx.advanceMs(60 * 60 * 1000);
    const review = rateReview(ctx.factory, {
      propositionId: p.propositionId,
      cueId: c.cueId,
      grade: 3,
    });
    const state = replay([...events, review]);
    const schedule = state.schedule[p.propositionId]!;
    expect(schedule.reviewCount).toBe(1);
    expect(schedule.stability).toBeGreaterThan(0);
    expect(schedule.stage).not.toBe('new');
    expect(state.reviews).toHaveLength(1);
    expect(state.reviews[0]?.rBefore).toBe(0); // first review: no prediction
    expect(state.mastery[p.propositionId]!.alpha).toBeGreaterThan(2); // recall evidence
  });

  it('later reviews carry a real rBefore prediction', () => {
    const { ctx, p, c, events } = seed();
    ctx.advanceMs(60 * 60 * 1000);
    const r1 = rateReview(ctx.factory, { propositionId: p.propositionId, cueId: c.cueId, grade: 3 });
    ctx.advanceMs(3 * 24 * 60 * 60 * 1000);
    const r2 = rateReview(ctx.factory, { propositionId: p.propositionId, cueId: c.cueId, grade: 3 });
    const state = replay([...events, r1, r2]);
    expect(state.reviews[1]?.rBefore).toBeGreaterThan(0);
    expect(state.reviews[1]?.rBefore).toBeLessThanOrEqual(1);
    expect(state.reviews[1]?.elapsedDays).toBeCloseTo(3, 1);
  });

  it('is order-independent and deduplicates by event id', () => {
    const { ctx, p, c, events } = seed();
    ctx.advanceMs(3600_000);
    const review = rateReview(ctx.factory, { propositionId: p.propositionId, cueId: c.cueId, grade: 2 });
    const forward = replay([...events, review]);
    const backward = replay([review, ...events.slice().reverse()]);
    const duplicated = replay([...events, review, review, ...events]);
    expect(stateDigest(backward)).toBe(stateDigest(forward));
    expect(stateDigest(duplicated)).toBe(stateDigest(forward));
    expect(dedupeAndSort([...events, review, review])).toHaveLength(3);
  });

  it('quiz answers feed mastery with a heavier weight than free explanation', () => {
    const { ctx, p, events } = seed();
    const quiz = answerQuiz(ctx.factory, { propositionId: p.propositionId, correct: true });
    const state = replay([...events, quiz]);
    expect(state.mastery[p.propositionId]!.alpha).toBeCloseTo(3, 10); // 2 + 1.0
    expect(state.mastery[p.propositionId]!.beta).toBeCloseTo(2, 10);
  });

  it('a wrong quiz answer moves beta, not alpha', () => {
    const { ctx, p, events } = seed();
    const quiz = answerQuiz(ctx.factory, { propositionId: p.propositionId, correct: false });
    const state = replay([...events, quiz]);
    expect(state.mastery[p.propositionId]!.alpha).toBeCloseTo(2, 10);
    expect(state.mastery[p.propositionId]!.beta).toBeCloseTo(3, 10);
  });

  it('ignores cues whose proposition is missing', () => {
    const ctx = testContext();
    const orphan = assertCue(ctx.factory, ctx.newId, {
      propositionId: 'nope',
      front: 'q',
      back: 'a',
    });
    const state = replay([orphan.event]);
    expect(Object.keys(state.cues)).toHaveLength(0);
  });

  it('merges a duplicate proposition into the survivor without losing history', () => {
    const { ctx, p, c, events } = seed();
    const dup = assertProposition(ctx.factory, ctx.newId, { statement: '边际效用递减（重复）' });
    ctx.advanceMs(1000);
    const merge = mergeProposition(ctx.factory, { fromId: dup.propositionId, intoId: p.propositionId });
    const state = replay([...events, dup.event, merge]);
    expect(state.propositions[dup.propositionId]?.status).toBe('superseded');
    expect(state.propositions[dup.propositionId]?.mergedInto).toBe(p.propositionId);
    expect(state.propositions[p.propositionId]?.aliases).toContain('边际效用递减（重复）');
    // Cues stay reviewable through the survivor.
    expect(state.cues[c.cueId]?.propositionId).toBe(p.propositionId);
  });

  it('produces a different digest when the log changes', () => {
    const { ctx, p, c, events } = seed();
    const before = replay(events);
    const review = rateReview(ctx.factory, { propositionId: p.propositionId, cueId: c.cueId, grade: 4 });
    const after = replay([...events, review]);
    expect(stateDigest(after)).not.toBe(stateDigest(before));
  });
});
