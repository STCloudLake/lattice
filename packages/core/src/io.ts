import type { CognitiveLevel, CueKind, Difficulty, Id, ISODate, LatticeEvent } from './types.js';
import { dedupeAndSort } from './replay.js';
import { assertChain, assertCue, assertProposition, validateEvent, type EventFactory } from './events.js';

/** Stable, diff-friendly export: deduped, ordered, one JSON object per line. */
export function exportJsonl(events: readonly LatticeEvent[]): string {
  const body = dedupeAndSort(events)
    .map((e) => JSON.stringify(e))
    .join('\n');
  return body.length > 0 ? body + '\n' : '';
}

export interface JsonlParseResult {
  events: LatticeEvent[];
  errors: string[];
}

export function parseJsonl(text: string): JsonlParseResult {
  const events: LatticeEvent[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      errors.push(`line ${i + 1}: invalid JSON (${(err as Error).message})`);
      continue;
    }
    const problems = validateEvent(parsed);
    if (problems.length > 0) {
      errors.push(`line ${i + 1}: ${problems.join('; ')}`);
      continue;
    }
    events.push(parsed as LatticeEvent);
  }
  return { events, errors };
}

// ---------------------------------------------------------------------------
// M0 import format: a small, hand-writable proposition pack.
// ---------------------------------------------------------------------------

export interface PropositionPackCue {
  front: string;
  back: string;
  kind?: CueKind;
}

export interface PropositionPackEntry {
  /** Optional stable reference used by `chains`. Defaults to its index. */
  ref?: string;
  statement: string;
  name?: string;
  aliases?: string[];
  domain?: string;
  difficulty?: Difficulty;
  cues: PropositionPackCue[];
}

const COGNITIVE_LEVELS: ReadonlySet<string> = new Set<CognitiveLevel>([
  'remember',
  'understand',
  'apply',
  'analyze',
  'evaluate',
]);

function readPackDifficulty(value: unknown): Difficulty | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const tier = typeof raw['tier'] === 'number' ? Math.round(raw['tier']) : NaN;
  if (!(tier >= 1 && tier <= 5)) return undefined;
  const cognitiveRaw = typeof raw['cognitive'] === 'string' ? raw['cognitive'] : '';
  const cognitive = COGNITIVE_LEVELS.has(cognitiveRaw) ? (cognitiveRaw as CognitiveLevel) : 'understand';
  const difficulty: Difficulty = { tier: tier as Difficulty['tier'], cognitive };
  const minutes = raw['minutes'];
  if (typeof minutes === 'number' && minutes > 0 && minutes <= 600) difficulty.minutes = Math.round(minutes);
  return difficulty;
}

export interface PropositionPackChain {
  premises: string[];
  conclusion: string;
  strength?: number;
}

export interface PropositionPack {
  format: 1;
  propositions: PropositionPackEntry[];
  /** Optional prerequisite structure; refs point at entry `ref` (or index). */
  chains?: PropositionPackChain[];
}

export function parsePropositionPack(text: string): { pack?: PropositionPack; errors: string[] } {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { errors: [`不是合法 JSON：${(err as Error).message}`] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { errors: ['顶层必须是一个对象'] };
  }
  const obj = raw as Record<string, unknown>;
  if (obj['format'] !== 1) errors.push('format 必须是 1');
  const list = obj['propositions'];
  if (!Array.isArray(list)) return { errors: [...errors, 'propositions 必须是数组'] };

  const propositions: PropositionPackEntry[] = [];
  list.forEach((entry, i) => {
    const at = `propositions[${i}]`;
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`${at}: 不是对象`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const statement = typeof e['statement'] === 'string' ? e['statement'].trim() : '';
    if (!statement) errors.push(`${at}.statement 不能为空`);

    const cuesRaw = Array.isArray(e['cues']) ? e['cues'] : [];
    const cues: PropositionPackCue[] = [];
    cuesRaw.forEach((cue, j) => {
      const cat = `${at}.cues[${j}]`;
      if (typeof cue !== 'object' || cue === null) {
        errors.push(`${cat}: 不是对象`);
        return;
      }
      const c = cue as Record<string, unknown>;
      const front = typeof c['front'] === 'string' ? c['front'].trim() : '';
      const back = typeof c['back'] === 'string' ? c['back'].trim() : '';
      if (!front) errors.push(`${cat}.front 不能为空`);
      if (!back) errors.push(`${cat}.back 不能为空`);
      const item: PropositionPackCue = { front, back };
      if (typeof c['kind'] === 'string') item.kind = c['kind'] as CueKind;
      cues.push(item);
    });

    const entryOut: PropositionPackEntry = { statement, cues };
    if (typeof e['ref'] === 'string' && e['ref'].trim().length > 0) entryOut.ref = e['ref'].trim();
    if (typeof e['name'] === 'string') entryOut.name = e['name'];
    if (Array.isArray(e['aliases'])) entryOut.aliases = e['aliases'].filter((x): x is string => typeof x === 'string');
    if (typeof e['domain'] === 'string') entryOut.domain = e['domain'];
    const difficulty = readPackDifficulty(e['difficulty']);
    if (difficulty) entryOut.difficulty = difficulty;
    propositions.push(entryOut);
  });

  const knownRefs = new Set(propositions.map((entry, index) => entry.ref ?? `#${index + 1}`));
  const rawChains = obj['chains'];
  const chains: PropositionPackChain[] = [];
  if (rawChains !== undefined) {
    if (!Array.isArray(rawChains)) {
      errors.push('chains 必须是数组');
    } else {
      rawChains.forEach((item, i) => {
        const at = `chains[${i}]`;
        if (typeof item !== 'object' || item === null) {
          errors.push(`${at}: 不是对象`);
          return;
        }
        const c = item as Record<string, unknown>;
        const premises = Array.isArray(c['premises'])
          ? c['premises'].filter((x): x is string => typeof x === 'string')
          : [];
        const conclusion = typeof c['conclusion'] === 'string' ? c['conclusion'] : '';
        if (premises.length === 0) errors.push(`${at}.premises 不能为空`);
        if (!conclusion) errors.push(`${at}.conclusion 不能为空`);
        for (const ref of [...premises, conclusion]) {
          if (ref && !knownRefs.has(ref)) errors.push(`${at}: 引用了未知命题 ref "${ref}"`);
        }
        const chain: PropositionPackChain = { premises, conclusion };
        if (typeof c['strength'] === 'number') chain.strength = c['strength'];
        chains.push(chain);
      });
    }
  }

  if (errors.length > 0) return { errors };
  const pack: PropositionPack = { format: 1, propositions };
  if (chains.length > 0) pack.chains = chains;
  return { pack, errors: [] };
}

export function packToEvents(
  pack: PropositionPack,
  factory: EventFactory,
  newId: () => Id,
  opts: { at?: ISODate } = {},
): { events: LatticeEvent[]; propositionIds: Id[] } {
  const events: LatticeEvent[] = [];
  const propositionIds: Id[] = [];
  const idsByRef = new Map<string, Id>();
  pack.propositions.forEach((entry, index) => {
    const { propositionId, event } = assertProposition(factory, newId, entry, opts);
    events.push(event);
    propositionIds.push(propositionId);
    idsByRef.set(entry.ref ?? `#${index + 1}`, propositionId);
    for (const cue of entry.cues) {
      const { event: cueEvent } = assertCue(
        factory,
        newId,
        { propositionId, front: cue.front, back: cue.back, ...(cue.kind ? { kind: cue.kind } : {}) },
        opts,
      );
      events.push(cueEvent);
    }
  });
  for (const chain of pack.chains ?? []) {
    const premiseIds = chain.premises.map((ref) => idsByRef.get(ref));
    const conclusionId = idsByRef.get(chain.conclusion);
    if (!conclusionId || premiseIds.some((id) => !id)) continue;
    const { event } = assertChain(
      factory,
      newId,
      {
        premiseIds: premiseIds as Id[],
        conclusionId,
        ...(chain.strength !== undefined ? { strength: chain.strength } : {}),
      },
      opts,
    );
    events.push(event);
  }
  return { events, propositionIds };
}
