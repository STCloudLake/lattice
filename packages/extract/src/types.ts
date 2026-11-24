import type { Difficulty, Id, ProvenanceRef } from '@lattice/core';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
}

/** The only thing extraction needs from a model. Implemented by the extension. */
export interface LlmPort {
  complete(request: LlmRequest): Promise<string>;
}

export type SourceKind = 'page' | 'pdf' | 'video' | 'note' | 'paste' | 'import' | 'session';

export interface NormalizedSource {
  /** Stable content fingerprint, used by the coverage ledger. */
  sourceHash: string;
  text: string;
  title?: string;
  sourceUri?: string;
  sourceKind: SourceKind;
  /** Fake clock for tests. */
  capturedAt: string;
}

export interface ExtractedProposition {
  /** Source-local reference, e.g. "p1". Resolved to a real id by the merger. */
  ref: string;
  statement: string;
  name?: string;
  aliases?: string[];
  /** Short verbatim quote from the source. Required by the prompt, not by the schema. */
  quote?: string;
  /** ★1–5 acquisition difficulty + cognitive operation. */
  difficulty?: Difficulty;
}

export interface ExtractedChain {
  premises: string[];
  conclusion: string;
  strength?: number;
}

export interface ExtractionCandidate {
  /** The domain/topic the passage belongs to (interest signal, not a quiz). */
  domain?: string;
  propositions: ExtractedProposition[];
  chains: ExtractedChain[];
}

export interface ExtractResult {
  candidate: ExtractionCandidate;
  promptVersion: string;
  /** Raw model output, kept for the preview UI's "what did it actually say" view. */
  raw: string;
}

export interface ExistingProposition {
  id: Id;
  statement: string;
  aliases?: string[];
}

export interface IdentityDecision {
  ref: string;
  /** Existing proposition id, or null when the candidate is genuinely new. */
  existingId: Id | null;
  reason?: string;
}

export interface IdentityResult {
  decisions: Map<string, IdentityDecision>;
  promptVersion: string;
  raw: string;
  /** Refs the model failed to answer for. They default to "new". */
  unresolved: string[];
}

export interface MergePlan {
  /** Domain carried into created propositions and the interest ledger. */
  domain?: string;
  create: Array<{
    ref: string;
    statement: string;
    name?: string;
    aliases: string[];
    quote?: string;
    difficulty?: Difficulty;
  }>;
  reuse: Array<{ ref: string; existingId: Id }>;
  cues: Array<{ ref: string; front: string; back: string; kind: 'recall' }>;
  chains: Array<{ premiseRefs: string[]; conclusionRef: string; strength: number }>;
  dropped: Array<{ ref?: string; reason: string }>;
}

export interface MergeOptions {
  /** Existing chains as (sorted premise ids + conclusion) keys, to avoid duplicates. */
  existingChainKeys?: Set<string>;
  /** Drop chains weaker than this. Default 0 (keep all, UI shows confidence). */
  minChainStrength?: number;
}

export function chainKey(premiseIds: readonly Id[], conclusionId: Id): string {
  return [...premiseIds].sort().join(',') + '=>' + conclusionId;
}

export function provenanceFor(
  source: NormalizedSource,
  quote?: string,
): ProvenanceRef {
  const ref: ProvenanceRef = {
    sourceKind: source.sourceKind,
    capturedAt: source.capturedAt,
  };
  if (source.sourceUri) ref.sourceUri = source.sourceUri;
  if (source.title) ref.title = source.title;
  if (quote) ref.span = { quote };
  return ref;
}
