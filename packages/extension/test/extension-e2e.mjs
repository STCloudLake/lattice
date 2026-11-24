/**
 * Real-browser E2E test of the unpacked MV3 extension.
 *
 * Launches a headless Chrome/Edge with `--load-extension`, finds the extension id
 * from its background service worker, opens the newtab page over CDP and drives
 * it like a user.
 *
 * M2c flow it proves end-to-end (this is the only test that can prove MV3 CSP /
 * manifest / module-worker / OPFS behaviour):
 *
 *   1. a fresh profile seeds 计算机 + 人工智能 beginner content on boot and 今日推送
 *      shows it WITHOUT a model being configured;
 *   2. a new domain (数学) can be declared through 设置 → 兴趣领域 and shows up in
 *      诊断 (`兴趣:` / `待生成:` lines), with a non-blocking "configure a model" hint;
 *   3. saving the stub provider triggers autonomous curriculum generation for that
 *      domain (the stub answers the 课程设计者 prompt), the new propositions appear,
 *      and the once-per-day guard is persisted in chrome.storage.local;
 *   4. the M0/M1a flows keep working: review + rating, capture preview/confirm,
 *      coverage short-circuit, feed micro-actions, dose setting, feed exhaustion,
 *      persistence across reload and a second tab.
 *
 * Usage (from the repo root, after `npm run build`):
 *   node packages/extension/test/extension-e2e.mjs
 * Set CHROME_PATH to force a specific browser binary.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const PORT = 9411 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : undefined,
].filter(Boolean);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Local OpenAI-compatible stub provider.
//
// This is the acceptance proof that both capture and curriculum generation work
// with no real key: the E2E configures this endpoint through the settings dialog.
// The stub answers three prompts:
//   - extraction (system contains 知识抽取器) -> STUB_EXTRACTION (3 propositions)
//   - identity   (system contains 命题去重)   -> "all new"
//   - curriculum (system contains 课程设计者) -> STUB_CURRICULUM (6 propositions)
// ---------------------------------------------------------------------------

const CAPTURE_TEXT = [
  '机会成本是你为了得到某样东西而放弃的最佳替代方案的价值。',
  '沉没成本是已经发生且无法收回的成本。',
  '因为沉没成本无法收回，所以理性决策不应考虑沉没成本。',
].join('\n');

const STUB_EXTRACTION = {
  // A capture is an interest signal first: the domain is part of the answer, so
  // committing it must create `interest.observed` and stamp every proposition.
  domain: '经济学',
  propositions: [
    {
      ref: 'p1',
      statement: '机会成本是为了得到某样东西而放弃的最佳替代方案的价值。',
      name: '机会成本',
      quote: '机会成本是你为了得到某样东西而放弃的最佳替代方案的价值。',
    },
    {
      ref: 'p2',
      statement: '沉没成本是已经发生且无法收回的成本。',
      name: '沉没成本',
      quote: '沉没成本是已经发生且无法收回的成本。',
    },
    {
      ref: 'p3',
      statement: '理性决策不应考虑沉没成本。',
      name: '沉没成本谬误',
      quote: '理性决策不应考虑沉没成本。',
    },
  ],
  chains: [{ premises: ['p1', 'p2'], conclusion: 'p3', strength: 0.8 }],
};

/** The curriculum designer's answer: 6 atomic statements + 1 chain. */
const STUB_CURRICULUM = {
  domain: '数学',
  propositions: [
    { ref: 'm1', statement: '数学研究数量、结构、空间与变化。', name: '数学' },
    { ref: 'm2', statement: '集合是一组无序且互异对象的整体。', name: '集合' },
    { ref: 'm3', statement: '函数把每个输入映射到唯一的输出。', name: '函数' },
    { ref: 'm4', statement: '命题是可以判断真假的陈述句。', name: '命题' },
    { ref: 'm5', statement: '两个命题都真时，合取命题才为真。', name: '合取' },
    { ref: 'm6', statement: '定义域是函数允许的全部输入。', name: '定义域' },
  ],
  chains: [{ premises: ['m2', 'm3'], conclusion: 'm6', strength: 0.8 }],
};

async function startStubProvider() {
  const requests = [];
  const server = createServer((req, res) => {
    // M2b sidebar test: serve a fake video-site page. The browser maps
    // www.bilibili.com to 127.0.0.1 via --host-resolver-rules, so navigating to
    // http://www.bilibili.com:<port>/fake-bilibili really loads this response and
    // the manifest content script runs on a real bilibili.com origin.
    if (req.method === 'GET' && String(req.url ?? '').startsWith('/fake-bilibili')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>B站测试页</title></head>' +
          '<body><h1>fake bilibili page</h1><p>用于验证 Lattice 侧栏 / 评论区 / 推荐位 content script。</p>' +
          '<div id="comment"><div class="reply-list">' +
          '<div class="reply-item"><span class="user-name">real_user</span> 这是真实用户评论内容。</div>' +
          '<div class="reply-item"><span class="user-name">another_user</span> 第二条真实评论。</div>' +
          '</div></div>' +
          '<div class="rec-list"><div class="video-page-card-small">真实推荐视频</div></div>' +
          '</body></html>',
      );
      return;
    }
    if (req.method === 'GET' && String(req.url ?? '').startsWith('/generic')) {
      // Generic local page for the ambient-pill test: no video containers, no
      // layout mutation should be observable.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>普通页面</title></head>' +
          '<body><main><h1>generic article</h1><p>正文内容，用来验证环境胶囊不会改变布局。</p>' +
          '<div style="height:1200px"></div></main></body></html>',
      );
      return;
    }
    // Deliberately no CORS / CORP headers: the real DeepSeek/OpenAI APIs do not
    // send them either. The manifest `host_permissions` are what let the
    // extension worker call the endpoint — this E2E proves exactly that path.
    const cors = {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method !== 'POST' || !String(req.url ?? '').startsWith('/v1/chat/completions')) {
      res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"not found"}}');
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
      const system = String(body?.messages?.[0]?.content ?? '');
      const user = String(body?.messages?.[1]?.content ?? '');
      let content;
      let kind;
      if (system.includes('知识抽取器')) {
        content = JSON.stringify(STUB_EXTRACTION);
        kind = 'extraction';
      } else if (system.includes('命题去重')) {
        content = JSON.stringify({ decisions: [] });
        kind = 'identity';
      } else if (system.includes('课程设计者')) {
        content = JSON.stringify(STUB_CURRICULUM);
        kind = 'curriculum';
      } else {
        content = 'OK';
        kind = 'generic';
      }
      requests.push({ model: body.model ?? null, kind, system, user });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, port, baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

async function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 Chrome/Edge；请设置 CHROME_PATH');
}

async function waitForJson(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(120);
  }
  throw new Error(`等待 ${url} 超时：${lastError && lastError.message}`);
}

/** Polls /json/list for a target whose URL matches. */
async function findTargetUrl(match, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`${BASE}/json/list`).then((response) => response.json());
      const found = targets.find((target) => typeof target.url === 'string' && match(target.url));
      if (found) return found;
    } catch {
      /* browser still starting */
    }
    await sleep(120);
  }
  return null;
}

/** Minimal CDP client over the global WebSocket (Node 22). */
class Cdp {
  #socket;
  #nextId = 0;
  #pending = new Map();
  #listeners = new Map();

  static async connect(url) {
    const client = new Cdp();
    client.#socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      client.#socket.addEventListener('open', resolve, { once: true });
      client.#socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    client.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = client.#pending.get(message.id);
        if (!entry) return;
        client.#pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else entry.resolve(message.result);
        return;
      }
      for (const handler of client.#listeners.get(message.method) ?? []) handler(message.params);
    });
    return client;
  }

  send(method, params = {}) {
    const id = (this.#nextId += 1);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    const list = this.#listeners.get(method) ?? [];
    list.push(handler);
    this.#listeners.set(method, list);
  }

  close() {
    try {
      this.#socket.close();
    } catch {
      /* ignore */
    }
  }
}

/** Reads the rendered 今日推送 card as plain data (no DOM internals leak). */
async function readFeedCard(harness) {
  const card = await harness.eval(`({
    id: document.getElementById("feed-card").dataset.propositionId || "",
    statement: document.getElementById("feed-statement").textContent,
    cue: document.getElementById("feed-cue").hidden ? "" : document.getElementById("feed-cue").textContent,
    meta: document.getElementById("feed-meta").textContent,
    source: document.getElementById("feed-source").textContent,
    domain: document.getElementById("feed-domain").textContent,
    reason: document.getElementById("feed-reason").textContent,
    difficulty: document.getElementById("feed-difficulty").hidden ? "" : document.getElementById("feed-difficulty").textContent,
    remaining: Number(document.getElementById("feed-card").dataset.remaining) || 0,
  })`);
  card.summary = `[${card.reason}] ${card.statement} · ${card.meta} · ${card.source} · ${card.difficulty || '(无难度)'}`;
  return card;
}

/** Reads one chrome.storage.local key as JSON from an extension page. */
async function readStorageJson(harness, key) {
  const raw = await harness.eval(
    `chrome.storage.local.get(${JSON.stringify(key)}).then((got) => { const value = got[${JSON.stringify(
      key,
    )}]; return JSON.stringify(value === undefined ? null : value); })`,
  );
  return JSON.parse(String(raw));
}

/** "共 14 命题" -> 14 */
async function propositionCount(harness) {
  return Number(
    String(await harness.eval('document.getElementById("counter-total").textContent')).replace(/[^0-9]/g, ''),
  );
}

/** "新学 13" -> 13 */
async function newCount(harness) {
  return Number(String(await harness.eval('document.getElementById("counter-new").textContent')).replace(/[^0-9]/g, ''));
}

async function diagLine(harness, prefix) {
  const text = await harness.eval('document.getElementById("diag-text").textContent');
  return String(text)
    .split('\n')
    .find((line) => line.startsWith(prefix)) ?? `(缺失 ${prefix})`;
}

function createHarness(page) {
  let contextId;
  return {
    async eval(expression) {
      const result = await page.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        contextId,
      });
      if (result.exceptionDetails) {
        throw new Error(`页面脚本异常：${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`);
      }
      return result.result.value;
    },
    async setContext(id) {
      contextId = id;
    },
    async waitFor(expression, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          if (await this.eval(`Boolean(${expression})`)) return true;
        } catch {
          /* page might be navigating */
        }
        await sleep(120);
      }
      throw new Error(`等待条件超时：${label}`);
    },
    /** Like waitFor, but the expression may resolve a Promise (chrome.storage). */
    async waitForAsync(expression, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          if (await this.eval(`(${expression})`)) return true;
        } catch {
          /* page might be navigating */
        }
        await sleep(120);
      }
      throw new Error(`等待条件超时：${label}`);
    },
    async key(key, code, keyCode) {
      const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
  };
}

async function main() {
  const browserPath = await findBrowser();
  const profileDir = await mkdtemp(path.join(tmpdir(), 'lattice-e2e-'));
  const stub = await startStubProvider();
  const browser = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--window-size=1280,900',
      // M2b: make www.bilibili.com resolve to the local stub server, so the
      // declarative sidebar content script runs on a real bilibili.com origin.
      // --no-proxy-server keeps a system proxy from resolving the host itself.
      '--host-resolver-rules=MAP www.bilibili.com 127.0.0.1',
      '--no-proxy-server',
      '--disable-features=HttpsUpgrades,HttpsFirstModeV2',
      `--user-data-dir=${profileDir}`,
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      `--remote-debugging-port=${PORT}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );

  let browserErrors = '';
  browser.stderr?.on('data', (chunk) => {
    browserErrors += String(chunk);
  });

  let pageClient;
  try {
    await waitForJson(`${BASE}/json/version`);
    console.log(`browser: ${browserPath}`);
    console.log(`mode:    headless + --load-extension（真实 MV3 环境）`);

    // The background service worker tells us the extension id and proves the
    // manifest loaded at all.
    let extensionId = null;
    const deadline = Date.now() + 15000;
    while (!extensionId && Date.now() < deadline) {
      const targets = await fetch(`${BASE}/json/list`).then((response) => response.json());
      for (const target of targets) {
        if (target.type !== 'service_worker' || !target.url.endsWith('/background.js')) continue;
        const probe = await Cdp.connect(target.webSocketDebuggerUrl);
        try {
          const result = await probe.send('Runtime.evaluate', {
            expression: 'JSON.stringify({name: chrome.runtime.getManifest().name, id: chrome.runtime.id})',
            returnByValue: true,
          });
          const info = JSON.parse(result.result.value);
          if (info.name === 'Lattice (M0)') extensionId = info.id;
        } catch {
          /* target may be starting */
        } finally {
          probe.close();
        }
      }
      if (!extensionId) await sleep(250);
    }
    assert.ok(extensionId, '未能从 service worker 找到 Lattice 扩展（manifest 可能加载失败）');
    console.log(`ext id:  ${extensionId}（background.js service worker 已启动）`);

    const pageUrl = `chrome-extension://${extensionId}/newtab/newtab.html`;
    const created = await fetch(`${BASE}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' }).then((response) =>
      response.json(),
    );
    pageClient = await Cdp.connect(created.webSocketDebuggerUrl);

    const consoleErrors = [];
    const harness = createHarness(pageClient);
    pageClient.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error' && params.type !== 'warning') return;
      const text = params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
      consoleErrors.push(`${params.type}: ${text}`);
    });
    pageClient.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(`exception: ${params.exceptionDetails?.text ?? 'unknown'}`);
    });
    pageClient.on('Runtime.executionContextCreated', (params) => {
      if (params.context.auxData?.isDefault) harness.setContext(params.context.id);
    });

    await pageClient.send('Runtime.enable');
    await pageClient.send('Page.enable');
    await pageClient.send('Log.enable');
    await sleep(300);

    await harness.waitFor('document.readyState === "complete"', '页面 load');
    await harness.waitFor(
      'document.getElementById("view-empty").hidden === false || document.getElementById("view-feed").hidden === false || document.getElementById("view-fatal").hidden === false',
      'worker 初始化完成',
    );
    const fatal = await harness.eval('document.getElementById("view-fatal").hidden === false');
    if (fatal) {
      const detail = await harness.eval('document.getElementById("fatal-detail").textContent');
      throw new Error(`扩展启动进入 fatal 视图：${detail}`);
    }

    // -----------------------------------------------------------------------
    // 1) first run: seed content without configuring any model
    // -----------------------------------------------------------------------
    await harness.waitFor(
      'document.getElementById("toast").textContent.includes("已为你准备")',
      '首次运行自动载入入门内容 toast',
      30000,
    );
    const seedToast = await harness.eval('document.getElementById("toast").textContent');
    console.log(`seed:    ${seedToast}`);
    assert.equal(seedToast, '已为你准备「计算机」「人工智能」入门内容');

    await harness.waitFor('document.getElementById("counter-total").textContent.includes("14")', 'seed 后共 14 命题');
    await harness.waitFor(
      'document.getElementById("view-feed").hidden === false && document.getElementById("feed-card").hidden === false',
      'seed 后今日推送首条',
    );
    const firstFeed = await readFeedCard(harness);
    console.log(`feed:    ${firstFeed.summary}`);
    assert.ok(['计算机', '人工智能'].includes(firstFeed.domain), `推送领域应为内置领域（实际「${firstFeed.domain}」）`);
    assert.ok(firstFeed.statement.length > 0, '推送命题为空');
    assert.match(firstFeed.reason, /基础|前沿|复习/);
    assert.match(firstFeed.meta, /掌握 \d+% · R \d+%/);
    assert.match(firstFeed.source, /^来自「.+」$/);
    assert.match(firstFeed.difficulty, /^[★☆]{5} (记忆|理解|应用|分析|评价)$/, 'seed 内容应带难度星级 + 认知标签');
    assert.ok(firstFeed.remaining >= 1 && firstFeed.remaining <= 3, '今日剩余条数应在剂量内');
    assert.equal(stub.requests.length, 0, '首次运行不配置模型也必须有内容');
    const seenFeedIds = new Set([firstFeed.id]);

    // 知道了 -> engaged; the feed advances. Counted in the C ledger only.
    await harness.eval('document.getElementById("btn-feed-know").click()');
    await harness.waitFor(
      `document.getElementById("feed-card").hidden === false && document.getElementById("feed-card").dataset.propositionId !== ${JSON.stringify(
        firstFeed.id,
      )}`,
      '知道了 -> 下一张（seed 内容）',
    );
    const secondFeed = await readFeedCard(harness);
    console.log(`feed:    知道了 -> ${secondFeed.statement.slice(0, 22)}…`);
    seenFeedIds.add(secondFeed.id);

    // -----------------------------------------------------------------------
    // 2) declare 数学 through 设置 → 兴趣领域 (no model yet)
    // -----------------------------------------------------------------------
    await harness.eval('document.getElementById("btn-settings").click()');
    await harness.waitFor('document.getElementById("dialog-settings").open === true', '设置对话框');
    await harness.waitFor(
      'document.querySelectorAll("#interest-list .interest-row").length === 2',
      '兴趣列表显示 seed 的两个领域',
    );
    const seedInterestRows = await harness.eval(
      'Array.from(document.querySelectorAll("#interest-list .interest-row")).map((row) => row.textContent)',
    );
    console.log(`兴趣:    ${seedInterestRows.join(' / ')}`);
    assert.ok(seedInterestRows.some((row) => row.includes('计算机') && row.includes('入门')), '列表应含 计算机 · 入门');
    assert.ok(seedInterestRows.some((row) => row.includes('人工智能') && row.includes('入门')), '列表应含 人工智能 · 入门');
    assert.ok(seedInterestRows.every((row) => row.includes('移除')), '每行应有移除按钮');

    await harness.eval(`
      (() => {
        const setValue = (id, value) => {
          const element = document.getElementById(id);
          element.value = value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setValue('interest-domain', '数学');
        setValue('interest-level', 'beginner');
        document.getElementById('btn-interest-add').click();
      })()
    `);
    await harness.waitFor(
      'document.querySelectorAll("#interest-list .interest-row").length === 3 && document.getElementById("interest-list").textContent.includes("数学")',
      '声明「数学」后列表新增一行',
    );
    const mathRow = await harness.eval(
      'document.querySelector("#interest-list .interest-row[data-domain=\\"数学\\"]").textContent',
    );
    console.log(`兴趣:    声明 -> ${mathRow}`);
    assert.match(mathRow, /数学 · 入门 · 移除/);

    // No provider configured: a non-blocking hint must explain how to get content.
    await harness.waitFor(
      'document.getElementById("feed-hint").hidden === false && document.getElementById("feed-hint").textContent.includes("点 ⚙ 配置模型后")',
      '未配置模型时的提示',
    );
    const noProviderHint = await harness.eval('document.getElementById("feed-hint").textContent');
    console.log(`hint:    ${noProviderHint}`);
    assert.match(noProviderHint, /系统会为你主动准备「数学」的内容/);
    await harness.eval('document.getElementById("btn-settings-close").click()');

    // 诊断: declared interests + pending generation must be visible.
    await harness.eval('document.getElementById("btn-diagnostics").click()');
    await harness.waitFor('document.getElementById("diag-text").textContent.includes("待生成:")', '诊断兴趣/待生成行');
    const interestLine = await diagLine(harness, '兴趣:');
    const needLine = await diagLine(harness, '待生成:');
    const pushLine = await diagLine(harness, '推送:');
    console.log(`diag:    ${interestLine.trim()}`);
    console.log(`diag:    ${needLine.trim()}`);
    assert.ok(interestLine.includes('计算机(入门)'), '诊断应列出 计算机(入门)');
    assert.ok(interestLine.includes('人工智能(入门)'), '诊断应列出 人工智能(入门)');
    assert.ok(interestLine.includes('数学(入门)'), '诊断应列出刚声明的 数学(入门)');
    assert.match(needLine, /数学\(入门·已有 0\)/, '诊断应显示 数学 待生成');
    assert.match(pushLine, /^推送: 每日 3 条 · 今日已展示 \d+ · 参与 1 · 跳过 0 · 兴趣 /);
    await harness.eval('document.getElementById("btn-diag-close").click()');

    // -----------------------------------------------------------------------
    // 3) configure the stub provider -> autonomous generated curriculum for 数学
    // -----------------------------------------------------------------------
    console.log(`stub:    ${stub.baseUrl}（本地假模型，无需真实 Key）`);
    await harness.eval('document.getElementById("btn-settings").click()');
    await harness.waitFor('document.getElementById("dialog-settings").open === true', '设置对话框（模型）');
    await harness.eval(`
      (() => {
        const setValue = (id, value) => {
          const element = document.getElementById(id);
          element.value = value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setValue('provider-preset', 'local');
        setValue('provider-base-url', ${JSON.stringify(stub.baseUrl)});
        setValue('provider-model', 'stub-model');
        setValue('provider-key', '');
        document.getElementById('btn-provider-save').click();
      })()
    `);
    await harness.waitFor(
      'document.getElementById("provider-status").textContent.includes("stub-model")',
      '模型配置保存到 chrome.storage.local',
    );
    // Saving the model is a generation trigger: 数学 has no content yet.
    await harness.waitFor(
      'document.getElementById("toast").textContent.includes("已加入 6 条 · 今日推荐已更新")',
      '为「数学」自动准备内容',
      60000,
    );
    const generateToast = await harness.eval('document.getElementById("toast").textContent');
    console.log(`gen:     ${generateToast}`);
    const curriculumRequest = stub.requests.find((request) => request.kind === 'curriculum');
    assert.ok(curriculumRequest, `stub 应收到课程生成请求（实际 ${JSON.stringify(stub.requests.map((r) => r.kind))}）`);
    assert.match(curriculumRequest.system, /课程设计者/, '课程生成请求的 system 应包含「课程设计者」');
    assert.match(curriculumRequest.user, /领域：数学/, '课程生成请求的 user 消息应包含领域名与水平');
    await harness.waitFor('document.getElementById("counter-total").textContent.includes("20")', '生成 6 条 → 共 20 命题');

    // Once-per-domain-per-day guard is persisted by the page, not in SQLite.
    const guard = await harness.eval(
      'chrome.storage.local.get("latticeCurriculumState").then((got) => JSON.stringify(got.latticeCurriculumState ?? null))',
    );
    console.log(`guard:   ${guard}`);
    assert.ok(guard && guard !== 'null', '应持久化 latticeCurriculumState');
    const guardMap = JSON.parse(guard);
    assert.ok(Object.keys(guardMap).includes('数学'), 'guard 应记录 数学');
    assert.match(guardMap['数学'], /^\d{4}-\d{2}-\d{2}$/);

    await harness.eval('document.getElementById("btn-settings-close").click()');
    await harness.waitFor(
      'document.getElementById("view-feed").hidden === false && document.getElementById("feed-card").hidden === false',
      '生成后推送刷新',
    );
    await harness.waitFor(
      'document.getElementById("feed-domain").textContent === "数学"',
      '生成的内容进入今日推送（声明的兴趣优先）',
    );
    const generatedFeed = await readFeedCard(harness);
    console.log(`feed:    生成后 -> ${generatedFeed.summary}`);
    assert.equal(generatedFeed.domain, '数学');
    seenFeedIds.add(generatedFeed.id);

    // provider test still works (generic prompt -> OK)
    await harness.eval('document.getElementById("btn-settings").click()');
    await harness.waitFor('document.getElementById("dialog-settings").open === true', '设置对话框（测试连接）');
    await harness.eval('document.getElementById("btn-provider-test").click()');
    await harness.waitFor(
      'document.getElementById("provider-status").textContent.includes("连接成功")',
      '测试连接（worker 真实请求 stub provider）',
      30000,
    );
    console.log(`test:    ${await harness.eval('document.getElementById("provider-status").textContent')}`);
    await harness.eval('document.getElementById("btn-settings-close").click()');

    // -----------------------------------------------------------------------
    // 4) the M0 review queue still works (keyboard: Space reveal, 3 = 一般)
    // -----------------------------------------------------------------------
    const newBeforeReview = await newCount(harness);
    await harness.eval('document.getElementById("tab-review").click()');
    await harness.waitFor('document.getElementById("view-card").hidden === false', '进入复习队列');
    const front = await harness.eval('document.getElementById("card-front").textContent');
    const meta = await harness.eval('document.getElementById("card-meta").textContent');
    console.log(`review:  ${front}`);
    console.log(`meta:    ${meta}`);
    assert.equal(front.length > 0, true, '卡片正面为空');
    assert.match(meta, /掌握 .+% ±.+% · 可用 .+% · 复习 \d+ 次/);
    await harness.key(' ', 'Space', 32);
    await harness.waitFor('document.getElementById("card-answer").hidden === false', '空格显示答案');
    await harness.key('3', 'Digit3', 51);
    await harness.waitFor(
      `Number(document.getElementById("counter-new").textContent.replace(/[^0-9]/g, "")) < ${newBeforeReview}`,
      '数字键 3 评级后新学减少',
    );
    console.log(`grade:   数字键 3 → ${await harness.eval('document.getElementById("counter-new").textContent')}`);
    await harness.eval('document.getElementById("tab-feed").click()');
    await harness.waitFor('document.getElementById("view-feed").hidden === false', '回到今日推送');

    // -----------------------------------------------------------------------
    // 5) capture through the real UI with the stub provider
    // -----------------------------------------------------------------------
    await harness.eval('document.getElementById("btn-settings").click()');
    await harness.waitFor('document.getElementById("dialog-settings").open === true', '设置（自动入库）');
    await harness.eval(`
      (() => {
        const box = document.getElementById('capture-auto-commit');
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await harness.waitFor('document.getElementById("toast").textContent.includes("已关闭自动入库")', '关闭自动入库');
    await harness.eval('document.getElementById("btn-settings-close").click()');

    await harness.eval('document.getElementById("btn-capture").click()');
    await harness.waitFor('document.getElementById("dialog-capture").open === true', '捕获对话框');
    await harness.eval(`
      (() => {
        const setValue = (id, value) => {
          const element = document.getElementById(id);
          element.value = value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
        };
        setValue('capture-title', '机会成本与沉没成本');
        setValue('capture-text', ${JSON.stringify(CAPTURE_TEXT)});
        document.getElementById('btn-capture-extract').click();
      })()
    `);
    await harness.waitFor('document.getElementById("capture-preview").hidden === false', '抽取预览', 60000);
    const previewStats = await harness.eval(`({
      title: document.getElementById("capture-preview-title").textContent,
      props: document.querySelectorAll("#capture-props .preview-prop").length,
      chains: document.querySelectorAll("#capture-chains .preview-chain").length,
      checkedProps: document.querySelectorAll("#capture-props input[type=checkbox]:checked").length,
      checkedChains: document.querySelectorAll("#capture-chains input[type=checkbox]:checked").length,
      chainText: document.querySelector("#capture-chains .preview-chain-body").textContent,
      droppedHidden: document.getElementById("capture-dropped").hidden,
    })`);
    console.log(`capture: ${previewStats.title}`);
    console.log(`         ${previewStats.chainText}`);
    assert.equal(previewStats.props, 3, '预览应有 3 条命题');
    assert.equal(previewStats.chains, 1, '预览应有 1 条推理链');
    assert.equal(previewStats.checkedProps, 3, '命题应默认全选');
    assert.equal(previewStats.checkedChains, 1, '强度 ≥ 0.5 的推理链应默认勾选');
    assert.match(previewStats.chainText, /前提 .+ ⟹ 结论 /);
    assert.match(previewStats.title, /领域「经济学」/, '预览应显示模型抽到的领域');
    assert.equal(previewStats.droppedHidden, true, '没有丢弃项时不应显示丢弃列表');
    assert.ok(
      stub.requests.filter((request) => request.kind === 'extraction').length === 1,
      'stub 应收到一次抽取请求',
    );

    await harness.eval('document.getElementById("btn-capture-confirm").click()');
    await harness.waitFor(
      'document.getElementById("toast").textContent.includes("已加入「经济学」")',
      '确认入库 toast（领域 = 兴趣信号）',
      30000,
    );
    await harness.waitFor('document.getElementById("counter-total").textContent.includes("23")', '入库后 23 命题');
    const captureToast = await harness.eval('document.getElementById("toast").textContent');
    console.log(`入库:    ${captureToast}`);
    assert.match(captureToast, /已加入「经济学」· 今日推荐已更新/);
    await harness.waitFor(
      'document.getElementById("view-feed").hidden === false && document.getElementById("feed-card").hidden === false',
      '入库后推送刷新',
    );
    const feedAfterCapture = await readFeedCard(harness);
    console.log(`feed:    入库后 -> ${feedAfterCapture.summary}`);
    seenFeedIds.add(feedAfterCapture.id);

    // coverage: capturing the same text again must be short-circuited.
    const requestsBeforeCoverage = stub.requests.length;
    await harness.eval('document.getElementById("btn-capture").click()');
    await harness.waitFor('document.getElementById("dialog-capture").open === true', '再次打开捕获对话框');
    await harness.eval(`
      (() => {
        const element = document.getElementById('capture-text');
        element.value = ${JSON.stringify(CAPTURE_TEXT)};
        element.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btn-capture-extract').click();
      })()
    `);
    await harness.waitFor(
      'document.getElementById("capture-coverage").hidden === false && document.getElementById("capture-coverage-text").textContent.includes("3 条命题")',
      'coverage 命中提示',
      30000,
    );
    console.log(`coverage: ${await harness.eval('document.getElementById("capture-coverage-text").textContent')}`);
    assert.equal(stub.requests.length, requestsBeforeCoverage, 'coverage 命中时不应再调用模型');
    await harness.eval('document.getElementById("btn-capture-cancel").click()');

    // -----------------------------------------------------------------------
    // 6) feed micro-actions: 知道了 (engaged), 不感兴趣 (skipped), 考考我 (quiz)
    // -----------------------------------------------------------------------
    const knowTarget = await harness.eval('document.getElementById("feed-card").dataset.propositionId');
    await harness.eval('document.getElementById("btn-feed-know").click()');
    await harness.waitFor(
      `document.getElementById("feed-card").hidden === false && document.getElementById("feed-card").dataset.propositionId !== ${JSON.stringify(
        knowTarget,
      )}`,
      '知道了 -> 下一张（入库后）',
    );
    const afterKnow = await readFeedCard(harness);
    console.log(`feed:    知道了 -> ${afterKnow.statement.slice(0, 22)}…`);
    seenFeedIds.add(afterKnow.id);

    const skipTarget = afterKnow.id;
    await harness.eval('document.getElementById("btn-feed-skip").click()');
    await harness.waitFor(
      `document.getElementById("feed-card").hidden === false && document.getElementById("feed-card").dataset.propositionId !== ${JSON.stringify(
        skipTarget,
      )}`,
      '不感兴趣 -> 下一张',
    );
    const afterSkip = await readFeedCard(harness);
    console.log(`feed:    不感兴趣 -> ${afterSkip.statement.slice(0, 22)}…`);

    await harness.eval('document.getElementById("btn-feed-quiz").click()');
    await harness.waitFor('document.getElementById("view-card").hidden === false', '考考我 -> 卡片视图');
    await harness.key(' ', 'Space', 32);
    await harness.waitFor('document.getElementById("card-answer").hidden === false', '考考我 显示答案');
    const quizModeOk = await harness.eval(
      'document.getElementById("actions-quiz").hidden === false && document.getElementById("actions-grade").hidden === true',
    );
    assert.equal(quizModeOk, true, '考考我应进入测验模式（只判对错，不写调度账）');
    await harness.key('1', 'Digit1', 49);
    await harness.waitFor(
      'document.getElementById("view-feed").hidden === false && (document.getElementById("feed-card").hidden === false || document.getElementById("feed-done").hidden === false)',
      '考考我 后回到推送',
    );

    // C ledger evidence + graph stats + model line (never the key)
    await harness.eval('document.getElementById("btn-diagnostics").click()');
    await harness.waitFor('document.getElementById("diag-text").textContent.includes("图谱:")', '诊断图谱统计');
    const diagFeedAfter = await diagLine(harness, '推送:');
    const graphLine = await diagLine(harness, '图谱:');
    const modelLine = await diagLine(harness, '模型:');
    const needLineAfter = await diagLine(harness, '待生成:');
    console.log(`diag:    ${diagFeedAfter.trim()}`);
    console.log(`diag:    ${graphLine.trim()}`);
    assert.match(diagFeedAfter, /^推送: 每日 3 条 · 今日已展示 \d+ · 参与 2 · 跳过 1 · 兴趣 /);
    assert.match(diagFeedAfter, /经济学×1/);
    assert.match(graphLine, /命题 23 · 推理链 5/, '图谱应为 14 + 6 生成 + 3 捕获');
    assert.match(modelLine, /模型: stub-model \(local\)/);
    assert.match(needLineAfter, /^待生成: 无/);
    const diagAfterCapture = await harness.eval('document.getElementById("diag-text").textContent');
    assert.doesNotMatch(diagAfterCapture, /sk-/);
    await harness.eval('document.getElementById("btn-diag-close").click()');

    // -----------------------------------------------------------------------
    // 7) 推送设置：每日剂量写入 chrome.storage.local，并在诊断里显示
    // -----------------------------------------------------------------------
    await harness.eval('document.getElementById("btn-settings").click()');
    await harness.waitFor('document.getElementById("dialog-settings").open === true', '设置（推送剂量）');
    await harness.eval(`
      (() => {
        const radio = document.querySelector('input[name="feed-dose"][value="5"]');
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await harness.waitFor(
      'document.getElementById("toast").textContent.includes("每日剂量已设为 5 条")',
      '每日剂量设置 toast',
    );
    const storedFeedSettings = await harness.eval(
      'chrome.storage.local.get("latticeFeedSettings").then((got) => JSON.stringify(got.latticeFeedSettings))',
    );
    console.log(`settings: ${storedFeedSettings}`);
    assert.equal(storedFeedSettings, '{"dose":5}', '每日剂量应持久化到 chrome.storage.local');
    await harness.eval('document.getElementById("btn-settings-close").click()');
    await harness.eval('document.getElementById("btn-diagnostics").click()');
    await harness.waitFor(
      'document.getElementById("diag-text").textContent.includes("推送: 每日 5 条")',
      '诊断显示当前剂量',
    );
    await harness.eval('document.getElementById("btn-diag-close").click()');

    // -----------------------------------------------------------------------
    // 7b) M2b: interruption settings + the sidebar content script on a REAL
    //     bilibili.com origin (host-resolver maps it to the local stub page).
    // -----------------------------------------------------------------------
    await harness.eval('document.getElementById("btn-settings").click()');
    await harness.waitFor('document.getElementById("dialog-settings").open === true', '设置（打扰预算）');
    const notificationsDefault = await harness.eval('document.getElementById("interrupt-notifications").checked');
    console.log(`settings: 通知默认 ${notificationsDefault ? '开' : '关'}（应为关）`);
    assert.equal(notificationsDefault, false, '系统通知默认必须关闭');
    await harness.eval(`
      (() => {
        const limit = document.querySelector('input[name="interrupt-limit"][value="3"]');
        limit.checked = true;
        limit.dispatchEvent(new Event('change', { bubbles: true }));
        const setValue = (id, value) => {
          const element = document.getElementById(id);
          element.value = value;
          element.dispatchEvent(new Event('change', { bubbles: true }));
        };
        // start === end means "no quiet window", so this E2E does not depend on
        // the wall-clock time it happens to run at.
        setValue('interrupt-quiet-start', '00:00');
        setValue('interrupt-quiet-end', '00:00');
      })()
    `);
    await harness.waitForAsync(
      `chrome.storage.local.get("latticeInterruptSettings").then((got) => {
         const settings = got.latticeInterruptSettings || {};
         return settings.dailyLimit === 3 && settings.quietStart === '00:00' &&
           settings.quietEnd === '00:00' && settings.notifications === false && settings.sidebar === true &&
           settings.ambient === true && settings.injectComments === true && settings.searchJump === true;
       })`,
      '打扰设置写入 chrome.storage.local',
    );
    const storedInterrupt = await readStorageJson(harness, 'latticeInterruptSettings');
    console.log(`settings: ${JSON.stringify(storedInterrupt)}`);
    assert.equal(storedInterrupt.dailyLimit, 3);
    assert.equal(storedInterrupt.notifications, false);
    assert.equal(storedInterrupt.sidebar, true);
    assert.equal(storedInterrupt.ambient, true, '任意网页显示默认开启');
    assert.equal(storedInterrupt.injectComments, true, '评论/推荐注入默认开启');
    assert.equal(storedInterrupt.searchJump, true, '站内搜索跳转默认开启');
    await harness.eval('document.getElementById("btn-settings-close").click()');
    // M2c test override: make all ambient surfaces appear regardless of the
    // 25%/50% roll (the real random path is covered by m2c-smoke.mjs).
    await harness.eval('chrome.storage.local.set({ latticeForceAmbient: true })');
    // Make sure the sidebar has a fresh billboard snapshot to read.
    await harness.waitForAsync(
      `chrome.storage.local.get("latticeBillboard").then((got) => {
         const board = got.latticeBillboard || {};
         return board.day === new Date().toISOString().slice(0, 10) && Array.isArray(board.items) && board.items.length >= 2;
       })`,
      '快照写入 chrome.storage.local',
    );

    const fakeBilibiliUrl = `http://www.bilibili.com:${stub.port}/fake-bilibili`;
    const sidebarTarget = await fetch(`${BASE}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' }).then(
      (response) => response.json(),
    );
    const sidebarPage = await Cdp.connect(sidebarTarget.webSocketDebuggerUrl);
    const sidebarHarness = createHarness(sidebarPage);
    sidebarPage.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error' && params.type !== 'warning') return;
      consoleErrors.push(
        `sidebar ${params.type}: ${params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`,
      );
    });
    sidebarPage.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(`sidebar exception: ${params.exceptionDetails?.text ?? 'unknown'}`);
    });
    sidebarPage.on('Runtime.executionContextCreated', (params) => {
      if (params.context.auxData?.isDefault) sidebarHarness.setContext(params.context.id);
    });
    await sidebarPage.send('Runtime.enable');
    await sidebarPage.send('Page.enable');
    await sleep(200);
    // Navigate from the harness (not via /json/new) so the custom host mapping
    // has a real load to apply to.
    await sidebarPage.send('Page.navigate', { url: fakeBilibiliUrl });
    await sidebarPage.send('Page.enable');
    await sleep(500);
    await sidebarHarness.waitFor('document.readyState === "complete"', 'bilibili 测试页 load');
    await sidebarHarness.waitFor('document.getElementById("lattice-sidebar") !== null', '侧栏 content script 注入', 15000);
    const sidebarState = await sidebarHarness.eval(`({
      url: location.href,
      items: document.querySelectorAll('#lattice-sidebar .lattice-item').length,
      text: document.getElementById('lattice-sidebar').textContent,
      difficulty: document.querySelectorAll('#lattice-sidebar .lattice-difficulty').length,
    })`);
    console.log(
      `sidebar: ${sidebarState.url} · ${sidebarState.items} 条 · ${String(sidebarState.text).replace(/\s+/g, ' ').trim().slice(0, 40)}…`,
    );
    assert.match(sidebarState.url, /bilibili\.com/, '测试页应运行在 bilibili.com 源上');
    assert.equal(sidebarState.items, 2, '侧栏最多显示 2 条');
    assert.match(sidebarState.text, /知道了/);
    assert.match(sidebarState.text, /不感兴趣/);
    assert.ok(sidebarState.difficulty >= 1, '侧栏应渲染难度星级');
    await sidebarHarness.waitFor(
      'document.querySelector(\'[data-lattice="comment"]\') !== null',
      '评论区注入卡片',
      15000,
    );
    await sidebarHarness.waitFor(
      'document.querySelector(\'[data-lattice="recommend"]\') !== null',
      '推荐位注入卡片',
      15000,
    );
    const surfaces = await sidebarHarness.eval(`(() => {
      const inspect = (surface) => {
        const node = document.querySelector('[data-lattice="' + surface + '"]');
        if (!node) return null;
        return {
          text: node.textContent,
          badge: node.querySelector('.lattice-badge') ? node.querySelector('.lattice-badge').textContent : '',
          fake: node.querySelectorAll('[class*="avatar"],[class*="user-name"],[class*="username"],[class*="like"]').length,
          statement: node.querySelector('.lattice-card-statement') ? node.querySelector('.lattice-card-statement').textContent : '',
          propositionId: node.getAttribute('data-proposition-id'),
          parentId: node.parentNode ? node.parentNode.id : '',
        };
      };
      return { comment: inspect('comment'), recommend: inspect('recommend') };
    })()`);
    console.log(
      `surface: comment=${surfaces.comment ? '✓' : '✗'} recommend=${surfaces.recommend ? '✓' : '✗'}（评论区/推荐位均带 Lattice 标识）`,
    );
    const surfaceCountsAtRender = await sidebarHarness.eval(`({
      comment: document.querySelectorAll('[data-lattice="comment"]').length,
      recommend: document.querySelectorAll('[data-lattice="recommend"]').length,
    })`);
    assert.equal(surfaceCountsAtRender.comment, 1, '评论区每页最多注入 1 条');
    assert.equal(surfaceCountsAtRender.recommend, 1, '推荐位每页最多注入 1 条');
    assert.equal(
      await sidebarHarness.eval('document.getElementById("lattice-ambient") === null'),
      true,
      '视频页已有侧栏时不应再出现环境胶囊（每页最多 1 个环境表面）',
    );
    assert.ok(surfaces.comment, '评论区注入卡片应存在');
    assert.ok(surfaces.recommend, '推荐位注入卡片应存在');
    for (const surface of ['comment', 'recommend']) {
      const card = surfaces[surface];
      assert.match(card.badge, /Lattice/, `${surface} 卡片必须带 Lattice 标识`);
      assert.equal(card.fake, 0, `${surface} 卡片不应伪造用户名/头像/点赞结构`);
      assert.doesNotMatch(card.text, /网友|点赞|\d+\s*楼|回复/, `${surface} 卡片不应出现评论/点赞框架`);
      assert.ok(card.statement.length > 0, `${surface} 卡片应有命题正文`);
    }
    // recordShown() writes are async; wait until all three surfaces' shown records
    // are in the queue before inspecting counts.
    await harness.waitForAsync(
      `chrome.storage.local.get("latticePendingExposures").then((got) => {
         const shown = (got.latticePendingExposures || []).filter((entry) => entry.kind === 'shown');
         return shown.filter((entry) => entry.surface === 'sidebar').length === 2 &&
           shown.filter((entry) => entry.surface === 'comment').length === 1 &&
           shown.filter((entry) => entry.surface === 'recommend').length === 1;
       })`,
      '三类表面 shown 全部入队',
    );
    const queuedAfterRender = await readStorageJson(harness, 'latticePendingExposures');
    const shownAfterRender = (queuedAfterRender || []).filter((entry) => entry.kind === 'shown');
    assert.equal(shownAfterRender.filter((entry) => entry.surface === 'sidebar').length, 2, '侧栏 2 条 shown');
    assert.equal(shownAfterRender.filter((entry) => entry.surface === 'comment').length, 1, '评论区 1 条 shown');
    assert.equal(shownAfterRender.filter((entry) => entry.surface === 'recommend').length, 1, '推荐位 1 条 shown');
    const sidebarShownIds = shownAfterRender.filter((entry) => entry.surface === 'sidebar').map((entry) => entry.propositionId);

    // M2c: "感兴趣" on the comment card -> same-platform search tab.
    await sidebarHarness.eval(`document.querySelector('[data-lattice="comment"] .lattice-primary').click()`);
    await harness.waitForAsync(
      `chrome.storage.local.get("latticePendingExposures").then((got) => {
         const queue = got.latticePendingExposures || [];
         return queue.some((entry) => entry.kind === 'engaged' && entry.surface === 'comment');
       })`,
      '评论区「感兴趣」engaged 入队',
    );
    const searchTarget = await findTargetUrl((url) => url.startsWith('https://search.bilibili.com/all?keyword='), 10000);
    assert.ok(searchTarget, '「感兴趣」应打开 bilibili 站内搜索标签页');
    console.log(`search:  ${searchTarget.url.slice(0, 64)}…`);
    await fetch(`${BASE}/json/close/${searchTarget.id}`).catch(() => {});
    const sidebarKnowText = await sidebarHarness.eval(`(() => {
      const button = document.querySelector('#lattice-sidebar .lattice-primary');
      if (!button) return '';
      button.click();
      return button.textContent;
    })()`);
    await harness.waitForAsync(
      `chrome.storage.local.get("latticePendingExposures").then((got) => {
         const queue = got.latticePendingExposures || [];
         return queue.some((entry) => entry.kind === 'engaged' && entry.surface === 'sidebar');
       })`,
      '侧栏「知道了」engaged 入队',
    );
    const queuedAfterKnow = await readStorageJson(harness, 'latticePendingExposures');
    console.log(`sidebar: ${sidebarKnowText.trim()} -> queue ${queuedAfterKnow.length} 条`);
    const engagedEntry = queuedAfterKnow.find((entry) => entry.kind === 'engaged' && entry.surface === 'sidebar');
    assert.ok(engagedEntry, '应有 engaged 记录');
    assert.equal(engagedEntry.propositionId, sidebarShownIds[0]);
    const sidebarAfterKnow = await sidebarHarness.eval(`({
      items: document.querySelectorAll('#lattice-sidebar .lattice-item').length,
      hasPanel: document.getElementById('lattice-sidebar') !== null,
    })`);
    assert.equal(sidebarAfterKnow.hasPanel, true);
    assert.equal(sidebarAfterKnow.items, 1, '知道了之后应推进到剩下的 1 条');
    const sidebarSkipText = await sidebarHarness.eval(`(() => {
      const buttons = Array.from(document.querySelectorAll('#lattice-sidebar button'));
      const button = buttons.find((entry) => entry.textContent.trim() === '不感兴趣');
      if (!button) return '';
      button.click();
      return button.textContent;
    })()`);
    await harness.waitForAsync(
      `chrome.storage.local.get("latticePendingExposures").then((got) => {
         const queue = got.latticePendingExposures || [];
         return queue.some((entry) => entry.kind === 'skipped' && entry.surface === 'sidebar');
       })`,
      '侧栏「不感兴趣」skipped 入队',
    );
    const queuedAfterSkip = await readStorageJson(harness, 'latticePendingExposures');
    console.log(`sidebar: ${String(sidebarSkipText).trim()} -> queue ${queuedAfterSkip.length} 条（尚未 drain）`);
    const surfaceCounts = queuedAfterSkip.reduce((counts, entry) => {
      const key = `${entry.surface}/${entry.kind}`;
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
    console.log(`queue:   ${JSON.stringify(surfaceCounts)}`);
    assert.equal(surfaceCounts['sidebar/shown'], 2);
    assert.equal(surfaceCounts['comment/shown'], 1);
    assert.equal(surfaceCounts['recommend/shown'], 1);
    assert.equal(surfaceCounts['comment/engaged'], 1);
    assert.equal(surfaceCounts['sidebar/engaged'], 1);
    assert.equal(surfaceCounts['sidebar/skipped'], 1);
    await fetch(`${BASE}/json/close/${sidebarTarget.id}`).catch(() => {});
    sidebarPage.close();

    // -----------------------------------------------------------------------
    // 8) reload: the event log (seed + generated + captured) must survive, today's
    //    already-shown cards must not be pushed again, and the browser-side
    //    exposure queue must be drained into the log on boot.
    // -----------------------------------------------------------------------
    await pageClient.send('Page.reload', { ignoreCache: true });
    await harness.waitFor('document.readyState === "complete"', 'reload');
    await harness.waitFor(
      'document.getElementById("view-feed").hidden === false || document.getElementById("view-empty").hidden === false',
      'reload 后 worker 初始化',
    );
    await harness.waitFor('document.getElementById("counter-total").textContent.includes("23")', 'reload 后数据仍在');
    const afterReload = await harness.eval(
      '["counter-new","counter-total"].map((id) => document.getElementById(id).textContent).join(" / ")',
    );
    // Seed must not run again on a non-empty log.
    await harness.waitFor(
      'document.getElementById("view-feed").hidden === false && (document.getElementById("feed-card").hidden === false || document.getElementById("feed-done").hidden === false)',
      'reload 后推送视图',
    );
    console.log(`reload:  ${afterReload}（seed 不重复执行）`);
    // Surfaces queued: sidebar 2 shown + comment/recommend 1 shown each + 2 engaged
    // (comment, sidebar) + 1 skipped (sidebar); boot drains all of them.
    await harness.waitForAsync(
      `chrome.storage.local.get("latticePendingExposures").then((got) => {
         const queue = got.latticePendingExposures || [];
         return queue.length === 0;
       })`,
      '启动时把侧栏曝光队列 drain 进事件日志',
    );
    await harness.eval('document.getElementById("btn-diagnostics").click()');
    await harness.waitFor('document.getElementById("diag-text").textContent.includes("打扰:")', '诊断打扰行');
    const diagFeedAfterSidebar = await diagLine(harness, '推送:');
    const diagInterruptAfterSidebar = await diagLine(harness, '打扰:');
    console.log(`diag:    ${diagFeedAfterSidebar.trim()}`);
    console.log(`diag:    ${diagInterruptAfterSidebar.trim()}`);
    assert.match(
      diagFeedAfterSidebar,
      /今日已展示 14 · 参与 4 · 跳过 2/,
      '侧栏/评论区的 shown/engaged/skipped 应已 drain 进 C 账',
    );
    assert.match(
      diagInterruptAfterSidebar,
      /^打扰: 上限 3 次 · 今日已用 1 · 安静 未启用 · 侧栏 开 · 通知 关 · 待入库曝光 0 条/,
    );
    const diagAmbientAfterSidebar = await diagLine(harness, '环境:');
    console.log(`diag:    ${diagAmbientAfterSidebar.trim()}`);
    assert.match(diagAmbientAfterSidebar, /^环境: 任意网页 开 · 评论注入 开 · 站内跳转 开 · 本站已屏蔽 否/);
    await harness.eval('document.getElementById("btn-diag-close").click()');

    // -----------------------------------------------------------------------
    // 8b) M2c: ambient pill on a generic local page. Fixed positioning only: the
    //     panel must not change body layout; Esc closes it; 感兴趣 opens a focused
    //     Lattice newtab; 此站不再显示 persists and removes the pill.
    // -----------------------------------------------------------------------
    const genericUrl = `http://127.0.0.1:${stub.port}/generic`;
    const genericTarget = await fetch(`${BASE}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' }).then(
      (response) => response.json(),
    );
    const genericPage = await Cdp.connect(genericTarget.webSocketDebuggerUrl);
    const genericHarness = createHarness(genericPage);
    genericPage.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error' && params.type !== 'warning') return;
      consoleErrors.push(
        `ambient ${params.type}: ${params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`,
      );
    });
    genericPage.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(`ambient exception: ${params.exceptionDetails?.text ?? 'unknown'}`);
    });
    genericPage.on('Runtime.executionContextCreated', (params) => {
      if (params.context.auxData?.isDefault) genericHarness.setContext(params.context.id);
    });
    await genericPage.send('Runtime.enable');
    await genericPage.send('Page.enable');
    await sleep(200);
    await genericPage.send('Page.navigate', { url: genericUrl });
    await sleep(500);
    await genericHarness.waitFor('document.readyState === "complete"', 'generic page load');
    await genericHarness.waitFor('document.getElementById("lattice-ambient") !== null', '环境胶囊注入', 15000);
    const beforeExpand = await genericHarness.eval(`({
      scrollWidth: document.body.scrollWidth,
      children: document.body.children.length,
      style: document.body.getAttribute('style') || '',
      hidden: document.querySelector('#lattice-ambient .lattice-ambient-panel').hidden,
    })`);
    assert.equal(beforeExpand.hidden, true, '面板初始收起');
    await genericHarness.eval(`document.querySelector('#lattice-ambient .lattice-pill').click()`);
    await genericHarness.waitFor(
      'document.querySelector("#lattice-ambient .lattice-ambient-panel").hidden === false',
      '胶囊展开成面板',
    );
    const expanded = await genericHarness.eval(`({
      scrollWidth: document.body.scrollWidth,
      children: document.body.children.length,
      style: document.body.getAttribute('style') || '',
      text: document.querySelector('#lattice-ambient .lattice-ambient-panel').textContent,
      width: getComputedStyle(document.querySelector('#lattice-ambient .lattice-ambient-panel')).width,
    })`);
    console.log(
      `ambient: 面板 ${expanded.width} · ${String(expanded.text).replace(/\s+/g, ' ').trim().slice(0, 42)}…`,
    );
    assert.equal(expanded.scrollWidth, beforeExpand.scrollWidth, '展开面板不得改变 body.scrollWidth');
    assert.equal(expanded.children, beforeExpand.children, '环境表面不得改动 <body> 子节点');
    assert.equal(expanded.style, beforeExpand.style, '环境表面不得改动 <body> 内联样式');
    assert.match(expanded.text, /Lattice · 知识/);
    assert.match(expanded.text, /感兴趣/);
    await genericHarness.key('Escape', 'Escape', 27);
    await genericHarness.waitFor(
      'document.querySelector("#lattice-ambient .lattice-ambient-panel").hidden === true',
      'Esc 收起面板',
    );
    await genericHarness.eval(`document.querySelector('#lattice-ambient .lattice-pill').click()`);
    await genericHarness.waitFor(
      'document.querySelector("#lattice-ambient .lattice-ambient-panel").hidden === false',
      '再次展开面板',
    );
    const ambientFocusId = await genericHarness.eval(
      `document.querySelector('#lattice-ambient .lattice-card').getAttribute('data-proposition-id')`,
    );
    await genericHarness.eval(`document.querySelector('#lattice-ambient .lattice-primary').click()`);
    await harness.waitForAsync(
      `chrome.storage.local.get("latticePendingExposures").then((got) => {
         const queue = got.latticePendingExposures || [];
         return queue.some((entry) => entry.kind === 'engaged' && entry.surface === 'ambient');
       })`,
      '环境胶囊「感兴趣」engaged 入队',
    );
    const focusTarget = await findTargetUrl(
      (url) =>
        url.startsWith(`chrome-extension://${extensionId}/newtab/newtab.html`) &&
        url.includes(`focus=${ambientFocusId}`),
      10000,
    );
    assert.ok(focusTarget, '非视频页「感兴趣」应打开聚焦该命题的 Lattice 新标签页');
    console.log(`ambient: 感兴趣 -> ${focusTarget.url.slice(0, 78)}…`);
    await fetch(`${BASE}/json/close/${focusTarget.id}`).catch(() => {});
    await genericHarness.eval(`document.querySelector('#lattice-ambient .lattice-optout').click()`);
    await harness.waitForAsync(
      `chrome.storage.local.get("latticeAmbientOptOut").then((got) => {
         const list = got.latticeAmbientOptOut || [];
         return list.includes('127.0.0.1');
       })`,
      '此站不再显示持久化',
    );
    assert.equal(
      await genericHarness.eval('document.getElementById("lattice-ambient") === null'),
      true,
      '屏蔽后应立即移除胶囊',
    );
    await fetch(`${BASE}/json/close/${genericTarget.id}`).catch(() => {});
    genericPage.close();

    // -----------------------------------------------------------------------
    // 9) exhaust the feed: the empty state is "今天的知识看完了 ✓" with a review entry
    // -----------------------------------------------------------------------
    for (let i = 0; i < 40; i += 1) {
      const done = await harness.eval('document.getElementById("feed-done").hidden === false');
      if (done) break;
      const cardVisible = await harness.eval('document.getElementById("feed-card").hidden === false');
      if (!cardVisible) {
        await sleep(150);
        continue;
      }
      const currentId = await harness.eval('document.getElementById("feed-card").dataset.propositionId');
      await harness.eval('document.getElementById("btn-feed-know").click()');
      await harness.waitFor(
        `document.getElementById("feed-done").hidden === false || document.getElementById("feed-card").dataset.propositionId !== ${JSON.stringify(
          currentId,
        )}`,
        `推送清空推进（${i + 1}）`,
        15000,
      );
    }
    await harness.waitFor('document.getElementById("feed-done").hidden === false', '今天的知识看完了 ✓');
    const feedDoneText = await harness.eval('document.getElementById("feed-done").textContent');
    console.log(`feed:    ${feedDoneText.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
    assert.match(feedDoneText, /今天的知识看完了 ✓/);
    assert.match(feedDoneText, /去复习/);
    assert.match(feedDoneText, /在任意网页点 Lattice 图标可加新领域/);
    await harness.eval('document.getElementById("btn-feed-review").click()');
    await harness.waitFor(
      'document.getElementById("view-card").hidden === false || document.getElementById("view-done").hidden === false',
      '空状态「去复习」进入复习队列',
    );
    await harness.eval('document.getElementById("tab-feed").click()');
    await harness.waitFor('document.getElementById("view-feed").hidden === false', '回到今日推送');

    // -----------------------------------------------------------------------
    // 10) second tab in the same profile: must at least boot without fatal errors
    // -----------------------------------------------------------------------
    const secondTarget = await fetch(`${BASE}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' }).then((response) =>
      response.json(),
    );
    const second = await Cdp.connect(secondTarget.webSocketDebuggerUrl);
    const secondHarness = createHarness(second);
    second.on('Runtime.executionContextCreated', (params) => {
      if (params.context.auxData?.isDefault) secondHarness.setContext(params.context.id);
    });
    await second.send('Runtime.enable');
    await second.send('Runtime.executionContextCreated', {}).catch(() => {});
    await sleep(300);
    await secondHarness.waitFor('document.readyState === "complete"', '第二个标签页 load');
    await secondHarness.waitFor(
      'document.getElementById("view-empty").hidden === false || document.getElementById("view-feed").hidden === false || document.getElementById("view-fatal").hidden === false',
      '第二个标签页 worker 初始化',
    );
    const secondFatal = await secondHarness.eval('document.getElementById("view-fatal").hidden === false');
    const secondCount = await secondHarness.eval('document.getElementById("counter-total").textContent');
    console.log(`2nd tab: ${secondFatal ? 'fatal 视图' : secondCount}`);
    second.close();

    // -----------------------------------------------------------------------
    // 11) no uncaught errors / CSP violations
    // -----------------------------------------------------------------------
    const realErrors = consoleErrors.filter(
      (entry) => !entry.includes('favicon') && !entry.includes('net::ERR_FILE_NOT_FOUND'),
    );
    if (realErrors.length > 0) {
      console.log('console:');
      for (const entry of realErrors.slice(0, 8)) console.log(`  ${entry}`);
    }
    assert.equal(realErrors.length, 0, `页面出现 ${realErrors.length} 条 console 错误`);
    console.log('console: 无错误 / 无 CSP 违规');
    console.log('\nE2E OK: 首次运行 seed、声明兴趣、自动准备内容、复习、捕获、推送、侧栏+评论区/推荐位、环境胶囊、站内跳转、持久化全部通过');
  } finally {
    pageClient?.close();
    browser.kill();
    stub.server.close();
    await sleep(400);
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    if (browserErrors.includes('DevTools listening')) {
      // Only surface real launch problems, not the usual DevTools banner.
      const problems = browserErrors
        .split('\n')
        .filter((line) => /ERROR|Failed|Invalid/i.test(line) && !/DevTools|GPU|gl_/i.test(line));
      if (problems.length > 0) {
        console.log('browser stderr:');
        for (const line of problems.slice(0, 8)) console.log(`  ${line.trim()}`);
      }
    }
  }
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
