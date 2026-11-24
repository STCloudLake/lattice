import type { Actor, CueKind, EventType, Grade, Id, ISODate, LatticeEvent } from './types.js';

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
  /** Pre-assigned id (used by importers that must stay stable). */
  id?: Id;
}

export function assertProposition(
  factory: EventFactory,
  newId: () => Id,
  input: PropositionInput,
  opts?: { at?: ISODate },
): { propositionId: Id; event: LatticeEvent } {
  const propositionId = input.id ?? newId();
  const payload: Record<string, unknown> = { statement: input.statement };
  if (input.name !== undefined) payload.name = input.name;
  if (input.aliases !== undefined) payload.aliases = input.aliases;
  if (input.domain !== undefined) payload.domain = input.domain;
  return { propositionId, event: factory('proposition.asserted', propositionId, payload, opts) };
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
  opts?: { at?: ISODate },
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
  opts?: { at?: ISODate },
): LatticeEvent {
  return factory('review.rated', input.propositionId, { cueId: input.cueId, grade: input.grade }, opts);
}

export function answerQuiz(
  factory: EventFactory,
  input: { propositionId: Id; cueId?: Id; correct: boolean; latencyMs?: number },
  opts?: { at?: ISODate },
): LatticeEvent {
  const payload: Record<string, unknown> = { correct: input.correct };
  if (input.cueId !== undefined) payload.cueId = input.cueId;
  if (input.latencyMs !== undefined) payload.latencyMs = input.latencyMs;
  return factory('quiz.answered', input.propositionId, payload, opts);
}

export function mergeProposition(
  factory: EventFactory,
  input: { fromId: Id; intoId: Id; reason?: string },
  opts?: { at?: ISODate },
): LatticeEvent {
  const payload: Record<string, unknown> = { intoId: input.intoId };
  if (input.reason !== undefined) payload.reason = input.reason;
  return factory('proposition.merged', input.fromId, payload, opts);
}

export function resetMasteryEvent(factory: EventFactory, propositionId: Id, opts?: { at?: ISODate }): LatticeEvent {
  return factory('mastery.reset', propositionId, {}, opts);
}

export function clearedDataEvent(factory: EventFactory, opts?: { at?: ISODate }): LatticeEvent {
  return factory('data.cleared', undefined, {}, opts);
}

const KNOWN_TYPES: ReadonlySet<string> = new Set<EventType>([
  'proposition.asserted',
  'proposition.merged',
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
