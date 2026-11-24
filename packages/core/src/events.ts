import { fnv1a64 } from './ids.js';
import type {
  Actor,
  DomainLevel,
  CueKind,
  EventType,
  Grade,
  Id,
  ISODate,
  LatticeEvent,
  ProvenanceRef,
} from './types.js';

export interface EventFactoryOptions {
  deviceId: string;
  newId: () => Id;
  now?: () => Date;
  startSeq?: number;
  actor?: Actor;
}

export interface EventFactory {
  (
    type: EventType,
    subjectId: Id | undefined,
    payload?: Record<string, unknown>,
    opts?: { actor?: Actor; at?: ISODate },
  ): LatticeEvent;
  readonly seq: number;
}

/**
 * Creates events with monotonically increasing per-device sequence numbers.
 * `seq` is what makes cross-device merges deterministic and idempotent.
 */
export function createEventFactory(options: EventFactoryOptions): EventFactory {
  let seq = options.startSeq ?? 0;
  const now = options.now ?? (() => new Date());

  const factory = ((
    type: EventType,
    subjectId: Id | undefined,
    payload: Record<string, unknown> = {},
    opts: { actor?: Actor; at?: ISODate } = {},
  ): LatticeEvent => {
    seq += 1;
    const occurredAt = opts.at ?? now().toISOString();
    const event: LatticeEvent = {
      id: options.newId(),
      deviceId: options.deviceId,
      seq,
      occurredAt,
      recordedAt: now().toISOString(),
      actor: opts.actor ?? options.actor ?? 'human',
      type,
      payload: { ...payload },
    };
    if (subjectId !== undefined) event.subjectId = subjectId;
    return event;
  }) as EventFactory;

  Object.defineProperty(factory, 'seq', { get: () => seq });
  return factory;
}

// ---------------------------------------------------------------------------
// Command helpers: pure, return the event(s) to append. They never touch state.
// ---------------------------------------------------------------------------

export interface PropositionInput {
  statement: string;
  name?: string;
  aliases?: string[];
  domain?: string;
  provenance?: ProvenanceRef[];
  /** Pre-assigned id (used by importers that must stay stable). */
  id?: Id;
}

export function assertProposition(
  factory: EventFactory,
  newId: () => Id,
  input: PropositionInput,
  opts?: { at?: ISODate; actor?: Actor },
): { propositionId: Id; event: LatticeEvent } {
  const propositionId = input.id ?? newId();
  const payload: Record<string, unknown> = { statement: input.statement };
  if (input.name !== undefined) payload.name = input.name;
  if (input.aliases !== undefined) payload.aliases = input.aliases;
  if (input.domain !== undefined) payload.domain = input.domain;
  if (input.provenance !== undefined) payload.provenance = input.provenance;
  return { propositionId, event: factory('proposition.asserted', propositionId, payload, opts) };
}

export interface ChainInput {
  premiseIds: Id[];
  conclusionId: Id;
  strength?: number;
  provenance?: ProvenanceRef[];
  id?: Id;
}

/**
 * A chain says: these premises, *jointly*, imply the conclusion.
 * The merger is responsible for never emitting a chain whose premises are
 * treated as independent; this is why the two lists are distinct fields.
 */
export function assertChain(
  factory: EventFactory,
  newId: () => Id,
  input: ChainInput,
  opts?: { at?: ISODate; actor?: Actor },
): { chainId: Id; event: LatticeEvent } {
  const chainId = input.id ?? newId();
  const payload: Record<string, unknown> = {
    premises: input.premiseIds,
    conclusion: input.conclusionId,
  };
  if (input.strength !== undefined) payload.strength = input.strength;
  if (input.provenance !== undefined) payload.provenance = input.provenance;
  return { chainId, event: factory('chain.asserted', chainId, payload, opts) };
}

export interface CueInput {
  propositionId: Id;
  front: string;
  back: string;
  kind?: CueKind;
  id?: Id;
}

export function assertCue(
  factory: EventFactory,
  newId: () => Id,
  input: CueInput,
  opts?: { at?: ISODate; actor?: Actor },
): { cueId: Id; event: LatticeEvent } {
  const cueId = input.id ?? newId();
  const payload: Record<string, unknown> = {
    propositionId: input.propositionId,
    front: input.front,
    back: input.back,
  };
  if (input.kind !== undefined) payload.kind = input.kind;
  return { cueId, event: factory('cue.asserted', cueId, payload, opts) };
}

export function rateReview(
  factory: EventFactory,
  input: { propositionId: Id; cueId: Id; grade: Grade },
  opts?: { at?: ISODate; actor?: Actor },
): LatticeEvent {
  return factory('review.rated', input.propositionId, { cueId: input.cueId, grade: input.grade }, opts);
}

export function answerQuiz(
  factory: EventFactory,
  input: { propositionId: Id; cueId?: Id; correct: boolean; latencyMs?: number },
  opts?: { at?: ISODate; actor?: Actor },
): LatticeEvent {
  const payload: Record<string, unknown> = { correct: input.correct };
  if (input.cueId !== undefined) payload.cueId = input.cueId;
  if (input.latencyMs !== undefined) payload.latencyMs = input.latencyMs;
  return factory('quiz.answered', input.propositionId, payload, opts);
}

export function mergeProposition(
  factory: EventFactory,
  input: { fromId: Id; intoId: Id; reason?: string },
  opts?: { at?: ISODate; actor?: Actor },
): LatticeEvent {
  const payload: Record<string, unknown> = { intoId: input.intoId };
  if (input.reason !== undefined) payload.reason = input.reason;
  return factory('proposition.merged', input.fromId, payload, opts);
}

/** A capture is an interest signal for a domain, not a request to be quizzed. */
export function assertInterest(
  factory: EventFactory,
  input: { domain: string; topics?: string[]; weight?: number; sourceUri?: string; title?: string },
  opts?: { at?: ISODate; actor?: Actor },
): { interestId: Id; event: LatticeEvent } {
  const domain = input.domain.trim();
  const interestId = 'dom_' + fnv1a64(domain.toLowerCase()).slice(0, 12);
  const payload: Record<string, unknown> = { domain };
  if (input.topics && input.topics.length > 0) payload.topics = input.topics;
  if (input.weight !== undefined) payload.weight = input.weight;
  if (input.sourceUri) payload.sourceUri = input.sourceUri;
  if (input.title) payload.title = input.title;
  return { interestId, event: factory('interest.observed', interestId, payload, opts) };
}

/** The user explicitly says "I want to learn this domain at this level". */
export function declareInterest(
  factory: EventFactory,
  input: { domain: string; level?: DomainLevel; weight?: number },
  opts?: { at?: ISODate; actor?: Actor },
): { interestId: Id; event: LatticeEvent } {
  const domain = input.domain.trim();
  const interestId = 'dom_' + fnv1a64(domain.toLowerCase()).slice(0, 12);
  const payload: Record<string, unknown> = { domain, level: input.level ?? 'beginner' };
  if (input.weight !== undefined) payload.weight = input.weight;
  return { interestId, event: factory('interest.declared', interestId, payload, opts) };
}

export function removeInterest(
  factory: EventFactory,
  input: { domain: string },
  opts?: { at?: ISODate; actor?: Actor },
): { interestId: Id; event: LatticeEvent } {
  const domain = input.domain.trim();
  const interestId = 'dom_' + fnv1a64(domain.toLowerCase()).slice(0, 12);
  return { interestId, event: factory('interest.removed', interestId, { domain }, opts) };
}

/** Declares that `alias` and `canonical` are the same domain. */
export function aliasDomain(
  factory: EventFactory,
  input: { alias: string; canonical: string; decidedBy?: string },
  opts?: { at?: ISODate; actor?: Actor },
): LatticeEvent {
  return factory(
    'domain.alias',
    undefined,
    {
      alias: input.alias.trim(),
      canonical: input.canonical.trim(),
      decidedBy: input.decidedBy ?? 'human',
    },
    opts,
  );
}

export function exposureShown(
  factory: EventFactory,
  input: { propositionId: Id; surface?: string; reason?: string; day?: string },
  opts?: { at?: ISODate; actor?: Actor },
): LatticeEvent {
  const payload: Record<string, unknown> = {};
  if (input.surface) payload.surface = input.surface;
  if (input.reason) payload.reason = input.reason;
  if (input.day) payload.day = input.day;
  return factory('exposure.shown', input.propositionId, payload, opts);
}

export function exposureEngaged(
  factory: EventFactory,
  input: { propositionId: Id; surface?: string },
  opts?: { at?: ISODate; actor?: Actor },
): LatticeEvent {
  return factory('exposure.engaged', input.propositionId, input.surface ? { surface: input.surface } : {}, opts);
}

export function exposureSkipped(
  factory: EventFactory,
  input: { propositionId: Id; surface?: string },
  opts?: { at?: ISODate; actor?: Actor },
): LatticeEvent {
  return factory('exposure.skipped', input.propositionId, input.surface ? { surface: input.surface } : {}, opts);
}

export function resetMasteryEvent(factory: EventFactory, propositionId: Id, opts?: { at?: ISODate; actor?: Actor }): LatticeEvent {
  return factory('mastery.reset', propositionId, {}, opts);
}

export function clearedDataEvent(factory: EventFactory, opts?: { at?: ISODate; actor?: Actor }): LatticeEvent {
  return factory('data.cleared', undefined, {}, opts);
}

const KNOWN_TYPES: ReadonlySet<string> = new Set<EventType>([
  'proposition.asserted',
  'proposition.merged',
  'chain.asserted',
  'interest.observed',
  'interest.declared',
  'interest.removed',
  'domain.alias',
  'cue.asserted',
  'review.rated',
  'quiz.answered',
  'exposure.shown',
  'exposure.engaged',
  'exposure.skipped',
  'mastery.reset',
  'data.cleared',
]);

/** Structural validation for events read from disk (imports / corrupted logs). */
export function validateEvent(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) return ['event: not an object'];
  const e = value as Record<string, unknown>;
  for (const key of ['id', 'deviceId', 'occurredAt', 'recordedAt', 'actor', 'type']) {
    if (typeof e[key] !== 'string' || (e[key] as string).length === 0) errors.push(`${key}: missing or not a string`);
  }
  if (typeof e['seq'] !== 'number' || !Number.isInteger(e['seq']) || (e['seq'] as number) < 0) {
    errors.push('seq: missing or not a non-negative integer');
  }
  if (typeof e['type'] === 'string' && !KNOWN_TYPES.has(e['type'])) errors.push(`type: unknown "${e['type']}"`);
  if (typeof e['payload'] !== 'object' || e['payload'] === null || Array.isArray(e['payload'])) {
    errors.push('payload: must be an object');
  }
  if (typeof e['occurredAt'] === 'string' && Number.isNaN(Date.parse(e['occurredAt']))) {
    errors.push('occurredAt: not a valid date');
  }
  return errors;
}
