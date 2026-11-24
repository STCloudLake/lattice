/*
 * Lattice ambient surfaces (M2c).
 *
 * One content script for every http(s) page. It renders knowledge "like an ad":
 *
 *   1. an ambient pill (bottom-right, fixed, ~44px) that expands to a 300px panel
 *      on click/hover (>=1100px wide viewports only) and auto-collapses after 30s;
 *   2. on bilibili / YouTube, ONE native-looking card inside the comment area and
 *      ONE in the recommendation list;
 *   3. "感兴趣" never navigates the current tab: it asks the background worker to
 *      open the platform's own search (or the Lattice newtab on non-video pages).
 *
 * HARD RULE (ETHICS.md): no impersonation. Cards are always visibly attributed
 * with a `Lattice · 知识` badge; we never render fake usernames, avatars, likes,
 * timestamps or "网友评论" framing. If a surface could only be served by faking a
 * comment structure we do not touch it.
 *
 * Everything here reads the cached `latticeBillboard` snapshot and queues plain
 * exposure records — the SQLite event log is only touched by the newtab worker.
 */
(function (root) {
  'use strict';

  const Shared = root.LatticeBillboard;
  if (!Shared) return;
  if (root.__latticeAmbientInjected) return;
  root.__latticeAmbientInjected = true;

  const HIDE_AFTER_MS = 30000;
  const NARROW_WIDTH = 1100;
  const SCAN_DEBOUNCE_MS = 400;
  const URL_POLL_MS = 1500;
  /** On video pages the M2b sidebar boots first; give it a moment before a pill. */
  const SIDEBAR_GRACE_MS = 700;
  const SURFACES_INLINE = ['comment', 'recommend'];

  const state = {
    booting: false,
    booted: false,
    stopped: false,
    settings: null,
    optOut: [],
    board: null,
    guard: null,
    force: false,
    usedIds: new Set(),
    dismissed: { comment: false, recommend: false },
    injected: { comment: false, recommend: false },
    /** Guards a scan/observer burst from injecting the same surface twice. */
    inFlight: { comment: false, recommend: false },
    anchors: typeof WeakSet === 'function' ? new WeakSet() : null,
    pillRoot: null,
    pill: null,
    panel: null,
    panelItem: null,
    panelOpen: false,
    pillAttempted: false,
    hideTimer: null,
    scanTimer: null,
    urlTimer: null,
    observer: null,
    lastUrl: '',
    localRandom: null,
    keyHandlerInstalled: false,
  };

  const PLATFORM_SELECTORS = {
    bilibili: {
      comment: [
        { selector: '#comment .reply-list', mode: 'after' },
        { selector: '.reply-list', mode: 'after' },
      ],
      recommend: [
        { selector: '.rec-list', mode: 'append' },
        { selector: '.recommend-list-v1', mode: 'append' },
        { selector: '.video-page-card-small', mode: 'after-parent' },
      ],
    },
    youtube: {
      comment: [
        { selector: '#comments', mode: 'after' },
        { selector: 'ytd-comments', mode: 'after' },
        { selector: 'ytd-comment-thread-renderer', mode: 'after-parent' },
      ],
      recommend: [
        { selector: '#secondary #related', mode: 'append' },
        { selector: '#secondary', mode: 'append' },
        { selector: 'ytd-compact-video-renderer', mode: 'after-parent' },
        { selector: '#secondary ytd-rich-item-renderer', mode: 'after-parent' },
      ],
    },
  };

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  function now() {
    return new Date();
  }

  function storageArea() {
    return (root.chrome && root.chrome.storage && root.chrome.storage.local) || null;
  }

  function runtimeApi() {
    return (root.chrome && root.chrome.runtime) || null;
  }

  function sessionStore() {
    return root.sessionStorage || null;
  }

  function pageInfo() {
    const loc = root.location || {};
    return {
      protocol: loc.protocol || 'https:',
      hostname: loc.hostname || '',
      pathname: loc.pathname || '/',
    };
  }

  function platformFor() {
    return Shared.siteKeyFor(pageInfo().hostname);
  }

  function random() {
    return state.localRandom ? Number(state.localRandom()) : Math.random();
  }

  function setTimer(callback, ms) {
    return setTimeout(callback, ms);
  }

  function hasDomOptOut() {
    const html = root.document && root.document.documentElement;
    const body = root.document && root.document.body;
    const check = (element) =>
      Boolean(element && typeof element.hasAttribute === 'function' && element.hasAttribute('data-lattice-optout'));
    return check(html) || check(body);
  }

  function isNarrow() {
    const width = Number(root.innerWidth) || 9999;
    return width < NARROW_WIDTH;
  }

  function pageAllowed() {
    if (Shared.isBlockedPage(pageInfo())) return false;
    if (hasDomOptOut()) return false;
    return true;
  }

  // -------------------------------------------------------------------------
  // C-ledger bookkeeping (queued; the newtab drains it into the event log)
  // -------------------------------------------------------------------------

  async function pickItem() {
    const area = storageArea();
    if (!area || !state.board) return null;
    const guard = await Shared.readShownGuard(area, now());
    // Sidebar + ambient surfaces share one page-level reservation, so the same
    // proposition is never shown by two surfaces on the same page (guard reads
    // can race across the two scripts).
    const reserved = Shared.pageReservedSet(root);
    const used = new Set([...state.usedIds, ...reserved]);
    const item = Shared.pickNextSnapshotItem(state.board, guard, used, now());
    if (item) Shared.reservePageIds(root, [item.propositionId]);
    return item;
  }

  async function recordShown(item, surface) {
    const area = storageArea();
    if (!area || !item) return;
    const at = now();
    state.usedIds.add(item.propositionId);
    await Shared.markShown(area, at, [item.propositionId]);
    await Shared.queueExposure(area, {
      propositionId: item.propositionId,
      kind: 'shown',
      surface,
      at: at.toISOString(),
      day: Shared.dayOf(at),
    });
  }

  async function recordEngaged(item, surface) {
    const area = storageArea();
    if (!area || !item) return;
    const at = now();
    await Shared.queueExposure(area, {
      propositionId: item.propositionId,
      kind: 'engaged',
      surface,
      at: at.toISOString(),
      day: Shared.dayOf(at),
    });
  }

  /** The force flag is the E2E/test override: it bypasses probability + budget. */
  async function claimCredit() {
    if (state.force) return { ok: true, reason: 'forced' };
    const area = storageArea();
    if (!area) return { ok: false, reason: 'storage' };
    return Shared.claimInterrupt(area, now());
  }

  function sendMessage(message) {
    const runtime = runtimeApi();
    try {
      if (runtime && typeof runtime.sendMessage === 'function') {
        runtime.sendMessage(message);
        return true;
      }
    } catch {
      /* best effort from a content script */
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Shared card markup (attribution is non-negotiable: the badge is always there)
  // -------------------------------------------------------------------------

  function button(label, className, onClick) {
    const element = root.document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = label;
    element.addEventListener('click', (event) => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      onClick();
    });
    return element;
  }

  function buildCard(item, surface, platform, options) {
    const card = root.document.createElement('div');
    card.className = 'lattice-card lattice-card-' + surface;
    card.setAttribute('data-lattice', surface);
    card.setAttribute('data-proposition-id', item.propositionId);
    fillCard(card, item);

    const actions = root.document.createElement('div');
    actions.className = 'lattice-card-actions';
    actions.appendChild(button('感兴趣', 'lattice-btn lattice-primary', () => void onInterested(card, surface, platform)));
    actions.appendChild(button('换一条', 'lattice-btn lattice-next', () => void onNextItem(card, surface, platform)));
    if (surface === 'ambient') {
      actions.appendChild(button('收起', 'lattice-btn lattice-collapse-card', () => collapsePanel()));
      actions.appendChild(
        button('此站不再显示', 'lattice-btn lattice-optout', () => void dismissCurrentSite()),
      );
    } else {
      actions.appendChild(button('收起', 'lattice-btn lattice-collapse-card', () => dismissInlineCard(card, surface)));
    }
    card.appendChild(actions);

    card.addEventListener('mouseenter', () => {
      if (surface === 'ambient') scheduleAutoCollapse();
    });
    return card;
  }

  /** Writes head + truncated statement into an existing card element. */
  function fillCard(card, item) {
    card.__latticeItem = item;
    const oldHead = card.querySelector ? card.querySelector('.lattice-card-head') : null;
    const oldStatement = card.querySelector ? card.querySelector('.lattice-card-statement') : null;
    if (oldHead) oldHead.remove();
    if (oldStatement) oldStatement.remove();
    card.setAttribute('data-proposition-id', item.propositionId);

    const head = root.document.createElement('div');
    head.className = 'lattice-card-head';
    const badge = root.document.createElement('span');
    badge.className = 'lattice-badge';
    badge.textContent = 'Lattice · 知识';
    const domain = root.document.createElement('span');
    domain.className = 'lattice-domain';
    domain.textContent = item.domain || '知识';
    head.appendChild(badge);
    head.appendChild(domain);
    const difficulty = Shared.describeDifficulty(item);
    if (difficulty) {
      const level = root.document.createElement('span');
      level.className = 'lattice-difficulty';
      level.textContent = difficulty.text;
      head.appendChild(level);
    }
    const statement = root.document.createElement('p');
    statement.className = 'lattice-card-statement';
    statement.textContent = item.statement || '（这条命题没有正文）';

    card.insertBefore(head, card.firstChild || null);
    card.insertBefore(statement, head.nextSibling || null);
  }

  // -------------------------------------------------------------------------
  // "感兴趣" / "换一条" / "收起"
  // -------------------------------------------------------------------------

  async function onInterested(card, surface, platform) {
    const item = card && card.__latticeItem;
    if (!item) return;
    await recordEngaged(item, surface);
    const settings = state.settings || Shared.normalizeInterruptSettings(null);
    const primary = card.querySelector ? card.querySelector('.lattice-primary') : null;
    if (primary) {
      primary.textContent = '已感兴趣';
      primary.disabled = true;
    }
    if (platform && settings.searchJump) {
      sendMessage({ type: 'lattice-open-search', platform, query: Shared.buildSearchQuery(item) });
    } else {
      // Non-video surfaces: open the Lattice newtab focused on this item.
      sendMessage({ type: 'lattice-open-newtab', focus: item.propositionId });
    }
  }

  async function onNextItem(card, surface, platform) {
    void platform;
    if (!card) return;
    const item = await pickItem();
    const statement = card.querySelector ? card.querySelector('.lattice-card-statement') : null;
    if (!item) {
      if (statement) statement.textContent = '今天的知识看完了 ✓';
      return;
    }
    fillCard(card, item);
    await recordShown(item, surface);
  }

  function dismissInlineCard(card, surface) {
    state.dismissed[surface] = true;
    state.injected[surface] = false;
    if (card && card.__latticeParent && state.anchors) state.anchors.delete(card.__latticeParent);
    if (card && typeof card.remove === 'function') card.remove();
  }

  function removeInlineCards() {
    const document = root.document;
    if (!document) return;
    for (const surface of SURFACES_INLINE) {
      const node = document.querySelector(`[data-lattice="${surface}"]`);
      if (node) {
        if (node.__latticeParent && state.anchors) state.anchors.delete(node.__latticeParent);
        if (typeof node.remove === 'function') node.remove();
      }
    }
    state.injected = { comment: false, recommend: false };
    state.dismissed = { comment: false, recommend: false };
    state.anchors = typeof WeakSet === 'function' ? new WeakSet() : null;
  }

  // -------------------------------------------------------------------------
  // Comment / recommendation injection (video platforms)
  // -------------------------------------------------------------------------

  function findAnchor(platform, surface) {
    const specs = (PLATFORM_SELECTORS[platform] || {})[surface] || [];
    const document = root.document;
    for (const spec of specs) {
      const element = document.querySelector(spec.selector);
      if (!element) continue;
      if (spec.mode === 'append') {
        return { parent: element, before: null, anchor: element };
      }
      if (!element.parentNode) continue;
      return { parent: element.parentNode, before: element.nextSibling || null, anchor: element };
    }
    return null;
  }

  function cleanupStaleCards() {
    for (const surface of SURFACES_INLINE) {
      const card = root.document.querySelector(`[data-lattice="${surface}"]`);
      if (!card) {
        state.injected[surface] = false;
        continue;
      }
      const connected =
        typeof root.document.contains === 'function' ? root.document.contains(card) : Boolean(card.parentNode);
      if (!connected) {
        if (card.__latticeParent && state.anchors) state.anchors.delete(card.__latticeParent);
        if (typeof card.remove === 'function') card.remove();
        state.injected[surface] = false;
      }
    }
  }

  async function injectSurface(platform, surface) {
    if (state.stopped || !state.settings) return false;
    if (!state.settings.ambient || !state.settings.injectComments) return false;
    if (state.injected[surface] || state.dismissed[surface] || state.inFlight[surface]) return false;
    const document = root.document;
    if (document.querySelector(`[data-lattice="${surface}"]`)) {
      state.injected[surface] = true;
      return true;
    }
    const anchor = findAnchor(platform, surface);
    if (!anchor) return false;
    if (state.anchors && state.anchors.has(anchor.parent)) return false;
    state.inFlight[surface] = true;
    try {
      const item = await pickItem();
      if (!item) return false;
      const credit = await claimCredit();
      if (!credit.ok) return false;
      // Re-check after the awaits: another scan may have inserted in the meantime.
      if (document.querySelector(`[data-lattice="${surface}"]`)) {
        state.injected[surface] = true;
        return true;
      }
      const card = buildCard(item, surface, platform, {});
      if (anchor.before) anchor.parent.insertBefore(card, anchor.before);
      else anchor.parent.appendChild(card);
      card.__latticeAnchor = anchor.anchor;
      card.__latticeParent = anchor.parent;
      if (state.anchors) state.anchors.add(anchor.parent);
      state.injected[surface] = true;
      await recordShown(item, surface);
      return true;
    } finally {
      state.inFlight[surface] = false;
    }
  }

  async function scanInline(platform) {
    const activePlatform = platform || platformFor();
    if (!activePlatform || state.stopped || !state.settings) return;
    cleanupStaleCards();
    await injectSurface(activePlatform, 'comment');
    await injectSurface(activePlatform, 'recommend');
  }

  // -------------------------------------------------------------------------
  // Ambient pill + panel
  // -------------------------------------------------------------------------

  function clearHideTimer() {
    if (state.hideTimer !== null) {
      clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
  }

  function scheduleAutoCollapse() {
    clearHideTimer();
    state.hideTimer = setTimer(() => {
      state.hideTimer = null;
      if (state.panelOpen) collapsePanel();
    }, HIDE_AFTER_MS);
  }

  function ensurePill() {
    if (state.pillRoot) return state.pillRoot;
    const document = root.document;
    const container = document.createElement('div');
    container.id = 'lattice-ambient';
    container.className = 'lattice-ambient';
    container.setAttribute('data-lattice', 'ambient');
    container.setAttribute('data-lattice-surface', 'ambient');

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'lattice-pill';
    pill.setAttribute('aria-label', 'Lattice 知识');
    pill.setAttribute('title', 'Lattice · 一点知识');
    pill.textContent = 'Lattice';
    pill.addEventListener('click', (event) => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      if (isNarrow()) {
        if (state.panelItem) sendMessage({ type: 'lattice-open-newtab', focus: state.panelItem.propositionId });
        return;
      }
      togglePanel();
    });
    pill.addEventListener('mouseenter', () => {
      if (!isNarrow()) openPanel();
    });

    const panel = document.createElement('div');
    panel.className = 'lattice-ambient-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Lattice 今日知识');
    panel.hidden = true;
    panel.addEventListener('mouseenter', () => {
      if (state.panelOpen) scheduleAutoCollapse();
    });

    container.appendChild(pill);
    container.appendChild(panel);
    // Fixed positioning only: attach to <html>, never mutate <body>'s layout.
    (document.documentElement || document.body).appendChild(container);
    state.pillRoot = container;
    state.pill = pill;
    state.panel = panel;
    return container;
  }

  function renderPanel() {
    if (!state.panel || !state.panelItem) return;
    const document = root.document;
    state.panel.textContent = '';
    const card = buildCard(state.panelItem, 'ambient', platformFor(), {});
    state.panel.appendChild(card);
  }

  function openPanel() {
    if (isNarrow() || !state.panelItem) return;
    ensurePill();
    renderPanel();
    if (state.panel) state.panel.hidden = false;
    state.panelOpen = true;
    scheduleAutoCollapse();
  }

  function collapsePanel() {
    clearHideTimer();
    state.panelOpen = false;
    if (state.panel) state.panel.hidden = true;
  }

  function togglePanel() {
    if (state.panelOpen) collapsePanel();
    else openPanel();
  }

  function removePill() {
    clearHideTimer();
    state.panelOpen = false;
    if (state.pillRoot && typeof state.pillRoot.remove === 'function') state.pillRoot.remove();
    state.pillRoot = null;
    state.pill = null;
    state.panel = null;
    state.panelItem = null;
  }

  async function dismissCurrentSite() {
    const area = storageArea();
    const hostname = pageInfo().hostname;
    if (area && hostname) await Shared.addAmbientOptOut(area, hostname);
    stopAll('opted-out');
  }

  async function decideAmbientPill() {
    if (state.stopped || state.pillRoot || state.pillAttempted) return;
    if (!state.settings || !state.settings.ambient) return;
    if (Shared.isHostOptedOut(pageInfo().hostname, state.optOut)) return;
    if (!Shared.boardIsToday(state.board, now())) return;
    // "Max 1 ambient surface per page": the video sidebar wins over the pill.
    // While the sidebar is still deciding (its DOM is appended after its storage
    // writes), do not race it into existence.
    if (platformFor() && root.__latticeSidebarInjected === true && root.__latticeSidebarSettled !== true) {
      return;
    }
    if (root.document.getElementById('lattice-sidebar')) return;
    state.pillAttempted = true;
    const force = state.force === true;
    if (!force) {
      if (Shared.ambientCoolingDown(sessionStore(), now())) return;
      if (!Shared.shouldShowAmbient({ hostname: pageInfo().hostname, force: false, random })) return;
    }
    const item = await pickItem();
    if (!item) return;
    if (!force) {
      const credit = await claimCredit();
      if (!credit.ok) return;
      Shared.markAmbientShown(sessionStore(), now());
    }
    state.panelItem = item;
    ensurePill();
    renderPanel();
    await recordShown(item, 'ambient');
  }

  /** Resolves when sidebar.js finished its page-level decision (or after a cap). */
  function waitForSidebarSettled() {
    if (root.__latticeSidebarInjected !== true || root.__latticeSidebarSettled === true) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const deadline = Date.now() + SIDEBAR_GRACE_MS * 3;
      const poll = () => {
        if (root.__latticeSidebarSettled === true || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimer(poll, 50);
      };
      setTimer(poll, 50);
    });
  }

  function scheduleAmbientDecision() {
    if (platformFor()) {
      // The video sidebar is this page's ambient surface. Wait for its decision
      // (rendered or not) before considering a pill, so a page never shows both.
      void waitForSidebarSettled().then(() => decideAmbientPill());
      return;
    }
    void decideAmbientPill();
  }

  // -------------------------------------------------------------------------
  // SPA + storage reactivity
  // -------------------------------------------------------------------------

  function scheduleScan() {
    if (state.stopped || state.scanTimer !== null) return;
    state.scanTimer = setTimer(() => {
      state.scanTimer = null;
      void scan();
    }, SCAN_DEBOUNCE_MS);
  }

  async function scan() {
    if (state.stopped) return;
    const platform = platformFor();
    if (!platform) return;
    // If a sidebar mounted late, drop our pill (one ambient surface per page).
    if (state.pillRoot && root.document.getElementById('lattice-sidebar')) removePill();
    if (state.settings && state.settings.ambient && state.settings.injectComments) await scanInline(platform);
  }

  function installObserver() {
    if (state.observer || typeof MutationObserver !== 'function') return;
    const target = root.document.documentElement || root.document.body;
    if (!target) return;
    const observer = new MutationObserver(() => scheduleScan());
    observer.observe(target, { childList: true, subtree: true });
    state.observer = observer;
  }

  function watchUrl() {
    state.lastUrl = String((root.location && root.location.href) || '');
    if (typeof setInterval !== 'function') return;
    state.urlTimer = setInterval(() => {
      const href = String((root.location && root.location.href) || '');
      if (href === state.lastUrl) return;
      state.lastUrl = href;
      void onNavigation();
    }, URL_POLL_MS);
  }

  async function onNavigation() {
    if (state.stopped) return;
    removeInlineCards();
    await refreshFromStorage();
    if (state.stopped) return;
    const platform = platformFor();
    if (platform && state.settings && state.settings.ambient && state.settings.injectComments) await scanInline(platform);
  }

  function installKeyHandler() {
    if (state.keyHandlerInstalled || !root.document) return;
    state.keyHandlerInstalled = true;
    root.document.addEventListener('keydown', (event) => {
      if (!event || event.key !== 'Escape' || !state.panelOpen) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      collapsePanel();
    });
  }

  async function refreshFromStorage() {
    const area = storageArea();
    if (!area) return;
    const [rawSettings, board, rawGuard, optOut, force] = await Promise.all([
      Shared.readKey(area, Shared.KEYS.interruptSettings, null),
      Shared.readKey(area, Shared.KEYS.billboard, null),
      Shared.readKey(area, Shared.KEYS.shownGuard, null),
      Shared.readAmbientOptOut(area),
      Shared.readKey(area, Shared.KEYS.forceAmbient, false),
    ]);
    state.settings = Shared.normalizeInterruptSettings(rawSettings);
    state.board = board;
    state.guard = rawGuard;
    state.optOut = Array.isArray(optOut) ? optOut : [];
    state.force = force === true;
  }

  function installStorageListener() {
    const onChanged = root.chrome && root.chrome.storage && root.chrome.storage.onChanged;
    if (!onChanged || typeof onChanged.addListener !== 'function') return;
    onChanged.addListener((changes, areaName) => {
      if (areaName && areaName !== 'local') return;
      const keys = Object.keys(changes || {});
      const relevant =
        keys.includes(Shared.KEYS.billboard) ||
        keys.includes(Shared.KEYS.interruptSettings) ||
        keys.includes(Shared.KEYS.interruptState) ||
        keys.includes(Shared.KEYS.ambientOptOut) ||
        keys.includes(Shared.KEYS.shownGuard) ||
        keys.includes(Shared.KEYS.forceAmbient);
      if (!relevant) return;
      void refreshFromStorage().then(() => applyStorageChange());
    });
  }

  async function applyStorageChange() {
    if (state.stopped) return;
    if (!pageAllowed() || !state.settings || !state.settings.ambient) {
      stopAll('disabled');
      return;
    }
    if (Shared.isHostOptedOut(pageInfo().hostname, state.optOut)) {
      stopAll('opted-out');
      return;
    }
    const platform = platformFor();
    // On video pages the sidebar owns the ambient surface; wait for it to settle
    // before even considering a pill (its own writes emit storage events).
    if (platform && root.__latticeSidebarSettled !== true) return;
    if (!state.settings.injectComments) removeInlineCards();
    if (platform && state.settings.injectComments) {
      installObserver();
      await scanInline(platform);
    }
    if (!state.pillRoot && !state.pillAttempted) void decideAmbientPill();
  }

  function stopAll(reason) {
    void reason;
    state.stopped = true;
    state.booted = false;
    removeInlineCards();
    removePill();
    // "此站不再显示" also hides the M2b video sidebar if it is on this page.
    const sidebar = root.LatticeSidebar;
    if (sidebar && typeof sidebar.dismiss === 'function') sidebar.dismiss();
    else if (root.document && root.document.getElementById) {
      const node = root.document.getElementById('lattice-sidebar');
      if (node && typeof node.remove === 'function') node.remove();
    }
    if (state.observer && typeof state.observer.disconnect === 'function') state.observer.disconnect();
    state.observer = null;
    if (state.scanTimer !== null) clearTimeout(state.scanTimer);
    state.scanTimer = null;
    if (state.urlTimer !== null) clearInterval(state.urlTimer);
    state.urlTimer = null;
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async function boot() {
    if (state.booted || state.booting || state.stopped) return;
    if (typeof root.document === 'undefined' || !root.document.body) {
      if (typeof root.document !== 'undefined' && typeof root.document.addEventListener === 'function') {
        root.document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
      }
      return;
    }
    if (!pageAllowed()) return;
    state.booting = true;
    try {
      await refreshFromStorage();
      if (state.stopped) return;
      installKeyHandler();
      installStorageListener();
      if (!state.settings || !state.settings.ambient) return;
      if (Shared.isHostOptedOut(pageInfo().hostname, state.optOut)) return;
      if (!Shared.boardIsToday(state.board, now())) return;
      state.booted = true;
      if (platformFor()) {
        installObserver();
        watchUrl();
        if (state.settings.injectComments) await scanInline(platformFor());
      }
      scheduleAmbientDecision();
    } catch (error) {
      if (root.console && typeof root.console.warn === 'function') {
        root.console.warn('[Lattice] 环境表面初始化失败', error);
      }
    } finally {
      state.booting = false;
    }
  }

  // Test hook (isolated world only): lets the Node DOM-stub test drive the same
  // code path the manifest runs. No cross-world exposure.
  root.LatticeAmbient = {
    boot,
    getState: () => ({
      booted: state.booted,
      booting: state.booting,
      stopped: state.stopped,
      platform: platformFor(),
      pillVisible: Boolean(state.pillRoot),
      panelOpen: state.panelOpen,
      panelItem: state.panelItem,
      injected: { ...state.injected },
      inFlight: { ...state.inFlight },
      dismissed: { ...state.dismissed },
      settings: state.settings,
      optOut: [...state.optOut],
      force: state.force,
    }),
    scanNow: scan,
    decidePillNow: decideAmbientPill,
    openPanel,
    collapsePanel,
    removePill,
    dismissCurrentSite,
    setRandom: (fn) => {
      state.localRandom = typeof fn === 'function' ? fn : null;
    },
    __test: {
      pageInfo,
      pageAllowed,
      hasDomOptOut,
      platformFor,
      findAnchor: (platform, surface) => findAnchor(platform, surface),
      selectors: PLATFORM_SELECTORS,
    },
  };

  if (typeof root.document !== 'undefined') {
    if (root.document.readyState === 'loading' && typeof root.document.addEventListener === 'function') {
      root.document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
    } else {
      void boot();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
