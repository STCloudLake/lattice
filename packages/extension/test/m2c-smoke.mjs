/**
 * Headless smoke test of the M2c ambient surfaces (no browser needed).
 *
 * Loads the SAME `shared/billboard.js` + `content/ambient.js` the manifest injects,
 * in a vm with a small DOM stub + fake chrome.storage.local:
 *
 *   - hard blocklist (mail / bank / payment / checkout / localhost admin /
 *     data-lattice-optout / non-http pages) never renders anything;
 *   - random appearance (video 50% vs 25%), 20-minute per-tab cooldown, budget
 *     gating, force override;
 *   - ambient pill -> panel -> 30s auto-collapse -> Esc; narrow viewports show
 *     the pill only; the pill never mutates <body> layout;
 *   - bilibili/YouTube comment + recommendation injection: exactly one each,
 *     marker + re-attach after a container is replaced (SPA), stale-node cleanup,
 *     no duplicate;
 *   - "感兴趣": same-platform search URL (bilibili/youtube; encoded), non-video
 *     opens the Lattice newtab; logged as exposure.engaged;
 *   - "换一条" advances to another snapshot item; "收起" never re-injects;
 *   - "此站不再显示" persists the hostname and stops all surfaces;
 *   - NO IMPERSONATION: every injected node carries a visible Lattice badge and
 *     contains no generated username/avatar/like/time "comment" structure.
 *
 * Run from the repo root (after `npm run build`):
 *   node packages/extension/test/m2c-smoke.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const sharedSource = readFileSync(path.join(here, '../shared/billboard.js'), 'utf8');
const ambientSource = readFileSync(path.join(here, '../content/ambient.js'), 'utf8');

let failures = 0;
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
async function waitFor(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  throw new Error(`等待超时：${label}`);
}

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

function localClockWindow(iso) {
  const date = new Date(iso);
  const minutes = date.getHours() * 60 + date.getMinutes();
  const hhmm = (value) => {
    const wrapped = ((value % 1440) + 1440) % 1440;
    return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
  };
  return { start: hhmm(minutes - 1), end: hhmm(minutes + 1) };
}

function makeArea(seed = {}) {
  const data = { ...seed };
  return {
    data,
    area: {
      async get(keys) {
        const wanted = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of wanted) if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = data[key];
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
// Minimal DOM stub — enough for content/ambient.js.
// ---------------------------------------------------------------------------

function createDomStub({ innerWidth = 1400, sessionSeed = {} } = {}) {
  const registry = new Map();
  const timeouts = new Map();
  const intervals = new Map();
  let timerSeq = 0;
  const documentListeners = {};
  const mutations = [];
  let mutationObservers = [];

  const parseSimple = (selector) => {
    const attr = /^\[([a-zA-Z0-9_-]+)(?:=["']([^"']*)["'])?\]$/.exec(selector);
    if (attr) return { kind: 'attr', name: attr[1], value: attr[2] === undefined ? null : attr[2] };
    if (selector.startsWith('#')) return { kind: 'id', value: selector.slice(1) };
    if (selector.startsWith('.')) return { kind: 'class', value: selector.slice(1) };
    return { kind: 'tag', value: selector.toLowerCase() };
  };

  const matchesSimple = (element, selector) => {
    const spec = parseSimple(selector);
    if (spec.kind === 'id') return element.id === spec.value;
    if (spec.kind === 'class') return String(element.className).split(/\s+/).filter(Boolean).includes(spec.value);
    if (spec.kind === 'attr') {
      if (!Object.prototype.hasOwnProperty.call(element.attributes, spec.name)) return false;
      return spec.value === null || element.attributes[spec.name] === spec.value;
    }
    return element.tagName.toLowerCase() === spec.value;
  };

  const descendantsOf = (node, out = []) => {
    for (const child of node.children) {
      if (child.nodeType !== 1) continue;
      out.push(child);
      descendantsOf(child, out);
    }
    return out;
  };

  const queryAll = (root, selector) => {
    const parts = String(selector).trim().split(/\s+/);
    let scope = [root];
    let first = true;
    for (const part of parts) {
      const next = [];
      for (const node of scope) {
        const pool = first ? [node, ...descendantsOf(node)] : descendantsOf(node);
        for (const element of pool) if (matchesSimple(element, part)) next.push(element);
      }
      scope = next;
      first = false;
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
      this.disabled = false;
      this.type = '';
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
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name);
    }
    removeAttribute(name) {
      delete this.attributes[name];
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    insertBefore(child, reference) {
      if (child.parentNode) child.parentNode.removeChild(child);
      const index = reference ? this.children.indexOf(reference) : -1;
      child.parentNode = this;
      if (index < 0) this.children.push(child);
      else this.children.splice(index, 0, child);
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
    get firstChild() {
      return this.children[0] ?? null;
    }
    get nextSibling() {
      if (!this.parentNode) return null;
      const index = this.parentNode.children.indexOf(this);
      return this.parentNode.children[index + 1] ?? null;
    }
    get isConnected() {
      let node = this;
      while (node) {
        if (node === document.documentElement) return true;
        node = node.parentNode;
      }
      return false;
    }
    contains(node) {
      if (!node) return false;
      return node === this || descendantsOf(this).includes(node);
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
      return this.dispatchEvent({ type: 'click', target: this, stopPropagation() {}, preventDefault() {} });
    }
    set textContent(value) {
      this.children = [];
      this._text = value === undefined || value === null ? '' : String(value);
    }
    get textContent() {
      return this._text + this.children.map((child) => child.textContent).join('');
    }
    querySelector(selector) {
      return queryAll(this, selector)[0] ?? null;
    }
    querySelectorAll(selector) {
      return queryAll(this, selector);
    }
  }

  const documentElement = new Element('html');
  const head = new Element('head');
  const body = new Element('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const document = {
    readyState: 'complete',
    documentElement,
    head,
    body,
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    addEventListener(type, handler) {
      const list = documentListeners[type] ?? [];
      list.push(handler);
      documentListeners[type] = list;
    },
    getElementById(id) {
      const element = registry.get(id);
      return element && element.isConnected ? element : null;
    },
    querySelector(selector) {
      return queryAll(documentElement, selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      return queryAll(documentElement, selector);
    },
    contains(node) {
      return Boolean(node) && (node === documentElement || documentElement.contains(node));
    },
  };

  const sessionData = { ...sessionSeed };
  const sessionStorage = {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(sessionData, key) ? sessionData[key] : null;
    },
    setItem(key, value) {
      sessionData[key] = String(value);
    },
    removeItem(key) {
      delete sessionData[key];
    },
    dump() {
      return { ...sessionData };
    },
  };

  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      mutationObservers.push(this);
    }
    observe() {}
    disconnect() {
      mutationObservers = mutationObservers.filter((observer) => observer !== this);
    }
  }

  const dom = {
    document,
    documentElement,
    body,
    sessionStorage,
    MutationObserver,
    timeouts,
    intervals,
    setTimeout(fn, ms) {
      timerSeq += 1;
      timeouts.set(timerSeq, { id: timerSeq, fn, ms });
      return timerSeq;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(fn, ms) {
      timerSeq += 1;
      intervals.set(timerSeq, { id: timerSeq, fn, ms });
      return timerSeq;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    runTimerMs(ms) {
      const matching = [...timeouts.values()].filter((timer) => timer.ms === ms);
      for (const timer of matching) {
        timeouts.delete(timer.id);
        timer.fn();
      }
      return matching.length;
    },
    runInterval() {
      for (const timer of [...intervals.values()]) timer.fn();
    },
    dispatchKeydown(key) {
      for (const handler of documentListeners.keydown ?? []) {
        handler({ type: 'keydown', key, preventDefault() {}, stopPropagation() {} });
      }
    },
    triggerMutation() {
      for (const observer of [...mutationObservers]) observer.callback([]);
    },
    innerWidth,
  };
  return dom;
}

/** Convenience: create an element with attributes/children. */
function el(document, tag, attributes = {}, text = '') {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  if (text) element.textContent = text;
  return element;
}

// ---------------------------------------------------------------------------
// Fixtures: snapshot + settings
// ---------------------------------------------------------------------------

const ITEMS = [
  {
    propositionId: 'prop-econ',
    name: '机会成本',
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
    propositionId: 'prop-sunk',
    name: '沉没成本',
    statement: '沉没成本是已经发生且无法收回的成本。',
    domain: '经济学',
    reason: 'frontier',
    tier: 1,
    cognitive: 'remember',
    mastery: 0.5,
    retrievability: 0,
    score: 0.6,
  },
  {
    propositionId: 'prop-func',
    name: '函数',
    statement: '函数把每个输入映射到唯一的输出。',
    domain: '数学',
    reason: 'foundation',
    tier: 2,
    cognitive: 'understand',
    mastery: 0.5,
    retrievability: 0,
    score: 0.3,
  },
  {
    propositionId: 'prop-limit',
    name: '边际效用',
    statement: '边际效用递减：每增加一单位消费，新增的满足感下降。',
    domain: '经济学',
    reason: 'frontier',
    tier: 3,
    cognitive: 'understand',
    mastery: 0.5,
    retrievability: 0,
    score: 0.25,
  },
  {
    propositionId: 'prop-slope',
    name: '需求曲线',
    statement: '在预算约束下最大化效用，会使需求曲线向右下倾斜。',
    domain: '经济学',
    reason: 'foundation',
    tier: 2,
    cognitive: 'analyze',
    mastery: 0.5,
    retrievability: 0,
    score: 0.2,
  },
];

const BOARD = { day: TODAY, dose: 5, refreshedAt: FIXED, items: ITEMS };
const BASE_SETTINGS = {
  dailyLimit: 3,
  quietStart: '00:00',
  quietEnd: '00:00',
  sidebar: true,
  notifications: false,
  ambient: true,
  injectComments: true,
  searchJump: true,
  sites: { bilibili: true, youtube: true },
};

function seedFor(overrides = {}) {
  return {
    latticeBillboard: BOARD,
    latticeInterruptSettings: BASE_SETTINGS,
    latticeInterruptState: { day: TODAY, used: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Ambient env (vm)
// ---------------------------------------------------------------------------

function createAmbientEnv(options = {}) {
  const {
    hostname = 'example.com',
    pathname = '/article',
    protocol = 'https:',
    innerWidth = 1400,
    seed = seedFor(),
    sessionSeed = {},
    setup,
    mathRandom = Math.random,
  } = options;
  const dom = createDomStub({ innerWidth, sessionSeed });
  const store = makeArea(seed);
  const sent = [];
  const storageListeners = [];
  let ambient = null;
  const location = {
    protocol,
    hostname,
    pathname,
    search: '',
    href: `${protocol}//${hostname}${pathname}`,
  };
  const customMath = Object.create(Math);
  customMath.random = mathRandom;

  const context = vm.createContext({
    console,
    crypto: globalThis.crypto,
    Date: makeFakeDate(FIXED),
    Math: customMath,
    document: dom.document,
    location,
    sessionStorage: dom.sessionStorage,
    setTimeout: (fn, ms) => dom.setTimeout(fn, ms),
    clearTimeout: (id) => dom.clearTimeout(id),
    setInterval: (fn, ms) => dom.setInterval(fn, ms),
    clearInterval: (id) => dom.clearInterval(id),
    MutationObserver: dom.MutationObserver,
    innerWidth,
    chrome: {
      storage: {
        local: store.area,
        onChanged: {
          addListener(fn) {
            storageListeners.push(fn);
          },
        },
      },
      runtime: {
        sendMessage(message) {
          sent.push(message);
          return Promise.resolve({ ok: true });
        },
        getURL: (suffix) => `chrome-extension://test/${suffix}`,
      },
    },
  });
  if (typeof setup === 'function') setup(dom.document);
  vm.runInContext(sharedSource, context, { filename: 'shared/billboard.js' });
  vm.runInContext(ambientSource, context, { filename: 'content/ambient.js' });
  ambient = context.LatticeAmbient;
  return { context, dom, store, sent, storageListeners, ambient, location, shared: context.LatticeBillboard };
}

async function settle(env) {
  await waitFor(() => env.ambient.getState().booting === false, '环境脚本 boot');
  return env.ambient.getState();
}

function setupBilibili(document) {
  const comment = el(document, 'div', { id: 'comment' });
  const replies = el(document, 'div', { class: 'reply-list' });
  replies.appendChild(el(document, 'div', { class: 'reply-item' }, '真实用户评论内容'));
  replies.appendChild(el(document, 'div', { class: 'reply-item' }, '第二条真实评论'));
  comment.appendChild(replies);
  document.body.appendChild(comment);

  const recommend = el(document, 'div', { class: 'rec-list' });
  recommend.appendChild(el(document, 'div', { class: 'video-page-card-small' }, '真实推荐视频'));
  document.body.appendChild(recommend);
}

function setupYoutube(document) {
  const comments = el(document, 'div', { id: 'comments' });
  comments.appendChild(el(document, 'div', { class: 'comment-thread' }, '真实 YouTube 评论'));
  document.body.appendChild(comments);

  const secondary = el(document, 'div', { id: 'secondary' });
  const compact = el(document, 'ytd-compact-video-renderer', {}, '真实推荐视频');
  secondary.appendChild(compact);
  document.body.appendChild(secondary);
}

function queueOf(env) {
  return env.store.read('latticePendingExposures') || [];
}
function findQueue(env, kind, surface) {
  return queueOf(env).filter((entry) => entry.kind === kind && (!surface || entry.surface === surface));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const sharedContext = vm.createContext({ console, Math, Date: makeFakeDate(FIXED) });
  vm.runInContext(sharedSource, sharedContext, { filename: 'shared/billboard.js' });
  const shared = sharedContext.LatticeBillboard;

  // -------------------------------------------------------------------------
  step('shared：敏感站点硬排除（邮箱/银行/支付/结账/本地管理页）');
  // -------------------------------------------------------------------------
  check('邮箱、银行、支付站点与结账路径被排除', () => {
    const blocked = [
      { protocol: 'https:', hostname: 'mail.google.com', pathname: '/' },
      { protocol: 'https:', hostname: 'mail.yahoo.com', pathname: '/' },
      { protocol: 'https:', hostname: 'www.bankofamerica.com', pathname: '/' },
      { protocol: 'https:', hostname: 'mybank.example.cn', pathname: '/' },
      { protocol: 'https:', hostname: 'www.paypal.com', pathname: '/' },
      { protocol: 'https:', hostname: 'shop.example.com', pathname: '/checkout/pay' },
      { protocol: 'https:', hostname: 'example.com', pathname: '/billing/invoice' },
      { protocol: 'https:', hostname: 'localhost', pathname: '/admin' },
      { protocol: 'https:', hostname: '127.0.0.1', pathname: '/wp-admin' },
      { protocol: 'chrome-extension:', hostname: 'abc', pathname: '/newtab.html' },
    ];
    for (const page of blocked) assert.equal(shared.isBlockedPage(page), true, JSON.stringify(page));
  });
  check('普通内容页 / 本地开发页 / 视频站不被排除', () => {
    const allowed = [
      { protocol: 'https:', hostname: 'example.com', pathname: '/article' },
      { protocol: 'https:', hostname: 'www.bilibili.com', pathname: '/video/BV1' },
      { protocol: 'https:', hostname: 'www.youtube.com', pathname: '/watch' },
      { protocol: 'http:', hostname: '127.0.0.1', pathname: '/generic' },
      { protocol: 'http:', hostname: 'localhost', pathname: '/docs' },
    ];
    for (const page of allowed) assert.equal(shared.isBlockedPage(page), false, JSON.stringify(page));
  });

  // -------------------------------------------------------------------------
  step('shared：随机出现策略 + 20 分钟/标签页冷却 + 每站屏蔽');
  // -------------------------------------------------------------------------
  check('视频站 ~50%，其它页面 ~25%，force 覆盖随机', () => {
    assert.equal(shared.shouldShowAmbient({ hostname: 'www.bilibili.com', random: () => 0.49 }), true);
    assert.equal(shared.shouldShowAmbient({ hostname: 'www.bilibili.com', random: () => 0.51 }), false);
    assert.equal(shared.shouldShowAmbient({ hostname: 'example.com', random: () => 0.24 }), true);
    assert.equal(shared.shouldShowAmbient({ hostname: 'example.com', random: () => 0.26 }), false);
    assert.equal(shared.shouldShowAmbient({ hostname: 'example.com', force: true, random: () => 0.99 }), true);
  });
  check('20 分钟冷却：刚展示过跳过，时间够了重新允许', () => {
    const store = { value: null };
    const session = {
      getItem: () => store.value,
      setItem: (_key, value) => {
        store.value = value;
      },
    };
    assert.equal(shared.ambientCoolingDown(session, FIXED), false);
    shared.markAmbientShown(session, FIXED);
    assert.equal(shared.ambientCoolingDown(session, new Date(new Date(FIXED).getTime() + 60 * 1000)), true);
    assert.equal(shared.ambientCoolingDown(session, new Date(new Date(FIXED).getTime() + 21 * 60 * 1000)), false);
  });
  check('每站屏蔽：精确 host 与子域都命中', () => {
    assert.equal(shared.isHostOptedOut('www.bilibili.com', ['www.bilibili.com']), true);
    assert.equal(shared.isHostOptedOut('m.bilibili.com', ['bilibili.com']), true);
    assert.equal(shared.isHostOptedOut('example.com', ['bilibili.com']), false);
  });

  // -------------------------------------------------------------------------
  step('shared：站内搜索 URL（name 优先 / 截断 / 编码）');
  // -------------------------------------------------------------------------
  check('bilibili / youtube URL 与编码', () => {
    assert.equal(shared.buildSearchQuery(ITEMS[0]), '机会成本');
    assert.equal(
      shared.searchUrl('bilibili', '机会成本 & 沉没成本'),
      `https://search.bilibili.com/all?keyword=${encodeURIComponent('机会成本 & 沉没成本')}`,
    );
    assert.equal(
      shared.searchUrl('youtube', '函数 数学'),
      `https://www.youtube.com/results?search_query=${encodeURIComponent('函数 数学')}`,
    );
    assert.equal(shared.searchUrl('unknown', 'x'), '');
  });
  check('没有 name 时用 statement 前 24 字 + 领域', () => {
    const query = shared.buildSearchQuery({
      statement: '这是一条非常长的命题用来验证截断逻辑是否工作正常并且不超过二十四个字',
      domain: '经济学',
    });
    assert.ok(query.length <= 24 + 1 + '经济学'.length);
    assert.ok(query.endsWith('经济学'));
  });
  check('快照保留 name 字段，旧快照缺 name 也不报错', () => {
    assert.equal(shared.normalizeSnapshotItem(ITEMS[0]).name, '机会成本');
    assert.equal(shared.normalizeSnapshotItem({ propositionId: 'x', statement: '旧' }).name, undefined);
  });
  check('pickNextSnapshotItem 跳过本页已用与今天已展示的', () => {
    const picked = shared.pickNextSnapshotItem(BOARD, { day: TODAY, ids: ['prop-econ'] }, new Set(['prop-sunk']), FIXED);
    assert.equal(picked.propositionId, 'prop-func');
  });
  check('settings 新字段默认开启且可分别关闭', () => {
    const defaults = shared.normalizeInterruptSettings(null);
    assert.equal(defaults.ambient, true);
    assert.equal(defaults.injectComments, true);
    assert.equal(defaults.searchJump, true);
    const off = shared.normalizeInterruptSettings({ ambient: false, injectComments: false, searchJump: false });
    assert.equal(off.ambient, false);
    assert.equal(off.injectComments, false);
    assert.equal(off.searchJump, false);
  });

  // -------------------------------------------------------------------------
  step('ambient：硬排除页面不渲染、不入队（即使 force=true）');
  // -------------------------------------------------------------------------
  const blockedCases = [
    ['mail.google.com', '/'],
    ['www.bankofamerica.com', '/'],
    ['shop.example.com', '/checkout'],
    ['localhost', '/admin'],
  ];
  for (const [hostname, pathname] of blockedCases) {
    await checkAsync(`敏感页 ${hostname}${pathname} 无胶囊/无曝光`, async () => {
      const env = createAmbientEnv({
        hostname,
        pathname,
        seed: seedFor({ latticeForceAmbient: true }),
      });
      await settle(env);
      assert.equal(env.dom.document.getElementById('lattice-ambient'), null);
      assert.equal(queueOf(env).length, 0);
    });
  }
  await checkAsync('页面带 data-lattice-optout 属性时完全不渲染', async () => {
    const env = createAmbientEnv({
      seed: seedFor({ latticeForceAmbient: true }),
      setup(document) {
        document.documentElement.setAttribute('data-lattice-optout', '1');
      },
    });
    await settle(env);
    assert.equal(env.dom.document.getElementById('lattice-ambient'), null);
    assert.equal(queueOf(env).length, 0);
  });

  // -------------------------------------------------------------------------
  step('ambient：预算 / 安静时段 / 开关 / 每站屏蔽（force=false）');
  // -------------------------------------------------------------------------
  await checkAsync('预算耗尽：不渲染、不消耗', async () => {
    const env = createAmbientEnv({
      seed: seedFor({ latticeInterruptState: { day: TODAY, used: 3 } }),
      mathRandom: () => 0,
    });
    await settle(env);
    assert.equal(env.dom.document.getElementById('lattice-ambient'), null);
    assert.equal(env.store.read('latticeInterruptState').used, 3);
  });
  await checkAsync('安静时段：不渲染', async () => {
    const window = localClockWindow(FIXED);
    const env = createAmbientEnv({
      seed: seedFor({ latticeInterruptSettings: { ...BASE_SETTINGS, quietStart: window.start, quietEnd: window.end } }),
      mathRandom: () => 0,
    });
    await settle(env);
    assert.equal(env.dom.document.getElementById('lattice-ambient'), null);
  });
  await checkAsync('任意网页显示关闭 / 本站已屏蔽：不渲染', async () => {
    const off = createAmbientEnv({
      seed: seedFor({ latticeInterruptSettings: { ...BASE_SETTINGS, ambient: false } }),
      mathRandom: () => 0,
    });
    await settle(off);
    assert.equal(off.dom.document.getElementById('lattice-ambient'), null);
    const optedOut = createAmbientEnv({
      seed: seedFor({ latticeAmbientOptOut: ['example.com'] }),
      mathRandom: () => 0,
    });
    await settle(optedOut);
    assert.equal(optedOut.dom.document.getElementById('lattice-ambient'), null);
  });
  await checkAsync('冷却中：不渲染；冷却过期后渲染并消耗 1 次预算', async () => {
    const cooling = createAmbientEnv({
      seed: seedFor(),
      sessionSeed: { latticeAmbientShownAt: String(new Date(FIXED).getTime() - 60 * 1000) },
      mathRandom: () => 0,
    });
    await settle(cooling);
    assert.equal(cooling.dom.document.getElementById('lattice-ambient'), null);
    const fresh = createAmbientEnv({ seed: seedFor(), mathRandom: () => 0 });
    await settle(fresh);
    assert.ok(fresh.dom.document.getElementById('lattice-ambient'), '应渲染胶囊');
    assert.equal(fresh.store.read('latticeInterruptState').used, 1);
  });

  // -------------------------------------------------------------------------
  step('ambient：胶囊 -> 面板 -> 30s 自动收起 / Esc / 窄屏只有胶囊');
  // -------------------------------------------------------------------------
  const pillEnv = createAmbientEnv({ seed: seedFor({ latticeForceAmbient: true }) });
  await settle(pillEnv);
  await waitFor(() => pillEnv.dom.document.getElementById('lattice-ambient') !== null, '胶囊渲染');
  const bodyChildrenBefore = pillEnv.dom.document.body.children.length;
  const bodyStyleBefore = pillEnv.dom.document.body.getAttribute('style');
  check('胶囊在右下角（fixed）+ 面板初始收起', () => {
    assert.ok(pillEnv.dom.document.querySelector('#lattice-ambient .lattice-pill'), '有胶囊');
    assert.equal(pillEnv.dom.document.querySelector('#lattice-ambient .lattice-ambient-panel').hidden, true);
    assert.equal(pillEnv.dom.document.getElementById('lattice-ambient').parentNode, pillEnv.dom.document.documentElement);
  });
  check('点击胶囊展开 300px 面板（一张卡 + Lattice 标识）', () => {
    pillEnv.dom.document.querySelector('#lattice-ambient .lattice-pill').click();
    const panel = pillEnv.dom.document.querySelector('#lattice-ambient .lattice-ambient-panel');
    assert.equal(panel.hidden, false);
    assert.ok(panel.querySelector('.lattice-card'), '面板里有卡片');
    assert.match(panel.textContent, /Lattice · 知识/);
    assert.match(panel.textContent, /机会成本/);
    assert.match(panel.textContent, /感兴趣/);
  });
  check('不改变 <body> 布局（子节点数/内联样式不变）', () => {
    assert.equal(pillEnv.dom.document.body.children.length, bodyChildrenBefore);
    assert.equal(pillEnv.dom.document.body.getAttribute('style'), bodyStyleBefore);
  });
  check('30 秒无交互自动收起（按时长 30000 的定时器）', () => {
    assert.ok(pillEnv.dom.runTimerMs(30000) >= 1, '应有 30s 定时器');
    assert.equal(pillEnv.dom.document.querySelector('#lattice-ambient .lattice-ambient-panel').hidden, true);
  });
  await checkAsync('Esc 关闭面板；窄屏点击胶囊不展开', async () => {
    pillEnv.dom.document.querySelector('#lattice-ambient .lattice-pill').click();
    assert.equal(pillEnv.dom.document.querySelector('#lattice-ambient .lattice-ambient-panel').hidden, false);
    pillEnv.dom.dispatchKeydown('Escape');
    assert.equal(pillEnv.dom.document.querySelector('#lattice-ambient .lattice-ambient-panel').hidden, true);

    const narrow = createAmbientEnv({ seed: seedFor({ latticeForceAmbient: true }), innerWidth: 900 });
    await settle(narrow);
    await waitFor(() => narrow.dom.document.getElementById('lattice-ambient') !== null, '窄屏胶囊');
    narrow.dom.document.querySelector('#lattice-ambient .lattice-pill').click();
    assert.equal(narrow.dom.document.querySelector('#lattice-ambient .lattice-ambient-panel').hidden, true);
    assert.ok(narrow.sent.some((message) => message.type === 'lattice-open-newtab'), '窄屏点击打开新标签页');
  });

  // -------------------------------------------------------------------------
  step('comment/recommend：bilibili 注入、唯一性、归因、无冒充');
  // -------------------------------------------------------------------------
  const biliEnv = createAmbientEnv({
    hostname: 'www.bilibili.com',
    pathname: '/video/BV1xx',
    seed: seedFor({ latticeForceAmbient: true }),
    setup: setupBilibili,
  });
  await settle(biliEnv);
  await waitFor(() => biliEnv.ambient.getState().injected.comment && biliEnv.ambient.getState().injected.recommend, '注入两个表面');
  biliEnv.dom.runTimerMs(700); // video-page pill grace timer (sidebar absent in this stub)
  check('评论区/推荐位各注入 1 条，带 data-lattice 标记', () => {
    assert.equal(biliEnv.dom.document.querySelectorAll('[data-lattice="comment"]').length, 1);
    assert.equal(biliEnv.dom.document.querySelectorAll('[data-lattice="recommend"]').length, 1);
    assert.equal(biliEnv.dom.document.querySelector('[data-lattice="comment"]').parentNode.id, 'comment');
  });
  check('注入卡片始终带 Lattice 标识 + 领域/难度', () => {
    const card = biliEnv.dom.document.querySelector('[data-lattice="comment"]');
    assert.match(card.textContent, /Lattice · 知识/);
    assert.match(card.textContent, /经济学/);
    assert.match(card.textContent, /★★★☆☆ 应用/);
    assert.match(card.querySelector('.lattice-card-statement').textContent, /机会成本/);
  });
  check('不伪造评论结构（无用户名/头像/点赞/时间/楼层）', () => {
    for (const surface of ['comment', 'recommend']) {
      const card = biliEnv.dom.document.querySelector(`[data-lattice="${surface}"]`);
      assert.equal(card.querySelectorAll('[class*="avatar"]').length, 0);
      assert.equal(card.querySelectorAll('[class*="user-name"],[class*="username"],[class*="user "]').length, 0);
      assert.equal(card.querySelectorAll('[class*="like"]').length, 0);
      assert.doesNotMatch(card.textContent, /网友|点赞|\d+\s*楼|回复/);
      assert.equal(card.querySelectorAll('[data-lattice="comment"],[data-lattice="recommend"]').length, 0);
    }
  });
  check('不重排平台原有内容：真实评论/推荐仍在原位', () => {
    const comment = biliEnv.dom.document.getElementById('comment');
    assert.match(comment.children[0].textContent, /真实用户评论内容/);
    assert.match(comment.children[0].textContent, /第二条真实评论/);
    const recommend = biliEnv.dom.document.querySelector('.rec-list');
    assert.equal(recommend.children[0].className, 'video-page-card-small');
    assert.equal(recommend.children[recommend.children.length - 1].getAttribute('data-lattice'), 'recommend');
  });
  await checkAsync('重复扫描不重复注入（marker + WeakSet）', async () => {
    await biliEnv.ambient.scanNow();
    await biliEnv.ambient.scanNow();
    assert.equal(biliEnv.dom.document.querySelectorAll('[data-lattice="comment"]').length, 1);
    assert.equal(biliEnv.dom.document.querySelectorAll('[data-lattice="recommend"]').length, 1);
  });
  await checkAsync('SPA 容器替换后重新挂载，旧节点清理且仍各只 1 条', async () => {
    const oldComment = biliEnv.dom.document.getElementById('comment');
    oldComment.remove();
    const fresh = el(biliEnv.dom.document, 'div', { id: 'comment' });
    const list = el(biliEnv.dom.document, 'div', { class: 'reply-list' });
    list.appendChild(el(biliEnv.dom.document, 'div', { class: 'reply-item' }, '新视频的评论'));
    fresh.appendChild(list);
    biliEnv.dom.document.body.appendChild(fresh);
    biliEnv.dom.triggerMutation();
    await biliEnv.ambient.scanNow();
    assert.equal(biliEnv.dom.document.querySelectorAll('[data-lattice="comment"]').length, 1);
    const card = biliEnv.dom.document.querySelector('[data-lattice="comment"]');
    assert.equal(card.parentNode.id, 'comment');
    assert.match(card.textContent, /Lattice · 知识/);
    assert.equal(biliEnv.dom.document.getElementById('comment').children[0].className, 'reply-list');
  });
  await checkAsync('「换一条」换到下一命题并再记一条 shown', async () => {
    const card = biliEnv.dom.document.querySelector('[data-lattice="comment"]');
    const before = card.getAttribute('data-proposition-id');
    const shownBefore = findQueue(biliEnv, 'shown', 'comment').length;
    card.querySelector('.lattice-next').click();
    await waitFor(() => card.getAttribute('data-proposition-id') !== before, '换一条');
    assert.equal(findQueue(biliEnv, 'shown', 'comment').length, shownBefore + 1);
    assert.equal(biliEnv.dom.document.querySelectorAll('[data-lattice="comment"]').length, 1);
  });
  await checkAsync('「收起」移除卡片且不再被扫描注入', async () => {
    const card = biliEnv.dom.document.querySelector('[data-lattice="comment"]');
    card.querySelector('.lattice-collapse-card').click();
    assert.equal(biliEnv.dom.document.querySelector('[data-lattice="comment"]'), null);
    await biliEnv.ambient.scanNow();
    assert.equal(biliEnv.dom.document.querySelector('[data-lattice="comment"]'), null);
  });
  await checkAsync('「感兴趣」记 engaged(surface=comment) 并请求站内搜索', async () => {
    const recommendCard = biliEnv.dom.document.querySelector('[data-lattice="recommend"]');
    const item = recommendCard.querySelector('.lattice-card-statement').textContent;
    recommendCard.querySelector('.lattice-primary').click();
    await waitFor(() => findQueue(biliEnv, 'engaged', 'recommend').length === 1, 'engaged 入队');
    const search = biliEnv.sent.find((message) => message.type === 'lattice-open-search');
    assert.ok(search, '应发送 lattice-open-search');
    assert.equal(search.platform, 'bilibili');
    assert.ok(search.query.length > 0, `查询词不能为空（命题：${item}）`);
    assert.match(recommendCard.textContent, /已感兴趣/);
  });

  // -------------------------------------------------------------------------
  step('comment/recommend：YouTube 适配器');
  // -------------------------------------------------------------------------
  const ytEnv = createAmbientEnv({
    hostname: 'www.youtube.com',
    pathname: '/watch?v=1',
    seed: seedFor({ latticeForceAmbient: true }),
    setup: setupYoutube,
  });
  await settle(ytEnv);
  await waitFor(() => ytEnv.ambient.getState().injected.comment && ytEnv.ambient.getState().injected.recommend, 'YouTube 注入');
  check('YouTube 评论区/推荐位各 1 条且带 Lattice 标识', () => {
    assert.equal(ytEnv.dom.document.querySelectorAll('[data-lattice="comment"]').length, 1);
    assert.equal(ytEnv.dom.document.querySelectorAll('[data-lattice="recommend"]').length, 1);
    assert.match(ytEnv.dom.document.querySelector('[data-lattice="comment"]').textContent, /Lattice · 知识/);
    assert.match(ytEnv.dom.document.querySelector('[data-lattice="recommend"]').textContent, /Lattice · 知识/);
    assert.equal(ytEnv.dom.document.getElementById('comments').children[0].className, 'comment-thread');
  });
  await checkAsync('YouTube「感兴趣」请求 youtube 搜索', async () => {
    const card = ytEnv.dom.document.querySelector('[data-lattice="comment"]');
    card.querySelector('.lattice-primary').click();
    await waitFor(() => findQueue(ytEnv, 'engaged', 'comment').length === 1, 'YouTube engaged');
    const search = ytEnv.sent.find((message) => message.type === 'lattice-open-search');
    assert.equal(search.platform, 'youtube');
  });

  // -------------------------------------------------------------------------
  step('预算：force=false 时评论区/推荐位也受每日预算限制');
  // -------------------------------------------------------------------------
  await checkAsync('预算只剩 1 次：只注入评论区，推荐位与胶囊被预算挡住', async () => {
    const env = createAmbientEnv({
      hostname: 'www.bilibili.com',
      pathname: '/video/BV2',
      seed: seedFor({ latticeInterruptState: { day: TODAY, used: 2 }, latticeInterruptSettings: { ...BASE_SETTINGS, dailyLimit: 3 } }),
      setup: setupBilibili,
      mathRandom: () => 0,
    });
    await settle(env);
    await waitFor(() => env.ambient.getState().injected.comment, '评论注入');
    env.dom.runTimerMs(700);
    assert.equal(env.dom.document.querySelectorAll('[data-lattice="comment"]').length, 1);
    assert.equal(env.dom.document.querySelectorAll('[data-lattice="recommend"]').length, 0);
    assert.equal(env.dom.document.getElementById('lattice-ambient'), null);
    assert.equal(env.store.read('latticeInterruptState').used, 3);
  });

  // -------------------------------------------------------------------------
  step('非视频页：「感兴趣」打开 Lattice 新标签页（focus），并记 engaged(ambient)');
  // -------------------------------------------------------------------------
  await checkAsync('胶囊面板「感兴趣」-> newtab focus + engaged(ambient)', async () => {
    const env = createAmbientEnv({ seed: seedFor({ latticeForceAmbient: true }) });
    await settle(env);
    await waitFor(() => env.dom.document.getElementById('lattice-ambient') !== null, '胶囊');
    env.dom.document.querySelector('#lattice-ambient .lattice-pill').click();
    const card = env.dom.document.querySelector('#lattice-ambient .lattice-card');
    assert.ok(card);
    card.querySelector('.lattice-primary').click();
    await waitFor(() => findQueue(env, 'engaged', 'ambient').length === 1, 'ambient engaged');
    const message = env.sent.find((entry) => entry.type === 'lattice-open-newtab');
    assert.ok(message, '应发送 lattice-open-newtab');
    assert.equal(message.focus, 'prop-econ');
    assert.equal(env.sent.some((entry) => entry.type === 'lattice-open-search'), false);
  });

  // -------------------------------------------------------------------------
  step('「此站不再显示」：持久化 hostname 并停止所有表面');
  // -------------------------------------------------------------------------
  await checkAsync('opt-out 写入 storage、移除胶囊、下次进入不再渲染', async () => {
    const env = createAmbientEnv({ seed: seedFor({ latticeForceAmbient: true }) });
    await settle(env);
    await waitFor(() => env.dom.document.getElementById('lattice-ambient') !== null, '胶囊');
    env.dom.document.querySelector('#lattice-ambient .lattice-pill').click();
    env.dom.document.querySelector('#lattice-ambient .lattice-optout').click();
    await waitFor(() => (env.store.read('latticeAmbientOptOut') || []).includes('example.com'), 'opt-out 持久化');
    assert.equal(env.dom.document.getElementById('lattice-ambient'), null);
    assert.equal(env.ambient.getState().stopped, true);
    const again = createAmbientEnv({
      seed: seedFor({ latticeForceAmbient: true, latticeAmbientOptOut: ['example.com'] }),
    });
    await settle(again);
    assert.equal(again.dom.document.getElementById('lattice-ambient'), null);
  });

  console.log('');
  if (failures > 0) {
    console.log(`M2C SMOKE FAILED: ${failures} 项未通过`);
    process.exitCode = 1;
    return;
  }
  console.log('M2C SMOKE OK: 全部检查通过');
}

main().catch((err) => {
  console.error('M2C SMOKE CRASHED', err);
  process.exitCode = 1;
});
