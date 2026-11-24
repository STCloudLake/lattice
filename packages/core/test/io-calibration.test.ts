import { describe, expect, it } from 'vitest';
import {
  assertCue,
  assertProposition,
  calibrate,
  formatReport,
  packToEvents,
  parseJsonl,
  parsePropositionPack,
  rateReview,
  replay,
  samplesFromState,
  stateDigest,
  exportJsonl,
  type LatticeEvent,
} from '../src/index.js';
import { testContext } from './helpers.js';

describe('calibration', () => {
  it('scores a perfect model at zero Brier', () => {
    const report = calibrate([
      { predicted: 1, outcome: 1 },
      { predicted: 0, outcome: 0 },
    ]);
    expect(report.brier).toBe(0);
    expect(report.n).toBe(2);
    expect(report.beatsBaseline).toBe(true);
  });

  it('a constant prediction equal to the base rate earns nothing over baseline', () => {
    const report = calibrate([
      { predicted: 0.5, outcome: 1 },
      { predicted: 0.5, outcome: 0 },
    ]);
    expect(report.brier).toBeCloseTo(report.baselineBrier, 10);
    expect(report.beatsBaseline).toBe(false);
  });

  it('an anti-informative model is worse than baseline', () => {
    const report = calibrate([
      { predicted: 1, outcome: 0 },
      { predicted: 0, outcome: 1 },
    ]);
    expect(report.brier).toBe(1);
    expect(report.beatsBaseline).toBe(false);
  });

  it('reports an empty sample honestly', () => {
    const report = calibrate([]);
    expect(report.n).toBe(0);
    expect(Number.isNaN(report.brier)).toBe(true);
    expect(formatReport(report)).toContain('样本数: 0');
  });

  it('excludes first reviews (no prediction existed)', () => {
    const ctx = testContext();
    const p = assertProposition(ctx.factory, ctx.newId, { statement: 'x' });
    const c = assertCue(ctx.factory, ctx.newId, { propositionId: p.propositionId, front: 'q', back: 'a' });
    ctx.advanceMs(1000);
    const r1 = rateReview(ctx.factory, { propositionId: p.propositionId, cueId: c.cueId, grade: 3 });
    ctx.advanceMs(86400_000);
    const r2 = rateReview(ctx.factory, { propositionId: p.propositionId, cueId: c.cueId, grade: 2 });
    const state = replay([p.event, c.event, r1, r2]);
    expect(state.reviews).toHaveLength(2);
    expect(samplesFromState(state)).toHaveLength(1);
  });
});

describe('io', () => {
  it('round-trips events through JSONL without changing the projection', () => {
    const ctx = testContext();
    const p = assertProposition(ctx.factory, ctx.newId, { statement: 'a', aliases: ['x'] });
    const c = assertCue(ctx.factory, ctx.newId, { propositionId: p.propositionId, front: 'q', back: 'a' });
    ctx.advanceMs(1000);
    const r = rateReview(ctx.factory, { propositionId: p.propositionId, cueId: c.cueId, grade: 3 });
    const events: LatticeEvent[] = [p.event, c.event, r];

    const text = exportJsonl(events);
    const parsed = parseJsonl(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.events).toHaveLength(3);
    expect(stateDigest(replay(parsed.events))).toBe(stateDigest(replay(events)));
  });

  it('reports malformed lines instead of silently dropping them', () => {
    const result = parseJsonl('{"id":"x"}\nnot json\n');
    expect(result.events).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[1]).toContain('invalid JSON');
  });

  it('parses a proposition pack and turns it into events', () => {
    const packText = JSON.stringify({
      format: 1,
      propositions: [
        {
          statement: '机会成本',
          name: '机会成本',
          cues: [{ front: '什么是机会成本？', back: '放弃的最佳替代方案的价值。' }],
        },
        { statement: '比较优势', cues: [] },
      ],
    });
    const { pack, errors } = parsePropositionPack(packText);
    expect(errors).toEqual([]);
    expect(pack).toBeDefined();

    const ctx = testContext();
    const { events } = packToEvents(pack!, ctx.factory, ctx.newId);
    expect(events).toHaveLength(3); // 2 propositions + 1 cue
    const state = replay(events);
    expect(Object.keys(state.propositions)).toHaveLength(2);
    expect(Object.keys(state.cues)).toHaveLength(1);
  });

  it('refuses a pack with an empty statement', () => {
    const { errors } = parsePropositionPack(JSON.stringify({ format: 1, propositions: [{ statement: '  ' }] }));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('statement');
  });
});
