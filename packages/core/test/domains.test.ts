import { describe, expect, it } from 'vitest';
import {
  aliasDomain,
  assertCue,
  assertInterest,
  assertProposition,
  buildFeed,
  canonicalizeInterests,
  createDomainResolver,
  createEventFactory,
  declareInterest,
  curriculumNeeds,
  interestWeightAt,
  normalizeDomainKey,
  replay,
  type LatticeEvent,
} from '../src/index.js';

const AT = '2026-11-24T09:00:00.000Z';
const NOW = '2026-11-24T12:00:00.000Z';

function ctx(now = AT) {
  let n = 0;
  const newId = () => 'd' + String(++n).padStart(4, '0');
  const factory = createEventFactory({ deviceId: 'domain-test', newId, now: () => new Date(now) });
  return { newId, factory };
}

function prop(factory: ReturnType<typeof ctx>['factory'], newId: () => string, domain: string, statement: string) {
  const p = assertProposition(factory, newId, { statement, domain });
  const c = assertCue(factory, newId, { propositionId: p.propositionId, front: '问？', back: statement });
  return { propositionId: p.propositionId, cueId: c.cueId, events: [p.event, c.event] as LatticeEvent[] };
}

describe('domain normalization', () => {
  it('folds case, spacing and punctuation', () => {
    expect(normalizeDomainKey('Computer Science')).toBe('computerscience');
    expect(normalizeDomainKey('computer-science')).toBe('computerscience');
    expect(normalizeDomainKey('  CS ')).toBe('cs');
    expect(normalizeDomainKey('计算机')).toBe('计算机');
  });

  it('resolves built-in aliases to one canonical name', () => {
    const resolve = createDomainResolver();
    expect(resolve('CS')).toBe('计算机');
    expect(resolve('Computer Science')).toBe('计算机');
    expect(resolve('计算机科学')).toBe('计算机');
    expect(resolve('AI')).toBe('人工智能');
    expect(resolve('economics')).toBe('经济学');
    expect(resolve('机器学习')).toBe('机器学习'); // subfield is not the same field
  });

  it('applies explicit alias events, which win over built-ins', () => {
    const { factory } = ctx();
    const event = aliasDomain(factory, { alias: '深度学习', canonical: '人工智能' }, { at: AT });
    const state = replay([event]);
    expect(createDomainResolver(state.domainAliases)('深度学习')).toBe('人工智能');
  });

  it('merges interest records that resolve to the same domain', () => {
    const { factory } = ctx();
    const a = assertInterest(factory, { domain: '计算机', weight: 2 }, { at: AT });
    const b = assertInterest(factory, { domain: 'CS', weight: 3 }, { at: AT });
    const declared = declareInterest(factory, { domain: 'Computer Science', level: 'intermediate' }, { at: AT });
    const state = replay([a.event, b.event, declared.event]);
    const interests = Object.values(state.interests);
    expect(interests).toHaveLength(1);
    expect(interests[0]?.name).toBe('计算机');
    expect(interests[0]?.weight).toBeGreaterThanOrEqual(5);
    expect(interests[0]?.declared).toBe(true);
    expect(interests[0]?.level).toBe('intermediate');
  });

  it('merges records even when the alias is declared afterwards', () => {
    const { factory } = ctx();
    const a = assertInterest(factory, { domain: '深度学习', weight: 2 }, { at: AT });
    const b = assertInterest(factory, { domain: '人工智能', weight: 1 }, { at: AT });
    const alias = aliasDomain(factory, { alias: '深度学习', canonical: '人工智能' }, { at: NOW });
    const state = replay([a.event, b.event, alias]);
    expect(Object.values(state.interests)).toHaveLength(1);
    expect(Object.values(state.interests)[0]?.weight).toBe(3);
  });
});

describe('interest decay', () => {
  it('halves at the half-life', () => {
    const interest = { weight: 8, declared: false, lastSeenAt: '2026-01-01T00:00:00.000Z' };
    const at60 = '2026-03-02T00:00:00.000Z'; // ~60 days
    expect(interestWeightAt(interest, at60)).toBeCloseTo(4, 1);
    const at120 = '2026-05-01T00:00:00.000Z'; // ~120 days
    expect(interestWeightAt(interest, at120)).toBeCloseTo(2, 1);
  });

  it('decays declared interest much more slowly', () => {
    const observed = { weight: 8, declared: false, lastSeenAt: '2026-01-01T00:00:00.000Z' };
    const declared = { weight: 8, declared: true, lastSeenAt: '2026-01-01T00:00:00.000Z' };
    const later = '2026-05-01T00:00:00.000Z';
    expect(interestWeightAt(declared, later)).toBeGreaterThan(interestWeightAt(observed, later) * 2);
  });

  it('lets a fresh capture outrank a stale one in the feed', () => {
    const fresh = ctx();
    const stale = ctx('2026-01-01T00:00:00.000Z');
    const oldEconomy = prop(stale.factory, stale.newId, '经济学', '旧的经济学命题');
    const newAi = prop(fresh.factory, fresh.newId, '人工智能', '新的人工智能命题');
    const oldInterest = assertInterest(stale.factory, { domain: '经济学', weight: 10 }, { at: '2026-01-01T00:00:00.000Z' });
    const newInterest = assertInterest(fresh.factory, { domain: '人工智能', weight: 1 }, { at: NOW });

    const state = replay([...oldEconomy.events, ...newAi.events, oldInterest.event, newInterest.event]);
    const feed = buildFeed(state, { now: NOW, dose: 2 });
    expect(feed[0]?.propositionId).toBe(newAi.propositionId);
  });
});

describe('curriculum needs use canonical domains', () => {
  it('counts propositions written under an alias', () => {
    const { factory, newId } = ctx();
    const p = prop(factory, newId, 'CS', '通过别名写入的计算机命题');
    const declaration = declareInterest(factory, { domain: '计算机', level: 'beginner' }, { at: AT });
    const state = replay([...p.events, declaration.event]);
    const needs = curriculumNeeds(state, { minPropositions: 2 });
    // The alias-written proposition counts toward 计算机, but 1 < 2 still needs more.
    expect(needs.find((need) => need.domain === '计算机')?.existing).toBe(1);
  });
});
