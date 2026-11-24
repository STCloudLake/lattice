import { isDue } from './fsrs.js';
import { activePropositions, cuesFor } from './replay.js';
import type { Id, ISODate, LearnerState, QueueItem, QueueOptions } from './types.js';

/**
 * Which cue to show for a proposition.
 *
 * M0 heuristic (deterministic, not yet the weighted choice from the design):
 * prefer the cue with the fewest reviews, then creation order. This exercises
 * every cue before repeating one, which is the property that matters for M0.
 */
export function pickCue(state: LearnerState, propositionId: Id): Id | undefined {
  const cues = cuesFor(state, propositionId);
  if (cues.length === 0) return undefined;
  const counts = new Map<Id, number>();
  for (const review of state.reviews) counts.set(review.cueId, (counts.get(review.cueId) ?? 0) + 1);
  let best = cues[0]!;
  let bestCount = counts.get(best.id) ?? 0;
  for (const cue of cues) {
    const count = counts.get(cue.id) ?? 0;
    if (count < bestCount) {
      best = cue;
      bestCount = count;
    }
  }
  return best.id;
}

export function dueItems(state: LearnerState, at: ISODate): QueueItem[] {
  const items: QueueItem[] = [];
  for (const proposition of activePropositions(state)) {
    const schedule = state.schedule[proposition.id];
    if (!schedule || schedule.reviewCount === 0) continue;
    if (!isDue(schedule, at)) continue;
    const cueId = pickCue(state, proposition.id);
    if (!cueId) continue;
    items.push({ kind: 'review', propositionId: proposition.id, cueId, dueAt: schedule.dueAt });
  }
  items.sort((a, b) => {
    const da = a.dueAt ?? '';
    const db = b.dueAt ?? '';
    return da === db ? (a.propositionId < b.propositionId ? -1 : 1) : da < db ? -1 : 1;
  });
  return items;
}

export function newItems(state: LearnerState, limit: number): QueueItem[] {
  const items: QueueItem[] = [];
  for (const proposition of activePropositions(state)) {
    const schedule = state.schedule[proposition.id];
    if (!schedule || schedule.reviewCount > 0) continue;
    const cueId = pickCue(state, proposition.id);
    if (!cueId) continue;
    items.push({ kind: 'new', propositionId: proposition.id, cueId });
    if (items.length >= limit) break;
  }
  return items;
}

/**
 * Reviews always come before new material: an overdue backlog must never be
 * buried under new introductions.
 */
export function buildQueue(state: LearnerState, at: ISODate, options: QueueOptions = {}): QueueItem[] {
  const now = options.now ?? at;
  const newLimit = options.newLimit ?? 20;
  const reviewLimit = options.reviewLimit ?? 0;
  let reviews = dueItems(state, now);
  if (reviewLimit > 0) reviews = reviews.slice(0, reviewLimit);
  const fresh = newItems(state, newLimit);
  return [...reviews, ...fresh];
}
