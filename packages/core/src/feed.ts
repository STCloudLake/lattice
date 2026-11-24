import { isDue, retrievability } from './fsrs.js';
import { masteryOf } from './mastery.js';
import { pickCue } from './queue.js';
import { activePropositions, exposureOf, transitivePrerequisites } from './replay.js';
import type { Id, ISODate, LearnerState } from './types.js';

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
}

export function dayOf(iso: ISODate): string {
  return iso.slice(0, 10);
}

function interestBoost(state: LearnerState, domain: string | undefined): number {
  if (!domain) return 1;
  const target = domain.trim().toLowerCase();
  if (target.length === 0) return 1;
  let weight = 0;
  for (const interest of Object.values(state.interests)) {
    if (interest.name.trim().toLowerCase() === target) weight = Math.max(weight, interest.weight);
  }
  // Captures are interest evidence; they bias the ordering, never the mastery.
  return 1 + Math.min(weight, 10) * 0.15;
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
    const boost = interestBoost(state, proposition.domain);
    const cueId = pickCue(state, proposition.id);
    const base: Pick<FeedItem, 'propositionId' | 'cueId' | 'domain'> = { propositionId: proposition.id };
    if (cueId) base.cueId = cueId;
    if (proposition.domain) base.domain = proposition.domain;

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
    const score = (0.6 * (1 - mastery) + 0.4 * central + (foundation ? 0.08 : 0)) * boost;
    fresh.push({ ...base, kind: 'new', reason: foundation ? 'foundation' : 'frontier', score });
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
