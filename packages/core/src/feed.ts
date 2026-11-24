import { createDomainResolver, interestWeightAt } from './domains.js';
import { isDue, retrievability } from './fsrs.js';
import { masteryOf } from './mastery.js';
import { pickCue } from './queue.js';
import { activePropositions, exposureOf, transitivePrerequisites } from './replay.js';
import type { CognitiveLevel, DomainLevel, Id, ISODate, LearnerState } from './types.js';

/**
 * The push policy: what to show in the newtab feed today.
 *
 * Product stance (from the original design): knowledge is delivered like an ad —
 * a small daily dose, passively absorbed, no quiz required. This module only
 * decides *what*; surfaces decide how. It is a pure function so the feed is
 * reproducible and testable.
 */

export type FeedReason = 'due' | 'frontier' | 'foundation';

export interface FeedItem {
  propositionId: Id;
  cueId?: Id;
  /** `review` items already have a schedule; `new` items are first exposures. */
  kind: 'review' | 'new';
  reason: FeedReason;
  score: number;
  domain?: string;
  /** ★1–5 acquisition difficulty, when the point has been graded. */
  tier?: number;
  cognitive?: CognitiveLevel;
}

export interface FeedOptions {
  /** Everything is evaluated as of this instant. */
  now: ISODate;
  /** How many cards to show today. Ads-like: small by default. */
  dose?: number;
  /** Max share of the dose spent on due reviews (rest is new material). */
  reviewShare?: number;
  /** A proposition is "ready" when all its prerequisites are at least this mastered. */
  minPrereqMastery?: number;
  /** Set false for a pure-exposure feed that ignores the review schedule. */
  includeReviews?: boolean;
  /** Fallback ★ target when the domain has no declared level. */
  targetTier?: number;
}

/** Declared learner level -> the ★ tier the feed should aim at. */
export function tierForLevel(level: DomainLevel): number {
  if (level === 'advanced') return 4;
  if (level === 'intermediate') return 3;
  return 2;
}

function targetTierFor(state: LearnerState, domain: string | undefined, fallback: number): number {
  if (!domain) return fallback;
  const resolver = createDomainResolver(state.domainAliases);
  const target = resolver(domain).trim().toLowerCase();
  for (const interest of Object.values(state.interests)) {
    if (!interest.declared) continue;
    if (resolver(interest.name).trim().toLowerCase() === target) return tierForLevel(interest.level);
  }
  return fallback;
}

export interface CurriculumNeed {
  domain: string;
  level: DomainLevel;
  /** Propositions we already have in this domain. */
  existing: number;
}

/** Average mastery of a domain's propositions (0 when it has none). */
export function domainMastery(state: LearnerState, domain: string): number {
  const target = domain.trim().toLowerCase();
  let sum = 0;
  let count = 0;
  const resolver = createDomainResolver(state.domainAliases);
  for (const proposition of Object.values(state.propositions)) {
    if (proposition.status !== 'active' || !proposition.domain) continue;
    if (resolver(proposition.domain).trim().toLowerCase() !== target) continue;
    sum += masteryOf(state.mastery[proposition.id]);
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Which curriculum level to generate next for a declared domain.
 * Starts at the requested level and steps up only when the domain is understood.
 */
export function curriculumLevelFor(state: LearnerState, domain: string): DomainLevel {
  const resolver = createDomainResolver(state.domainAliases);
  const target = resolver(domain).trim().toLowerCase();
  const declared = Object.values(state.interests).find(
    (i) => resolver(i.name).trim().toLowerCase() === target,
  );
  const start: DomainLevel = declared?.level ?? 'beginner';
  const avg = domainMastery(state, domain);
  if (start === 'beginner' && avg >= 0.55) return 'intermediate';
  if (start === 'intermediate' && avg >= 0.8) return 'advanced';
  return start;
}

/**
 * Declared domains that still need content. The extension uses this to decide
 * when to call the model and generate the next batch instead of waiting for the
 * user to capture something.
 */
export function curriculumNeeds(
  state: LearnerState,
  options: { minPropositions?: number } = {},
): CurriculumNeed[] {
  const minPropositions = options.minPropositions ?? 6;
  const resolver = createDomainResolver(state.domainAliases);
  const counts = new Map<string, number>();
  for (const proposition of Object.values(state.propositions)) {
    if (proposition.status !== 'active' || !proposition.domain) continue;
    const key = resolver(proposition.domain).trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const needs: CurriculumNeed[] = [];
  for (const interest of Object.values(state.interests)) {
    if (!interest.declared) continue;
    const key = resolver(interest.name).trim().toLowerCase();
    const existing = counts.get(key) ?? 0;
    if (existing >= minPropositions) continue;
    needs.push({ domain: interest.name, level: curriculumLevelFor(state, interest.name), existing });
  }
  needs.sort((a, b) => (a.existing === b.existing ? (a.domain < b.domain ? -1 : 1) : a.existing - b.existing));
  return needs;
}

export function dayOf(iso: ISODate): string {
  return iso.slice(0, 10);
}

function interestBoost(state: LearnerState, domain: string | undefined, now: ISODate): number {
  if (!domain) return 1;
  const resolver = createDomainResolver(state.domainAliases);
  const target = resolver(domain).trim().toLowerCase();
  if (target.length === 0) return 1;
  let weight = 0;
  let declared = false;
  for (const interest of Object.values(state.interests)) {
    if (resolver(interest.name).trim().toLowerCase() !== target) continue;
    // Interest decays: captures from months ago should not dominate today.
    weight = Math.max(weight, interestWeightAt(interest, now));
    declared = declared || interest.declared;
  }
  // Captures are interest evidence; they bias the ordering, never the mastery.
  // An explicitly declared domain outranks one merely inferred from captures.
  const base = 1 + Math.min(weight, 10) * 0.15;
  return declared ? base * 1.4 : base;
}

function chainCentrality(state: LearnerState): Map<Id, number> {
  const counts = new Map<Id, number>();
  for (const chain of Object.values(state.chains)) {
    for (const premiseId of chain.premiseIds) counts.set(premiseId, (counts.get(premiseId) ?? 0) + 1);
  }
  let max = 1;
  for (const value of counts.values()) max = Math.max(max, value);
  const normalized = new Map<Id, number>();
  for (const [id, count] of counts) normalized.set(id, count / max);
  return normalized;
}

function byScore(a: FeedItem, b: FeedItem): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.propositionId < b.propositionId ? -1 : a.propositionId > b.propositionId ? 1 : 0;
}

/**
 * Builds today's feed.
 *
 * Rules, in order:
 * 1. never show the same proposition twice in one day;
 * 2. never show something the user skipped twice;
 * 3. due reviews get at most `reviewShare` of the dose;
 * 4. everything else is frontier material whose prerequisites are understood;
 * 5. interest weight (from captures) only reorders; it never fakes mastery.
 */
export function buildFeed(state: LearnerState, options: FeedOptions): FeedItem[] {
  const dose = Math.max(1, options.dose ?? 3);
  const reviewShare = Math.min(1, Math.max(0, options.reviewShare ?? 0.4));
  const minPrereqMastery = options.minPrereqMastery ?? 0.7;
  const fallbackTier = options.targetTier ?? 3;
  const includeReviews = options.includeReviews !== false;
  const now = options.now;
  const today = dayOf(now);
  const centrality = chainCentrality(state);
  const reviewCap = Math.max(1, Math.floor(dose * reviewShare));

  const reviews: FeedItem[] = [];
  const fresh: FeedItem[] = [];

  for (const proposition of activePropositions(state)) {
    const exposure = exposureOf(state, proposition.id);
    if (exposure.lastShownDay === today) continue; // ad fatigue: once a day
    if (exposure.skipped >= 2) continue; // explicit "not interested"

    const schedule = state.schedule[proposition.id];
    if (!schedule) continue;

    const mastery = masteryOf(state.mastery[proposition.id]);
    const boost = interestBoost(state, proposition.domain, now);
    const canonicalDomain = proposition.domain
      ? createDomainResolver(state.domainAliases)(proposition.domain)
      : undefined;
    const cueId = pickCue(state, proposition.id);
    const base: Pick<FeedItem, 'propositionId' | 'cueId' | 'domain'> = { propositionId: proposition.id };
    if (cueId) base.cueId = cueId;
    if (canonicalDomain) base.domain = canonicalDomain;

    if (includeReviews && schedule.reviewCount > 0) {
      if (!isDue(schedule, now)) continue;
      const r = retrievability(schedule, now);
      reviews.push({ ...base, kind: 'review', reason: 'due', score: (1 - r) * 2.2 * boost });
      continue;
    }
    if (schedule.reviewCount > 0) continue; // reviewed but not due yet

    const prerequisites = transitivePrerequisites(state, proposition.id, { minStrength: 0.4 });
    const ready = prerequisites.every((id) => masteryOf(state.mastery[id]) >= minPrereqMastery);
    if (!ready) continue;

    const foundation = prerequisites.length === 0;
    const central = centrality.get(proposition.id) ?? 0;
    const targetTier = targetTierFor(state, proposition.domain, fallbackTier);
    const difficulty = proposition.difficulty;
    // Never push material two tiers above the learner's stage: an ad you cannot
    // parse is noise. Unknown difficulty is treated as neutral, not easy.
    if (difficulty && difficulty.tier > targetTier + 2) continue;
    const levelFit = difficulty
      ? 1 - Math.min(4, Math.abs(difficulty.tier - targetTier)) / 4
      : 0.6;
    const score =
      (0.5 * (1 - mastery) + 0.3 * central + 0.12 * levelFit + (foundation ? 0.08 : 0)) * boost;
    const item: FeedItem = { ...base, kind: 'new', reason: foundation ? 'foundation' : 'frontier', score };
    if (difficulty) {
      item.tier = difficulty.tier;
      item.cognitive = difficulty.cognitive;
    }
    fresh.push(item);
  }

  reviews.sort(byScore);
  fresh.sort(byScore);

  const picked: FeedItem[] = [];
  for (const item of reviews.slice(0, reviewCap)) picked.push(item);
  for (const item of fresh) {
    if (picked.length >= dose) break;
    picked.push(item);
  }
  // Still short? Spend the remaining room on reviews beyond the cap.
  for (const item of reviews.slice(reviewCap)) {
    if (picked.length >= dose) break;
    picked.push(item);
  }

  picked.sort(byScore);
  return picked.slice(0, dose);
}
