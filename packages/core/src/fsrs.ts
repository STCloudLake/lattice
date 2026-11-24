import { createEmptyCard, fsrs, State, type Card, type Grade as FsrsGrade } from 'ts-fsrs';
import type { Grade, ISODate, Id, ScheduleStage, ScheduleState } from './types.js';

/**
 * FSRS-6 adapter. This is the only module that knows about ts-fsrs; the rest of
 * the core speaks ScheduleState. Keeping the vendor behind this seam means the
 * scheduler can be swapped (or pinning upgraded) without touching projections.
 */
const engine = fsrs();

const STAGE_BY_STATE: Record<number, ScheduleStage> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};

const STATE_BY_STAGE: Record<ScheduleStage, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function toCard(s: ScheduleState): Card {
  const card: Card = {
    due: new Date(s.dueAt),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: 0,
    scheduled_days: s.scheduledDays,
    reps: s.reviewCount,
    lapses: s.lapses,
    learning_steps: s.learningSteps,
    state: STATE_BY_STAGE[s.stage],
  };
  if (s.lastReviewAt) card.last_review = new Date(s.lastReviewAt);
  return card;
}

function fromCard(propositionId: Id, card: Card): ScheduleState {
  const out: ScheduleState = {
    propositionId,
    stability: card.stability,
    difficulty: card.difficulty,
    stage: STAGE_BY_STATE[card.state] ?? 'new',
    dueAt: card.due.toISOString(),
    reviewCount: card.reps,
    lapses: card.lapses,
    learningSteps: card.learning_steps,
    scheduledDays: card.scheduled_days,
  };
  if (card.last_review) out.lastReviewAt = card.last_review.toISOString();
  return out;
}

export function newSchedule(propositionId: Id, at: ISODate): ScheduleState {
  return fromCard(propositionId, createEmptyCard(new Date(at)));
}

/** Probability the learner would recall it right now. 0 for never-reviewed. */
export function retrievability(s: ScheduleState, at: ISODate): number {
  if (s.reviewCount === 0 || !(s.stability > 0)) return 0;
  const r = engine.get_retrievability(toCard(s), new Date(at), false);
  if (typeof r !== 'number' || !Number.isFinite(r)) return 0;
  return clamp01(r);
}

export interface GradeResult {
  schedule: ScheduleState;
  /** Predicted recall probability before this review (0 = unknown). */
  rBefore: number;
  elapsedDays: number;
}

export function applyGrade(s: ScheduleState, at: ISODate, grade: Grade): GradeResult {
  const now = new Date(at);
  const rBefore = s.reviewCount === 0 ? 0 : retrievability(s, at);
  const elapsedDays = s.lastReviewAt
    ? Math.max(0, (now.getTime() - new Date(s.lastReviewAt).getTime()) / 86_400_000)
    : 0;
  const result = engine.next(toCard(s), now, grade as unknown as FsrsGrade);
  return { schedule: fromCard(s.propositionId, result.card), rBefore, elapsedDays };
}

/** True when the proposition is scheduled at or before `at`. */
export function isDue(s: ScheduleState, at: ISODate): boolean {
  return new Date(s.dueAt).getTime() <= new Date(at).getTime();
}
