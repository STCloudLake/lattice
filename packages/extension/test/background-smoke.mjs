/*
 * Orchestration smoke test for background.js.
 *
 * background.js is a classic MV3 service worker script, so it is evaluated in a
 * vm context with a stubbed `chrome`. This covers the part that cannot be tested
 * in the page DOM test: "click icon / right-click" -> inject -> park payload ->
 * open newtab, including every failure path.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '../background.js'), 'utf8');
// background.js loads the shared push-layer contract via importScripts(); emulate
// that in the vm so the classic script can be evaluated outside a service worker.
const sharedSource = readFileSync(path.join(here, '../shared/billboard.js'), 'utf8');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('  ok   ' + name);
  } catch (error) {
    failures += 1;
    console.log('  FAIL ' + name + ' :: ' + (error && error.message ? error.message : error));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error('等待超时：' + label);
}

function createEnv({ extraction, tab } = {}) {
  const listeners = {};
  const storage = {};
  const createdTabs = [];
  const scriptCalls = [];

  const chrome = {
    runtime: {
      onInstalled: { addListener: (fn) => (listeners.installed = fn) },
      onMessage: { addListener: (fn) => (listeners.message = fn) },
      getURL: (p) => 'chrome-extension://test/' + p,
    },
    contextMenus: {
      removeAll: (cb) => cb && cb(),
      create: (item) => (listeners.menuItem = item),
      onClicked: { addListener: (fn) => (listeners.menuClicked = fn) },
    },
    action: { onClicked: { addListener: (fn) => (listeners.actionClicked = fn) } },
    scripting: {
      async executeScript(args) {
        scriptCalls.push(args);
        if (args.files) return [{ result: null }];
        if (extraction instanceof Error) throw extraction;
        return [{ result: extraction }];
      },
    },
    storage: {
      local: {
        async get(keys) {
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of wanted) if (Object.prototype.hasOwnProperty.call(storage, key)) out[key] = storage[key];
          return out;
        },
        async set(items) {
          Object.assign(storage, items);
        },
      },
    },
    tabs: {
      create: async (options) => {
        createdTabs.push(options);
        return { id: 2 };
      },
    },
  };

  const context = vm.createContext({
    chrome,
    console,
    setTimeout,
    clearTimeout,
    importScripts(file) {
      if (String(file).endsWith('shared/billboard.js')) {
        vm.runInContext(sharedSource, context, { filename: 'shared/billboard.js' });
        return;
      }
      throw new Error('unexpected importScripts: ' + String(file));
    },
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  return {
    listeners,
    storage,
    createdTabs,
    scriptCalls,
    tab: tab ?? { id: 1, url: 'https://example.com/article' },
  };
}

const GOOD_EXTRACTION = {
  title: '测试文章',
  url: 'https://example.com/article',
  text: '正文第一段。\n\n正文第二段。',
  selection: '',
  truncated: false,
  charCount: 20,
};

console.log('background smoke');

await check('安装时注册「选中文字」右键菜单', async () => {
  const env = createEnv({ extraction: GOOD_EXTRACTION });
  env.listeners.installed();
  // Arrays created inside the vm realm have a different prototype, so compare
  // elements rather than deep-equality across realms.
  assert.equal(env.listeners.menuItem.contexts.length, 1);
  assert.equal(env.listeners.menuItem.contexts[0], 'selection');
  assert.match(env.listeners.menuItem.title, /Lattice/);
});

await check('点图标：注入提取脚本 -> 暂存正文 -> 打开新标签页', async () => {
  const env = createEnv({ extraction: GOOD_EXTRACTION });
  env.listeners.actionClicked(env.tab);
  await waitUntil(() => env.storage.latticePendingCapture && env.createdTabs.length > 0, 'capture');
  const pending = env.storage.latticePendingCapture;
  assert.equal(pending.ok, true);
  assert.equal(pending.text, GOOD_EXTRACTION.text);
  assert.equal(pending.title, '测试文章');
  assert.equal(pending.selectionOnly, false);
  assert.equal(env.scriptCalls.length, 2);
  assert.equal(env.scriptCalls[0].files.length, 1);
  assert.equal(env.scriptCalls[0].files[0], 'content/page-extract.js');
  assert.match(env.createdTabs[0].url, /newtab\/newtab\.html\?capture=1$/);
});

await check('右键：只抓选中文字（selectionOnly 传给页面）', async () => {
  const env = createEnv({
    extraction: { ...GOOD_EXTRACTION, selection: '选中的一句话', text: '选中的一句话' },
  });
  env.listeners.menuClicked({ menuItemId: 'lattice-capture-selection' }, env.tab);
  await waitUntil(() => env.storage.latticePendingCapture, 'selection capture');
  assert.equal(env.storage.latticePendingCapture.selectionOnly, true);
  assert.equal(env.scriptCalls[1].args[0], true);
  assert.equal(env.storage.latticePendingCapture.hasSelection, true);
});

await check('右键但没有选中文字：明确报错而不是静默失败', async () => {
  const env = createEnv({ extraction: { ...GOOD_EXTRACTION, selection: '' } });
  env.listeners.menuClicked({ menuItemId: 'lattice-capture-selection' }, env.tab);
  await waitUntil(() => env.storage.latticePendingCapture, 'selection error');
  assert.equal(env.storage.latticePendingCapture.ok, false);
  assert.match(env.storage.latticePendingCapture.reason, /没有选中文字/);
});

await check('浏览器内部页面：拒绝并说明原因', async () => {
  const env = createEnv({ extraction: GOOD_EXTRACTION, tab: { id: 1, url: 'chrome://extensions' } });
  env.listeners.actionClicked(env.tab);
  await waitUntil(() => env.storage.latticePendingCapture, 'internal page');
  assert.equal(env.storage.latticePendingCapture.ok, false);
  assert.match(env.storage.latticePendingCapture.reason, /内部页面/);
  assert.equal(env.scriptCalls.length, 0);
});

await check('页面没有正文：报错而不是打开空预览', async () => {
  const env = createEnv({ extraction: { ...GOOD_EXTRACTION, text: '   ' } });
  env.listeners.actionClicked(env.tab);
  await waitUntil(() => env.storage.latticePendingCapture, 'empty text');
  assert.equal(env.storage.latticePendingCapture.ok, false);
  assert.match(env.storage.latticePendingCapture.reason, /没有在这个页面提取到正文/);
});

await check('健康检查：ping 返回 build，供诊断判断后台是否为新版', async () => {
  const env = createEnv({ extraction: GOOD_EXTRACTION });
  assert.equal(typeof env.listeners.message, 'function');
  let replied = null;
  const kept = env.listeners.message({ type: 'lattice-ping' }, {}, (reply) => {
    replied = reply;
  });
  assert.equal(kept, true);
  assert.equal(replied.ok, true);
  assert.equal(typeof replied.build, 'string');
  assert.ok(replied.build.length > 0);
  // Unknown messages are ignored.
  assert.equal(env.listeners.message({ type: 'other' }, {}, () => {}), false);
});

await check('注入失败（受限页面）：错误被包装成中文提示', async () => {
  const env = createEnv({ extraction: new Error('Cannot access contents of the page') });
  env.listeners.actionClicked(env.tab);
  await waitUntil(() => env.storage.latticePendingCapture, 'inject error');
  assert.equal(env.storage.latticePendingCapture.ok, false);
  assert.match(env.storage.latticePendingCapture.reason, /Cannot access/);
});

console.log('');
if (failures > 0) {
  console.log(`BACKGROUND SMOKE FAILED: ${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('BACKGROUND SMOKE OK: 全部检查通过');
}
