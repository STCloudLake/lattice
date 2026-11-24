import { canonicalizeInterests, createDomainResolver } from './domains.js';
import { applyGrade, newSchedule } from './fsrs.js';
import { applyEvidence, emptyMastery, resetMastery } from './mastery.js';
import type {
  Chain,
  Cue,
  DomainLevel,
  ExposureState,
  Interest,
  CueKind,
  Grade,
  Id,
  LatticeEvent,
  LearnerState,
  Proposition,
  ProvenanceRef,
  ReviewLog,
} from './types.js';

export function emptyState(): LearnerState {
  return {
    propositions: {},
    cues: {},
    chains: {},
    interests: {},
    exposures: {},
    domainAliases: [],
    mastery: {},
    schedule: {},
    reviews: [],
  };
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

function asProvenance(v: unknown): ProvenanceRef[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is ProvenanceRef =>
      typeof x === 'object' &&
      x !== null &&
      typeof (x as ProvenanceRef).sourceKind === 'string' &&
      typeof (x as ProvenanceRef).capturedAt === 'string',
  );
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
  // Aliases may be declared after the interests they affect, so canonicalization
  // is a post-pass rather than part of the fold.
  const resolver = createDomainResolver(state.domainAliases);
  state.interests = canonicalizeInterests(state.interests, resolver);
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
        provenance: asProvenance(e.payload['provenance']),
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

    case 'chain.asserted': {
      const id = e.subjectId ?? asString(e.payload['id']);
      const conclusionId = asString(e.payload['conclusion']);
      const premisesRaw = e.payload['premises'];
      if (!id || !conclusionId || !Array.isArray(premisesRaw)) return;
      const premiseIds = [
        ...new Set(premisesRaw.filter((x): x is Id => typeof x === 'string' && x.length > 0)),
      ].filter((p) => p !== conclusionId);
      if (premiseIds.length === 0) return;
      const strengthRaw = e.payload['strength'];
      const strength =
        typeof strengthRaw === 'number' && strengthRaw >= 0 && strengthRaw <= 1 ? strengthRaw : 1;
      state.chains[id] = {
        id,
        conclusionId,
        premiseIds,
        strength,
        createdAt: e.occurredAt,
        provenance: asProvenance(e.payload['provenance']),
      };
      return;
    }

    case 'interest.observed': {
      const name = asString(e.payload['domain']);
      const id = e.subjectId ?? (name ? 'dom_' + name.toLowerCase() : undefined);
      if (!name || !id) return;
      const weightRaw = e.payload['weight'];
      const weight = typeof weightRaw === 'number' && weightRaw > 0 ? weightRaw : 1;
      const topicsRaw = e.payload['topics'];
      const topics = Array.isArray(topicsRaw) ? topicsRaw.filter((t): t is string => typeof t === 'string') : [];
      const existing = state.interests[id];
      const next: Interest = existing
        ? {
            ...existing,
            weight: existing.weight + weight,
            captureCount: existing.captureCount + 1,
            lastSeenAt: e.occurredAt,
            topics: { ...existing.topics },
          }
        : {
            id,
            name,
            weight,
            captureCount: 1,
            lastSeenAt: e.occurredAt,
            topics: {},
            declared: false,
            level: 'beginner',
          };
      for (const topic of topics) next.topics[topic] = (next.topics[topic] ?? 0) + 1;
      state.interests[id] = next;
      return;
    }

    case 'domain.alias': {
      const alias = asString(e.payload['alias']);
      const canonical = asString(e.payload['canonical']);
      if (!alias || !canonical) return;
      const decidedBy = asString(e.payload['decidedBy']) ?? 'human';
      state.domainAliases = state.domainAliases
        .filter((rule) => rule.alias.toLowerCase() !== alias.toLowerCase())
        .concat({ alias, canonical, decidedBy, at: e.occurredAt });
      return;
    }

    case 'interest.removed': {
      const name = asString(e.payload['domain']);
      const id = e.subjectId ?? (name ? 'dom_' + name.toLowerCase() : undefined);
      if (!id) return;
      const existing = state.interests[id];
      if (!existing) return;
      // Captures remain evidence; only the explicit declaration is withdrawn.
      if (existing.captureCount === 0) delete state.interests[id];
      else state.interests[id] = { ...existing, declared: false };
      return;
    }

    case 'interest.declared': {
      const name = asString(e.payload['domain']);
      const id = e.subjectId ?? (name ? 'dom_' + name.toLowerCase() : undefined);
      if (!name || !id) return;
      const levelRaw = e.payload['level'];
      const level = levelRaw === 'intermediate' || levelRaw === 'advanced' ? levelRaw : 'beginner';
      const weightRaw = e.payload['weight'];
      const weight = typeof weightRaw === 'number' && weightRaw > 0 ? weightRaw : 5;
      const existing = state.interests[id];
      const next: Interest = existing
        ? {
            ...existing,
            declared: true,
            level,
            weight: Math.max(existing.weight, weight),
            lastSeenAt: e.occurredAt,
            topics: { ...existing.topics },
          }
        : {
            id,
            name,
            weight,
            captureCount: 0,
            lastSeenAt: e.occurredAt,
            topics: {},
            declared: true,
            level,
          };
      state.interests[id] = next;
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
      // Chains must never point at a superseded node.
      for (const chain of Object.values(state.chains)) {
        if (chain.conclusionId === fromId) chain.conclusionId = intoId;
        chain.premiseIds = [...new Set(chain.premiseIds.map((p) => (p === fromId ? intoId : p)))];
        if (chain.premiseIds.length === 0 || chain.premiseIds.includes(chain.conclusionId)) {
          delete state.chains[chain.id];
        }
      }
      return;
    }

    case 'data.cleared': {
      state.propositions = {};
      state.cues = {};
      state.chains = {};
      state.interests = {};
      state.exposures = {};
      state.domainAliases = [];
      state.mastery = {};
      state.schedule = {};
      state.reviews = [];
      return;
    }

    // Attention evidence feeds the C ledger only. It never touches mastery.
    case 'exposure.shown': {
      const propositionId = e.subjectId ?? asString(e.payload['propositionId']);
      if (!propositionId) return;
      const day = asString(e.payload['day']) ?? e.occurredAt.slice(0, 10);
      const previous = state.exposures[propositionId] ?? { propositionId, shown: 0, engaged: 0, skipped: 0 };
      state.exposures[propositionId] = {
        ...previous,
        shown: previous.shown + 1,
        lastShownAt: e.occurredAt,
        lastShownDay: day,
      };
      return;
    }

    case 'exposure.engaged': {
      const propositionId = e.subjectId ?? asString(e.payload['propositionId']);
      if (!propositionId) return;
      const previous = state.exposures[propositionId] ?? { propositionId, shown: 0, engaged: 0, skipped: 0 };
      state.exposures[propositionId] = { ...previous, engaged: previous.engaged + 1 };
      return;
    }

    case 'exposure.skipped': {
      const propositionId = e.subjectId ?? asString(e.payload['propositionId']);
      if (!propositionId) return;
      const previous = state.exposures[propositionId] ?? { propositionId, shown: 0, engaged: 0, skipped: 0 };
      state.exposures[propositionId] = { ...previous, skipped: previous.skipped + 1 };
      return;
    }
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

/** Interests sorted by weight (highest first), deterministic tie-break by id. */
export function interestsOf(state: LearnerState): Interest[] {
  return Object.values(state.interests).sort((a, b) => {
    if (a.weight !== b.weight) return b.weight - a.weight;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Exposure bookkeeping for one proposition (0s when never shown). */
export function exposureOf(state: LearnerState, propositionId: Id): ExposureState {
  return state.exposures[propositionId] ?? { propositionId, shown: 0, engaged: 0, skipped: 0 };
}

/** Chains where the proposition is the conclusion or one of the premises. */
export function chainsFor(state: LearnerState, propositionId: Id): Chain[] {
  return Object.values(state.chains)
    .filter((c) => c.conclusionId === propositionId || c.premiseIds.includes(propositionId))
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
}

export interface PrerequisiteEdge {
  /** The premise: must be understood first. */
  from: Id;
  /** The conclusion: can be learned once `from` is held. */
  to: Id;
  chainId: Id;
  strength: number;
}

/**
 * Prerequisite structure is *derived* from chains, never stored separately.
 * One source of truth means the graph view and the path planner cannot disagree.
 */
export function prerequisiteEdges(
  state: LearnerState,
  options: { minStrength?: number; activeOnly?: boolean } = {},
): PrerequisiteEdge[] {
  const minStrength = options.minStrength ?? 0;
  const activeOnly = options.activeOnly ?? true;
  const edges = new Map<string, PrerequisiteEdge>();
  for (const chain of Object.values(state.chains)) {
    if (chain.strength < minStrength) continue;
    const conclusion = state.propositions[chain.conclusionId];
    if (!conclusion) continue;
    if (activeOnly && conclusion.status !== 'active') continue;
    for (const premiseId of chain.premiseIds) {
      const premise = state.propositions[premiseId];
      if (!premise) continue;
      if (activeOnly && premise.status !== 'active') continue;
      const key = premiseId + '->' + chain.conclusionId;
      const existing = edges.get(key);
      // Keep the strongest assertion of the same edge.
      if (!existing || existing.strength < chain.strength) {
        edges.set(key, {
          from: premiseId,
          to: chain.conclusionId,
          chainId: chain.id,
          strength: chain.strength,
        });
      }
    }
  }
  return [...edges.values()].sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1));
}

/** Direct prerequisites of one proposition. */
export function prerequisitesOf(
  state: LearnerState,
  propositionId: Id,
  options: { minStrength?: number } = {},
): Id[] {
  return prerequisiteEdges(state, options)
    .filter((e) => e.to === propositionId)
    .map((e) => e.from);
}

/** All ancestors, breadth-first, cycle-safe. */
export function transitivePrerequisites(
  state: LearnerState,
  propositionId: Id,
  options: { minStrength?: number } = {},
): Id[] {
  const seen = new Set<Id>();
  const queue = [...prerequisitesOf(state, propositionId, options)];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const parent of prerequisitesOf(state, next, options)) {
      if (!seen.has(parent)) queue.push(parent);
    }
  }
  return [...seen];
}

/** Propositions with no prerequisites in the current graph ("foundations"). */
export function foundationPropositions(state: LearnerState): Proposition[] {
  const withPrereq = new Set(prerequisiteEdges(state).map((e) => e.to));
  return activePropositions(state).filter((p) => !withPrereq.has(p.id));
}
