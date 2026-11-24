import {
  assertChain,
  assertCue,
  assertInterest,
  assertProposition,
  fnv1a64,
  type Actor,
  type EventFactory,
  type Id,
  type LatticeEvent,
} from '@lattice/core';
import {
  buildCurriculumMessages,
  buildExtractMessages,
  buildIdentifyMessages,
  CURRICULUM_PROMPT_VERSION,
  EXTRACT_PROMPT_VERSION,
  IDENTIFY_PROMPT_VERSION,
} from './prompts.js';
import { extractJsonObject, validateCandidateJson, type ValidationIssue } from './validate.js';
import {
  chainKey,
  provenanceFor,
  type ExistingProposition,
  type ExtractionCandidate,
  type ExtractResult,
  type IdentityResult,
  type LlmPort,
  type MergeOptions,
  type MergePlan,
  type NormalizedSource,
  type SourceKind,
} from './types.js';

export class ExtractionError extends Error {
  readonly issues: ValidationIssue[];
  constructor(message: string, issues: ValidationIssue[] = []) {
    super(message);
    this.name = 'ExtractionError';
    this.issues = issues;
  }
}

export interface NormalizeInput {
  text: string;
  title?: string;
  sourceUri?: string;
  sourceKind?: SourceKind;
  capturedAt?: string;
}

/** Whitespace-stable text + a content fingerprint for the coverage ledger. */
export function normalizeSource(input: NormalizeInput): NormalizedSource {
  const text = input.text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length === 0) throw new ExtractionError('内容为空');
  const source: NormalizedSource = {
    sourceHash: fnv1a64(text),
    text,
    sourceKind: input.sourceKind ?? 'paste',
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
  if (input.title) source.title = input.title;
  if (input.sourceUri) source.sourceUri = input.sourceUri;
  return source;
}

/** Step 1: model reads the source and proposes propositions + chains. */
export async function extractCandidate(
  source: NormalizedSource,
  options: { llm: LlmPort; maxTokens?: number },
): Promise<ExtractResult> {
  const raw = await options.llm.complete({
    messages: buildExtractMessages(source),
    temperature: 0,
    maxTokens: options.maxTokens ?? 2500,
  });
  let parsed: unknown;
  try {
    parsed = extractJsonObject(raw);
  } catch (err) {
    throw new ExtractionError(`模型输出不是合法 JSON：${(err as Error).message}`);
  }
  const { candidate, issues } = validateCandidateJson(parsed);
  if (!candidate) throw new ExtractionError('抽取结果未通过校验', issues);
  return { candidate, promptVersion: EXTRACT_PROMPT_VERSION, raw };
}

/**
 * Step 2: identity resolution. The auditor never sees the source — only the
 * candidate statements and the existing ones — and may only answer "same or new".
 * With no existing propositions we skip the call entirely (deterministic + cheap).
 */
export async function resolveIdentity(
  candidate: ExtractionCandidate,
  existing: ExistingProposition[],
  options: { llm: LlmPort },
): Promise<IdentityResult> {
  const allNew = (): IdentityResult => ({
    decisions: new Map(candidate.propositions.map((p) => [p.ref, { ref: p.ref, existingId: null }])),
    promptVersion: IDENTIFY_PROMPT_VERSION,
    raw: '',
    unresolved: [],
  });
  if (existing.length === 0 || candidate.propositions.length === 0) return allNew();

  const raw = await options.llm.complete({
    messages: buildIdentifyMessages(candidate.propositions, existing),
    temperature: 0,
    maxTokens: 1500,
  });
  let parsed: unknown;
  try {
    parsed = extractJsonObject(raw);
  } catch {
    return { ...allNew(), raw, unresolved: candidate.propositions.map((p) => p.ref) };
  }

  const known = new Map(existing.map((e) => [e.id, e]));
  const candidateRefs = new Set(candidate.propositions.map((p) => p.ref));
  const decisions = new Map<string, { ref: string; existingId: Id | null; reason?: string }>();
  const record = parsed as Record<string, unknown>;
  const list = Array.isArray(record['decisions']) ? record['decisions'] : [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const d = item as Record<string, unknown>;
    const ref = typeof d['ref'] === 'string' ? d['ref'] : undefined;
    if (!ref || !candidateRefs.has(ref) || decisions.has(ref)) continue;
    const existingIdRaw = d['existingId'];
    const reason = typeof d['reason'] === 'string' ? d['reason'] : undefined;
    if (typeof existingIdRaw === 'string' && known.has(existingIdRaw)) {
      decisions.set(ref, { ref, existingId: existingIdRaw, ...(reason ? { reason } : {}) });
    } else {
      decisions.set(ref, { ref, existingId: null, ...(reason ? { reason } : {}) });
    }
  }
  const unresolved = candidate.propositions.map((p) => p.ref).filter((ref) => !decisions.has(ref));
  for (const ref of unresolved) decisions.set(ref, { ref, existingId: null });
  return { decisions, promptVersion: IDENTIFY_PROMPT_VERSION, raw, unresolved };
}

function cueFront(props: { statement: string; name?: string; aliases?: string[] }): string {
  if (props.name) return `${props.name}是什么？`;
  const short = props.statement.replace(/。$/, '');
  return `请回忆：${short.length > 40 ? short.slice(0, 40) + '…' : short}`;
}

/**
 * Step 3: deterministic merge. No model calls, no timestamps taken from here —
 * everything is derived from the validated candidate plus the identity map.
 */
export function buildMergePlan(
  candidate: ExtractionCandidate,
  identity: IdentityResult,
  options: MergeOptions = {},
): MergePlan {
  const plan: MergePlan = { create: [], reuse: [], cues: [], chains: [], dropped: [] };
  if (candidate.domain && candidate.domain.trim().length > 0) plan.domain = candidate.domain.trim();
  const target = new Map<string, { kind: 'create' | 'reuse'; id?: Id }>();

  for (const proposition of candidate.propositions) {
    const decision = identity.decisions.get(proposition.ref);
    const existingId = decision?.existingId ?? null;
    if (existingId) {
      plan.reuse.push({ ref: proposition.ref, existingId });
      target.set(proposition.ref, { kind: 'reuse', id: existingId });
      continue;
    }
    const entry: MergePlan['create'][number] = {
      ref: proposition.ref,
      statement: proposition.statement,
      aliases: proposition.aliases ?? [],
    };
    if (proposition.name) entry.name = proposition.name;
    if (proposition.quote) entry.quote = proposition.quote;
    plan.create.push(entry);
    target.set(proposition.ref, { kind: 'create' });
    plan.cues.push({
      ref: proposition.ref,
      front: cueFront(proposition),
      back: proposition.statement,
      kind: 'recall',
    });
  }

  const existingChainKeys = options.existingChainKeys ?? new Set<string>();
  const minStrength = options.minChainStrength ?? 0;
  const seen = new Set<string>();

  for (const chain of candidate.chains) {
    const strength = chain.strength ?? 0.8;
    if (strength < minStrength) {
      plan.dropped.push({ reason: `推理链置信度 ${strength} 低于阈值 ${minStrength}` });
      continue;
    }
    const missing = [...chain.premises, chain.conclusion].filter((ref) => !target.has(ref));
    if (missing.length > 0) {
      plan.dropped.push({ reason: `推理链引用了未知命题：${missing.join(', ')}` });
      continue;
    }
    const refKey = [...chain.premises].sort().join(',') + '=>' + chain.conclusion;
    if (seen.has(refKey)) {
      plan.dropped.push({ reason: '同一批次内重复的推理链' });
      continue;
    }
    seen.add(refKey);

    // Compare against existing chains only when every node already has an id.
    const allReuse = [...chain.premises, chain.conclusion].every((ref) => target.get(ref)?.kind === 'reuse');
    if (allReuse) {
      const ids = [...chain.premises, chain.conclusion].map((ref) => target.get(ref)!.id!) as Id[];
      const conclusionId = ids[ids.length - 1]!;
      const premiseIds = ids.slice(0, -1);
      if (existingChainKeys.has(chainKey(premiseIds, conclusionId))) {
        plan.dropped.push({ reason: '与已有推理链重复' });
        continue;
      }
    }

    plan.chains.push({ premiseRefs: chain.premises, conclusionRef: chain.conclusion, strength });
  }

  return plan;
}

export interface PlanToEventsOptions {
  factory: EventFactory;
  newId: () => Id;
  source: NormalizedSource;
  actor?: Actor;
}

export interface PlanToEventsResult {
  events: LatticeEvent[];
  idsByRef: Map<string, Id>;
}

/** Step 4: the only place that turns a plan into events. */
export function planToEvents(plan: MergePlan, options: PlanToEventsOptions): PlanToEventsResult {
  const events: LatticeEvent[] = [];
  const idsByRef = new Map<string, Id>();
  const at = options.source.capturedAt;
  const provenance = provenanceFor(options.source);
  const actor = options.actor ?? 'system';

  for (const entry of plan.create) {
    const { propositionId, event } = assertProposition(
      options.factory,
      options.newId,
      {
        statement: entry.statement,
        ...(entry.name ? { name: entry.name } : {}),
        ...(plan.domain ? { domain: plan.domain } : {}),
        aliases: entry.aliases,
        provenance: entry.quote ? [provenanceFor(options.source, entry.quote)] : [provenance],
      },
      { at, actor },
    );
    idsByRef.set(entry.ref, propositionId);
    events.push(event);
  }
  for (const entry of plan.reuse) idsByRef.set(entry.ref, entry.existingId);

  // A capture is an interest signal first: record the domain even when every
  // proposition turned out to duplicate something we already had.
  if (plan.domain) {
    const { event } = assertInterest(
      options.factory,
      { domain: plan.domain, ...(options.source.sourceUri ? { sourceUri: options.source.sourceUri } : {}) },
      { at, actor },
    );
    events.push(event);
  }

  for (const cue of plan.cues) {
    const propositionId = idsByRef.get(cue.ref);
    if (!propositionId) continue;
    const { event } = assertCue(
      options.factory,
      options.newId,
      { propositionId, front: cue.front, back: cue.back, kind: cue.kind },
      { at, actor },
    );
    events.push(event);
  }

  for (const chain of plan.chains) {
    const premiseIds = chain.premiseRefs.map((ref) => idsByRef.get(ref));
    const conclusionId = idsByRef.get(chain.conclusionRef);
    if (!conclusionId || premiseIds.some((id) => !id)) continue;
    const { event } = assertChain(
      options.factory,
      options.newId,
      {
        premiseIds: premiseIds as Id[],
        conclusionId,
        strength: chain.strength,
        provenance: [provenance],
      },
      { at, actor },
    );
    events.push(event);
  }

  return { events, idsByRef };
}


/**
 * Generates a small prerequisite-ordered curriculum for a declared interest.
 * The result goes through the same validation and merge as a capture, so the
 * graph rules (joint premises, deterministic merge) stay identical.
 */
export async function generateCurriculum(
  input: {
    domain: string;
    level: 'beginner' | 'intermediate' | 'advanced';
    count?: number;
    existingStatements?: string[];
  },
  options: { llm: LlmPort; maxTokens?: number },
): Promise<ExtractResult> {
  const raw = await options.llm.complete({
    messages: buildCurriculumMessages({
      domain: input.domain,
      level: input.level,
      count: input.count ?? 6,
      ...(input.existingStatements ? { existingStatements: input.existingStatements } : {}),
    }),
    temperature: 0.3,
    maxTokens: options.maxTokens ?? 2500,
  });
  let parsed: unknown;
  try {
    parsed = extractJsonObject(raw);
  } catch (err) {
    throw new ExtractionError(`课程生成输出不是合法 JSON：${(err as Error).message}`);
  }
  const { candidate, issues } = validateCandidateJson(parsed);
  if (!candidate) throw new ExtractionError('课程生成结果未通过校验', issues);
  // The declared domain wins: it is the interest key, not a model suggestion.
  candidate.domain = input.domain;
  return { candidate, promptVersion: CURRICULUM_PROMPT_VERSION, raw };
}
