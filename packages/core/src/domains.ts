import type { DomainAlias, DomainLevel, ISODate, Interest } from './types.js';

/**
 * Domain identity.
 *
 * Users and models name the same field in different ways: `CS`, `Computer
 * Science`, `计算机`. Interest matching and curriculum counts must agree on one
 * canonical name or the feed "forgets" that you asked for a domain. Resolution is
 * deterministic: built-in aliases plus explicit `domain.alias` events, applied at
 * replay time so old logs are canonicalized too.
 */

export interface DomainAliasRule {
  canonical: string;
  aliases: string[];
}

/**
 * Deliberately conservative: only names that are unambiguously the same field.
 * Subfields (机器学习 vs 人工智能) are NOT merged — that changes meaning.
 */
export const BUILTIN_DOMAIN_ALIASES: readonly DomainAliasRule[] = [
  { canonical: '计算机', aliases: ['计算机科学', 'cs', 'computer science', 'computing', 'computer'] },
  { canonical: '人工智能', aliases: ['ai', 'artificial intelligence', 'machine intelligence'] },
  { canonical: '数学', aliases: ['math', 'maths', 'mathematics'] },
  { canonical: '经济学', aliases: ['economics', 'econ'] },
  { canonical: '心理学', aliases: ['psychology'] },
  { canonical: '物理', aliases: ['physics'] },
  { canonical: '生物', aliases: ['biology'] },
  { canonical: '统计学', aliases: ['statistics', 'stats'] },
  { canonical: '产品设计', aliases: ['product design'] },
];

/** Case/punctuation/width-insensitive key. `"Computer-Science"` -> `computerscience`. */
export function normalizeDomainKey(name: string): string {
  return String(name ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-–—·・/\\]+/g, '');
}

export type DomainResolver = (name: string) => string;

/**
 * Builds the resolver. Explicit alias events win over built-ins, and every
 * canonical name resolves to itself.
 */
export function createDomainResolver(aliases: readonly DomainAlias[] = []): DomainResolver {
  const map = new Map<string, string>();
  for (const rule of BUILTIN_DOMAIN_ALIASES) {
    map.set(normalizeDomainKey(rule.canonical), rule.canonical);
    for (const alias of rule.aliases) map.set(normalizeDomainKey(alias), rule.canonical);
  }
  for (const alias of aliases) {
    if (!alias.alias || !alias.canonical) continue;
    map.set(normalizeDomainKey(alias.alias), alias.canonical.trim());
  }
  return (name: string): string => {
    const raw = String(name ?? '').trim();
    if (raw.length === 0) return raw;
    return map.get(normalizeDomainKey(raw)) ?? raw;
  };
}

export function canonicalDomainId(canonicalName: string): string {
  // Kept out of ids.ts to avoid a cycle; must match the shape used by replay.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const input = canonicalName.trim().toLowerCase();
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * prime) & mask;
  }
  return 'dom_' + hash.toString(16).padStart(16, '0').slice(0, 12);
}

/**
 * Interest weight as of `at`. Captures are evidence that decays: a domain you
 * captured three months ago should not outrank one you declared yesterday.
 * Declared interests decay four times slower because the user said them out loud.
 */
export function interestWeightAt(
  interest: Pick<Interest, 'weight' | 'declared' | 'lastSeenAt'>,
  at: ISODate,
  options: { halfLifeDays?: number; declaredHalfLifeDays?: number } = {},
): number {
  const halfLife = interest.declared ? (options.declaredHalfLifeDays ?? 240) : (options.halfLifeDays ?? 60);
  if (!(halfLife > 0)) return interest.weight;
  const seen = Date.parse(interest.lastSeenAt);
  const now = Date.parse(at);
  if (!Number.isFinite(seen) || !Number.isFinite(now)) return interest.weight;
  const ageDays = Math.max(0, (now - seen) / 86_400_000);
  return interest.weight * Math.pow(0.5, ageDays / halfLife);
}

function laterOf(a: ISODate, b: ISODate): ISODate {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function pickLevel(a: DomainLevel, b: DomainLevel): DomainLevel {
  const rank: Record<DomainLevel, number> = { beginner: 0, intermediate: 1, advanced: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Merges interest records that resolve to the same canonical domain.
 * Run after folding the log so aliases declared later still merge earlier data.
 */
export function canonicalizeInterests(
  interests: Record<string, Interest>,
  resolver: DomainResolver,
): Record<string, Interest> {
  const merged: Record<string, Interest> = {};
  for (const interest of Object.values(interests)) {
    const canonical = resolver(interest.name);
    const id = canonicalDomainId(canonical);
    const previous = merged[id];
    if (!previous) {
      merged[id] = { ...interest, id, name: canonical };
      continue;
    }
    const topics = { ...previous.topics };
    for (const [topic, count] of Object.entries(interest.topics)) {
      topics[topic] = (topics[topic] ?? 0) + count;
    }
    const declared = previous.declared || interest.declared;
    merged[id] = {
      id,
      name: canonical,
      weight: previous.weight + interest.weight,
      captureCount: previous.captureCount + interest.captureCount,
      lastSeenAt: laterOf(previous.lastSeenAt, interest.lastSeenAt),
      topics,
      declared,
      level: declared ? pickLevel(previous.level, interest.level) : previous.level,
    };
  }
  return merged;
}
