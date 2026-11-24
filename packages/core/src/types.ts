/**
 * Core types for Lattice.
 *
 * The four ledgers (see docs/design): knowledge (propositions/cues), mastery
 * (understanding), schedule (availability), context (attention). Everything
 * except the raw event log is a projection and can be rebuilt by replay.
 */

export type Id = string;
export type ISODate = string;

export type Actor = 'human' | 'system' | `llm:${string}`;

export type EventType =
  | 'proposition.asserted'
  | 'proposition.merged'
  | 'chain.asserted'
  | 'interest.observed'
  | 'interest.declared'
  | 'interest.removed'
  | 'domain.alias'
  | 'cue.asserted'
  | 'review.rated'
  | 'quiz.answered'
  | 'exposure.shown'
  | 'exposure.engaged'
  | 'exposure.skipped'
  | 'mastery.reset'
  | 'data.cleared';

export interface LatticeEvent {
  /** Globally unique (ULID-like). Also the merge key across devices. */
  id: Id;
  /** Stable per-device identity; used for ordering and idempotency. */
  deviceId: string;
  /** Monotonic per device. */
  seq: number;
  /** When the fact happened (user-facing truth). */
  occurredAt: ISODate;
  /** When it was written. Differs from occurredAt when offline. */
  recordedAt: ISODate;
  actor: Actor;
  type: EventType;
  subjectId?: Id;
  payload: Record<string, unknown>;
}

/** Where a claim came from. Kept coarse on purpose: no full-text copies. */
export interface ProvenanceRef {
  sourceKind: 'page' | 'pdf' | 'video' | 'note' | 'paste' | 'import' | 'session';
  sourceUri?: string;
  title?: string;
  /** A short quote anchoring the claim to the source. Never the whole source. */
  span?: { quote?: string; start?: number; end?: number };
  capturedAt: ISODate;
}

export type PropositionStatus = 'active' | 'superseded' | 'archived';

/**
 * How hard a knowledge point is *to acquire*, independent of the learner.
 * Two dimensions on purpose: a fact can be hard to remember but easy to apply,
 * or easy to state but hard to evaluate. See docs/difficulty.md.
 */
export type CognitiveLevel = 'remember' | 'understand' | 'apply' | 'analyze' | 'evaluate';

export interface Difficulty {
  /** ★1 facts/terminology → ★5 evaluation/synthesis across domains. */
  tier: 1 | 2 | 3 | 4 | 5;
  cognitive: CognitiveLevel;
  /** Rough time to first understanding, in minutes. */
  minutes?: number;
}

/** K ledger: an objective claim. Never carries learner state. */
export interface Proposition {
  id: Id;
  statement: string;
  name?: string;
  aliases: string[];
  domain?: string;
  status: PropositionStatus;
  createdAt: ISODate;
  mergedInto?: Id;
  provenance: ProvenanceRef[];
  /** Optional until the grader has seen it. */
  difficulty?: Difficulty;
}

/**
 * K ledger: a reasoning chain. Premises are used *jointly*: "A and B imply C"
 * is not "A implies C". Chains are the only source of prerequisite structure.
 */
export interface Chain {
  id: Id;
  conclusionId: Id;
  premiseIds: Id[];
  /** Extractor confidence, 0..1. Low-strength chains should not drive paths. */
  strength: number;
  createdAt: ISODate;
  provenance: ProvenanceRef[];
}

export type CueKind = 'recall' | 'cloze' | 'apply' | 'contrast';

/** K ledger: one retrieval route for a proposition. Many cues share one schedule. */
export interface Cue {
  id: Id;
  propositionId: Id;
  front: string;
  back: string;
  kind: CueKind;
  createdAt: ISODate;
}

/** 1 = Again, 2 = Hard, 3 = Good, 4 = Easy (matches ts-fsrs Rating). */
export type Grade = 1 | 2 | 3 | 4;

/** Evidence channel 2 (retrieval). Projection of review.rated events. */
export interface ReviewLog {
  id: Id;
  cueId: Id;
  propositionId: Id;
  grade: Grade;
  /** Days since previous review of this proposition (0 for the first). */
  elapsedDays: number;
  /** Model-predicted recall probability right before this review (0 = unknown/new). */
  rBefore: number;
  reviewedAt: ISODate;
}

export type ScheduleStage = 'new' | 'learning' | 'review' | 'relearning';

/** S ledger: availability. One per proposition. */
export interface ScheduleState {
  propositionId: Id;
  stability: number;
  difficulty: number;
  stage: ScheduleStage;
  dueAt: ISODate;
  lastReviewAt?: ISODate;
  reviewCount: number;
  lapses: number;
  learningSteps: number;
  scheduledDays: number;
}

/** M ledger: understanding. Beta posterior over "the learner understands it". */
export interface MasteryState {
  propositionId: Id;
  alpha: number;
  beta: number;
  evidenceCount: number;
  updatedAt: ISODate;
}

export interface MasterySummary {
  /** Posterior mean, 0..1. */
  mean: number;
  /** Approximate 10th percentile, 0..1. */
  low: number;
  /** Approximate 90th percentile, 0..1. */
  high: number;
  /** Pseudo-sample size (alpha + beta - 4), i.e. how much evidence we have. */
  strength: number;
}

export type DomainLevel = 'beginner' | 'intermediate' | 'advanced';

/** An explicit alias decision: `alias` is the same field as `canonical`. */
export interface DomainAlias {
  alias: string;
  canonical: string;
  decidedBy: string;
  at: ISODate;
}

/** C ledger: what the learner is interested in. Declared beats inferred. */
export interface Interest {
  id: Id;
  name: string;
  /** Accumulated interest weight (captures count as evidence). */
  weight: number;
  captureCount: number;
  lastSeenAt: ISODate;
  topics: Record<string, number>;
  /** True when the user set this domain explicitly (settings / onboarding). */
  declared: boolean;
  /** Requested starting level for this domain. */
  level: DomainLevel;
}

/** C ledger: exposure bookkeeping. Never evidence of understanding. */
export interface ExposureState {
  propositionId: Id;
  shown: number;
  engaged: number;
  skipped: number;
  lastShownAt?: ISODate;
  /** Local calendar day of the last exposure, used for daily de-duplication. */
  lastShownDay?: string;
}

export interface LearnerState {
  propositions: Record<Id, Proposition>;
  cues: Record<Id, Cue>;
  chains: Record<Id, Chain>;
  interests: Record<Id, Interest>;
  exposures: Record<Id, ExposureState>;
  /** Alias rules declared in the log, applied when replay canonicalizes domains. */
  domainAliases: DomainAlias[];
  mastery: Record<Id, MasteryState>;
  schedule: Record<Id, ScheduleState>;
  reviews: ReviewLog[];
}

export type EvidenceKind = 'quiz' | 'recall' | 'explain';

export interface QueueItem {
  kind: 'review' | 'new';
  propositionId: Id;
  cueId: Id;
  /** Present for review items. */
  dueAt?: ISODate;
}

export interface QueueOptions {
  /** Max new propositions introduced per queue build. */
  newLimit?: number;
  /** Max reviews per queue build (0 = unlimited). */
  reviewLimit?: number;
  /** Keep reviews due before this instant, default: now. */
  now?: ISODate;
}
