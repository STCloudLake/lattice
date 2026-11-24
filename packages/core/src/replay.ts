import { applyGrade, newSchedule } from './fsrs.js';
import { applyEvidence, emptyMastery, resetMastery } from './mastery.js';
import type {
  Cue,
  CueKind,
  Grade,
  Id,
  LatticeEvent,
  LearnerState,
  Proposition,
  ReviewLog,
} from './types.js';

export function emptyState(): LearnerState {
  return { propositions: {}, cues: {}, mastery: {}, schedule: {}, reviews: [] };
}

/**
 * Deduplicates by event id and orders deterministically:
 * occurredAt, then deviceId, then seq.
 *
 * Ordering by occurredAt (not arrival) is what lets a device that was offline
 * merge its events into the middle of history and still produce the same
 * projection everywhere.
 */
export function dedupeAndSort(events: readonly LatticeEvent[]): LatticeEvent[] {
  const seen = new Set<string>();
  const out: LatticeEvent[] = [];
  for (const e of events) {
    if (!e || typeof e.id !== 'string' || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  out.sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
    if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
    return a.seq - b.seq;
  });
  return out;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function asGrade(v: unknown): Grade | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  if (n === 1 || n === 2 || n === 3 || n === 4) return n as Grade;
  return undefined;
}

const CUE_KINDS: ReadonlySet<string> = new Set<CueKind>(['recall', 'cloze', 'apply', 'contrast']);

function asCueKind(v: unknown): CueKind {
  return typeof v === 'string' && CUE_KINDS.has(v) ? (v as CueKind) : 'recall';
}

/**
 * Folds the event log into the four ledgers. Pure and deterministic: same
 * events in, same state out, regardless of order or duplicates.
 */
export function replay(events: readonly LatticeEvent[]): LearnerState {
  const state = emptyState();
  for (const event of dedupeAndSort(events)) applyEvent(state, event);
  return state;
}

function applyEvent(state: LearnerState, e: LatticeEvent): void {
  switch (e.type) {
    case 'proposition.asserted': {
      const id = e.subjectId ?? asString(e.payload['id']);
      const statement = asString(e.payload['statement']);
      if (!id || !statement) return;
      const existing = state.propositions[id];
      if (existing) {
        // Re-assertion: union aliases, keep first statement.
        const aliases = new Set([...existing.aliases, ...asStringArray(e.payload['aliases'])]);
        state.propositions[id] = { ...existing, aliases: [...aliases] };
        return;
      }
      const proposition: Proposition = {
        id,
        statement,
        aliases: asStringArray(e.payload['aliases']),
        status: 'active',
        createdAt: e.occurredAt,
      };
      const name = asString(e.payload['name']);
      if (name) proposition.name = name;
      const domain = asString(e.payload['domain']);
      if (domain) proposition.domain = domain;
      state.propositions[id] = proposition;
      state.mastery[id] = emptyMastery(id, e.occurredAt);
      state.schedule[id] = newSchedule(id, e.occurredAt);
      return;
    }

    case 'cue.asserted': {
      const id = e.subjectId ?? asString(e.payload['id']);
      const propositionId = asString(e.payload['propositionId']);
      const front = asString(e.payload['front']);
      const back = asString(e.payload['back']);
      if (!id || !propositionId || !front || !back) return;
      if (!state.propositions[propositionId]) return; // cue without its proposition: orphan, ignored
      const cue: Cue = {
        id,
        propositionId,
        front,
        back,
        kind: asCueKind(e.payload['kind']),
        createdAt: e.occurredAt,
      };
      state.cues[id] = cue;
      return;
    }

    case 'review.rated': {
      const propositionId = e.subjectId ?? asString(e.payload['propositionId']);
      const cueId = asString(e.payload['cueId']);
      const grade = asGrade(e.payload['grade']);
      if (!propositionId || !cueId || !grade) return;
      const schedule = state.schedule[propositionId] ?? newSchedule(propositionId, e.occurredAt);
      const result = applyGrade(schedule, e.occurredAt, grade);
      state.schedule[propositionId] = result.schedule;
      const mastery = state.mastery[propositionId] ?? emptyMastery(propositionId, e.occurredAt);
      state.mastery[propositionId] = applyEvidence(mastery, 'recall', grade >= 3, e.occurredAt);
      const log: ReviewLog = {
        id: e.id,
        cueId,
        propositionId,
        grade,
        elapsedDays: result.elapsedDays,
        rBefore: result.rBefore,
        reviewedAt: e.occurredAt,
      };
      state.reviews.push(log);
      return;
    }

    case 'quiz.answered': {
      const propositionId = e.subjectId ?? asString(e.payload['propositionId']);
      const correct = e.payload['correct'];
      if (!propositionId || typeof correct !== 'boolean') return;
      const mastery = state.mastery[propositionId] ?? emptyMastery(propositionId, e.occurredAt);
      state.mastery[propositionId] = applyEvidence(mastery, 'quiz', correct, e.occurredAt);
      return;
    }

    case 'mastery.reset': {
      const propositionId = e.subjectId ?? asString(e.payload['propositionId']);
      if (!propositionId) return;
      const mastery = state.mastery[propositionId] ?? emptyMastery(propositionId, e.occurredAt);
      state.mastery[propositionId] = resetMastery(mastery, e.occurredAt);
      return;
    }

    case 'proposition.merged': {
      const fromId = e.subjectId ?? asString(e.payload['fromId']);
      const intoId = asString(e.payload['intoId']);
      if (!fromId || !intoId || fromId === intoId) return;
      const from = state.propositions[fromId];
      const into = state.propositions[intoId];
      if (!from || !into) return;
      into.aliases = [...new Set([...into.aliases, ...from.aliases, from.statement])];
      from.status = 'superseded';
      from.mergedInto = intoId;
      // Fold learner state into the survivor so history is not lost.
      const mFrom = state.mastery[fromId];
      const mInto = state.mastery[intoId];
      if (mFrom && mInto) {
        state.mastery[intoId] = {
          ...mInto,
          alpha: mInto.alpha + (mFrom.alpha - 2),
          beta: mInto.beta + (mFrom.beta - 2),
          evidenceCount: mInto.evidenceCount + mFrom.evidenceCount,
          updatedAt: e.occurredAt,
        };
      }
      const sFrom = state.schedule[fromId];
      const sInto = state.schedule[intoId];
      if (sFrom && sInto && sFrom.reviewCount > sInto.reviewCount) {
        state.schedule[intoId] = { ...sFrom, propositionId: intoId };
      }
      for (const cue of Object.values(state.cues)) {
        if (cue.propositionId === fromId) cue.propositionId = intoId;
      }
      return;
    }

    case 'data.cleared': {
      state.propositions = {};
      state.cues = {};
      state.mastery = {};
      state.schedule = {};
      state.reviews = [];
      return;
    }

    // Attention evidence is the C ledger; M0 does not model it yet.
    case 'exposure.shown':
    case 'exposure.engaged':
    case 'exposure.skipped':
      return;
  }
}

/** Live (not superseded) propositions, in creation order. */
export function activePropositions(state: LearnerState): Proposition[] {
  return Object.values(state.propositions)
    .filter((p) => p.status === 'active')
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
}

export function cuesFor(state: LearnerState, propositionId: Id): Cue[] {
  return Object.values(state.cues)
    .filter((c) => c.propositionId === propositionId)
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
}
