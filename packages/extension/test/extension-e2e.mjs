/**
 * Real-browser E2E test of the unpacked MV3 extension.
 *
 * Launches a headless Chrome/Edge with `--load-extension`, finds the extension id
 * from its background service worker, opens the newtab page over CDP and drives
 * it like a user: import the sample pack, reveal with Space, rate with 3, open the
 * diagnostics panel, reload and check persistence.
 *
 * This is the only test that can prove MV3 CSP / manifest / module-worker / OPFS
 * behaviour; the Node smoke test covers the data layer.
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
// This is the acceptance proof that capture works with no real key: the E2E
// configures this endpoint through the settings dialog, captures text, checks
// the preview and confirms it. The stub answers the extraction prompt with a
// canned candidate (3 propositions / 1 chain) and the identity prompt with
// "all new".
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

async function startStubProvider() {
  const requests = [];
  const server = createServer((req, res) => {
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
      requests.push({ model: body.model ?? null, system: system.slice(0, 20) });
      let content;
      if (system.includes('知识抽取器')) content = JSON.stringify(STUB_EXTRACTION);
      else if (system.includes('命题去重')) content = JSON.stringify({ decisions: [] });
      else content = 'OK';
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
    remaining: Number(document.getElementById("feed-card").dataset.remaining) || 0,
  })`);
  card.summary = `[${card.reason}] ${card.statement} · ${card.meta} · ${card.source}`;
  return card;
}

function createHarness(page) {  let contextId;
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

    const emptyCounters = await harness.eval(
      '["counter-review","counter-new","counter-total"].map((id) => document.getElementById(id).textContent).join(" / ")',
    );
    console.log(`empty:   ${emptyCounters}`);
    assert.match(emptyCounters, /复习 0/);

    // 1) import the sample pack (8 propositions / 12 cues). The default surface
    //    is now 今日推送 (ad-like feed), not the review card.
    await harness.eval('document.getElementById("btn-sample").click()');
    await harness.waitFor('document.getElementById("counter-total").textContent.includes("8")', '示例包导入');
    const counts = await harness.eval(
      '["counter-review","counter-new","counter-total"].map((id) => document.getElementById(id).textContent).join(" / ")',
    );
    await harness.waitFor(
      'document.getElementById("view-feed").hidden === false && document.getElementById("feed-card").hidden === false',
      '今日推送首条',
    );
    const firstFeed = await readFeedCard(harness);
    console.log(`import:  ${counts}`);
    console.log(`feed:    ${firstFeed.summary}`);
    assert.ok(firstFeed.statement.length > 0, '推送命题为空');
    assert.match(firstFeed.reason, /基础|前沿|复习/);
    assert.ok(firstFeed.domain.length > 0, '推送卡片应带领域徽标');
    assert.match(firstFeed.meta, /掌握 \d+% · R \d+%/);
    assert.match(firstFeed.source, /^来自「.+」$/);
    assert.ok(firstFeed.remaining >= 1 && firstFeed.remaining <= 3, '今日剩余条数应在剂量内');
    const seenFeedIds = new Set([firstFeed.id]);

    // 2) 知道了 -> engaged, then the feed advances to the next card.
    await harness.eval('document.getElementById("btn-feed-know").click()');
    await harness.waitFor(
      `document.getElementById("feed-card").hidden === false && document.getElementById("feed-card").dataset.propositionId !== ${JSON.stringify(
        firstFeed.id,
      )}`,
      '知道了 -> 下一张',
    );
    const secondFeed = await readFeedCard(harness);
    console.log(`feed:    知道了 -> ${secondFeed.statement.slice(0, 22)}…`);
    seenFeedIds.add(secondFeed.id);

    // 3) 复习队列 stays one click away; the M0 review/quiz flow must keep working.
    await harness.eval('document.getElementById("tab-review").click()');
    await harness.waitFor('document.getElementById("view-card").hidden === false', '进入复习队列');
    const front = await harness.eval('document.getElementById("card-front").textContent');
    const meta = await harness.eval('document.getElementById("card-meta").textContent');
    console.log(`review:  ${front}`);
    console.log(`meta:    ${meta}`);
    assert.equal(front.length > 0, true, '卡片正面为空');
    assert.match(meta, /掌握 .+% ±.+% · 可用 .+% · 复习 \d+ 次/);

    // keyboard only inside the queue: Space reveals, 3 rates "一般"
    await harness.key(' ', 'Space', 32);
    await harness.waitFor('document.getElementById("card-answer").hidden === false', '空格显示答案');
    await harness.key('3', 'Digit3', 51);
    await harness.waitFor('document.getElementById("counter-new").textContent.includes("7")', '数字键 3 评级');
    console.log(`grade:   数字键 3 → ${await harness.eval('document.getElementById("counter-new").textContent')}`);

    // back to the feed surface for the remaining checks
    await harness.eval('document.getElementById("tab-feed").click()');
    await harness.waitFor(
      'document.getElementById("view-feed").hidden === false && document.getElementById("feed-card").hidden === false',
      '回到今日推送',
    );

    // 4) diagnostics panel must report storage mode + calibration + push facts
    await harness.eval('document.getElementById("btn-diagnostics").click()');
    await harness.waitFor('document.getElementById("diag-text").textContent.includes("校验摘要")', '诊断面板');
    const diagnostics = await harness.eval('document.getElementById("diag-text").textContent');
    const storageLine = diagnostics.split('\n').find((line) => line.startsWith('存储:')) ?? '(缺失)';
    const vfsLine = diagnostics.split('\n').find((line) => line.trim().startsWith('VFS:')) ?? '(无 VFS 行)';
    const feedLine = diagnostics.split('\n').find((line) => line.startsWith('推送:')) ?? '(缺失)';
    const backgroundLine = diagnostics.split('\n').find((line) => line.startsWith('后台:')) ?? '(缺失)';
    console.log(`diag:    ${storageLine.trim()} · ${vfsLine.trim()}`);
    console.log(`diag:    ${feedLine.trim()}`);
    console.log(`diag:    ${backgroundLine.trim()}`);
    assert.match(diagnostics, /存储: (OPFS|回退\(chrome\.storage\))/);
    assert.match(diagnostics, /校准报告/);
    assert.match(diagnostics, /事件 2\d/);
    assert.match(diagnostics, /^推送: 每日 3 条 · 今日已展示 \d+ · 参与 \d+ · 跳过 \d+ · 兴趣 /m);
    assert.match(diagnostics, /^后台: /m);
    await harness.eval('document.getElementById("btn-diag-close").click()');

    // 5) reload: the event log must survive (OPFS or chrome.storage fallback) and
    //    today's already-shown cards must not be pushed again.
    await pageClient.send('Page.reload', { ignoreCache: true });
    await harness.waitFor('document.readyState === "complete"', 'reload');
    await harness.waitFor(
      'document.getElementById("view-feed").hidden === false || document.getElementById("view-empty").hidden === false',
      'reload 后 worker 初始化',
    );
    await harness.waitFor('document.getElementById("counter-total").textContent.includes("8")', 'reload 后数据仍在');
    const afterReload = await harness.eval(
      '["counter-new","counter-total"].map((id) => document.getElementById(id).textContent).join(" / ")',
    );
    await harness.waitFor(
      'document.getElementById("feed-card").hidden === false || document.getElementById("feed-done").hidden === false',
      'reload 后推送视图',
    );
    const reloadFeedDone = await harness.eval('document.getElementById("feed-done").hidden === false');
    console.log(`reload:  ${afterReload}（事件日志持久化成功）`);
    if (reloadFeedDone) {
      console.log('feed:    reload → 今天的知识看完了 ✓（当天剂量已用完）');
    } else {
      const afterReloadFeed = await readFeedCard(harness);
      console.log(`feed:    reload → ${afterReloadFeed.statement.slice(0, 22)}…`);
      assert.ok(!seenFeedIds.has(afterReloadFeed.id), 'reload 后同一天不应重复推送已展示命题');
      seenFeedIds.add(afterReloadFeed.id);
    }

    // 5) M1a acceptance: configure the stub provider through the UI, capture
    //    text, inspect the preview, confirm it, and check the counters/coverage.
    console.log(`stub:    ${stub.baseUrl}（本地假模型，无需真实 Key）`);
    await harness.eval('document.getElementById("btn-settings").click()');
    await harness.waitFor('document.getElementById("dialog-settings").open === true', '设置对话框');
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
    const providerStatus = await harness.eval('document.getElementById("provider-status").textContent');
    console.log(`provider: ${providerStatus}`);

    await harness.eval('document.getElementById("btn-provider-test").click()');
    await harness.waitFor(
      'document.getElementById("provider-status").textContent.includes("连接成功")',
      '测试连接（worker 真实请求 stub provider）',
      30000,
    );
    const testStatus = await harness.eval('document.getElementById("provider-status").textContent');
    console.log(`test:    ${testStatus}`);

    // Auto-commit is ON by default; turn it OFF to exercise the preview path.
    await harness.eval(`
      (() => {
        const box = document.getElementById('capture-auto-commit');
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await harness.waitFor(
      'document.getElementById("toast").textContent.includes("已关闭自动入库")',
      '关闭自动入库',
    );
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
    assert.ok(stub.requests.length >= 2, `stub 应收到抽取 + 去重两次调用（实际 ${stub.requests.length}）`);

    await harness.eval('document.getElementById("btn-capture-confirm").click()');
    await harness.waitFor(
      'document.getElementById("toast").textContent.includes("已加入「经济学」")',
      '确认入库 toast（领域 = 兴趣信号）',
      30000,
    );
    await harness.waitFor('document.getElementById("counter-total").textContent.includes("11")', '入库后计数器更新');
    const afterCapture = await harness.eval(
      '["counter-review","counter-new","counter-total"].map((id) => document.getElementById(id).textContent).join(" / ")',
    );
    const captureToast = await harness.eval('document.getElementById("toast").textContent');
    console.log(`入库:    ${afterCapture}（8 条示例命题 + 3 条捕获）`);
    console.log(`toast:   ${captureToast}`);
    assert.match(captureToast, /已加入「经济学」· 今日推荐已更新/);

    // The feed must be recomputed right after a capture commit (interest added).
    await harness.waitFor(
      'document.getElementById("view-feed").hidden === false && document.getElementById("feed-card").hidden === false',
      '入库后推送刷新',
    );
    const feedAfterCapture = await readFeedCard(harness);
    console.log(`feed:    入库后 -> ${feedAfterCapture.summary}`);
    assert.match(feedAfterCapture.source, /^来自「经济学」$/, '捕获领域应参与推送排序');
    seenFeedIds.add(feedAfterCapture.id);

    // 6) feed micro-actions: 知道了 logs engaged, 不感兴趣 logs skipped, both advance.
    const knowTarget = feedAfterCapture.id;
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
    seenFeedIds.add(afterSkip.id);

    // 考考我: verification is optional but reachable — reuse the card flow in quiz mode.
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
    const afterQuizDone = await harness.eval('document.getElementById("feed-done").hidden === false');
    if (!afterQuizDone) {
      const afterQuizFeed = await readFeedCard(harness);
      console.log(`feed:    考考我 -> ${afterQuizFeed.statement.slice(0, 22)}…`);
      seenFeedIds.add(afterQuizFeed.id);
    }

    // C ledger evidence: diagnostics must show 2 engaged / 1 skipped / shown today.
    await harness.eval('document.getElementById("btn-diagnostics").click()');
    await harness.waitFor('document.getElementById("diag-text").textContent.includes("推送:")', '诊断推送信息');
    const diagFeedAfter = await harness.eval('document.getElementById("diag-text").textContent');
    const feedLineAfter = diagFeedAfter.split('\n').find((line) => line.startsWith('推送:')) ?? '(缺失)';
    console.log(`diag:    ${feedLineAfter.trim()}`);
    assert.match(feedLineAfter, /^推送: 每日 3 条 · 今日已展示 \d+ · 参与 2 · 跳过 1 · 兴趣 经济学×1/);
    await harness.eval('document.getElementById("btn-diag-close").click()');

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
    const coverageText = await harness.eval('document.getElementById("capture-coverage-text").textContent');
    console.log(`coverage: ${coverageText}`);
    assert.equal(stub.requests.length, requestsBeforeCoverage, 'coverage 命中时不应再调用模型');
    await harness.eval('document.getElementById("btn-capture-cancel").click()');

    // diagnostics after capture: graph stats + model line (never the key)
    await harness.eval('document.getElementById("btn-diagnostics").click()');
    await harness.waitFor('document.getElementById("diag-text").textContent.includes("图谱:")', '诊断图谱统计');
    const diagAfterCapture = await harness.eval('document.getElementById("diag-text").textContent');
    const modelLine = diagAfterCapture.split('\n').find((line) => line.startsWith('模型:')) ?? '(缺失)';
    const graphLine = diagAfterCapture.split('\n').find((line) => line.startsWith('图谱:')) ?? '(缺失)';
    console.log(`diag:    ${modelLine.trim()} · ${graphLine.trim()}`);
    assert.match(diagAfterCapture, /模型: stub-model \(local\)/);
    assert.match(diagAfterCapture, /图谱: 命题 11 · 推理链 1/);
    assert.doesNotMatch(diagAfterCapture, /sk-/);
    await harness.eval('document.getElementById("btn-diag-close").click()');

    // 6) auto-commit path: a toolbar capture must not open a confirmation dialog
    await harness.eval('document.getElementById("btn-settings").click()');
    await harness.eval(`
      (() => {
        const box = document.getElementById('capture-auto-commit');
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await harness.waitFor(
      'document.getElementById("toast").textContent.includes("已开启自动入库")',
      '开启自动入库',
    );
    await harness.eval('document.getElementById("btn-settings-close").click()');

    const AUTO_TEXT =
      '沉没成本是已经发生且无法收回的成本。理性决策只应看未来的边际收益与边际成本，而不应被沉没成本左右。';
    const pendingCapture = {
      ok: true,
      reason: '',
      capturedAt: new Date().toISOString(),
      selectionOnly: false,
      title: '自动入库测试',
      url: 'https://example.com/auto',
      text: AUTO_TEXT,
      truncated: false,
      charCount: AUTO_TEXT.length,
    };
    await harness.eval(
      `chrome.storage.local.set({ latticePendingCapture: ${JSON.stringify(pendingCapture)} })`,
    );
    await pageClient.send('Page.reload', { ignoreCache: true });
    await harness.waitFor('document.readyState === "complete"', 'reload(auto)');
    await harness.waitFor(
      'document.getElementById("toast").textContent.includes("已加入「经济学」")',
      '自动入库 toast（领域）',
      60000,
    );
    const autoDialogOpen = await harness.eval('document.getElementById("dialog-capture").open');
    const autoToast = await harness.eval('document.getElementById("toast").textContent');
    console.log(`auto:    ${autoToast}`);
    assert.equal(autoDialogOpen, false, '自动入库时不应打开确认弹窗');

    // 8) 推送设置：每日剂量写入 chrome.storage.local，并在诊断里显示
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

    // 9) exhaust the feed: the empty state is "今天的知识看完了 ✓" with a review entry.
    await harness.waitFor(
      'document.getElementById("view-feed").hidden === false && (document.getElementById("feed-card").hidden === false || document.getElementById("feed-done").hidden === false)',
      '推送视图（清空前）',
    );
    const alreadyDone = await harness.eval('document.getElementById("feed-done").hidden === false');
    if (!alreadyDone) {
      for (let i = 0; i < 12; i += 1) {
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
    }
    await harness.waitFor('document.getElementById("feed-done").hidden === false', '今天的知识看完了 ✓');
    const feedDoneText = await harness.eval('document.getElementById("feed-done").textContent');
    console.log(`feed:    ${feedDoneText.replace(/\s+/g, ' ').trim().slice(0, 70)}`);
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

    // 7) second tab in the same profile: must at least boot without fatal errors
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
    await secondHarness.eval('document.getElementById("btn-diagnostics").click()').catch(() => {});
    await sleep(800);
    const secondDiag = await secondHarness.eval('document.getElementById("diag-text").textContent').catch(() => '');
    const secondStorage = String(secondDiag).split('\n').find((line) => line.startsWith('存储:')) ?? '(未知)';
    console.log(`2nd tab storage: ${secondStorage.trim()}`);
    second.close();

    // 8) no uncaught errors / CSP violations
    const realErrors = consoleErrors.filter(
      (entry) => !entry.includes('favicon') && !entry.includes('net::ERR_FILE_NOT_FOUND'),
    );
    if (realErrors.length > 0) {
      console.log('console:');
      for (const entry of realErrors.slice(0, 8)) console.log(`  ${entry}`);
    }
    assert.equal(realErrors.length, 0, `页面出现 ${realErrors.length} 条 console 错误`);
    console.log('console: 无错误 / 无 CSP 违规');
    console.log('\nE2E OK: MV3 扩展在真实浏览器中加载、推送、复习、诊断、捕获、持久化全部通过');
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
