import { describe, expect, it } from 'vitest';
import {
  assertCue,
  assertInterest,
  assertProposition,
  buildFeed,
  createEventFactory,
  declareInterest,
  replay,
  type LatticeEvent,
} from '../src/index.js';

const AT = '2026-11-24T09:00:00.000Z';
const NOW = '2026-11-24T12:00:00.000Z';

function ctx() {
  let n = 0;
  const newId = () => 'x' + String(++n).padStart(3, '0');
  const factory = createEventFactory({ deviceId: 'difficulty-test', newId, now: () => new Date(AT) });
  return { newId, factory };
}

function graded(
  factory: ReturnType<typeof ctx>['factory'],
  newId: () => string,
  statement: string,
  difficulty: { tier: number; cognitive: string; minutes?: number },
  domain = '计算机',
) {
  const p = assertProposition(factory, newId, {
    statement,
    domain,
    difficulty: difficulty as never,
  });
  const c = assertCue(factory, newId, { propositionId: p.propositionId, front: '问？', back: statement });
  return { propositionId: p.propositionId, cueId: c.cueId, events: [p.event, c.event] as LatticeEvent[] };
}

describe('difficulty on propositions', () => {
  it('round-trips through the event log', () => {
    const { factory, newId } = ctx();
    const p = graded(factory, newId, '一个需要推导的命题。', { tier: 4, cognitive: 'analyze', minutes: 25 });
    const state = replay(p.events);
    const proposition = state.propositions[p.propositionId]!;
    expect(proposition.difficulty).toEqual({ tier: 4, cognitive: 'analyze', minutes: 25 });
  });

  it('ignores invalid tiers instead of trusting the model', () => {
    const { factory, newId } = ctx();
    const p = assertProposition(factory, newId, { statement: '坏难度。', difficulty: { tier: 9 as never, cognitive: 'remember' } });
    const state = replay([p.event]);
    expect(state.propositions[p.propositionId]?.difficulty).toBeUndefined();
  });

  it('defaults an unknown cognitive level to understand', () => {
    const { factory, newId } = ctx();
    const p = assertProposition(factory, newId, {
      statement: '未知认知层级。',
      difficulty: { tier: 2, cognitive: 'synthesize' as never },
    });
    const state = replay([p.event]);
    expect(state.propositions[p.propositionId]?.difficulty).toEqual({ tier: 2, cognitive: 'understand' });
  });
});

describe('feed paces by difficulty', () => {
  function setup() {
    const { factory, newId } = ctx();
    const easy = graded(factory, newId, '基础命题。', { tier: 2, cognitive: 'understand' });
    const hard = graded(factory, newId, '推导命题。', { tier: 4, cognitive: 'analyze' });
    const tooHard = graded(factory, newId, '评价命题。', { tier: 5, cognitive: 'evaluate' });
    const interest = declareInterest(factory, { domain: '计算机', level: 'beginner' }, { at: AT });
    const events = [...easy.events, ...hard.events, ...tooHard.events, interest.event];
    return { state: replay(events), easy, hard, tooHard };
  }

  it('never pushes material far above the declared stage', () => {
    const { state, tooHard } = setup();
    const ids = buildFeed(state, { now: NOW, dose: 5 }).map((item) => item.propositionId);
    expect(ids).not.toContain(tooHard.propositionId); // ★5 vs beginner target ★2 (+2 = 4)
  });

  it('prefers the tier closer to the target', () => {
    const { state, easy, hard } = setup();
    const feed = buildFeed(state, { now: NOW, dose: 5 });
    const easyIndex = feed.findIndex((item) => item.propositionId === easy.propositionId);
    const hardIndex = feed.findIndex((item) => item.propositionId === hard.propositionId);
    expect(easyIndex).toBeGreaterThanOrEqual(0);
    expect(hardIndex).toBeGreaterThanOrEqual(0);
    expect(easyIndex).toBeLessThan(hardIndex);
  });

  it('carries tier and cognitive into the feed item', () => {
    const { state, easy } = setup();
    const item = buildFeed(state, { now: NOW, dose: 5 }).find((entry) => entry.propositionId === easy.propositionId);
    expect(item?.tier).toBe(2);
    expect(item?.cognitive).toBe('understand');
  });

  it('treats unknown difficulty as neutral rather than easy', () => {
    const { factory, newId } = ctx();
    const unknown = graded(factory, newId, '未分级命题。', { tier: 2, cognitive: 'understand' });
    const interest = assertInterest(factory, { domain: '计算机', weight: 1 }, { at: AT });
    // Strip difficulty by asserting a second proposition without it.
    const plain = assertProposition(factory, newId, { statement: '没有难度的命题。', domain: '计算机' });
    const state = replay([...unknown.events, plain.event, interest.event]);
    const feed = buildFeed(state, { now: NOW, dose: 5 });
    const plainItem = feed.find((item) => item.propositionId === plain.propositionId);
    expect(plainItem).toBeDefined();
    expect(plainItem?.tier).toBeUndefined();
  });
});
