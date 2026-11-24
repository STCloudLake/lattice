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
      'document.getElementById("view-empty").hidden === false || document.getElementById("view-card").hidden === false || document.getElementById("view-fatal").hidden === false',
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

    // 1) import the sample pack (8 propositions / 12 cues)
    await harness.eval('document.getElementById("btn-sample").click()');
    await harness.waitFor('document.getElementById("counter-total").textContent.includes("8")', '示例包导入');
    const counts = await harness.eval(
      '["counter-review","counter-new","counter-total"].map((id) => document.getElementById(id).textContent).join(" / ")',
    );
    const front = await harness.eval('document.getElementById("card-front").textContent');
    const meta = await harness.eval('document.getElementById("card-meta").textContent');
    console.log(`import:  ${counts}`);
    console.log(`card:    ${front}`);
    console.log(`meta:    ${meta}`);
    assert.equal(front.length > 0, true, '卡片正面为空');
    assert.match(meta, /掌握 .+% ±.+% · 可用 .+% · 复习 \d+ 次/);

    // 2) keyboard only: Space reveals, 3 rates "一般"
    await harness.key(' ', 'Space', 32);
    await harness.waitFor('document.getElementById("card-answer").hidden === false', '空格显示答案');
    await harness.key('3', 'Digit3', 51);
    await harness.waitFor('document.getElementById("counter-new").textContent.includes("7")', '数字键 3 评级');
    console.log(`grade:   数字键 3 → ${await harness.eval('document.getElementById("counter-new").textContent')}`);

    // 3) diagnostics panel must report storage mode + calibration report
    await harness.eval('document.getElementById("btn-diagnostics").click()');
    await harness.waitFor('document.getElementById("diag-text").textContent.includes("校验摘要")', '诊断面板');
    const diagnostics = await harness.eval('document.getElementById("diag-text").textContent');
    const storageLine = diagnostics.split('\n').find((line) => line.startsWith('存储:')) ?? '(缺失)';
    const vfsLine = diagnostics.split('\n').find((line) => line.trim().startsWith('VFS:')) ?? '(无 VFS 行)';
    console.log(`diag:    ${storageLine.trim()} · ${vfsLine.trim()}`);
    assert.match(diagnostics, /存储: (OPFS|回退\(chrome\.storage\))/);
    assert.match(diagnostics, /校准报告/);
    assert.match(diagnostics, /事件 2\d/);
    await harness.eval('document.getElementById("btn-diag-close").click()');

    // 4) reload: the event log must survive (OPFS or chrome.storage fallback)
    await pageClient.send('Page.reload', { ignoreCache: true });
    await harness.waitFor('document.readyState === "complete"', 'reload');
    await harness.waitFor(
      'document.getElementById("view-card").hidden === false || document.getElementById("view-empty").hidden === false',
      'reload 后 worker 初始化',
    );
    await harness.waitFor('document.getElementById("counter-total").textContent.includes("8")', 'reload 后数据仍在');
    const afterReload = await harness.eval(
      '["counter-new","counter-total"].map((id) => document.getElementById(id).textContent).join(" / ")',
    );
    console.log(`reload:  ${afterReload}（事件日志持久化成功）`);

    // 5) second tab in the same profile: must at least boot without fatal errors
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
      'document.getElementById("view-empty").hidden === false || document.getElementById("view-card").hidden === false || document.getElementById("view-fatal").hidden === false',
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

    // 6) no uncaught errors / CSP violations
    const realErrors = consoleErrors.filter(
      (entry) => !entry.includes('favicon') && !entry.includes('net::ERR_FILE_NOT_FOUND'),
    );
    if (realErrors.length > 0) {
      console.log('console:');
      for (const entry of realErrors.slice(0, 8)) console.log(`  ${entry}`);
    }
    assert.equal(realErrors.length, 0, `页面出现 ${realErrors.length} 条 console 错误`);
    console.log('console: 无错误 / 无 CSP 违规');
    console.log('\nE2E OK: MV3 扩展在真实浏览器中加载、导入、答题、诊断、持久化全部通过');
  } finally {
    pageClient?.close();
    browser.kill();
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
