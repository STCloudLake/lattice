/**
 * Headless smoke test of the M2a push layer (no browser needed).
 *
 * Mirrors worker-smoke.mjs / capture-smoke.mjs: the real service code runs against
 * an in-memory SQLite database, a fake chrome.storage.local and (for the capture
 * part) a fake `fetch` standing in for the model provider. Covers the policy the
 * product direction depends on:
 *
 *   - `feed` returns at most `dose` items with valid reasons and a stable shape;
 *   - showing a card de-duplicates it for the rest of the day (ad fatigue);
 *   - skipping twice drops a proposition from future feeds (skip fatigue);
 *   - exposure events are C-ledger only: mastery / schedule never move;
 *   - committing a captured page with a domain writes `interest.observed`,
 *     stamps `proposition.domain` and reorders the feed;
 *   - `diagnostics().feed` reports dose / shown-today / interests.
 *
 * Run from the repo root (after `npm run build`):
 *   node packages/extension/test/feed-smoke.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import sqlite3InitModule from '../vendor/sqlite-wasm/node.mjs';
import { exposureOf, interestsOf, parseJsonl, replay } from '../vendor/lattice-core/index.js';
import { wrapDb } from '../worker/db.js';
import { createStoragePersistence } from '../worker/persist.js';
import { openService } from '../worker/service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const samplePath = path.join(here, '..', 'data', 'sample-pack.json');

let failures = 0;
let sqlite3;

/** Fixed instants keep the smoke deterministic (the service accepts `now`). */
const DAY1 = '2026-11-24T09:00:00.000Z';
const DAY2 = '2026-11-25T09:00:00.000Z';
const DAY3 = '2026-11-26T09:00:00.000Z';

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

const TEXT = [
  '机会成本是你为了得到某样东西而放弃的最佳替代方案的价值。',
  '沉没成本是已经发生且无法收回的成本。',
  '因为沉没成本无法收回，所以理性决策不应考虑沉没成本。',
].join('\n');

/** Canned extraction WITH a domain: capture is an interest signal first. */
const EXTRACTION = {
  domain: '经济学',
  propositions: [
    { ref: 'p1', statement: '机会成本是为了得到某样东西而放弃的最佳替代方案的价值。', name: '机会成本' },
    { ref: 'p2', statement: '沉没成本是已经发生且无法收回的成本。', name: '沉没成本' },
    { ref: 'p3', statement: '理性决策不应考虑沉没成本。', name: '沉没成本谬误' },
  ],
  chains: [{ premises: ['p1', 'p2'], conclusion: 'p3', strength: 0.8 }],
};

const PROVIDER = {
  preset: 'local',
  baseUrl: 'http://127.0.0.1:1234/v1',
  model: 'stub-model',
  apiKey: '',
};

function contentResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeProviderFetch() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
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

async function openMemoryService({ area, clock, fetchImpl } = {}) {
  const handle = new sqlite3.oo1.DB(':memory:');
  const persistence = createStoragePersistence(area, { debounceMs: 5 });
  const service = await openService({
    db: wrapDb(handle),
    mode: 'fallback',
    storageDetail: 'memory',
    persistence,
    seed: await persistence.load(),
    ...(clock ? { clock } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return { service, persistence };
}

function replayedState(service) {
  return replay(parseJsonl(service.exportJsonl().text).events);
}

function assertFeedShape(items) {
  for (const item of items) {
    assert.ok(typeof item.propositionId === 'string' && item.propositionId.length > 0, 'propositionId');
    assert.ok(item.kind === 'new' || item.kind === 'review', `kind=${item.kind}`);
    assert.ok(['due', 'frontier', 'foundation'].includes(item.reason), `reason=${item.reason}`);
    assert.ok(typeof item.score === 'number', 'score');
    assert.ok(typeof item.statement === 'string' && item.statement.length > 0, 'statement');
    assert.ok(item.mastery && typeof item.mastery.mean === 'number', 'mastery.mean');
    assert.ok(typeof item.mastery.low === 'number' && typeof item.mastery.high === 'number', 'mastery band');
    assert.ok(item.mastery.low <= item.mastery.mean && item.mastery.mean <= item.mastery.high, 'mastery band order');
    assert.ok(typeof item.retrievability === 'number', 'retrievability');
    assert.ok(item.exposure && typeof item.exposure.shown === 'number', 'exposure.shown');
    assert.ok(typeof item.exposure.engaged === 'number' && typeof item.exposure.skipped === 'number', 'exposure counts');
    if (item.cueId) {
      assert.ok(typeof item.cueFront === 'string' && item.cueFront.length > 0, 'cueFront');
      assert.ok(typeof item.cueBack === 'string', 'cueBack');
    }
  }
}

async function main() {
  sqlite3 = await sqlite3InitModule();
  const sampleText = await readFile(samplePath, 'utf8');

  // -------------------------------------------------------------------------
  step('feed：剂量、形状、reason（示例包 8 条命题，无先修链）');
  // -------------------------------------------------------------------------
  const area = createFakeStorageArea();
  const { service } = await openMemoryService({
    area,
    clock: { now: () => new Date('2026-11-24T12:00:00.000Z') },
  });
  const imported = service.importPack(sampleText);
  check('示例包导入 8 命题 / 12 卡', () => {
    assert.equal(imported.addedPropositions, 8);
    assert.equal(imported.addedCues, 12);
  });

  const eventsBeforeFeed = service.exportJsonl().events;
  const feed = service.feed({ dose: 3, now: DAY1 });
  check('≤ dose，todayDate 有值，item 形状完整', () => {
    assert.ok(feed.items.length > 0 && feed.items.length <= 3, `items=${feed.items.length}`);
    assert.equal(feed.dose, 3);
    assert.equal(feed.todayDate, '2026-11-24');
    assertFeedShape(feed.items);
    assert.equal(new Set(feed.items.map((item) => item.propositionId)).size, feed.items.length);
  });
  check('全是没有先修的基础新命题（reason=foundation / kind=new）', () => {
    for (const item of feed.items) {
      assert.equal(item.kind, 'new');
      assert.equal(item.reason, 'foundation');
    }
  });
  check('示例包里每条命题都带领域', () => {
    for (const item of feed.items) assert.ok(['economics', 'learning'].includes(item.domain), `domain=${item.domain}`);
  });
  check('feed 是纯读：不写任何事件', () => assert.equal(service.exportJsonl().events, eventsBeforeFeed));
  check('剂量可调：dose 5 -> 5 条，dose 1 -> 1 条', () => {
    assert.equal(service.feed({ dose: 5, now: DAY1 }).items.length, 5);
    assert.equal(service.feed({ dose: 1, now: DAY1 }).items.length, 1);
  });

  // -------------------------------------------------------------------------
  step('exposure.shown：同一天不再推（频次控制），且不动掌握/调度');
  // -------------------------------------------------------------------------
  const target = feed.items[0];
  const stateBefore = replayedState(service);
  const shown = service.exposure({ propositionId: target.propositionId, kind: 'shown', surface: 'newtab', now: DAY1 });
  check('shown 返回 ok + 重算后的 feed 不再包含该命题', () => {
    assert.equal(shown.ok, true);
    assert.ok(!shown.feed.items.some((item) => item.propositionId === target.propositionId));
    assert.ok(shown.feed.items.length > 0);
  });
  check('C 账：shown=1 事件落库', () => {
    const state = replayedState(service);
    assert.equal(service.exportJsonl().events, eventsBeforeFeed + 1);
    assert.equal(exposureOf(state, target.propositionId).shown, 1);
    assert.equal(state.exposures[target.propositionId].lastShownDay, '2026-11-24');
  });
  check('曝光不碰 M/S 账：mastery 与 schedule 完全不变', () => {
    const after = replayedState(service);
    assert.deepEqual(after.mastery[target.propositionId], stateBefore.mastery[target.propositionId]);
    assert.deepEqual(after.schedule[target.propositionId], stateBefore.schedule[target.propositionId]);
    assert.equal(after.reviews.length, stateBefore.reviews.length);
  });
  check('同一命题可以追加 engaged / skipped（仍不进 M/S）', () => {
    service.exposure({ propositionId: target.propositionId, kind: 'engaged', surface: 'newtab', now: DAY1 });
    service.exposure({ propositionId: target.propositionId, kind: 'skipped', surface: 'newtab', now: DAY1 });
    const state = replayedState(service);
    assert.equal(exposureOf(state, target.propositionId).engaged, 1);
    assert.equal(exposureOf(state, target.propositionId).skipped, 1);
    assert.deepEqual(state.mastery[target.propositionId], stateBefore.mastery[target.propositionId]);
    assert.deepEqual(state.schedule[target.propositionId], stateBefore.schedule[target.propositionId]);
  });
  check('换一天后（lastShownDay 不同）可以再次出现', () => {
    const nextDay = service.feed({ dose: 3, now: DAY2 });
    assert.ok(nextDay.items.some((item) => item.propositionId === target.propositionId));
  });

  // -------------------------------------------------------------------------
  step('skip fatigue：跳过两次后彻底不推');
  // -------------------------------------------------------------------------
  {
    const { service: skipService } = await openMemoryService({ area: createFakeStorageArea() });
    skipService.importPack(sampleText);
    const firstDay = skipService.feed({ dose: 3, now: DAY1 });
    const item = firstDay.items[0];
    skipService.exposure({ propositionId: item.propositionId, kind: 'shown', now: DAY1 });
    skipService.exposure({ propositionId: item.propositionId, kind: 'skipped', now: DAY1 });
    const day2 = skipService.feed({ dose: 3, now: DAY2 });
    check('跳过一次：第二天仍然会推', () =>
      assert.ok(day2.items.some((entry) => entry.propositionId === item.propositionId)));
    skipService.exposure({ propositionId: item.propositionId, kind: 'shown', now: DAY2 });
    skipService.exposure({ propositionId: item.propositionId, kind: 'skipped', now: DAY2 });
    check('跳过两次：第三天不再出现', () => {
      const day3 = skipService.feed({ dose: 3, now: DAY3 });
      assert.ok(!day3.items.some((entry) => entry.propositionId === item.propositionId));
    });
  }

  // -------------------------------------------------------------------------
  step('到期复习：以 kind=review / reason=due 出现（不挤掉全部新内容）');
  // -------------------------------------------------------------------------
  {
    const clockRef = { at: DAY1 };
    const { service: dueService } = await openMemoryService({
      area: createFakeStorageArea(),
      clock: { now: () => new Date(clockRef.at) },
    });
    dueService.importPack(sampleText);
    const first = dueService.feed({ dose: 3 });
    const item = first.items[0];
    dueService.grade({ propositionId: item.propositionId, cueId: item.cueId, grade: 4 });
    clockRef.at = '2027-11-24T09:00:00.000Z'; // a year later: certainly due
    const later = dueService.feed({ dose: 3 });
    check('到期命题出现在 feed 且标记复习', () => {
      const review = later.items.find((entry) => entry.propositionId === item.propositionId);
      assert.ok(review, '到期命题应出现在 feed');
      assert.equal(review.kind, 'review');
      assert.equal(review.reason, 'due');
      assert.ok(review.retrievability >= 0 && review.retrievability < 1);
    });
    check('复习份额受限: dose 3 中复习 ≤ 1 条（reviewShare 0.4）', () => {
      assert.ok(later.items.filter((entry) => entry.kind === 'review').length <= 1);
      assert.ok(later.items.some((entry) => entry.kind === 'new'), '仍应有新内容');
    });
  }

  // -------------------------------------------------------------------------
  step('捕获 = 兴趣信号：commit 写 interest.observed + proposition.domain');
  // -------------------------------------------------------------------------
  const providerFetch = makeProviderFetch();
  const { service: captureService } = await openMemoryService({
    area: createFakeStorageArea(),
    fetchImpl: providerFetch.fetchImpl,
  });
  const preview = await captureService.extractPreview({
    text: TEXT,
    title: '机会成本与沉没成本',
    sourceKind: 'paste',
    provider: PROVIDER,
  });
  check('预览计划带领域（page 必须原样带回 commit）', () => assert.equal(preview.plan.domain, '经济学'));
  check('预览不落库', () => assert.equal(captureService.exportJsonl().events, 0));

  const committed = captureService.commitExtraction({
    source: preview.source,
    plan: preview.plan,
    providerLabel: preview.providerLabel,
    model: preview.model,
    promptVersion: preview.promptVersion,
  });
  check('commit 返回领域，事件含 interest.observed（3 命题 + 3 卡 + 1 链 + 1 兴趣 = 8）', () => {
    assert.equal(committed.domain, '经济学');
    assert.equal(committed.committed, true);
    assert.equal(committed.counts.propositions, 3);
    assert.equal(committed.counts.cues, 3);
    assert.equal(committed.counts.chains, 1);
    assert.equal(committed.counts.events, 8);
  });
  check('重放：每条命题都带 domain，interest 权重/次数正确', () => {
    const state = replayedState(captureService);
    for (const proposition of Object.values(state.propositions)) {
      assert.equal(proposition.domain, '经济学');
    }
    const interest = interestsOf(state).find((entry) => entry.name === '经济学');
    assert.ok(interest, '应产生领域兴趣');
    assert.equal(interest.captureCount, 1);
    assert.ok(interest.weight >= 1);
  });
  const capturedFeed = captureService.feed({ dose: 3, now: DAY1 });
  check('feed 暴露兴趣与领域，兴趣只影响排序', () => {
    assert.ok(capturedFeed.interests.some((entry) => entry.name === '经济学' && entry.count === 1));
    assert.ok(capturedFeed.items.every((item) => item.domain === '经济学'));
    assert.equal(capturedFeed.items[0].domain, '经济学');
    assert.ok(capturedFeed.items.every((item) => item.mastery.mean > 0 && item.mastery.mean < 1));
  });

  // -------------------------------------------------------------------------
  step('diagnostics：推送层事实（剂量 / 今日展示 / 兴趣）');
  // -------------------------------------------------------------------------
  const diag = captureService.diagnostics({ dose: 5 });
  check('feed 诊断字段齐全且不含敏感信息', () => {
    assert.equal(diag.feed.dose, 5);
    assert.equal(typeof diag.feed.todayDate, 'string');
    assert.equal(diag.feed.shownToday, 0);
    assert.equal(diag.feed.engaged, 0);
    assert.equal(diag.feed.skipped, 0);
    assert.ok(diag.feed.interests.some((entry) => entry.name === '经济学'));
    assert.doesNotMatch(JSON.stringify(diag), /stub-model\s*\(/); // no provider config leak beyond label
  });
  const shownDiag = service.diagnostics({ dose: 3 });
  check('今日已展示数量与曝光事件一致', () => {
    assert.equal(shownDiag.feed.shownToday, 1);
    assert.equal(shownDiag.feed.engaged, 1);
    assert.equal(shownDiag.feed.skipped, 1);
    assert.equal(shownDiag.feed.interests.length, 0);
  });

  // -------------------------------------------------------------------------
  step('exposure 参数校验：中文错误');
  // -------------------------------------------------------------------------
  check('缺少 propositionId / 非法 kind / 不存在的命题', () => {
    assert.throws(() => captureService.exposure({ propositionId: '', kind: 'shown' }), /缺少 propositionId/);
    assert.throws(() => captureService.exposure({ propositionId: 'p', kind: 'wat' }), /曝光类型无效/);
    assert.throws(() => captureService.exposure({ propositionId: 'missing', kind: 'shown' }), /命题不存在/);
  });

  // -------------------------------------------------------------------------
  step('暴露事件跨重启保留（C 账跟事件日志一起持久化）');
  // -------------------------------------------------------------------------
  {
    const persistArea = createFakeStorageArea();
    const { service: keepService, persistence } = await openMemoryService({
      area: persistArea,
      fetchImpl: providerFetch.fetchImpl,
    });
    keepService.importPack(sampleText);
    const item = keepService.feed({ dose: 3, now: DAY1 }).items[0];
    keepService.exposure({ propositionId: item.propositionId, kind: 'shown', now: DAY1 });
    await persistence.flush();
    const { service: restarted } = await openMemoryService({ area: persistArea });
    await checkAsync('重启后同日去重仍生效', async () => {
      const feedAfterRestart = restarted.feed({ dose: 3, now: DAY1 });
      assert.ok(!feedAfterRestart.items.some((entry) => entry.propositionId === item.propositionId));
      const state = replayedState(restarted);
      assert.equal(exposureOf(state, item.propositionId).shown, 1);
    });
  }

  console.log('');
  if (failures > 0) {
    console.log(`FEED SMOKE FAILED: ${failures} 项未通过`);
    process.exitCode = 1;
    return;
  }
  console.log(`FEED SMOKE OK: 全部检查通过 · digest ${service.state().digest}`);
}

main().catch((err) => {
  console.error('FEED SMOKE CRASHED', err);
  process.exitCode = 1;
});
