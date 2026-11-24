import { canonicalJson, fnv1a64 } from './ids.js';
import type { LearnerState } from './types.js';

/**
 * A stable fingerprint of the whole projection.
 *
 * Two devices that replay the same event log must print the same digest. This
 * is how M0 proves "export -> replay -> identical state" without comparing
 * flaky floating-point text.
 */
export function stateDigest(state: LearnerState): string {
  const sortedBy = <T>(items: T[], key: (item: T) => string): T[] =>
    [...items].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  const snapshot = {
    propositions: sortedBy(Object.values(state.propositions), (p) => p.id),
    cues: sortedBy(Object.values(state.cues), (c) => c.id),
    mastery: sortedBy(Object.values(state.mastery), (m) => m.propositionId).map((m) => ({
      propositionId: m.propositionId,
      // Round so IEEE noise across engines cannot change the digest.
      alpha: round(m.alpha),
      beta: round(m.beta),
      evidenceCount: m.evidenceCount,
    })),
    schedule: sortedBy(Object.values(state.schedule), (s) => s.propositionId).map((s) => ({
      propositionId: s.propositionId,
      stability: round(s.stability),
      difficulty: round(s.difficulty),
      stage: s.stage,
      dueAt: s.dueAt,
      reviewCount: s.reviewCount,
      lapses: s.lapses,
    })),
    reviews: [...state.reviews]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r) => ({
        id: r.id,
        cueId: r.cueId,
        propositionId: r.propositionId,
        grade: r.grade,
        elapsedDays: round(r.elapsedDays),
        rBefore: round(r.rBefore),
      })),
  };

  return fnv1a64(canonicalJson(snapshot));
}

function round(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

/** Human-readable summary used by CLI and the extension's diagnostics panel. */
export function stateSummary(state: LearnerState): Record<string, number> {
  return {
    propositions: Object.keys(state.propositions).length,
    cues: Object.keys(state.cues).length,
    reviews: state.reviews.length,
    eventsDigestInputs: Object.keys(state.mastery).length,
  };
}
