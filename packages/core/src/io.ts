import type { CueKind, Id, ISODate, LatticeEvent } from './types.js';
import { dedupeAndSort } from './replay.js';
import { assertCue, assertProposition, validateEvent, type EventFactory } from './events.js';

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
  statement: string;
  name?: string;
  aliases?: string[];
  domain?: string;
  cues: PropositionPackCue[];
}

export interface PropositionPack {
  format: 1;
  propositions: PropositionPackEntry[];
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
    if (typeof e['name'] === 'string') entryOut.name = e['name'];
    if (Array.isArray(e['aliases'])) entryOut.aliases = e['aliases'].filter((x): x is string => typeof x === 'string');
    if (typeof e['domain'] === 'string') entryOut.domain = e['domain'];
    propositions.push(entryOut);
  });

  if (errors.length > 0) return { errors };
  return { pack: { format: 1, propositions }, errors: [] };
}

export function packToEvents(
  pack: PropositionPack,
  factory: EventFactory,
  newId: () => Id,
  opts: { at?: ISODate } = {},
): { events: LatticeEvent[]; propositionIds: Id[] } {
  const events: LatticeEvent[] = [];
  const propositionIds: Id[] = [];
  for (const entry of pack.propositions) {
    const { propositionId, event } = assertProposition(factory, newId, entry, opts);
    events.push(event);
    propositionIds.push(propositionId);
    for (const cue of entry.cues) {
      const { event: cueEvent } = assertCue(
        factory,
        newId,
        { propositionId, front: cue.front, back: cue.back, ...(cue.kind ? { kind: cue.kind } : {}) },
        opts,
      );
      events.push(cueEvent);
    }
  }
  return { events, propositionIds };
}
