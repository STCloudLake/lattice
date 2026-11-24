/**
 * Headless smoke test of M2c: declared interests + autonomously prepared content.
 *
 * Mirrors worker-smoke.mjs / feed-smoke.mjs: the real service code runs against an
 * in-memory SQLite database, a fake chrome.storage.local and a fake `fetch`
 * standing in for both the bundled curriculum file and the model provider. Covers
 * the product direction the extension must not lose:
 *
 *   - `seedCurriculum()` imports the bundled 计算机 + 人工智能 beginner pack and
 *     declares both domains, in ONE transaction, exactly once (idempotent even
 *     across a simulated worker restart);
 *   - `declareInterest` / `removeInterest` round-trip through the event log and
 *     the feed payload (declared beats inferred; removal keeps captures);
 *   - `curriculumNeeds()` reflects state and levels;
 *   - `generateCurriculum()` calls the model, adds propositions + chains, keeps
 *     the declared interest, and never touches mastery/schedule (C ledger only);
 *   - the once-per-domain-per-day guard (newtab/curriculum-guard.js, tested here
 *     with the same fake chrome.storage) blocks the second call of the day.
 *
 * Run from the repo root (after `npm run build`):
 *   node packages/extension/test/curriculum-smoke.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import sqlite3InitModule from '../vendor/sqlite-wasm/node.mjs';
import { replay } from '../vendor/lattice-core/index.js';
import {
  loadCurriculumState,
  localDayKey,
  markGeneratedForDay,
  planNextGeneration,
  saveCurriculumState,
} from '../newtab/curriculum-guard.js';
import { wrapDb } from '../worker/db.js';
import { createStoragePersistence } from '../worker/persist.js';
import { openService } from '../worker/service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const seedPath = path.join(here, '..', 'data', 'seed-curriculum.json');
const samplePath = path.join(here, '..', 'data', 'sample-pack.json');

const SEED_URL = 'https://extension.invalid/data/seed-curriculum.json';

let failures = 0;
let sqlite3;
let seedText = '';

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
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    },
    dump() {
      return Object.fromEntries(data);
    },
  };
}

/** Canned "curriculum designer" answer: 6 atomic statements + 1 chain. */
const STUB_CURRICULUM = {
  domain: '数学',
  propositions: [
    { ref: 'c1', statement: '数学研究数量、结构、空间与变化。', name: '数学' },
    { ref: 'c2', statement: '集合是一组无序且互异对象的整体。', name: '集合' },
    { ref: 'c3', statement: '函数把每个输入映射到唯一的输出。', name: '函数' },
    { ref: 'c4', statement: '命题是可以判断真假的陈述句。', name: '命题' },
    { ref: 'c5', statement: '两个命题都真时，合取命题才为真。', name: '合取' },
    { ref: 'c6', statement: '定义域是函数允许的全部输入。', name: '定义域' },
  ],
  chains: [{ premises: ['c2', 'c3'], conclusion: 'c6', strength: 0.8 }],
};

const PROVIDER = {
  preset: 'local',
  baseUrl: 'http://127.0.0.1:1234/v1',
  model: 'stub-model',
  apiKey: '',
};

function jsonResponse(payload) {
  return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Fake fetch: the bundled pack file + the OpenAI-compatible chat endpoint. */
function makeFetch() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    if (href === SEED_URL) {
      calls.push({ kind: 'seed', url: href });
      return jsonResponse(seedText);
    }
    if (href.includes('/chat/completions')) {
      let body = {};
      try {
        body = JSON.parse(init.body);
      } catch {
        body = {};
      }
      const system = String(body?.messages?.[0]?.content ?? '');
      calls.push({ kind: 'chat', system: system.slice(0, 24), model: body.model });
      if (system.includes('课程设计者')) return jsonResponse({ choices: [{ message: { content: JSON.stringify(STUB_CURRICULUM) } }] });
      if (system.includes('命题去重')) return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decisions: [] }) } }] });
      return jsonResponse({ choices: [{ message: { content: 'OK' } }] });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  return { fetchImpl, calls };
}

async function openMemoryService({ area, fetchImpl, seed } = {}) {
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
  return { service, persistence };
}

/** The exported event log, parsed line by line (what actually reached the ledger). */
function eventTypesOf(service) {
  const exported = service.exportJsonl();
  const eventList = [];
  for (const line of exported.text.split('\n')) {
    if (!line.trim()) continue;
    eventList.push(JSON.parse(line));
  }
  return { eventList };
}

/** Beta posterior means, keyed by proposition id (C ledger events must not move them). */
function masterySnapshot(service) {
  const replayed = replay(eventTypesOf(service).eventList);
  const out = {};
  for (const [id, mastery] of Object.entries(replayed.mastery)) {
    out[id] = { mean: mastery.mean, strength: mastery.strength };
  }
  return out;
}

async function main() {
  sqlite3 = await sqlite3InitModule();
  seedText = await readFile(seedPath, 'utf8');
  const sampleText = await readFile(samplePath, 'utf8');
  const area = createFakeStorageArea();
  const { fetchImpl, calls } = makeFetch();

  step('打开回退服务：空状态没有任何兴趣');
  const { service, persistence } = await openMemoryService({ area, fetchImpl });
  check('curriculumNeeds() = 空，init.interests = 空', () => {
    const needs = service.curriculumNeeds();
    assert.deepEqual(needs.needs, []);
    assert.deepEqual(needs.interests, []);
    const init = service.initPayload();
    assert.deepEqual(init.interests, []);
  });

  step('seedCurriculum(): 内置 14 命题 / 3 链 + 声明「计算机」「人工智能」入门');
  let seeded;
  await checkAsync('一次事务导入，返回计数与领域', async () => {
    seeded = await service.seedCurriculum({ url: SEED_URL });
    assert.equal(seeded.alreadySeeded, false);
    assert.equal(seeded.addedPropositions, 14);
    assert.equal(seeded.addedChains, 3);
    assert.deepEqual(seeded.domains, ['计算机', '人工智能']);
  });
  check('34 条事件（14 命题 + 14 卡 + 3 链 + 2 声明），14 命题可推', () => {
    const state = service.state();
    assert.equal(state.counts.propositions, 14);
    assert.equal(state.counts.cues, 14);
    assert.equal(state.counts.events, 14 + 14 + 3 + 2);
    assert.equal(state.empty, false);
  });
  check('两个领域都是 declared + beginner，seed 后已足够（needs 为空）', () => {
    const needs = service.curriculumNeeds();
    assert.equal(needs.needs.length, 0);
    const declared = needs.interests.filter((entry) => entry.declared);
    assert.deepEqual(
      declared.map((entry) => `${entry.name}:${entry.level}`).sort(),
      ['人工智能:beginner', '计算机:beginner'],
    );
  });
  check('事件日志里是 interest.declared，不是 interest.observed', () => {
    const { eventList } = eventTypesOf(service);
    const declared = eventList.filter((event) => event.type === 'interest.declared');
    assert.equal(declared.length, 2);
    assert.equal(declared[0].actor, 'system');
    assert.ok(declared.every((event) => event.payload.level === 'beginner'));
  });

  step('幂等：再次 seed 被拒绝（meta 标记）');
  await checkAsync('alreadySeeded = true，事件数不变', async () => {
    const before = service.state().counts.events;
    const again = await service.seedCurriculum({ url: SEED_URL });
    assert.equal(again.alreadySeeded, true);
    assert.equal(service.state().counts.events, before);
  });

  step('幂等：回退模式重启后（meta 丢失）靠已有内容也不会重复导入');
  await persistence.flush();
  const { service: restarted } = await openMemoryService({ area, fetchImpl });
  await checkAsync('重启后 seedCurriculum 仍 alreadySeeded', async () => {
    assert.equal(restarted.state().counts.propositions, 14);
    const again = await restarted.seedCurriculum({ url: SEED_URL });
    assert.equal(again.alreadySeeded, true);
    assert.equal(restarted.state().counts.propositions, 14);
  });

  step('幂等：已有用户内容时不注入 seed');
  const otherArea = createFakeStorageArea();
  const { service: userService } = await openMemoryService({ area: otherArea, fetchImpl });
  await checkAsync('先导入示例包，再 seed → alreadySeeded 且不新增', async () => {
    userService.importPack(sampleText);
    const before = userService.state().counts.propositions;
    const result = await userService.seedCurriculum({ url: SEED_URL });
    assert.equal(result.alreadySeeded, true);
    assert.equal(userService.state().counts.propositions, before);
    assert.equal(userService.curriculumNeeds().interests.length, 0);
  });

  step('declareInterest / removeInterest 往返（C 账事件）');
  const masteryBefore = masterySnapshot(service);
  let declaredFeed;
  check('声明「数学」进阶：feed 里出现 declared 兴趣，needs 反映水平', () => {
    const result = service.declareInterest({ domain: '数学', level: 'intermediate' });
    declaredFeed = result.feed;
    assert.equal(result.ok, true);
    const math = (result.feed.interests || []).find((entry) => entry.name === '数学');
    assert.ok(math, 'feed.interests 应包含 数学');
    assert.equal(math.declared, true);
    assert.equal(math.level, 'intermediate');
    const needs = service.curriculumNeeds().needs;
    assert.deepEqual(
      needs.map((entry) => `${entry.domain}:${entry.level}:${entry.existing}`),
      ['数学:intermediate:0'],
    );
  });
  check('移除「数学」：声明消失，needs 变空（没有捕获，兴趣直接删除）', () => {
    const result = service.removeInterest({ domain: '数学' });
    assert.equal(result.ok, true);
    assert.equal((result.feed.interests || []).some((entry) => entry.name === '数学'), false);
    assert.deepEqual(service.curriculumNeeds().needs, []);
  });
  check('兴趣事件不影响掌握度/复习（导出日志里没有 review/quiz 事件）', () => {
    const { eventList } = eventTypesOf(service);
    const cLedgerOnly = eventList.filter((event) => event.type.startsWith('interest.') || event.type.startsWith('exposure.'));
    assert.ok(cLedgerOnly.length >= 2);
    assert.equal(eventList.some((event) => event.type === 'review.rated' || event.type === 'quiz.answered'), false);
    assert.deepEqual(masterySnapshot(service), masteryBefore, '兴趣/声明事件不能改变 Beta 后验');
    const replayed = replay(eventList);
    // A fresh schedule row exists per proposition (FSRS needs a card), but no
    // event may have rated it: the C ledger never touches the S ledger.
    assert.ok(Object.values(replayed.schedule).every((schedule) => schedule.reviewCount === 0));
  });

  step('generateCurriculum(): 模型生成 + 全新增量 + 保留声明');
  service.declareInterest({ domain: '数学', level: 'beginner' });
  let generated;
  await checkAsync('stub 模型收到「课程设计者」提示并写入 6 命题 + 1 链', async () => {
    const before = service.state().counts.propositions;
    generated = await service.generateCurriculum({
      domain: '数学',
      level: 'beginner',
      count: 6,
      provider: PROVIDER,
    });
    assert.equal(generated.ok, true);
    assert.equal(generated.domain, '数学');
    assert.equal(generated.level, 'beginner');
    assert.equal(generated.addedPropositions, 6);
    assert.equal(generated.addedChains, 1);
    assert.equal(service.state().counts.propositions, before + 6);
  });
  check('stub 请求带 课程设计者 system 与模型名', () => {
    const chat = calls.filter((call) => call.kind === 'chat');
    const curriculumCall = chat.find((call) => call.system.includes('课程设计者'));
    assert.ok(curriculumCall, '应调用一次课程生成');
    assert.equal(curriculumCall.model, 'stub-model');
  });
  check('生成后该领域满足 minPropositions，needs 变空；兴趣仍是 declared', () => {
    assert.deepEqual(service.curriculumNeeds().needs, []);
    const interference = service.curriculumNeeds().interests.find((entry) => entry.name === '数学');
    assert.ok(interference);
    assert.equal(interference.declared, true);
    assert.equal(interference.level, 'beginner');
  });
  check('生成内容带 domain 与「session」来源，actor = llm:stub-model@curriculum-v2', () => {
    const { eventList } = eventTypesOf(service);
    const generatedProps = eventList.filter(
      (event) =>
        event.type === 'proposition.asserted' &&
        event.actor === 'llm:stub-model@curriculum-v2' &&
        event.payload.domain === '数学',
    );
    assert.equal(generatedProps.length, 6);
    assert.equal(
      eventList.filter((event) => event.type === 'chain.asserted' && event.actor === 'llm:stub-model@curriculum-v2').length,
      1,
    );
  });

  step('重复生成：声明级去重，不制造重复命题');
  await checkAsync('同一天同内容的第二批 addedPropositions = 0', async () => {
    const before = service.state().counts.propositions;
    const again = await service.generateCurriculum({ domain: '数学', level: 'beginner', count: 6, provider: PROVIDER });
    assert.equal(again.addedPropositions, 0);
    assert.equal(again.addedChains, 0);
    assert.equal(service.state().counts.propositions, before);
  });

  step('每日一次守卫（page 侧，fake chrome.storage.local）');
  const guardArea = createFakeStorageArea();
  const day = localDayKey();
  const tomorrow = localDayKey(new Date(Date.now() + 24 * 3600 * 1000));
  const need = { domain: '数学', level: 'beginner', existing: 0 };
  await checkAsync('第一天：无 provider → hint；有 provider → generate', async () => {
    let stateMap = await loadCurriculumState(guardArea);
    assert.deepEqual(stateMap, {});
    const hinted = planNextGeneration({ needs: [need], curriculumState: stateMap, day, providerReady: false });
    assert.equal(hinted.action, 'hint');
    assert.equal(hinted.need.domain, '数学');
    const fresh = planNextGeneration({ needs: [need], curriculumState: stateMap, day, providerReady: true });
    assert.equal(fresh.action, 'generate');
  });
  await checkAsync('生成成功后落盘，同一天第二次 → daily-limit', async () => {
    const marked = markGeneratedForDay(await loadCurriculumState(guardArea), '数学', day);
    assert.equal(await saveCurriculumState(guardArea, marked), true);
    assert.deepEqual(await loadCurriculumState(guardArea), { 数学: day });
    const blocked = planNextGeneration({ needs: [need], curriculumState: await loadCurriculumState(guardArea), day, providerReady: true });
    assert.equal(blocked.action, 'none');
    assert.equal(blocked.reason, 'daily-limit');
  });
  await checkAsync('次日恢复；并发中 / 本会话已尝试 / 无需求都返回 none', async () => {
    const nextDay = planNextGeneration({ needs: [need], curriculumState: await loadCurriculumState(guardArea), day: tomorrow, providerReady: true });
    assert.equal(nextDay.action, 'generate');
    const busy = planNextGeneration({ needs: [need], curriculumState: {}, day, providerReady: true, busy: true });
    assert.equal(busy.reason, 'busy');
    const attempted = planNextGeneration({ needs: [need], curriculumState: {}, day, providerReady: true, attempted: new Set(['数学']) });
    assert.equal(attempted.reason, 'attempted');
    const noNeeds = planNextGeneration({ needs: [], curriculumState: {}, day, providerReady: true });
    assert.equal(noNeeds.reason, 'no-needs');
  });
  await checkAsync('损坏的 storage 值被当作「今天没生成过」', async () => {
    const brokenArea = createFakeStorageArea();
    await brokenArea.set({ latticeCurriculumState: 'not-an-object' });
    assert.deepEqual(await loadCurriculumState(brokenArea), {});
  });

  step('诊断：兴趣 + 待生成行所需字段');
  check('diagnostics().curriculum 带 declared 兴趣与空 needs', () => {
    const diagnostics = service.diagnostics();
    assert.ok(diagnostics.curriculum);
    assert.equal(diagnostics.curriculum.needs.length, 0);
    const math = diagnostics.curriculum.interests.find((entry) => entry.name === '数学');
    assert.ok(math);
    assert.equal(math.declared, true);
    assert.equal(math.level, 'beginner');
  });
  check('feed().interests 含 declared/level（settings 列表数据源）', () => {
    const feed = service.feed({ dose: 3 });
    const entry = feed.interests.find((item) => item.name === '计算机');
    assert.ok(entry);
    assert.equal(entry.declared, true);
    assert.equal(entry.level, 'beginner');
  });

  console.log('');
  if (failures > 0) {
    console.log(`CURRICULUM SMOKE FAILED: ${failures} 项未通过`);
    process.exitCode = 1;
    return;
  }
  console.log('CURRICULUM SMOKE OK: 全部检查通过');
}

main().catch((err) => {
  console.error('CURRICULUM SMOKE CRASHED', err);
  process.exitCode = 1;
});
