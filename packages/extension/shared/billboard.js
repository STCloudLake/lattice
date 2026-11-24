/*
 * Lattice shared push-layer helpers (M2b).
 *
 * Loaded three ways so the sidebar, the background worker and the newtab page
 * agree on keys/policy without bundling:
 *   - manifest content_scripts (classic script, before content/sidebar.js)
 *   - background.js via importScripts('shared/billboard.js')
 *   - newtab.js via `import '../shared/billboard.js'` (side-effect module)
 *
 * Deliberately DOM-free and chrome-free: every function takes a
 * chrome.storage.local-like area ({get, set}). That keeps the whole
 * billboard / interruption-budget / exposure-queue contract unit-testable.
 *
 * Architecture note: the SQLite event log lives in the newtab's dedicated
 * Worker. Sidebar and notifications therefore never open the DB:
 *   - they read the cached `latticeBillboard` snapshot the newtab writes;
 *   - they append plain exposure records to `latticePendingExposures`;
 *   - the newtab drains that queue into the event log on boot.
 */
(function (root) {
  'use strict';

  const KEYS = {
    billboard: 'latticeBillboard',
    interruptSettings: 'latticeInterruptSettings',
    interruptState: 'latticeInterruptState',
    exposureQueue: 'latticePendingExposures',
    shownGuard: 'latticeExposureGuard',
    notifyDay: 'latticeNotifyDay',
  };

  /** Defaults per docs/m2-feed.md §9.3: conservative (fewer interruptions). */
  const DEFAULT_INTERRUPT_SETTINGS = {
    dailyLimit: 1,
    quietStart: '23:00',
    quietEnd: '08:00',
    sidebar: true,
    notifications: false,
    sites: { bilibili: true, youtube: true },
  };

  const COGNITIVE_LABELS = {
    remember: '记忆',
    understand: '理解',
    apply: '应用',
    analyze: '分析',
    evaluate: '评价',
  };
  const REASONS = new Set(['due', 'frontier', 'foundation']);
  /** The sidebar shows at most 2 cards (one billboard, not a page). */
  const MAX_SIDEBAR_ITEMS = 2;
  const MAX_QUEUE = 200;

  // -------------------------------------------------------------------------
  // Small pure helpers
  // -------------------------------------------------------------------------

  /** Date | ISO string | epoch ms -> Date. Anything unusable -> now. */
  function toDate(value) {
    if (value && typeof value.getTime === 'function') return value;
    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date;
    }
    return new Date();
  }

  /** UTC calendar day, matching how the event log stamps `day` (core dayOf). */
  function dayOf(value) {
    return toDate(value).toISOString().slice(0, 10);
  }

  function isDayString(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  /** "23:00" -> 1380, or null when the value is not a valid clock time. */
  function minutesOf(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  function normalizeClock(value, fallback) {
    const minutes = minutesOf(value);
    if (minutes === null) return fallback;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }

  /**
   * Quiet hours are wall-clock local time. start === end means "no quiet window"
   * (also what the E2E sets so the test is not time-of-day dependent).
   */
  function withinQuietHours(settings, at) {
    const start = minutesOf(settings && settings.quietStart);
    const end = minutesOf(settings && settings.quietEnd);
    if (start === null || end === null || start === end) return false;
    const date = toDate(at);
    const nowMinutes = date.getHours() * 60 + date.getMinutes();
    if (start < end) return nowMinutes >= start && nowMinutes < end;
    return nowMinutes >= start || nowMinutes < end;
  }

  function normalizeInterruptSettings(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const rawLimit = Math.round(Number(raw.dailyLimit));
    const dailyLimit = Number.isFinite(rawLimit)
      ? Math.min(3, Math.max(0, rawLimit))
      : DEFAULT_INTERRUPT_SETTINGS.dailyLimit;
    const rawSites = raw.sites && typeof raw.sites === 'object' ? raw.sites : {};
    return {
      dailyLimit,
      quietStart: normalizeClock(raw.quietStart, DEFAULT_INTERRUPT_SETTINGS.quietStart),
      quietEnd: normalizeClock(raw.quietEnd, DEFAULT_INTERRUPT_SETTINGS.quietEnd),
      // Sidebar defaults ON; notifications default OFF.
      sidebar: raw.sidebar !== false,
      notifications: raw.notifications === true,
      sites: {
        bilibili: rawSites.bilibili !== false,
        youtube: rawSites.youtube !== false,
      },
    };
  }

  /** A state from another day starts at 0; a corrupt state is treated as fresh. */
  function normalizeInterruptState(value, today) {
    const state = value && typeof value === 'object' ? value : {};
    const day = isDayString(today) ? today : dayOf(new Date());
    if (state.day !== day) return { day, used: 0 };
    const used = Math.floor(Number(state.used));
    return { day, used: Number.isFinite(used) && used > 0 ? used : 0 };
  }

  // -------------------------------------------------------------------------
  // chrome.storage.local helpers (promise API)
  // -------------------------------------------------------------------------

  async function readKey(area, key, fallback) {
    if (!area || typeof area.get !== 'function') return fallback;
    try {
      const got = await area.get(key);
      if (!got || typeof got !== 'object') return fallback;
      const value = got[key];
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  async function writeKey(area, key, value) {
    if (!area || typeof area.set !== 'function') return false;
    try {
      await area.set({ [key]: value });
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Billboard snapshot (written by newtab, read by everybody else)
  // -------------------------------------------------------------------------

  function masteryMean(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.min(1, Math.max(0, value));
    if (value && typeof value === 'object') {
      const mean = Number(value.mean);
      if (Number.isFinite(mean)) return Math.min(1, Math.max(0, mean));
    }
    return 0;
  }

  function normalizeTier(value) {
    const tier = Math.round(Number(value));
    return Number.isFinite(tier) && tier >= 1 && tier <= 5 ? tier : undefined;
  }

  function normalizeCognitive(value) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(COGNITIVE_LABELS, value)
      ? value
      : undefined;
  }

  /** One snapshot item. Tolerates old snapshots that lack tier/cognitive/domain. */
  function normalizeSnapshotItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const propositionId = typeof raw.propositionId === 'string' ? raw.propositionId.trim() : '';
    if (!propositionId) return null;
    const item = {
      propositionId,
      statement: typeof raw.statement === 'string' ? raw.statement : '',
      mastery: masteryMean(raw.mastery),
      retrievability: Math.min(1, Math.max(0, Number(raw.retrievability) || 0)),
    };
    if (typeof raw.cueId === 'string' && raw.cueId) item.cueId = raw.cueId;
    if (typeof raw.domain === 'string' && raw.domain) item.domain = raw.domain;
    item.reason = REASONS.has(raw.reason) ? raw.reason : 'frontier';
    const tier = normalizeTier(raw.tier);
    if (tier !== undefined) item.tier = tier;
    const cognitive = normalizeCognitive(raw.cognitive);
    if (cognitive) item.cognitive = cognitive;
    const score = Number(raw.score);
    if (Number.isFinite(score)) item.score = score;
    return item;
  }

  function snapshotItems(board, at) {
    if (!board || typeof board !== 'object') return [];
    if (board.day !== dayOf(at)) return [];
    if (!Array.isArray(board.items)) return [];
    return board.items.map(normalizeSnapshotItem).filter(Boolean);
  }

  function boardIsToday(board, at) {
    return Boolean(board && typeof board === 'object' && board.day === dayOf(at));
  }

  // -------------------------------------------------------------------------
  // Per-day "shown" guard: the local frequency cap that works before the queue
  // has been drained into the event log.
  // -------------------------------------------------------------------------

  function normalizeShownGuard(value, today) {
    const day = isDayString(today) ? today : dayOf(new Date());
    const guard = value && typeof value === 'object' ? value : {};
    if (guard.day !== day) return { day, ids: [] };
    const ids = Array.isArray(guard.ids) ? guard.ids.filter((id) => typeof id === 'string' && id) : [];
    return { day, ids: [...new Set(ids)] };
  }

  async function readShownGuard(area, at) {
    const today = dayOf(at);
    return normalizeShownGuard(await readKey(area, KEYS.shownGuard, null), today);
  }

  function shownIds(guard, at) {
    return new Set(normalizeShownGuard(guard, dayOf(at)).ids);
  }

  /** Marks ids as shown today; returns the ids that were not marked before. */
  async function markShown(area, at, propositionIds) {
    const today = dayOf(at);
    const guard = await readShownGuard(area, at);
    const seen = new Set(guard.ids);
    const added = [];
    for (const id of Array.isArray(propositionIds) ? propositionIds : []) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      added.push(id);
    }
    if (added.length > 0) await writeKey(area, KEYS.shownGuard, { day: today, ids: [...seen] });
    return added;
  }

  // -------------------------------------------------------------------------
  // Interruption budget: sidebar + notifications share one per-day allowance.
  // -------------------------------------------------------------------------

  function budgetStatus(settings, state, at) {
    const limit = Math.max(0, Number(settings && settings.dailyLimit) || 0);
    const used = Math.max(0, Number(state && state.used) || 0);
    const remaining = Math.max(0, limit - used);
    if (limit <= 0) return { allowed: false, reason: 'disabled', used, limit, remaining: 0 };
    if (withinQuietHours(settings, at)) {
      return { allowed: false, reason: 'quiet-hours', used, limit, remaining };
    }
    if (remaining <= 0) return { allowed: false, reason: 'exhausted', used, limit, remaining: 0 };
    return { allowed: true, reason: 'ok', used, limit, remaining };
  }

  async function readInterruptContext(area, at) {
    const today = dayOf(at);
    const settings = normalizeInterruptSettings(await readKey(area, KEYS.interruptSettings, null));
    const state = normalizeInterruptState(await readKey(area, KEYS.interruptState, null), today);
    return { today, settings, state, budget: budgetStatus(settings, state, at) };
  }

  /** Atomically-ish claims one interruption credit; false/none when not allowed. */
  async function claimInterrupt(area, at) {
    const context = await readInterruptContext(area, at);
    if (!context.budget.allowed) {
      return { ok: false, reason: context.budget.reason, used: context.state.used, limit: context.settings.dailyLimit };
    }
    const next = { day: context.today, used: context.state.used + 1 };
    const saved = await writeKey(area, KEYS.interruptState, next);
    if (!saved) return { ok: false, reason: 'storage', used: context.state.used, limit: context.settings.dailyLimit };
    return {
      ok: true,
      used: next.used,
      limit: context.settings.dailyLimit,
      remaining: Math.max(0, context.settings.dailyLimit - next.used),
    };
  }

  /** Gives one credit back (used when notification creation fails). */
  async function releaseInterrupt(area, at) {
    const today = dayOf(at);
    const state = normalizeInterruptState(await readKey(area, KEYS.interruptState, null), today);
    if (state.used <= 0) return state;
    const next = { day: today, used: state.used - 1 };
    await writeKey(area, KEYS.interruptState, next);
    return next;
  }

  // -------------------------------------------------------------------------
  // Pending exposure queue (sidebar / notification -> newtab -> event log)
  // -------------------------------------------------------------------------

  function newExposureId() {
    const cryptoApi = root.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      try {
        return cryptoApi.randomUUID();
      } catch {
        /* fall through */
      }
    }
    return `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function normalizeExposure(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const propositionId = typeof raw.propositionId === 'string' ? raw.propositionId.trim() : '';
    const kind = raw.kind === 'shown' || raw.kind === 'engaged' || raw.kind === 'skipped' ? raw.kind : '';
    if (!propositionId || !kind) return null;
    const at = typeof raw.at === 'string' && !Number.isNaN(Date.parse(raw.at)) ? raw.at : new Date().toISOString();
    const day = isDayString(raw.day) ? raw.day : dayOf(at);
    const surface = typeof raw.surface === 'string' && raw.surface ? raw.surface.slice(0, 40) : 'sidebar';
    const id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 80) : newExposureId();
    return { id, propositionId, kind, surface, at, day };
  }

  async function readExposureQueue(area) {
    const raw = await readKey(area, KEYS.exposureQueue, []);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeExposure).filter(Boolean);
  }

  /**
   * Appends one exposure record. De-duplicated by id and by
   * (propositionId, kind, day, surface), so a double render cannot double-log.
   */
  async function queueExposure(area, exposure) {
    const entry = normalizeExposure(exposure);
    if (!entry) return null;
    const queue = await readExposureQueue(area);
    const duplicate = queue.some(
      (item) =>
        item.id === entry.id ||
        (item.propositionId === entry.propositionId &&
          item.kind === entry.kind &&
          item.day === entry.day &&
          item.surface === entry.surface),
    );
    if (duplicate) return entry;
    queue.push(entry);
    await writeKey(area, KEYS.exposureQueue, queue.slice(-MAX_QUEUE));
    return entry;
  }

  // -------------------------------------------------------------------------
  // Selection: what the sidebar / a notification may show right now
  // -------------------------------------------------------------------------

  function siteKeyFor(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (/(^|\.)bilibili\.com$/.test(host)) return 'bilibili';
    if (/(^|\.)youtube\.com$/.test(host)) return 'youtube';
    return null;
  }

  function pickSidebarItems(board, guard, settings, siteKey, at, limit) {
    if (!boardIsToday(board, at)) return [];
    if (!settings || settings.sidebar === false) return [];
    if (siteKey && settings.sites && settings.sites[siteKey] === false) return [];
    const seen = shownIds(guard, at);
    const max = Math.max(0, Math.min(MAX_SIDEBAR_ITEMS, Number(limit) || MAX_SIDEBAR_ITEMS));
    return snapshotItems(board, at)
      .filter((item) => !seen.has(item.propositionId))
      .slice(0, max);
  }

  /** Highest-score item not shown/notified yet today (snapshot is already sorted). */
  function pickNotificationItem(board, guard, notifyDay, at) {
    if (!boardIsToday(board, at)) return null;
    const today = dayOf(at);
    const blocked = shownIds(guard, at);
    if (notifyDay && notifyDay.day === today && typeof notifyDay.id === 'string') {
      blocked.add(notifyDay.id);
    }
    const candidates = snapshotItems(board, at)
      .map((item, index) => ({ item, index }))
      .filter((entry) => !blocked.has(entry.item.propositionId));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const scoreA = typeof a.item.score === 'number' ? a.item.score : 0;
      const scoreB = typeof b.item.score === 'number' ? b.item.score : 0;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return a.index - b.index;
    });
    return candidates[0].item;
  }

  // -------------------------------------------------------------------------
  // Difficulty display (contract: tier 1-5 + cognitive level, both optional)
  // -------------------------------------------------------------------------

  function tierStars(tier) {
    const value = normalizeTier(tier);
    if (value === undefined) return '';
    return '★'.repeat(value) + '☆'.repeat(5 - value);
  }

  function cognitiveLabel(cognitive) {
    const key = normalizeCognitive(cognitive);
    return key ? COGNITIVE_LABELS[key] : '';
  }

  function describeDifficulty(item) {
    if (!item || typeof item !== 'object') return null;
    const stars = tierStars(item.tier);
    const label = cognitiveLabel(item.cognitive);
    if (!stars && !label) return null;
    return { stars, label, text: [stars, label].filter(Boolean).join(' ') };
  }

  root.LatticeBillboard = {
    KEYS,
    DEFAULT_INTERRUPT_SETTINGS,
    COGNITIVE_LABELS,
    MAX_SIDEBAR_ITEMS,
    // time / settings
    toDate,
    dayOf,
    isDayString,
    minutesOf,
    withinQuietHours,
    normalizeInterruptSettings,
    normalizeInterruptState,
    // storage
    readKey,
    writeKey,
    // snapshot
    masteryMean,
    normalizeSnapshotItem,
    snapshotItems,
    boardIsToday,
    readBillboard: (area) => readKey(area, KEYS.billboard, null),
    // guard
    normalizeShownGuard,
    readShownGuard,
    shownIds,
    markShown,
    // budget
    budgetStatus,
    readInterruptContext,
    claimInterrupt,
    releaseInterrupt,
    // queue
    newExposureId,
    normalizeExposure,
    readExposureQueue,
    queueExposure,
    // selection
    siteKeyFor,
    pickSidebarItems,
    pickNotificationItem,
    // difficulty
    tierStars,
    cognitiveLabel,
    describeDifficulty,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
