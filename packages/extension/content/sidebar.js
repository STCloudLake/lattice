/*
 * Lattice sidebar content script (M2b).
 *
 * A narrow, collapsible right-docked billboard on video sites. It reads the
 * cached `latticeBillboard` snapshot the newtab page writes; it never opens the
 * database (the DB lives in the newtab's dedicated Worker). Attention is queued
 * as plain records in `latticePendingExposures` and drained by the newtab later.
 *
 * Rules baked in here:
 *   - at most 2 items, one billboard at a time;
 *   - respects the shared interruption budget + quiet hours and the per-site
 *     toggle; exhausted -> nothing is rendered and nothing is queued;
 *   - each displayed item queues ONE `exposure.shown` for this day;
 *   - 30s without interaction collapses the panel (ignored locally, NOT a DB
 *     skip: a skip is only queued when the user presses 不感兴趣);
 *   - the small handle reopens it for the remaining items.
 */
(function (root) {
  'use strict';

  const Shared = root.LatticeBillboard;
  if (!Shared) return;
  if (root.__latticeSidebarInjected) return;
  root.__latticeSidebarInjected = true;

  const HIDE_AFTER_MS = 30000;
  const MAX_ITEMS = Shared.MAX_SIDEBAR_ITEMS;

  const state = {
    booting: false,
    booted: false,
    mounted: false,
    visible: false,
    collapsed: false,
    siteKey: null,
    items: [],
    index: 0,
    claimed: false,
    root: null,
    list: null,
    hideTimer: null,
  };

  function storageArea() {
    return (root.chrome && root.chrome.storage && root.chrome.storage.local) || null;
  }

  function clearHideTimer() {
    if (state.hideTimer !== null) {
      clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
  }

  function scheduleHide() {
    clearHideTimer();
    if (typeof setTimeout !== 'function') return;
    state.hideTimer = setTimeout(() => {
      state.hideTimer = null;
      if (state.visible) collapsePanel();
    }, HIDE_AFTER_MS);
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  function reasonLabel(reason) {
    if (reason === 'due') return '复习';
    if (reason === 'frontier') return '前沿';
    return '基础';
  }

  function button(label, className, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = label;
    element.addEventListener('click', (event) => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      onClick();
    });
    return element;
  }

  function renderItem(item) {
    const card = document.createElement('article');
    card.className = 'lattice-item';

    const badges = document.createElement('div');
    badges.className = 'lattice-badges';
    const domain = document.createElement('span');
    domain.className = 'lattice-domain';
    domain.textContent = item.domain || '知识';
    const reason = document.createElement('span');
    reason.className = 'lattice-reason';
    reason.textContent = reasonLabel(item.reason);
    badges.appendChild(domain);
    badges.appendChild(reason);
    const difficulty = Shared.describeDifficulty(item);
    if (difficulty) {
      const level = document.createElement('span');
      level.className = 'lattice-difficulty';
      level.textContent = difficulty.text;
      level.setAttribute('title', '难度' + (difficulty.label ? ' · ' + difficulty.label : ''));
      badges.appendChild(level);
    }

    const statement = document.createElement('p');
    statement.className = 'lattice-statement';
    statement.textContent = item.statement || '（这条命题没有正文）';

    const actions = document.createElement('div');
    actions.className = 'lattice-actions';
    actions.appendChild(button('知道了', 'lattice-btn lattice-primary', () => void act('engaged')));
    actions.appendChild(button('不感兴趣', 'lattice-btn', () => void act('skipped')));
    actions.appendChild(button('打开 Lattice', 'lattice-btn lattice-open', openLattice));

    card.appendChild(badges);
    card.appendChild(statement);
    card.appendChild(actions);
    return card;
  }

  function mount() {
    if (state.mounted) return;
    const container = document.createElement('div');
    container.id = 'lattice-sidebar';
    container.className = 'lattice-sidebar';
    container.setAttribute('role', 'complementary');
    container.setAttribute('aria-label', 'Lattice 今日推送');

    const header = document.createElement('div');
    header.className = 'lattice-header';
    const title = document.createElement('span');
    title.className = 'lattice-title';
    title.textContent = 'Lattice · 今日推送';
    const collapse = button('收起', 'lattice-collapse', collapsePanel);
    collapse.setAttribute('aria-label', '收起 Lattice 侧栏');
    header.appendChild(title);
    header.appendChild(collapse);

    const list = document.createElement('div');
    list.className = 'lattice-list';

    const handle = button('Lattice', 'lattice-handle', expand);
    handle.setAttribute('aria-label', '展开 Lattice 侧栏');

    container.appendChild(header);
    container.appendChild(list);
    container.appendChild(handle);

    // Any interaction restarts the 30s idle timer.
    for (const type of ['mouseenter', 'mousemove', 'focusin']) {
      container.addEventListener(type, () => {
        if (state.visible && !state.collapsed) scheduleHide();
      });
    }

    document.body.appendChild(container);
    state.root = container;
    state.list = list;
    state.mounted = true;
  }

  function paint() {
    if (!state.root) mount();
    if (!state.root || !state.list) return;
    state.list.textContent = '';
    const remaining = state.items.slice(state.index, state.index + MAX_ITEMS);
    if (remaining.length === 0) {
      dismiss();
      return;
    }
    for (const item of remaining) state.list.appendChild(renderItem(item));
    state.root.className = state.collapsed ? 'lattice-sidebar lattice-collapsed' : 'lattice-sidebar';
  }

  function show() {
    mount();
    state.visible = true;
    state.collapsed = false;
    paint();
    scheduleHide();
  }

  function collapsePanel() {
    clearHideTimer();
    state.visible = false;
    state.collapsed = true;
    if (state.root) state.root.className = 'lattice-sidebar lattice-collapsed';
  }

  function expand() {
    if (state.index >= state.items.length) {
      dismiss();
      return;
    }
    state.visible = true;
    state.collapsed = false;
    paint();
    scheduleHide();
  }

  function dismiss() {
    clearHideTimer();
    state.visible = false;
    state.collapsed = false;
    if (state.root && typeof state.root.remove === 'function') state.root.remove();
    state.mounted = false;
    state.root = null;
    state.list = null;
  }

  // -------------------------------------------------------------------------
  // Actions / exposures
  // -------------------------------------------------------------------------

  async function act(kind) {
    const item = state.items[state.index];
    if (!item) return;
    const area = storageArea();
    const now = new Date();
    if (area) {
      await Shared.queueExposure(area, {
        propositionId: item.propositionId,
        kind,
        surface: 'sidebar',
        at: now.toISOString(),
        day: Shared.dayOf(now),
      });
    }
    state.index += 1;
    if (state.index >= state.items.length) {
      dismiss();
      return;
    }
    paint();
    if (state.visible) scheduleHide();
  }

  function openLattice() {
    const runtime = root.chrome && root.chrome.runtime;
    try {
      if (runtime && typeof runtime.sendMessage === 'function') {
        runtime.sendMessage({ type: 'lattice-open-newtab' });
        return;
      }
    } catch {
      /* fall through to window.open */
    }
    try {
      if (runtime && typeof runtime.getURL === 'function' && typeof root.open === 'function') {
        root.open(runtime.getURL('newtab/newtab.html'));
      }
    } catch {
      /* nothing else we can do from a content script */
    }
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async function boot() {
    if (state.booted || state.booting) return;
    if (!Shared) return;
    if (typeof document === 'undefined' || !document.body) {
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
      }
      return;
    }
    const hostname = (root.location && root.location.hostname) || '';
    const siteKey = Shared.siteKeyFor(hostname);
    if (!siteKey) return;
    state.booting = true;
    state.siteKey = siteKey;
    try {
      const area = storageArea();
      if (!area) return;
      const now = new Date();
      const [rawSettings, rawState, board, rawGuard, optOut] = await Promise.all([
        Shared.readKey(area, Shared.KEYS.interruptSettings, null),
        Shared.readKey(area, Shared.KEYS.interruptState, null),
        Shared.readKey(area, Shared.KEYS.billboard, null),
        Shared.readKey(area, Shared.KEYS.shownGuard, null),
        Shared.readAmbientOptOut(area),
      ]);
      const settings = Shared.normalizeInterruptSettings(rawSettings);
      if (!settings.sidebar) return;
      // M2c: the master ambient toggle and "此站不再显示" also silence the sidebar.
      if (!settings.ambient) return;
      if (Shared.isHostOptedOut(hostname, optOut)) return;
      const interruptState = Shared.normalizeInterruptState(rawState, Shared.dayOf(now));
      if (!Shared.budgetStatus(settings, interruptState, now).allowed) return;
      const items = Shared.pickSidebarItems(
        board,
        rawGuard,
        settings,
        siteKey,
        now,
        MAX_ITEMS,
        Shared.pageReservedSet(root),
      );
      if (items.length === 0) return;
      // Reserve across surfaces on this page BEFORE any await so the ambient
      // cards can never pick the same proposition (shared isolated world).
      Shared.reservePageIds(root, items.map((item) => item.propositionId));
      const claim = await Shared.claimInterrupt(area, now);
      if (!claim.ok) return;
      state.claimed = true;
      state.items = items;
      state.index = 0;
      await Shared.markShown(area, now, items.map((item) => item.propositionId));
      for (const item of items) {
        await Shared.queueExposure(area, {
          propositionId: item.propositionId,
          kind: 'shown',
          surface: 'sidebar',
          at: now.toISOString(),
          day: Shared.dayOf(now),
        });
      }
      state.booted = true;
      show();
    } catch (error) {
      // A broken billboard must never break the page it is docked to.
      if (root.console && typeof root.console.warn === 'function') {
        root.console.warn('[Lattice] 侧栏初始化失败', error);
      }
    } finally {
      state.booting = false;
      // Signals ambient.js that this page's billboard decision is finished. The
      // two scripts share one isolated world, so a video page can enforce
      // "max 1 ambient surface" without a timing race.
      root.__latticeSidebarSettled = true;
    }
  }

  // Test hook (isolated world only; harmless): lets the Node DOM-stub test drive
  // the same code path the manifest runs.
  root.LatticeSidebar = {
    boot,
    expand,
    collapse: collapsePanel,
    dismiss,
    getState: () => ({
      booted: state.booted,
      booting: state.booting,
      visible: state.visible,
      collapsed: state.collapsed,
      index: state.index,
      items: state.items,
      siteKey: state.siteKey,
      claimed: state.claimed,
    }),
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
    } else {
      void boot();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
