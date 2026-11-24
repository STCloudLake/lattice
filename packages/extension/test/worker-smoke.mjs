/**
 * Headless smoke test of the Lattice worker logic (no browser needed).
 *
 * The real worker opens OPFS SQLite; here we inject an in-memory SQLite created
 * with the Node build of sqlite-wasm and a fake chrome.storage.local. That is the
 * same code path the extension's fallback mode takes, minus the browser.
 *
 * Run from the repo root:   npm run build && node packages/extension/test/worker-smoke.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import sqlite3InitModule from '../vendor/sqlite-wasm/node.mjs';
import { parseJsonl, replay, stateDigest } from '../vendor/lattice-core/index.js';
import { wrapDb } from '../worker/db.js';
import { createStoragePersistence, STORAGE_KEYS } from '../worker/persist.js';
import { openService } from '../worker/service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const samplePath = path.join(here, '..', 'data', 'sample-pack.json');

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

/** Fake chrome.storage.local area: `get(keys[])` / `set(object)`. */
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

async function openMemoryService({ area, seed } = {}) {
  const handle = new sqlite3.oo1.DB(':memory:');
  const persistence = createStoragePersistence(area, { debounceMs: 5 });
  const service = await openService({
    db: wrapDb(handle),
    mode: 'fallback',
    storageDetail: 'memory',
    persistence,
    seed: seed ?? (await persistence.load()),
  });
  return { service, persistence };
}

async function main() {
  sqlite3 = await sqlite3InitModule();
  const sampleText = await readFile(samplePath, 'utf8');
  const area = createFakeStorageArea();

  step('打开回退服务（内存 SQLite + 假 chrome.storage.local）');
  const { service, persistence } = await openMemoryService({ area });
  const init = service.initPayload();
  check('storage = fallback, persisted = true', () => {
    assert.equal(init.storage, 'fallback');
    assert.equal(init.persisted, true);
    assert.match(init.deviceId, /^[0-9a-f-]{36}$/);
  });
  check('空状态：0 命题，empty = true', () => {
    assert.equal(init.counts.propositions, 0);
    assert.equal(init.empty, true);
  });

  step('导入示例包（8 命题 / 12 张卡）');
  const imported = service.importPack(sampleText);
  check('addedPropositions = 8, addedCues = 12, errors = 0', () => {
    assert.equal(imported.addedPropositions, 8);
    assert.equal(imported.addedCues, 12);
    assert.equal(imported.errors.length, 0);
  });
  const again = service.importPack(sampleText);
  check('重复导入被去重（skipped = 8, added = 0）', () => {
    assert.equal(again.addedPropositions, 0);
    assert.equal(again.skipped, 8);
  });

  let render = service.state();
  check('投影一致：8 命题 / 12 cue / 8 新学 / 队列 8', () => {
    assert.equal(render.counts.propositions, 8);
    assert.equal(render.counts.cues, 12);
    assert.equal(render.counts.new, 8);
    assert.equal(render.counts.due, 0);
    assert.equal(render.queue.length, 8);
    assert.equal(render.empty, false);
  });
  check('render 项带掌握度/可用率/复习次数', () => {
    const item = render.queue[0];
    assert.ok(item.front.length > 0 && item.back.length > 0);
    assert.ok(item.mastery.mean > 0 && item.mastery.mean < 1);
    assert.equal(item.reviewCount, 0);
    assert.equal(item.retrievability, 0);
  });

  step('评级 3 张卡（一般 / 困难 / 简单）');
  const sequence = [3, 2, 4];
  for (let i = 0; i < sequence.length; i += 1) {
    const item = render.queue[0];
    render = service.grade({ propositionId: item.propositionId, cueId: item.cueId, grade: sequence[i] });
    check(`第 ${i + 1} 次评级后 reviews = ${i + 1}，seq = ${render.lastSeq}`, () => {
      assert.equal(render.counts.reviews, i + 1);
      assert.ok(render.lastSeq >= 20 + i + 1);
    });
  }
  check('三条 review.rated 事件落库（导入 20 条 + 3 条评级 = 23 条事件）', () => {
    assert.equal(render.counts.events, 23);
  });

  step('测验作答（quiz.answered 只进掌握账）');
  const quizItem = render.queue[0];
  const meanBefore = quizItem.mastery.mean;
  const reviewsBefore = render.counts.reviews;
  const afterQuiz = service.quiz({ propositionId: quizItem.propositionId, cueId: quizItem.cueId, correct: true, latencyMs: 1200 });
  check('掌握度上升、复习次数不变', () => {
    const again2 = afterQuiz.queue.find((entry) => entry.propositionId === quizItem.propositionId);
    assert.ok(afterQuiz.counts.reviews === reviewsBefore, 'quiz 不应写调度账');
    assert.ok(again2.mastery.mean > meanBefore, `掌握度应上升 (${meanBefore} -> ${again2.mastery.mean})`);
  });

  step('导出 JSONL → 重放：stateDigest 稳定');
  const exported = service.exportJsonl();
  const parsed = parseJsonl(exported.text);
  const replayed = replay(parsed.events);
  const replayedDigest = stateDigest(replayed);
  const liveDigest = service.state().digest;
  check(`导出 ${exported.events} 条事件，解析错误 ${parsed.errors.length} 条`, () => {
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.events.length, 24);
  });
  check(`digest 一致：${liveDigest} == ${replayedDigest}`, () => {
    assert.equal(replayedDigest, liveDigest);
  });

  step('回退持久化 → 模拟 worker 重启');
  await persistence.flush();
  const stored = area.dump();
  check('chrome.storage.local 存有 deviceId / seq / JSONL', () => {
    assert.equal(stored.latticeDeviceId, service.state().deviceId);
    assert.ok(stored.latticeSeq >= 24);
    assert.ok(stored.latticeEventsJsonl.split('\n').filter(Boolean).length === 24);
    assert.deepEqual(Object.keys(stored).sort(), [...STORAGE_KEYS].sort());
  });
  const { service: restarted } = await openMemoryService({ area });
  check('重启后重放 digest 相同（同一 deviceId、同一 seq 起点）', () => {
    assert.equal(restarted.state().digest, liveDigest);
    assert.equal(restarted.state().deviceId, service.state().deviceId);
  });

  step('诊断信息');
  const diagnostics = service.diagnostics();
  check('storage / digest / 校准报告齐全', () => {
    assert.equal(diagnostics.storage, 'fallback');
    assert.equal(diagnostics.digest, liveDigest);
    assert.equal(diagnostics.calibration.n, 0); // 首次复习 rBefore=0，不参与校准
    assert.match(diagnostics.reportText, /校准报告/);
    assert.match(diagnostics.reportText, /样本数: 0/);
  });

  step('清空全部数据（保留 deviceId）');
  const beforeClearDigest = service.state().digest;
  const cleared = await service.clear();
  check('0 命题 / 0 事件 / empty = true', () => {
    assert.equal(cleared.counts.propositions, 0);
    assert.equal(cleared.counts.events, 0);
    assert.equal(cleared.empty, true);
    assert.equal(cleared.deviceId, init.deviceId);
    assert.equal(cleared.lastSeq, 0);
    assert.equal(cleared.digest, stateDigest(replay([])));
  });
  await persistence.flush();
  check('chrome.storage.local 中的日志已清空', () => {
    assert.equal(area.dump().latticeEventsJsonl, '');
  });

  step('把导出的 JSONL 重新导入空库：digest 复原');
  const reimported = service.importJsonl(exported.text);
  check(`added = ${exported.events}`, () => {
    assert.equal(reimported.added, exported.events);
    assert.equal(reimported.errors.length, 0);
    assert.equal(service.state().digest, beforeClearDigest);
  });

  console.log('');
  if (failures > 0) {
    console.log(`SMOKE FAILED: ${failures} 项未通过`);
    process.exitCode = 1;
    return;
  }
  console.log(`SMOKE OK: 全部检查通过 · digest ${liveDigest}`);
}

main().catch((err) => {
  console.error('SMOKE CRASHED', err);
  process.exitCode = 1;
});
