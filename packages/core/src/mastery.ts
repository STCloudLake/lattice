import type { EvidenceKind, ISODate, Id, MasteryState, MasterySummary } from './types.js';

/**
 * Understanding (M ledger) as a Beta posterior.
 *
 * Deliberately separate from FSRS availability: a high-mastery/low-R proposition
 * means "understood, needs retrieval practice", a low-mastery/high-R one means
 * "memorised without understanding". One number cannot express both.
 *
 * M0 does not apply time decay to evidence (documented in docs/m0-limits.md).
 */
const PRIOR_ALPHA = 2;
const PRIOR_BETA = 2;

/** How much one unit of evidence moves the posterior, per channel. */
export const EVIDENCE_WEIGHT: Record<EvidenceKind, number> = {
  quiz: 1,
  recall: 0.6,
  explain: 0.4,
};

const Z_80 = 1.2815515655446004; // two-sided 80% -> 10th/90th percentile

export function emptyMastery(propositionId: Id, at: ISODate): MasteryState {
  return {
    propositionId,
    alpha: PRIOR_ALPHA,
    beta: PRIOR_BETA,
    evidenceCount: 0,
    updatedAt: at,
  };
}

export function applyEvidence(
  m: MasteryState,
  kind: EvidenceKind,
  correct: boolean,
  at: ISODate,
): MasteryState {
  const w = EVIDENCE_WEIGHT[kind];
  return {
    propositionId: m.propositionId,
    alpha: m.alpha + (correct ? w : 0),
    beta: m.beta + (correct ? 0 : w),
    evidenceCount: m.evidenceCount + 1,
    updatedAt: at,
  };
}

export function resetMastery(m: MasteryState, at: ISODate): MasteryState {
  return emptyMastery(m.propositionId, at);
}

export function masterySummary(m: MasteryState): MasterySummary {
  const total = m.alpha + m.beta;
  const mean = m.alpha / total;
  const variance = (m.alpha * m.beta) / (total * total * (total + 1));
  const sd = Math.sqrt(variance);
  const low = clamp01(mean - Z_80 * sd);
  const high = clamp01(mean + Z_80 * sd);
  return { mean, low, high, strength: Math.max(0, total - PRIOR_ALPHA - PRIOR_BETA) };
}

/** Convenience: mean only. */
export function masteryOf(m: MasteryState | undefined): number {
  return m ? m.alpha / (m.alpha + m.beta) : 0.5;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
