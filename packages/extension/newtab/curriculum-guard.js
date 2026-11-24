/**
 * Page-side guard for autonomous curriculum generation (M2c).
 *
 * The newtab decides *when* to ask the worker to prepare content for a declared
 * interest. That decision has one product rule that must not be re-litigated by
 * the UI: at most one generation per domain per calendar day. Keeping the rule
 * here (plain JS, no DOM, no chrome.* at import time) is what makes it testable
 * in Node — `test/curriculum-smoke.mjs` imports this module with a fake
 * chrome.storage.local area.
 *
 * The persisted value lives in chrome.storage.local under
 * `latticeCurriculumState` as `{ '<domain>': 'YYYY-MM-DD' }`. It is a cache of a
 * UI decision, not learner state: losing it only means the page may generate one
 * extra batch. Interests themselves stay events in the event log.
 */

export const CURRICULUM_STATE_KEY = 'latticeCurriculumState';

export const LEVELS = ['beginner', 'intermediate', 'advanced'];

export const LEVEL_LABELS = {
  beginner: '入门',
  intermediate: '进阶',
  advanced: '高级',
};

/** '入门' / '进阶' / '高级'; anything unknown falls back to 入门. */
export function levelLabel(level) {
  return LEVEL_LABELS[level] ?? LEVEL_LABELS.beginner;
}

/** Normalizes a level coming from a `<select>` or the page state. */
export function normalizeLevel(value) {
  return LEVELS.includes(value) ? value : 'beginner';
}

/** The user's local calendar day as YYYY-MM-DD (not UTC: "today" is local). */
export function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The need to work on: fewest existing propositions first, then domain name.
 * `curriculumNeeds()` already sorts this way; the picker is explicit so the
 * policy is visible in one place.
 */
export function pickNeed(needs) {
  const list = Array.isArray(needs) ? needs.filter((need) => need && typeof need.domain === 'string' && need.domain) : [];
  if (list.length === 0) return null;
  let best = list[0];
  for (const need of list.slice(1)) {
    const bestExisting = Number(best.existing) || 0;
    const needExisting = Number(need.existing) || 0;
    if (needExisting < bestExisting || (needExisting === bestExisting && need.domain < best.domain)) best = need;
  }
  return best;
}

/** True when this domain has not been generated today. */
export function shouldGenerateForDay(curriculumState, domain, day) {
  const map = curriculumState && typeof curriculumState === 'object' ? curriculumState : {};
  const key = String(domain ?? '').trim();
  if (!key) return false;
  return map[key] !== day;
}

/** Returns a copy with `domain` marked as generated on `day`. */
export function markGeneratedForDay(curriculumState, domain, day) {
  const map = curriculumState && typeof curriculumState === 'object' ? { ...curriculumState } : {};
  const key = String(domain ?? '').trim();
  if (key) map[key] = day;
  return map;
}

/** Reads the persisted guard map; a broken storage read means "nothing ran today". */
export async function loadCurriculumState(storage) {
  if (!storage || typeof storage.get !== 'function') return {};
  try {
    const got = (await storage.get(CURRICULUM_STATE_KEY)) ?? {};
    const value = got[CURRICULUM_STATE_KEY];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const clean = {};
    for (const [domain, day] of Object.entries(value)) {
      if (typeof domain === 'string' && domain.trim() && typeof day === 'string' && day) clean[domain] = day;
    }
    return clean;
  } catch {
    return {};
  }
}

/** Persists the guard map. Failure is non-fatal: worst case is one extra batch. */
export async function saveCurriculumState(storage, curriculumState) {
  if (!storage || typeof storage.set !== 'function') return false;
  try {
    await storage.set({ [CURRICULUM_STATE_KEY]: curriculumState ?? {} });
    return true;
  } catch {
    return false;
  }
}

/**
 * The single decision function the newtab uses, extracted so tests can cover all
 * branches without a browser:
 *
 *   - no declared need            -> { action: 'none' }
 *   - a generation is in flight   -> { action: 'none' }   (never two at once)
 *   - no usable model provider    -> { action: 'hint' }   (configure-model hint)
 *   - already tried this session  -> { action: 'none' }   (never loop)
 *   - already generated today     -> { action: 'none' }   (once per domain/day)
 *   - otherwise                   -> { action: 'generate', need }
 */
export function planNextGeneration(input = {}) {
  const needs = Array.isArray(input.needs) ? input.needs : [];
  const need = pickNeed(needs);
  if (!need) return { action: 'none', reason: 'no-needs' };
  if (input.busy) return { action: 'none', reason: 'busy', need };
  if (!input.providerReady) return { action: 'hint', reason: 'no-provider', need };
  const attempted = input.attempted instanceof Set ? input.attempted : new Set(Array.isArray(input.attempted) ? input.attempted : []);
  if (attempted.has(need.domain)) return { action: 'none', reason: 'attempted', need };
  const day = typeof input.day === 'string' && input.day ? input.day : localDayKey();
  if (!shouldGenerateForDay(input.curriculumState, need.domain, day)) {
    return { action: 'none', reason: 'daily-limit', need };
  }
  return { action: 'generate', reason: 'need', need };
}
