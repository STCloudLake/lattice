/**
 * Headless smoke test of the M2b interruption layer (no browser needed).
 *
 * Three units are exercised exactly as the browser loads them:
 *   1. shared/billboard.js  — snapshot tolerance, budget gating, queue de-dup,
 *      notification picker, difficulty display;
 *   2. content/sidebar.js   — rendered against a tiny DOM stub with a fake
 *      chrome.storage.local (budget/quiet/site gating, 2-item panel, 知道了 /
 *      不感兴趣 queueing, 30s auto-hide without a skip);
 *   3. background.js        — evaluated in a vm with a stubbed chrome (alarms,
 *      notifications) to test the notification path end to end: default OFF,
 *      one-per-day pick, budget consumption, click -> engaged, dismiss -> skipped.
 *
 * Run from the repo root (after `npm run build`):
 *   node packages/extension/test/m2b-smoke.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const sharedSource = readFileSync(path.join(here, '../shared/billboard.js'), 'utf8');
const sidebarSource = readFileSync(path.join(here, '../content/sidebar.js'), 'utf8');
const backgroundSource = readFileSync(path.join(here, '../background.js'), 'utf8');

let failures = 0;
let sqlite3Unused; // keep the file dependency-free; no SQLite is needed for M2b
void sqlite3Unused;

function step(title) {
  console.log(`\n# ${title}`);
}

function check(label, fn) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${label}`);
    console.log(`       ${err && err.message ? err.message.split('\n')[0] : String(err)}`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${label}`);
    console.log(`       ${err && err.message ? err.message.split('\n')[0] : String(err)}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  throw new Error(`等待超时：${label}`);
}

/** Fixed instant keeps "today" and quiet-hour tests deterministic. */
const FIXED = '2026-11-24T12:00:00.000Z';
const TODAY = new Date(FIXED).toISOString().slice(0, 10);

function makeFakeDate(iso) {
  const RealDate = Date;
  const fixed = new RealDate(iso).getTime();
  return class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  };
}

/** Minimal chrome.storage.local double with read/write observation. */
function makeArea(seed = {}) {
  const data = { ...seed };
  return {
    data,
    area: {
      async get(keys) {
        const wanted = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of wanted) {
          if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = data[key];
        }
        return out;
      },
      async set(items) {
        Object.assign(data, items);
      },
      async remove(keys) {
        const wanted = Array.isArray(keys) ? keys : [keys];
        for (const key of wanted) delete data[key];
      },
    },
    read(key) {
      return data[key];
    },
  };
}

// ---------------------------------------------------------------------------
// Tiny DOM stub: enough for content/sidebar.js (createElement / appendChild /
// textContent / className / attributes / listeners / click / querySelector).
// ---------------------------------------------------------------------------

function createDomStub({ hostname = 'www.bilibili.com', readyState = 'complete' } = {}) {
  const registry = new Map();
  const timers = new Map();
  let timerSeq = 0;

  const matchesSimple = (element, selector) => {
    if (selector.startsWith('#')) return element.id === selector.slice(1);
    if (selector.startsWith('.')) {
      return String(element.className)
        .split(/\s+/)
        .filter(Boolean)
        .includes(selector.slice(1));
    }
    return element.tagName.toLowerCase() === selector.toLowerCase();
  };

  const descendants = (node, out = []) => {
    for (const child of node.children) {
      if (child.nodeType === 1) {
        out.push(child);
        descendants(child, out);
      }
    }
    return out;
  };

  const queryAll = (root, selector) => {
    const parts = String(selector).trim().split(/\s+/);
    let scope = [root];
    for (const part of parts) {
      const next = [];
      for (const node of scope) {
        for (const child of descendants(node)) if (matchesSimple(child, part)) next.push(child);
      }
      scope = next;
    }
    return scope;
  };

  class Element {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this.nodeType = 1;
      this.children = [];
      this.parentNode = null;
      this._text = '';
      this._id = '';
      this.attributes = {};
      this.listeners = {};
      this.className = '';
      this.style = {};
      this.hidden = false;
    }
    set id(value) {
      if (this._id) registry.delete(this._id);
      this._id = value ? String(value) : '';
      if (this._id) registry.set(this._id, this);
    }
    get id() {
      return this._id;
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'id') this.id = String(value);
      if (name === 'class') this.className = String(value);
    }
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    }
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
      if (this._id) registry.delete(this._id);
    }
    addEventListener(type, handler) {
      const list = this.listeners[type] ?? [];
      list.push(handler);
      this.listeners[type] = list;
    }
    dispatchEvent(event) {
      for (const handler of this.listeners[event.type] ?? []) handler(event);
      return true;
    }
    click() {
      return this.dispatchEvent({
        type: 'click',
        target: this,
        stopPropagation() {},
        preventDefault() {},
      });
    }
    set textContent(value) {
      this.children = [];
      this._text = value === undefined || value === null ? '' : String(value);
    }
    get textContent() {
      return this._text + this.children.map((child) => child.textContent).join(' ');
    }
    querySelector(selector) {
      return queryAll(this, selector)[0] ?? null;
    }
    querySelectorAll(selector) {
      return queryAll(this, selector);
    }
  }

  const document = {
    readyState,
    body: new Element('body'),
    documentElement: new Element('html'),
    listeners: {},
    createElement: (tagName) => new Element(tagName),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    addEventListener(type, handler) {
      const list = document.listeners[type] ?? [];
      list.push(handler);
      document.listeners[type] = list;
    },
    getElementById(id) {
      const element = registry.get(id);
      return element && element.parentNode ? element : null;
    },
    querySelector: (selector) => queryAll(document.body, selector)[0] ?? null,
    querySelectorAll: (selector) => queryAll(document.body, selector),
  };

  return {
    document,
    location: { hostname },
    timers,
    setTimeout(fn, ms) {
      timerSeq += 1;
      timers.set(timerSeq, { id: timerSeq, fn, ms });
      return timerSeq;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
}

function localClockWindow(iso) {
  const date = new Date(iso);
  const nowMinutes = date.getHours() * 60 + date.getMinutes();
  const hhmm = (minutes) => {
    const wrapped = ((minutes % 1440) + 1440) % 1440;
    return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
  };
  return { start: hhmm(nowMinutes - 1), end: hhmm(nowMinutes + 1) };
}

// ---------------------------------------------------------------------------
// Snapshot fixtures
// ---------------------------------------------------------------------------

const BASE_ITEMS = [
  {
    propositionId: 'prop-econ',
    statement: '机会成本是为了得到某样东西而放弃的最佳替代方案的价值。',
    domain: '经济学',
    reason: 'foundation',
    tier: 3,
    cognitive: 'apply',
    mastery: 0.42,
    retrievability: 0.71,
    score: 0.9,
  },
  {
    propositionId: 'prop-math',
    statement: '函数把每个输入映射到唯一的输出。',
    domain: '数学',
    reason: 'frontier',
    tier: 1,
    cognitive: 'remember',
    mastery: 0.5,
    retrievability: 0,
    score: 0.6,
  },
  {
    propositionId: 'prop-old',
    statement: '这是一条没有难度标注的旧数据。',
    domain: '学习',
    reason: 'foundation',
    mastery: 0.5,
    retrievability: 0,
    score: 0.3,
  },
];

const BOARD = { day: TODAY, dose: 3, refreshedAt: FIXED, items: BASE_ITEMS };

const BASE_SETTINGS = {
  dailyLimit: 2,
  quietStart: '00:00',
  quietEnd: '00:00',
  sidebar: true,
  notifications: false,
  sites: { bilibili: true, youtube: true },
};

function seedBoard(overrides = {}) {
  return {
    latticeBillboard: BOARD,
    latticeInterruptSettings: BASE_SETTINGS,
    latticeInterruptState: { day: TODAY, used: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Sidebar + shared env
// ---------------------------------------------------------------------------

async function createSidebarEnv({ seed = seedBoard(), hostname = 'www.bilibili.com', now = FIXED } = {}) {
  const store = makeArea(seed);
  const dom = createDomStub({ hostname });
  const sentMessages = [];
  const context = vm.createContext({
    console,
    crypto: globalThis.crypto,
    Date: makeFakeDate(now),
    document: dom.document,
    location: dom.location,
    setTimeout: (fn, ms) => dom.setTimeout(fn, ms),
    clearTimeout: (id) => dom.clearTimeout(id),
    chrome: {
      storage: { local: store.area },
      runtime: {
        sendMessage: (message) => sentMessages.push(message),
        getURL: (suffix) => `chrome-extension://test/${suffix}`,
      },
    },
  });
  vm.runInContext(sharedSource, context, { filename: 'shared/billboard.js' });
  vm.runInContext(sidebarSource, context, { filename: 'content/sidebar.js' });
  const sidebar = context.LatticeSidebar;
  await waitFor(() => sidebar && sidebar.getState().booting === false, '侧栏初始化');
  return { context, store, dom, sidebar, sentMessages, shared: context.LatticeBillboard };
}

async function expectNoPanel(env, label) {
  await waitFor(() => env.sidebar.getState().booting === false, `${label} boot`);
  assert.equal(env.dom.document.getElementById('lattice-sidebar'), null, `${label}：不应渲染侧栏`);
  assert.equal(env.sidebar.getState().claimed, false, `${label}：不应消耗打扰预算`);
  const queue = env.store.read('latticePendingExposures') || [];
  assert.equal(queue.length, 0, `${label}：不应入队任何曝光`);
}

function findButtonByText(document, text) {
  return document.querySelectorAll('button').find((button) => button.textContent.trim() === text) ?? null;
}

// ---------------------------------------------------------------------------
// Background env
// ---------------------------------------------------------------------------

async function createBackgroundEnv({ seed = {}, now = FIXED } = {}) {
  const store = makeArea(seed);
  const listeners = {};
  const notifications = [];
  const cleared = [];
  const createdTabs = [];
  const alarms = [];
  const chrome = {
    runtime: {
      onInstalled: { addListener: (fn) => (listeners.installed = fn) },
      onStartup: { addListener: (fn) => (listeners.startup = fn) },
      onMessage: { addListener: (fn) => (listeners.message = fn) },
      getURL: (suffix) => `chrome-extension://test/${suffix}`,
      lastError: undefined,
    },
    contextMenus: {
      removeAll: (callback) => callback && callback(),
      create: (item) => (listeners.menuItem = item),
      onClicked: { addListener: (fn) => (listeners.menuClicked = fn) },
    },
    action: { onClicked: { addListener: (fn) => (listeners.actionClicked = fn) } },
    scripting: { executeScript: async () => [{ result: null }] },
    storage: { local: store.area },
    tabs: {
      create: async (options) => {
        createdTabs.push(options);
        return { id: 9 };
      },
    },
    alarms: {
      create: (name, info) => alarms.push({ name, info }),
      onAlarm: { addListener: (fn) => (listeners.alarm = fn) },
    },
    notifications: {
      create: (id, options, callback) => {
        notifications.push({ id, options });
        if (typeof callback === 'function') callback(id);
      },
      clear: (id) => cleared.push(id),
      onClicked: { addListener: (fn) => (listeners.notificationClicked = fn) },
      onButtonClicked: { addListener: (fn) => (listeners.notificationButton = fn) },
      onClosed: { addListener: (fn) => (listeners.notificationClosed = fn) },
    },
  };
  const context = vm.createContext({
    chrome,
    console,
    crypto: globalThis.crypto,
    Date: makeFakeDate(now),
    setTimeout,
    clearTimeout,
    importScripts(file) {
      if (String(file).endsWith('shared/billboard.js')) {
        vm.runInContext(sharedSource, context, { filename: 'shared/billboard.js' });
        return;
      }
      throw new Error(`unexpected importScripts: ${String(file)}`);
    },
  });
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });
  return { context, store, listeners, notifications, cleared, createdTabs, alarms, shared: context.LatticeBillboard };
}

async function main() {
  // -------------------------------------------------------------------------
  step('shared：默认打扰设置（保守：每日 1 次、通知关闭）');
  // -------------------------------------------------------------------------
  const sharedEnv = await (async () => {
    const context = vm.createContext({
      console,
      crypto: globalThis.crypto,
      Date: makeFakeDate(FIXED),
    });
    vm.runInContext(sharedSource, context, { filename: 'shared/billboard.js' });
    return context.LatticeBillboard;
  })();
  const shared = sharedEnv;
  check('默认值：limit 1 / 安静 23:00–08:00 / 侧栏开 / 通知关', () => {
    const settings = shared.normalizeInterruptSettings(null);
    assert.equal(settings.dailyLimit, 1);
    assert.equal(settings.quietStart, '23:00');
    assert.equal(settings.quietEnd, '08:00');
    assert.equal(settings.sidebar, true);
    assert.equal(settings.notifications, false);
    assert.equal(settings.sites.bilibili, true);
    assert.equal(settings.sites.youtube, true);
  });
  check('非法值被归一化：limit 99 -> 3，坏时间回退，通知仅 true 才开', () => {
    const settings = shared.normalizeInterruptSettings({
      dailyLimit: 99,
      quietStart: '25:99',
      quietEnd: 'nope',
      notifications: 'yes',
      sites: { bilibili: false },
    });
    assert.equal(settings.dailyLimit, 3);
    assert.equal(settings.quietStart, '23:00');
    assert.equal(settings.quietEnd, '08:00');
    assert.equal(settings.notifications, false);
    assert.equal(settings.sites.bilibili, false);
    assert.equal(settings.sites.youtube, true);
  });

  // -------------------------------------------------------------------------
  step('shared：打扰预算（0 / 用尽 / 安静时段 / 跨天重置）');
  // -------------------------------------------------------------------------
  await checkAsync('limit 0 -> disabled，且不写状态', async () => {
    const store = makeArea({ latticeInterruptSettings: { ...BASE_SETTINGS, dailyLimit: 0 } });
    const settings = shared.normalizeInterruptSettings({ ...BASE_SETTINGS, dailyLimit: 0 });
    const budget = shared.budgetStatus(settings, { day: TODAY, used: 0 }, FIXED);
    assert.equal(budget.allowed, false);
    assert.equal(budget.reason, 'disabled');
    const claim = await shared.claimInterrupt(store.area, new Date(FIXED));
    assert.equal(claim.ok, false);
    assert.equal(store.read('latticeInterruptState'), undefined);
  });
  await checkAsync('limit 1：第一次 ok，第二次 exhausted', async () => {
    const store = makeArea({
      latticeInterruptSettings: { ...BASE_SETTINGS, dailyLimit: 1 },
      latticeInterruptState: { day: TODAY, used: 0 },
    });
    const first = await shared.claimInterrupt(store.area, new Date(FIXED));
    assert.equal(first.ok, true);
    assert.equal(store.read('latticeInterruptState').used, 1);
    const second = await shared.claimInterrupt(store.area, new Date(FIXED));
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'exhausted');
    assert.equal(store.read('latticeInterruptState').used, 1);
  });
  await checkAsync('昨天用尽的额度今天自动重置', async () => {
    const store = makeArea({ latticeInterruptState: { day: '2026-11-23', used: 3 } });
    const context = await shared.readInterruptContext(store.area, new Date(FIXED));
    assert.equal(context.state.day, TODAY);
    assert.equal(context.state.used, 0);
  });
  await checkAsync('安静时段（跨夜窗口）阻止打扰，窗口相等表示不启用', async () => {
    const window = localClockWindow(FIXED);
    const quiet = shared.normalizeInterruptSettings({
      ...BASE_SETTINGS,
      quietStart: window.start,
      quietEnd: window.end,
    });
    assert.equal(shared.withinQuietHours(quiet, new Date(FIXED)), true);
    const budget = shared.budgetStatus(quiet, { day: TODAY, used: 0 }, FIXED);
    assert.equal(budget.allowed, false);
    assert.equal(budget.reason, 'quiet-hours');
    const disabled = shared.normalizeInterruptSettings({ ...BASE_SETTINGS, quietStart: '00:00', quietEnd: '00:00' });
    assert.equal(shared.withinQuietHours(disabled, new Date(FIXED)), false);
  });
  await checkAsync('releaseInterrupt 归还额度', async () => {
    const store = makeArea({
      latticeInterruptSettings: { ...BASE_SETTINGS, dailyLimit: 2 },
      latticeInterruptState: { day: TODAY, used: 1 },
    });
    await shared.releaseInterrupt(store.area, new Date(FIXED));
    assert.equal(store.read('latticeInterruptState').used, 0);
  });

  // -------------------------------------------------------------------------
  step('shared：快照容错 + 候选选择');
  // -------------------------------------------------------------------------
  check('旧快照（无 tier/cognitive/domain）可读，mastery 对象/数字都能解析', () => {
    const item = shared.normalizeSnapshotItem({ propositionId: 'old', statement: '旧数据', mastery: { mean: 0.42 } });
    assert.equal(item.propositionId, 'old');
    assert.equal(item.mastery, 0.42);
    assert.equal(item.tier, undefined);
    assert.equal(item.cognitive, undefined);
    assert.equal(item.domain, undefined);
    const direct = shared.normalizeSnapshotItem({ propositionId: 'n', mastery: 0.7 });
    assert.equal(direct.mastery, 0.7);
  });
  check('难度展示：★★★☆☆ 应用 / 记忆 / 缺失返回 null', () => {
    assert.equal(shared.describeDifficulty({ tier: 3, cognitive: 'apply' }).text, '★★★☆☆ 应用');
    assert.equal(shared.describeDifficulty({ tier: 1, cognitive: 'remember' }).text, '★☆☆☆☆ 记忆');
    assert.equal(shared.describeDifficulty({ tier: 5 }).text, '★★★★★');
    assert.equal(shared.describeDifficulty({}), null);
  });
  check('站点识别：bilibili / youtube / 其它', () => {
    assert.equal(shared.siteKeyFor('www.bilibili.com'), 'bilibili');
    assert.equal(shared.siteKeyFor('live.bilibili.com'), 'bilibili');
    assert.equal(shared.siteKeyFor('m.youtube.com'), 'youtube');
    assert.equal(shared.siteKeyFor('example.com'), null);
  });
  check('通知候选：最高分且未被展示/通知过；错日/空快照返回 null', () => {
    const board = { day: TODAY, items: BASE_ITEMS };
    const pick = shared.pickNotificationItem(board, { day: TODAY, ids: [] }, null, FIXED);
    assert.equal(pick.propositionId, 'prop-econ');
    const pickAfterShown = shared.pickNotificationItem(
      board,
      { day: TODAY, ids: ['prop-econ'] },
      null,
      FIXED,
    );
    assert.equal(pickAfterShown.propositionId, 'prop-math');
    const pickAfterNotified = shared.pickNotificationItem(
      board,
      { day: TODAY, ids: ['prop-econ'] },
      { day: TODAY, id: 'prop-math' },
      FIXED,
    );
    assert.equal(pickAfterNotified.propositionId, 'prop-old');
    assert.equal(shared.pickNotificationItem({ day: '2026-11-23', items: BASE_ITEMS }, null, null, FIXED), null);
    assert.equal(shared.pickNotificationItem({ day: TODAY, items: [] }, null, null, FIXED), null);
  });

  // -------------------------------------------------------------------------
  step('shared：曝光队列（同日去重、按 id 去重、非法项丢弃）');
  // -------------------------------------------------------------------------
  await checkAsync('同一 (item, kind, day, surface) 只入队一次', async () => {
    const store = makeArea();
    const now = new Date(FIXED);
    await shared.queueExposure(store.area, {
      propositionId: 'p1',
      kind: 'shown',
      surface: 'sidebar',
      at: FIXED,
      day: TODAY,
    });
    await shared.queueExposure(store.area, {
      propositionId: 'p1',
      kind: 'shown',
      surface: 'sidebar',
      at: FIXED,
      day: TODAY,
    });
    await shared.queueExposure(store.area, {
      propositionId: 'p1',
      kind: 'shown',
      surface: 'notification',
      at: FIXED,
      day: TODAY,
    });
    const queue = await shared.readExposureQueue(store.area);
    assert.equal(queue.length, 2);
    assert.equal(queue[0].surface, 'sidebar');
    assert.equal(queue[1].surface, 'notification');
    assert.ok(queue[0].id && queue[0].id !== queue[1].id);
    assert.equal(shared.normalizeExposure({ propositionId: '', kind: 'shown' }), null);
    assert.equal(shared.normalizeExposure({ propositionId: 'p', kind: 'bogus' }), null);
    void now;
  });
  await checkAsync('跨天不合并：同一条目的第二天的 shown 是新记录', async () => {
    const store = makeArea();
    await shared.queueExposure(store.area, { propositionId: 'p1', kind: 'shown', surface: 'sidebar', day: TODAY, at: FIXED });
    await shared.queueExposure(store.area, {
      propositionId: 'p1',
      kind: 'shown',
      surface: 'sidebar',
      day: '2026-11-25',
      at: '2026-11-25T12:00:00.000Z',
    });
    assert.equal((await shared.readExposureQueue(store.area)).length, 2);
  });

  // -------------------------------------------------------------------------
  step('sidebar：渲染最多 2 条，领域/难度/按钮齐全；shown 入队');
  // -------------------------------------------------------------------------
  const rendered = await createSidebarEnv();
  check('面板已挂载且显示 2 条（不超过 2）', () => {
    const panel = rendered.dom.document.getElementById('lattice-sidebar');
    assert.ok(panel, '应挂载侧栏');
    assert.equal(rendered.dom.document.querySelectorAll('#lattice-sidebar .lattice-item').length, 2);
    assert.match(panel.textContent, /经济学/);
    assert.match(panel.textContent, /机会成本/);
    assert.match(panel.textContent, /★★★☆☆ 应用/);
    assert.match(panel.textContent, /★☆☆☆☆ 记忆/);
    assert.match(panel.textContent, /知道了/);
    assert.match(panel.textContent, /不感兴趣/);
    assert.match(panel.textContent, /打开 Lattice/);
  });
  check('打扰预算消耗 1 次；两条 shown 以 sidebar 入队；同日 guard 记 2 条', () => {
    assert.equal(rendered.store.read('latticeInterruptState').day, TODAY);
    assert.equal(rendered.store.read('latticeInterruptState').used, 1);
    const queue = rendered.store.read('latticePendingExposures') || [];
    assert.equal(queue.length, 2);
    for (const entry of queue) {
      assert.equal(entry.kind, 'shown');
      assert.equal(entry.surface, 'sidebar');
      assert.equal(entry.day, TODAY);
    }
    const guard = rendered.store.read('latticeExposureGuard');
    assert.equal(guard.day, TODAY);
    assert.equal(guard.ids.length, 2);
  });
  check('30 秒无操作自动收起，不写 skip 曝光', () => {
    const hideTimer = [...rendered.dom.timers.values()].find((timer) => timer.ms === 30000);
    assert.ok(hideTimer, '应有 30s 自动收起计时器');
    hideTimer.fn();
    const panel = rendered.dom.document.getElementById('lattice-sidebar');
    assert.match(String(panel.className), /lattice-collapsed/);
    assert.equal(rendered.store.read('latticePendingExposures').length, 2, '自动收起不是「不感兴趣」');
  });
  await checkAsync('小把手可重新展开', async () => {
    rendered.sidebar.expand();
    assert.equal(rendered.sidebar.getState().visible, true);
    assert.equal(rendered.dom.document.querySelectorAll('#lattice-sidebar .lattice-item').length, 2);
  });
  await checkAsync('知道了 -> engaged 入队并推进到第二条', async () => {
    const know = rendered.dom.document.querySelector('#lattice-sidebar .lattice-primary');
    know.click();
    await waitFor(() => (rendered.store.read('latticePendingExposures') || []).length === 3, 'engaged 入队');
    const queue = rendered.store.read('latticePendingExposures');
    assert.equal(queue[2].kind, 'engaged');
    assert.equal(queue[2].propositionId, 'prop-econ');
    assert.equal(rendered.dom.document.querySelectorAll('#lattice-sidebar .lattice-item').length, 1);
    assert.match(rendered.dom.document.getElementById('lattice-sidebar').textContent, /函数/);
  });
  await checkAsync('不感兴趣 -> skipped 入队，然后收起', async () => {
    const skip = findButtonByText(rendered.dom.document, '不感兴趣');
    assert.ok(skip, '应找到不感兴趣按钮');
    skip.click();
    await waitFor(() => (rendered.store.read('latticePendingExposures') || []).length === 4, 'skipped 入队');
    const queue = rendered.store.read('latticePendingExposures');
    assert.equal(queue[3].kind, 'skipped');
    assert.equal(queue[3].propositionId, 'prop-math');
    assert.equal(rendered.dom.document.getElementById('lattice-sidebar'), null);
  });
  await checkAsync('预算耗尽（今天已用 2/2）：不渲染、不入队', async () => {
    const env = await createSidebarEnv({
      seed: seedBoard({ latticeInterruptState: { day: TODAY, used: 2 } }),
    });
    await expectNoPanel(env, '预算耗尽');
  });
  await checkAsync('安静时段：不渲染、不入队', async () => {
    const window = localClockWindow(FIXED);
    const env = await createSidebarEnv({
      seed: seedBoard({
        latticeInterruptSettings: { ...BASE_SETTINGS, quietStart: window.start, quietEnd: window.end },
      }),
    });
    await expectNoPanel(env, '安静时段');
  });
  await checkAsync('打扰上限 0：不渲染、不入队', async () => {
    const env = await createSidebarEnv({
      seed: seedBoard({ latticeInterruptSettings: { ...BASE_SETTINGS, dailyLimit: 0 } }),
    });
    await expectNoPanel(env, '上限 0');
  });
  await checkAsync('侧栏总开关关 / 站点开关关：不渲染、不入队', async () => {
    const off = await createSidebarEnv({
      seed: seedBoard({ latticeInterruptSettings: { ...BASE_SETTINGS, sidebar: false } }),
    });
    await expectNoPanel(off, '侧栏关闭');
    const siteOff = await createSidebarEnv({
      seed: seedBoard({
        latticeInterruptSettings: { ...BASE_SETTINGS, sites: { bilibili: false, youtube: true } },
      }),
    });
    await expectNoPanel(siteOff, 'B 站关闭');
  });
  await checkAsync('快照不是今天 / 空快照 / 全部已展示：不渲染、不入队', async () => {
    const stale = await createSidebarEnv({
      seed: seedBoard({ latticeBillboard: { ...BOARD, day: '2026-11-23' } }),
    });
    await expectNoPanel(stale, '昨日快照');
    const empty = await createSidebarEnv({
      seed: seedBoard({ latticeBillboard: { ...BOARD, items: [] } }),
    });
    await expectNoPanel(empty, '空快照');
    const guarded = await createSidebarEnv({
      seed: seedBoard({
        latticeExposureGuard: { day: TODAY, ids: ['prop-econ', 'prop-math', 'prop-old'] },
      }),
    });
    await expectNoPanel(guarded, '全部已展示');
  });
  await checkAsync('旧快照缺字段仍能渲染（领域回退「知识」，无难度行）', async () => {
    const env = await createSidebarEnv({
      seed: seedBoard({
        latticeBillboard: { day: TODAY, items: [{ propositionId: 'old', statement: '旧条目也能显示' }] },
      }),
    });
    const panel = env.dom.document.getElementById('lattice-sidebar');
    assert.ok(panel);
    assert.match(panel.textContent, /知识/);
    assert.match(panel.textContent, /旧条目也能显示/);
    assert.equal(env.dom.document.querySelectorAll('#lattice-sidebar .lattice-difficulty').length, 0);
  });

  // -------------------------------------------------------------------------
  step('background：通知默认关闭 / active hours / 每日一条 / 点击与关闭');
  // -------------------------------------------------------------------------
  const baseSeed = seedBoard();
  await checkAsync('安装时创建 90 分钟提醒', async () => {
    const env = await createBackgroundEnv({ seed: baseSeed });
    env.listeners.installed();
    const alarm = env.alarms.find((entry) => entry.name === 'lattice-notify');
    assert.ok(alarm, '应创建 lattice-notify 提醒');
    assert.equal(alarm.info.periodInMinutes, 90);
  });
  await checkAsync('通知默认 OFF：闹钟不产生通知、不消耗预算', async () => {
    const env = await createBackgroundEnv({ seed: baseSeed });
    env.listeners.alarm({ name: 'lattice-notify' });
    await sleep(120);
    assert.equal(env.notifications.length, 0);
    assert.equal(env.store.read('latticeInterruptState').day, TODAY);
    assert.equal(env.store.read('latticeInterruptState').used, 0);
  });
  await checkAsync('开启通知：选最高分项，只发一条，消耗预算，shown 入队', async () => {
    const env = await createBackgroundEnv({
      seed: seedBoard({
        latticeInterruptSettings: { ...BASE_SETTINGS, dailyLimit: 1, notifications: true },
      }),
    });
    env.listeners.alarm({ name: 'lattice-notify' });
    await waitFor(() => env.notifications.length === 1, '通知创建');
    const notification = env.notifications[0];
    assert.match(notification.id, /prop-econ/, '应选快照里分数最高的命题');
    assert.equal(notification.options.buttons.length, 2);
    assert.match(String(notification.options.iconUrl), /^data:image\/png;base64,/);
    assert.match(String(notification.options.title), /经济学/);
    assert.equal(env.store.read('latticeInterruptState').day, TODAY);
    assert.equal(env.store.read('latticeInterruptState').used, 1);
    const queue = env.store.read('latticePendingExposures') || [];
    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, 'shown');
    assert.equal(queue[0].surface, 'notification');
    assert.equal(queue[0].propositionId, 'prop-econ');
    const notifyDay = env.store.read('latticeNotifyDay');
    assert.equal(notifyDay.state, 'sent');
    assert.equal(notifyDay.id, 'prop-econ');
    // A second alarm the same day cannot notify again (one per day + budget spent).
    env.listeners.alarm({ name: 'lattice-notify' });
    await sleep(120);
    assert.equal(env.notifications.length, 1);
  });
  await checkAsync('预算已被侧栏用掉：通知不发出', async () => {
    const env = await createBackgroundEnv({
      seed: seedBoard({
        latticeInterruptSettings: { ...BASE_SETTINGS, dailyLimit: 1, notifications: true },
        latticeInterruptState: { day: TODAY, used: 1 },
      }),
    });
    env.listeners.alarm({ name: 'lattice-notify' });
    await sleep(120);
    assert.equal(env.notifications.length, 0);
  });
  await checkAsync('安静时段：通知不发出', async () => {
    const window = localClockWindow(FIXED);
    const env = await createBackgroundEnv({
      seed: seedBoard({
        latticeInterruptSettings: {
          ...BASE_SETTINGS,
          dailyLimit: 2,
          notifications: true,
          quietStart: window.start,
          quietEnd: window.end,
        },
      }),
    });
    env.listeners.alarm({ name: 'lattice-notify' });
    await sleep(120);
    assert.equal(env.notifications.length, 0);
  });
  await checkAsync('点击通知按钮：engaged 入队 + 打开新标签页；关闭通知（用户）：skipped', async () => {
    const seeded = await createBackgroundEnv({
      seed: seedBoard({
        latticeInterruptSettings: { ...BASE_SETTINGS, dailyLimit: 2, notifications: true },
      }),
    });
    seeded.listeners.alarm({ name: 'lattice-notify' });
    await waitFor(() => seeded.notifications.length === 1, '通知创建（点击测试）');
    const notification = seeded.notifications[0];
    seeded.listeners.notificationButton(notification.id, 0);
    await waitFor(
      () => (seeded.store.read('latticePendingExposures') || []).some((entry) => entry.kind === 'engaged'),
      'engaged 入队',
    );
    assert.equal(seeded.store.read('latticeNotifyDay').state, 'engaged');
    assert.ok(seeded.createdTabs.some((tab) => String(tab.url).includes('newtab/newtab.html')));
    assert.ok(seeded.cleared.includes(notification.id));
    // A dismissal of an already-handled notification must NOT queue a skip.
    seeded.listeners.notificationClosed(notification.id, true);
    await sleep(80);
    assert.equal(
      (seeded.store.read('latticePendingExposures') || []).filter((entry) => entry.kind === 'skipped').length,
      0,
    );

    const dismissed = await createBackgroundEnv({
      seed: {
        latticeBillboard: BOARD,
        latticeInterruptSettings: { ...BASE_SETTINGS, dailyLimit: 2, notifications: true },
        latticeInterruptState: { day: TODAY, used: 1 },
        latticeNotifyDay: {
          day: TODAY,
          id: 'prop-math',
          notificationId: 'lattice-notify-dismissed',
          state: 'sent',
        },
      },
    });
    dismissed.listeners.notificationClosed('lattice-notify-dismissed', true);
    await waitFor(
      () => (dismissed.store.read('latticePendingExposures') || []).some((entry) => entry.kind === 'skipped'),
      'skipped 入队',
    );
    const skipped = (dismissed.store.read('latticePendingExposures') || []).find((entry) => entry.kind === 'skipped');
    assert.equal(skipped.propositionId, 'prop-math');
    assert.equal(skipped.surface, 'notification');
    assert.equal(dismissed.store.read('latticeNotifyDay').state, 'skipped');
  });
  await checkAsync('程序化关闭（byUser=false）不算 skip', async () => {
    const env = await createBackgroundEnv({
      seed: {
        latticeBillboard: BOARD,
        latticeInterruptSettings: { ...BASE_SETTINGS, dailyLimit: 2, notifications: true },
        latticeNotifyDay: {
          day: TODAY,
          id: 'prop-math',
          notificationId: 'lattice-notify-programmatic',
          state: 'sent',
        },
      },
    });
    env.listeners.notificationClosed('lattice-notify-programmatic', false);
    await sleep(80);
    assert.equal((env.store.read('latticePendingExposures') || []).length, 0);
  });

  // -------------------------------------------------------------------------
  console.log('');
  if (failures > 0) {
    console.log(`M2B SMOKE FAILED: ${failures} 项未通过`);
    process.exitCode = 1;
    return;
  }
  console.log('M2B SMOKE OK: 全部检查通过');
}

main().catch((err) => {
  console.error('M2B SMOKE CRASHED', err);
  process.exitCode = 1;
});
