/**
 * Headless smoke test of the M1a capture pipeline (no browser needed).
 *
 * Mirrors worker-smoke.mjs: real service code against in-memory SQLite, a fake
 * chrome.storage.local and a fake `fetch` standing in for the model provider.
 * Covers the parts a real browser E2E cannot check cheaply:
 *
 *   - provider client wire format + Chinese HTTP error mapping (no key leaks)
 *   - extractPreview -> preview plan -> commitExtraction -> replay
 *   - coverage hit on the second preview (and no second model call)
 *   - idempotent re-commit (coverage guard + statement/chain dedupe)
 *   - coverage survives a fallback-mode restart
 *
 * Run from the repo root (after `npm run build`):
 *   node packages/extension/test/capture-smoke.mjs
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import sqlite3InitModule from '../vendor/sqlite-wasm/node.mjs';
import { activePropositions, parseJsonl, replay } from '../vendor/lattice-core/index.js';
import { wrapDb } from '../worker/db.js';
import { createStoragePersistence, STORAGE_KEYS } from '../worker/persist.js';
import { openService } from '../worker/service.js';
import {
  createLlmPort,
  chatEndpoint,
  listModels,
  modelsEndpoint,
  normalizeProvider,
  ProviderError,
  testProvider,
} from '../worker/llm.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let sqlite3;

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

const SECRET_KEY = 'sk-capture-smoke-secret-456';

const TEXT = [
  '机会成本是你为了得到某样东西而放弃的最佳替代方案的价值。',
  '沉没成本是已经发生且无法收回的成本。',
  '因为沉没成本无法收回，所以理性决策不应考虑沉没成本。',
].join('\n');

/** Canned extraction answer: 3 propositions, 1 chain with 2 premises. */
const EXTRACTION = {
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

const PROVIDER = {
  preset: 'local',
  baseUrl: 'http://127.0.0.1:1234/v1',
  model: 'stub-model',
  apiKey: SECRET_KEY,
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function contentResponse(content) {
  return jsonResponse({ choices: [{ message: { content } }] });
}

/** Fake fetch: answers the extraction / identity prompts like a stub provider. */
function makeProviderFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (respond) return respond(url, init, calls.length);
    let body = {};
    try {
      body = JSON.parse(init.body);
    } catch {
      body = {};
    }
    const system = String(body?.messages?.[0]?.content ?? '');
    if (system.includes('知识抽取器')) return contentResponse(JSON.stringify(EXTRACTION));
    if (system.includes('命题去重')) return contentResponse(JSON.stringify({ decisions: [] }));
    return contentResponse('OK');
  };
  return { fetchImpl, calls };
}

function createFakeStorageArea() {
  const data = new Map();
  return {
    async get(keys) {
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of wanted) if (data.has(key)) out[key] = data.get(key);
      return out;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    dump() {
      return Object.fromEntries(data);
    },
  };
}

async function openMemoryService({ area, seed, fetchImpl } = {}) {
  const handle = new sqlite3.oo1.DB(':memory:');
  const persistence = createStoragePersistence(area, { debounceMs: 5 });
  const service = await openService({
    db: wrapDb(handle),
    mode: 'fallback',
    storageDetail: 'memory',
    persistence,
    seed: seed ?? (await persistence.load()),
    fetchImpl,
  });
  return { service, persistence, handle };
}

async function main() {
  sqlite3 = await sqlite3InitModule();
  const area = createFakeStorageArea();

  // -------------------------------------------------------------------------
  step('provider 客户端：请求格式与响应解析');
  // -------------------------------------------------------------------------
  let seen = null;
  const happyPort = createLlmPort(
    { preset: 'deepseek', baseUrl: 'https://api.deepseek.com/v1/', model: 'deepseek-flash', apiKey: SECRET_KEY },
    { fetchImpl: async (url, init) => { seen = { url, init }; return contentResponse('{"ok":true}'); } },
  );
  const happyContent = await happyPort.complete({
    messages: [{ role: 'user', content: '你好' }],
    temperature: 0.2,
    maxTokens: 64,
  });
  check('返回 choices[0].message.content', () => assert.equal(happyContent, '{"ok":true}'));
  check('URL 规范化：baseUrl + /chat/completions', () =>
    assert.equal(seen.url, 'https://api.deepseek.com/v1/chat/completions'));
  check('POST + JSON + Bearer 认证头', () => {
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.headers['Content-Type'], 'application/json');
    assert.equal(seen.init.headers.Authorization, `Bearer ${SECRET_KEY}`);
  });
  check('请求体：model / messages / temperature / max_tokens / stream:false', () => {
    const body = JSON.parse(seen.init.body);
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_tokens, 64);
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: 'user', content: '你好' }]);
  });
  check('chatEndpoint 保留完整的 /chat/completions 地址', () =>
    assert.equal(chatEndpoint('https://x.test/v1/chat/completions/'), 'https://x.test/v1/chat/completions'));

  // -------------------------------------------------------------------------
  step('provider 客户端：HTTP 错误映射（中文、不含 Key）');
  // -------------------------------------------------------------------------
  const httpCases = [
    { status: 401, pattern: /API Key 无效/ },
    { status: 403, pattern: /权限/ },
    { status: 404, pattern: /不存在/ },
    { status: 429, pattern: /频繁|额度/ },
    { status: 500, pattern: /暂时不可用/ },
  ];
  for (const testCase of httpCases) {
    const { fetchImpl } = makeProviderFetch(() =>
      jsonResponse({ error: { message: `server rejected ${SECRET_KEY}` } }, testCase.status),
    );
    const port = createLlmPort(
      { preset: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'm', apiKey: SECRET_KEY },
      { fetchImpl },
    );
    await checkAsync(`HTTP ${testCase.status} -> 中文错误且不泄露 Key`, async () => {
      await assert.rejects(
        () => port.complete({ messages: [{ role: 'user', content: 'x' }] }),
        (err) => {
          assert.ok(err instanceof ProviderError, `应抛 ProviderError，实际 ${err && err.name}`);
          assert.match(err.message, testCase.pattern);
          assert.doesNotMatch(err.message, new RegExp(SECRET_KEY));
          return true;
        },
      );
    });
  }

  // -------------------------------------------------------------------------
  step('provider 客户端：网络错误 / 非法 JSON / 缺内容 / 超时');
  // -------------------------------------------------------------------------
  const networkPort = createLlmPort(
    { preset: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'm', apiKey: SECRET_KEY },
    { fetchImpl: async () => { throw new TypeError('fetch failed'); } },
  );
  await checkAsync('网络错误 -> 无法连接', async () => {
    await assert.rejects(() => networkPort.complete({ messages: [{ role: 'user', content: 'x' }] }), /无法连接/);
  });
  const badJsonPort = createLlmPort(
    { preset: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'm', apiKey: SECRET_KEY },
    { fetchImpl: async () => new Response('{not json', { status: 200 }) },
  );
  await checkAsync('响应不是 JSON -> 中文错误', async () => {
    await assert.rejects(() => badJsonPort.complete({ messages: [{ role: 'user', content: 'x' }] }), /不是合法 JSON/);
  });
  const emptyPort = createLlmPort(
    { preset: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'm', apiKey: SECRET_KEY },
    { fetchImpl: async () => jsonResponse({ choices: [{}] }) },
  );
  await checkAsync('缺少 choices[0].message.content -> 中文错误', async () => {
    await assert.rejects(() => emptyPort.complete({ messages: [{ role: 'user', content: 'x' }] }), /缺少内容/);
  });
  const timeoutPort = createLlmPort(
    { preset: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'm', apiKey: SECRET_KEY },
    {
      timeoutMs: 20,
      fetchImpl: (url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    },
  );
  await checkAsync('60 秒超时机制（此处 20ms）-> 中文超时错误', async () => {
    await assert.rejects(() => timeoutPort.complete({ messages: [{ role: 'user', content: 'x' }] }), /超时/);
  });

  // -------------------------------------------------------------------------
  step('provider 配置校验：本地可空 Key，远端必须有 Key');
  // -------------------------------------------------------------------------
  let localSeen = null;
  const localPort = createLlmPort(
    { preset: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen', apiKey: '' },
    { fetchImpl: async (url, init) => { localSeen = init; return contentResponse('OK'); } },
  );
  await localPort.complete({ messages: [{ role: 'user', content: 'x' }] });
  check('本机接口不发送 Authorization 头', () => assert.equal(localSeen.headers.Authorization, undefined));
  check('远端接口缺少 Key 时在发请求前拒绝', () => {
    assert.throws(
      () => createLlmPort({ preset: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'm', apiKey: '' }),
      /API Key/,
    );
  });
  check('缺少接口地址 / 模型名给出中文提示', () => {
    assert.throws(() => normalizeProvider({ baseUrl: '', model: 'm' }), /接口地址/);
    assert.throws(() => normalizeProvider({ baseUrl: 'https://x.test/v1', model: '' }), /模型名称/);
    assert.throws(() => normalizeProvider({ baseUrl: 'not a url', model: 'm' }), /URL/);
  });

  // -------------------------------------------------------------------------
  step('providerTest：延迟 + 模型回显');
  // -------------------------------------------------------------------------
  const testTarget = makeProviderFetch(() => contentResponse('OK'));
  const providerTestResult = await testProvider(
    { preset: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: SECRET_KEY },
    { fetchImpl: testTarget.fetchImpl },
  );
  check('返回 ok / latencyMs / model / reply', () => {
    assert.equal(providerTestResult.ok, true);
    assert.equal(typeof providerTestResult.latencyMs, 'number');
    assert.ok(providerTestResult.latencyMs >= 0);
    assert.equal(providerTestResult.model, 'deepseek-flash');
    assert.equal(providerTestResult.reply, 'OK');
  });

  // -------------------------------------------------------------------------
  step('打开服务（内存 SQLite + 假 chrome.storage.local + 假 fetch）');
  // -------------------------------------------------------------------------
  const providerFetch = makeProviderFetch();
  const { service, persistence } = await openMemoryService({ area, fetchImpl: providerFetch.fetchImpl });
  check('空状态：0 命题', () => assert.equal(service.state().counts.propositions, 0));

  // -------------------------------------------------------------------------
  step('extractPreview：只返回预览计划，不写入任何事件');
  // -------------------------------------------------------------------------
  const preview = await service.extractPreview({
    text: TEXT,
    title: '机会成本与沉没成本',
    sourceKind: 'paste',
    provider: PROVIDER,
  });
  check('coverageHit = false，抽出 3 条命题 / 1 条推理链', () => {
    assert.equal(preview.coverageHit, false);
    assert.equal(preview.plan.create.length, 3);
    assert.equal(preview.plan.cues.length, 3);
    assert.equal(preview.plan.chains.length, 1);
    assert.equal(preview.plan.chains[0].premiseRefs.length, 2);
    assert.equal(preview.plan.dropped.length, 0);
    assert.equal(preview.propositions.length, 3);
    assert.equal(preview.propositions[0].existingId, null);
    assert.equal(preview.providerLabel, 'stub-model (local)');
    assert.equal(preview.model, 'stub-model');
    assert.equal(preview.promptVersion, 'extract-v1');
  });
  check('页面边界上只有 JSON（没有 Map / 类实例）', () => {
    const roundTripped = JSON.parse(JSON.stringify(preview));
    assert.equal(roundTripped.plan.create.length, 3);
    assert.ok(!(preview.plan instanceof Map));
    assert.ok(!(preview.propositions instanceof Map));
    assert.ok(!JSON.stringify(roundTripped).includes(SECRET_KEY));
  });
  check('预览不落库：事件数仍为 0', () => assert.equal(service.state().counts.events, 0));
  check('只调用了一次模型（空库时跳过 identify）', () => assert.equal(providerFetch.calls.length, 1));

  // -------------------------------------------------------------------------
  step('commitExtraction：一次事务写入 3 命题 / 3 卡 / 1 链');
  // -------------------------------------------------------------------------
  const committed = service.commitExtraction({
    source: preview.source,
    plan: preview.plan,
    providerLabel: preview.providerLabel,
    model: preview.model,
    promptVersion: preview.promptVersion,
  });
  check('counts = 3 命题 / 3 卡 / 1 链 / 7 事件', () => {
    assert.equal(committed.committed, true);
    assert.equal(committed.alreadyCovered, false);
    assert.equal(committed.counts.propositions, 3);
    assert.equal(committed.counts.reused, 0);
    assert.equal(committed.counts.cues, 3);
    assert.equal(committed.counts.chains, 1);
    assert.equal(committed.counts.events, 7);
    assert.equal(committed.coverage.propositionCount, 3);
    assert.equal(committed.coverage.chainCount, 1);
  });
  const exportedAfterCommit = service.exportJsonl();
  const replayedState = replay(parseJsonl(exportedAfterCommit.text).events);
  check('重放：3 条命题 / 3 张卡 / 1 条推理链（2 条先修边）', () => {
    assert.equal(activePropositions(replayedState).length, 3);
    assert.equal(Object.keys(replayedState.cues).length, 3);
    assert.equal(Object.keys(replayedState.chains).length, 1);
    assert.equal(service.graphSummary().withPrereq, 1);
  });
  check('事件由 llm:<model>@<promptVersion> 写出', () => {
    const parsed = parseJsonl(exportedAfterCommit.text).events;
    const propositionEvent = parsed.find((event) => event.type === 'proposition.asserted');
    assert.equal(propositionEvent.actor, 'llm:stub-model@extract-v1');
  });
  check('导出的事件日志不含 API Key', () => assert.doesNotMatch(exportedAfterCommit.text, new RegExp(SECRET_KEY)));

  // -------------------------------------------------------------------------
  step('coverage：同一文本第二次预览命中，且不再调用模型');
  // -------------------------------------------------------------------------
  const fetchCallsBeforeSecondPreview = providerFetch.calls.length;
  const secondPreview = await service.extractPreview({
    // whitespace-only differences must hit the same normalized hash
    text: `  ${TEXT.replace(/\n/g, '  \r\n')}  `,
    title: '换个标题也不影响指纹',
    sourceKind: 'paste',
    provider: PROVIDER,
  });
  check('coverageHit = true，带命题数 / 时间 / 模型', () => {
    assert.equal(secondPreview.coverageHit, true);
    assert.equal(secondPreview.propositionCount, 3);
    assert.equal(secondPreview.chainCount, 1);
    assert.equal(secondPreview.model, 'stub-model');
    assert.ok(secondPreview.extractedAt);
    assert.ok(secondPreview.source.sourceHash);
  });
  check('命中 coverage 时模型调用次数不变', () =>
    assert.equal(providerFetch.calls.length, fetchCallsBeforeSecondPreview));
  const coverageLookup = service.coverageCheck({ hash: preview.source.sourceHash });
  check('coverageCheck({hash}) 命中', () => {
    assert.equal(coverageLookup.hit, true);
    assert.equal(coverageLookup.coverage.propositionCount, 3);
  });
  check('coverageCheck({text}) 自动规范化后命中', () =>
    assert.equal(service.coverageCheck({ text: TEXT }).hit, true));

  // -------------------------------------------------------------------------
  step('幂等：同一计划重复提交不重复命题 / 卡 / 链');
  // -------------------------------------------------------------------------
  const eventsBeforeRepeat = service.exportJsonl().events;
  const repeat = service.commitExtraction({
    source: preview.source,
    plan: preview.plan,
    providerLabel: preview.providerLabel,
    model: preview.model,
    promptVersion: preview.promptVersion,
  });
  check('第二次提交：alreadyCovered，零事件', () => {
    assert.equal(repeat.committed, false);
    assert.equal(repeat.alreadyCovered, true);
    assert.equal(repeat.counts.events, 0);
    assert.equal(service.exportJsonl().events, eventsBeforeRepeat);
  });
  const forcedRepeat = service.commitExtraction({
    source: preview.source,
    plan: preview.plan,
    providerLabel: preview.providerLabel,
    model: preview.model,
    promptVersion: preview.promptVersion,
    force: true,
  });
  check('强制重提交（仍然重新抽取路径）：按 statement/chain 去重，仍零事件', () => {
    assert.equal(forcedRepeat.counts.propositions, 0);
    assert.equal(forcedRepeat.counts.cues, 0);
    assert.equal(forcedRepeat.counts.chains, 0);
    assert.equal(forcedRepeat.counts.reused, 3);
    assert.equal(service.exportJsonl().events, eventsBeforeRepeat);
    const state = service.state();
    assert.equal(state.counts.propositions, 3);
    assert.equal(state.counts.cues, 3);
  });
  const replayAfterRepeat = replay(parseJsonl(service.exportJsonl().text).events);
  check('重放后图仍是 3 命题 / 1 链', () => {
    assert.equal(activePropositions(replayAfterRepeat).length, 3);
    assert.equal(Object.keys(replayAfterRepeat.chains).length, 1);
  });

  // -------------------------------------------------------------------------
  step('graphSummary 与诊断');
  // -------------------------------------------------------------------------
  const graph = service.graphSummary();
  check('graphSummary = {3,1,2,1,0}', () =>
    assert.deepEqual(graph, { propositions: 3, chains: 1, foundation: 2, withPrereq: 1, mastered: 0 }));
  const diagnostics = service.diagnostics();
  check('诊断含 coverageCount = 1，且不含 Key', () => {
    assert.equal(diagnostics.coverageCount, 1);
    assert.equal(diagnostics.counts.propositions, 3);
    assert.ok(!JSON.stringify(diagnostics).includes(SECRET_KEY));
  });

  // -------------------------------------------------------------------------
  step('回退模式重启：事件日志与覆盖记录都恢复');
  // -------------------------------------------------------------------------
  await persistence.flush();
  const stored = area.dump();
  check('chrome.storage.local 存有 coverage 镜像', () => {
    assert.deepEqual(Object.keys(stored).sort(), [...STORAGE_KEYS].sort());
    assert.ok(stored.latticeCoverage.includes('sourceHash'));
    assert.ok(!JSON.stringify(stored).includes(SECRET_KEY));
  });
  const { service: restarted } = await openMemoryService({ area, fetchImpl: providerFetch.fetchImpl });
  check('重启后图与 digest 一致', () => {
    assert.equal(restarted.state().digest, service.state().digest);
    assert.deepEqual(restarted.graphSummary(), graph);
    assert.equal(restarted.coverageCheck({ hash: preview.source.sourceHash }).hit, true);
  });

  // -------------------------------------------------------------------------
  step('模型错误与校验错误：中文文本 + 至多 3 条 issues');
  // -------------------------------------------------------------------------
  {
    const httpErrorFetch = makeProviderFetch(() =>
      jsonResponse({ error: { message: `bad key ${SECRET_KEY}` } }, 401),
    );
    const { service: errorService } = await openMemoryService({
      area: createFakeStorageArea(),
      fetchImpl: httpErrorFetch.fetchImpl,
    });
    await checkAsync('抽取遇到 HTTP 401 -> 中文错误，不含 Key', async () => {
      await assert.rejects(
        () => errorService.extractPreview({ text: '另一段完全不同的文本内容。', provider: PROVIDER }),
        (err) => {
          assert.match(err.message, /API Key 无效/);
          assert.doesNotMatch(err.message, new RegExp(SECRET_KEY));
          return true;
        },
      );
    });

    const invalidFetch = makeProviderFetch(() => contentResponse('{"propositions":"nope"}'));
    const { service: invalidService } = await openMemoryService({
      area: createFakeStorageArea(),
      fetchImpl: invalidFetch.fetchImpl,
    });
    await checkAsync('模型输出未过校验 -> 中文错误 + issues[]', async () => {
      await assert.rejects(
        () => invalidService.extractPreview({ text: '第三段用来触发校验错误的文本。', provider: PROVIDER }),
        (err) => {
          assert.match(err.message, /抽取结果未通过校验/);
          assert.ok(Array.isArray(err.issues));
          assert.ok(err.issues.length > 0);
          assert.ok(err.issues.length <= 3, 'worker 只透传前 3 条 issues');
          return true;
        },
      );
    });

    await checkAsync('未配置 provider -> 中文提示', async () => {
      await assert.rejects(
        () => errorService.extractPreview({ text: '第四段文本，用来验证 provider 校验。', provider: { baseUrl: '', model: '' } }),
        /接口地址/,
      );
    });

    await checkAsync('空文本 -> 内容为空', async () => {
      await assert.rejects(() => errorService.extractPreview({ text: '   ', provider: PROVIDER }), /内容为空/);
    });
  }

  // -------------------------------------------------------------------------
  step('模型列表：GET /models（模型改名时可自助修复）');
  // -------------------------------------------------------------------------
  {
    const seenUrls = [];
    const modelsFetch = async (url) => {
      seenUrls.push(String(url));
      return jsonResponse({
        object: 'list',
        data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }, { id: 'deepseek-flash' }],
      });
    };
    const result = await listModels(
      { preset: 'deepseek', baseUrl: 'https://api.deepseek.com', model: '', apiKey: 'sk-test' },
      { fetchImpl: modelsFetch },
    );
    await checkAsync('未填模型也能拉取列表', async () => {
      assert.deepEqual(result.models, ['deepseek-flash', 'deepseek-v4-pro']);
      assert.equal(result.count, 2);
    });
    await checkAsync('endpoint 不带重复 /models', async () => {
      assert.equal(result.endpoint, 'https://api.deepseek.com/models');
      assert.equal(modelsEndpoint('https://api.deepseek.com/models/'), 'https://api.deepseek.com/models');
      assert.equal(seenUrls[0], 'https://api.deepseek.com/models');
    });
    await checkAsync('401 映射为中文错误', async () => {
      await assert.rejects(
        () =>
          listModels(
            { preset: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test' },
            { fetchImpl: async () => jsonResponse({ error: { message: 'bad key' } }, 401) },
          ),
        /API Key 无效/,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Done
  // -------------------------------------------------------------------------
  console.log('');
  if (failures > 0) {
    console.log(`CAPTURE SMOKE FAILED: ${failures} 项未通过`);
    process.exitCode = 1;
    return;
  }
  console.log(`CAPTURE SMOKE OK: 全部检查通过 · digest ${service.state().digest}`);
}

main().catch((err) => {
  console.error('CAPTURE SMOKE CRASHED', err);
  process.exitCode = 1;
});
