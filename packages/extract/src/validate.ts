import type { CognitiveLevel, Difficulty } from '@lattice/core';
import type { ExtractionCandidate, ExtractedChain, ExtractedProposition } from './types.js';

const COGNITIVE = new Set<string>(['remember', 'understand', 'apply', 'analyze', 'evaluate']);

/** Parses the model's difficulty object; returns issues instead of throwing. */
export function readDifficulty(
  raw: unknown,
  path: string,
  issues: { severity: 'error' | 'warning'; path: string; message: string }[],
): Difficulty | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null) {
    issues.push({ severity: 'warning', path, message: 'difficulty 不是对象，已忽略' });
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const tierRaw = value['tier'];
  const tier = typeof tierRaw === 'number' ? Math.round(tierRaw) : NaN;
  if (!(tier >= 1 && tier <= 5)) {
    issues.push({ severity: 'warning', path: `${path}.tier`, message: 'tier 必须是 1–5，已按 3 处理' });
  }
  const cognitiveRaw = value['cognitive'];
  const cognitive: CognitiveLevel =
    typeof cognitiveRaw === 'string' && COGNITIVE.has(cognitiveRaw) ? (cognitiveRaw as CognitiveLevel) : 'understand';
  if (typeof cognitiveRaw === 'string' && !COGNITIVE.has(cognitiveRaw)) {
    issues.push({ severity: 'warning', path: `${path}.cognitive`, message: `未知认知层级 ${cognitiveRaw}，已按 understand 处理` });
  }
  const minutesRaw = value['minutes'];
  const difficulty: Difficulty = { tier: (tier >= 1 && tier <= 5 ? tier : 3) as Difficulty['tier'], cognitive };
  if (typeof minutesRaw === 'number' && minutesRaw > 0 && minutesRaw <= 600) {
    difficulty.minutes = Math.round(minutesRaw);
  }
  return difficulty;
}

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: IssueSeverity;
  path: string;
  message: string;
}

export interface CandidateValidation {
  candidate?: ExtractionCandidate;
  issues: ValidationIssue[];
}

export const LIMITS = {
  minPropositions: 1,
  maxPropositions: 40,
  minStatementChars: 4,
  maxStatementChars: 400,
  maxQuoteChars: 300,
} as const;

/** Models like to wrap JSON in ```json fences or prose. Recover the object. */
export function extractJsonObject(raw: string): unknown {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('模型输出里没有 JSON 对象');
  return JSON.parse(body.slice(start, end + 1));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}

/**
 * Validates the model's extraction output. Warnings may be repaired; any error
 * means the candidate must not be shown to the user as if it were fine.
 */
export function validateCandidateJson(raw: unknown): CandidateValidation {
  const issues: ValidationIssue[] = [];
  const error = (path: string, message: string) => issues.push({ severity: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ severity: 'warning', path, message });

  if (!isRecord(raw)) return { issues: [{ severity: 'error', path: '$', message: '顶层不是对象' }] };

  const rawProps = raw['propositions'];
  if (!Array.isArray(rawProps)) return { issues: [{ severity: 'error', path: 'propositions', message: '缺少 propositions 数组' }] };
  if (rawProps.length > LIMITS.maxPropositions) {
    error('propositions', `命题过多（${rawProps.length} > ${LIMITS.maxPropositions}）`);
  }

  const propositions: ExtractedProposition[] = [];
  const seenRefs = new Set<string>();
  const seenStatements = new Set<string>();

  rawProps.forEach((item, i) => {
    const at = `propositions[${i}]`;
    if (!isRecord(item)) return error(at, '不是对象');
    const ref = str(item['ref']);
    const statement = str(item['statement']);
    if (!ref) return error(`${at}.ref`, '缺少 ref');
    if (!statement) return error(`${at}.statement`, '缺少 statement');
    if (seenRefs.has(ref!)) return error(`${at}.ref`, `ref 重复：${ref}`);
    seenRefs.add(ref!);
    if (statement!.length < LIMITS.minStatementChars) return error(`${at}.statement`, '陈述过短');
    if (statement!.length > LIMITS.maxStatementChars) {
      warn(`${at}.statement`, '陈述过长，建议拆分');
    }
    const normalizedStatement = statement!.replace(/\s+/g, '').toLowerCase();
    if (seenStatements.has(normalizedStatement)) {
      warn(at, '与前面的命题重复，已忽略');
      return;
    }
    seenStatements.add(normalizedStatement);

    const prop: ExtractedProposition = { ref: ref!, statement: statement! };
    const name = str(item['name']);
    if (name) prop.name = name;
    const aliases = strArray(item['aliases']);
    if (aliases.length > 0) prop.aliases = aliases;
    const quote = str(item['quote']);
    if (quote) {
      if (quote.length > LIMITS.maxQuoteChars) warn(`${at}.quote`, '引文过长，已截断');
      prop.quote = quote.slice(0, LIMITS.maxQuoteChars);
    } else {
      warn(`${at}.quote`, '缺少原文引文，无法核对出处');
    }
    const difficulty = readDifficulty(item['difficulty'], `${at}.difficulty`, issues);
    if (difficulty) prop.difficulty = difficulty;
    propositions.push(prop);
  });

  if (propositions.length < LIMITS.minPropositions) {
    error('propositions', '没有可用的命题');
  }

  const chains: ExtractedChain[] = [];
  const rawChains = raw['chains'];
  if (rawChains !== undefined && !Array.isArray(rawChains)) {
    error('chains', 'chains 必须是数组');
  } else if (Array.isArray(rawChains)) {
    const knownRefs = new Set(propositions.map((p) => p.ref));
    const seen = new Set<string>();
    rawChains.forEach((item, i) => {
      const at = `chains[${i}]`;
      if (!isRecord(item)) return warn(at, '不是对象，已忽略');
      const premises = strArray(item['premises']);
      const conclusion = str(item['conclusion']);
      if (!conclusion) return warn(at, '缺少 conclusion，已忽略');
      if (premises.length === 0) return warn(at, '缺少 premises，已忽略');
      const unknown = [...premises, conclusion].filter((r) => !knownRefs.has(r));
      if (unknown.length > 0) return warn(at, `引用了不存在的命题：${unknown.join(', ')}，已忽略`);
      if (premises.includes(conclusion)) return warn(at, '结论不能同时是前提，已忽略');
      const dedupeKey = [...premises].sort().join(',') + '=>' + conclusion;
      if (seen.has(dedupeKey)) return warn(at, '重复的推理链，已忽略');
      seen.add(dedupeKey);
      const strengthRaw = item['strength'];
      let strength = 0.8;
      if (typeof strengthRaw === 'number' && strengthRaw >= 0 && strengthRaw <= 1) strength = strengthRaw;
      else if (strengthRaw !== undefined) warn(`${at}.strength`, '置信度不在 0–1，已按 0.8 处理');
      chains.push({ premises, conclusion, strength });
    });
  }

  const hasError = issues.some((x) => x.severity === 'error');
  if (hasError) return { issues };
  const domainRaw = raw['domain'];
  const candidate: ExtractionCandidate = { propositions, chains };
  if (typeof domainRaw === 'string' && domainRaw.trim().length > 0) {
    candidate.domain = domainRaw.trim().slice(0, 40);
  } else if (domainRaw !== undefined) {
    warn('domain', '领域名不是字符串，已忽略');
  }
  return { candidate, issues };
}
