import { describe, expect, it } from 'vitest';
import {
  applyGrade,
  createIdFactory,
  emptyMastery,
  applyEvidence,
  masterySummary,
  newSchedule,
  retrievability,
} from '../src/index.js';

describe('fsrs adapter', () => {
  it('starts undated: a new proposition has no retrievability', () => {
    const s = newSchedule('p1', '2026-11-01T00:00:00.000Z');
    expect(s.reviewCount).toBe(0);
    expect(s.stage).toBe('new');
    expect(retrievability(s, '2026-11-01T00:00:00.000Z')).toBe(0);
  });

  it('a Good review schedules forward and decays over time', () => {
    const base = newSchedule('p1', '2026-11-01T00:00:00.000Z');
    const r1 = applyGrade(base, '2026-11-01T00:00:00.000Z', 3);
    expect(r1.schedule.reviewCount).toBe(1);
    expect(r1.schedule.stability).toBeGreaterThan(0);
    expect(new Date(r1.schedule.dueAt).getTime()).toBeGreaterThan(new Date('2026-11-01T00:00:00.000Z').getTime());

    const rSoon = retrievability(r1.schedule, '2026-11-02T00:00:00.000Z');
    const rLater = retrievability(r1.schedule, '2026-12-01T00:00:00.000Z');
    expect(rSoon).toBeGreaterThan(0);
    expect(rSoon).toBeLessThanOrEqual(1);
    expect(rLater).toBeLessThan(rSoon); // forgetting curve
  });

  it('a lapse demotes the card and counts', () => {
    const base = newSchedule('p1', '2026-11-01T00:00:00.000Z');
    // Two good reviews graduate the card from learning into review.
    const r1 = applyGrade(base, '2026-11-01T00:00:00.000Z', 3);
    const r2 = applyGrade(r1.schedule, '2026-11-01T00:10:00.000Z', 3);
    expect(r2.schedule.stage).toBe('review');
    const lapsed = applyGrade(r2.schedule, '2026-11-05T00:00:00.000Z', 1);
    expect(lapsed.schedule.lapses).toBe(1);
    expect(['learning', 'relearning']).toContain(lapsed.schedule.stage);
  });

  it('reports elapsed days from the previous review', () => {
    const base = newSchedule('p1', '2026-11-01T00:00:00.000Z');
    const r1 = applyGrade(base, '2026-11-01T00:00:00.000Z', 3);
    const r2 = applyGrade(r1.schedule, '2026-11-04T12:00:00.000Z', 3);
    expect(r2.elapsedDays).toBeCloseTo(3.5, 2);
  });
});

describe('beta mastery', () => {
  it('starts at 0.5 with a wide, honest interval', () => {
    const m = emptyMastery('p1', '2026-11-01T00:00:00.000Z');
    const s = masterySummary(m);
    expect(s.mean).toBeCloseTo(0.5, 10);
    expect(s.low).toBeLessThan(0.35);
    expect(s.high).toBeGreaterThan(0.65);
    expect(s.strength).toBe(0);
  });

  it('correct evidence raises the mean and narrows the interval', () => {
    let m = emptyMastery('p1', '2026-11-01T00:00:00.000Z');
    const before = masterySummary(m);
    for (let i = 0; i < 5; i++) m = applyEvidence(m, 'quiz', true, '2026-11-01T00:00:00.000Z');
    const after = masterySummary(m);
    expect(after.mean).toBeGreaterThan(before.mean);
    expect(after.high - after.low).toBeLessThan(before.high - before.low);
  });

  it('channels carry different weights', () => {
    const quiz = applyEvidence(emptyMastery('a', '2026-11-01T00:00:00.000Z'), 'quiz', true, '2026-11-01T00:00:00.000Z');
    const explain = applyEvidence(
      emptyMastery('a', '2026-11-01T00:00:00.000Z'),
      'explain',
      true,
      '2026-11-01T00:00:00.000Z',
    );
    expect(quiz.alpha).toBeGreaterThan(explain.alpha);
    expect(quiz.alpha - 2).toBeCloseTo(1, 10);
    expect(explain.alpha - 2).toBeCloseTo(0.4, 10);
  });
});

describe('ids', () => {
  it('are time-ordered and unique', () => {
    let t = 1_700_000_000_000;
    const ids: string[] = [];
    const factory = createIdFactory({
      now: () => t++,
      random: () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    for (let i = 0; i < 50; i++) ids.push(factory());
    expect(new Set(ids).size).toBe(50);
    expect([...ids].sort()).toEqual(ids);
  });
});
