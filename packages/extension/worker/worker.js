/**
 * Lattice M0 RPC worker (module worker).
 *
 * Why the app is split in two: the browser OPFS SQLite VFS only runs inside a
 * dedicated Web Worker (it needs synchronous file access / Atomics). So the
 * newtab page owns the UI, and this worker owns the database. The protocol is a
 * deliberately tiny request/response RPC:
 *
 *   -> { type: 'lattice-rpc', id, op, args }
 *   <- { type: 'lattice-rpc-result', id, ok: true,  result }
 *   <- { type: 'lattice-rpc-result', id, ok: false, error }
 *
 * There is no background timer and no background work. M1a adds exactly one
 * outbound capability: when the page asks for an extraction (or a provider
 * test), this worker POSTs to the user-configured OpenAI-compatible endpoint
 * with its own 60s AbortController timeout. The API key arrives per call and is
 * never stored here.
 */

import sqlite3InitModule from '../vendor/sqlite-wasm/index.mjs';
import { openDatabase } from './db.js';
import { createStoragePersistence } from './persist.js';
import { openService } from './service.js';
import { errorText } from './util.js';

const RPC_REQUEST = 'lattice-rpc';
const RPC_RESULT = 'lattice-rpc-result';

/** @type {Promise<{service: object, mode: string, detail: string, persistence: boolean, openErrors: string[]}>|null} */
let bootPromise = null;

function boot() {
  if (!bootPromise) {
    bootPromise = (async () => {
      const sqlite3 = await sqlite3InitModule();
      const opened = await openDatabase(sqlite3);

      // In-memory fallback: mirror the event log to chrome.storage.local.
      // In OPFS mode SQLite itself is the persistence layer and we skip this.
      let persistence = null;
      const storageArea = globalThis.chrome?.storage?.local;
      if (opened.mode === 'fallback' && storageArea) {
        persistence = createStoragePersistence(storageArea);
      }
      const seed = persistence ? await persistence.load() : null;

      const service = await openService({
        db: opened.db,
        mode: opened.mode,
        storageDetail: opened.detail,
        openErrors: opened.errors,
        persistence,
        seed,
      });

      return {
        service,
        mode: opened.mode,
        detail: opened.detail,
        persistence: Boolean(persistence),
        openErrors: opened.errors,
      };
    })();
    // A failed boot must not be cached forever: the UI offers "retry".
    bootPromise.catch(() => {
      bootPromise = null;
    });
  }
  return bootPromise;
}

const OPS = {
  init: (service) => service.initPayload(),
  state: (service) => service.state(),
  // M2a push layer: today's ad-like feed + C-ledger attention events.
  feed: (service, args) => service.feed(args),
  exposure: (service, args) => service.exposure(args),
  // M2b: sidebar/notification exposures are queued in chrome.storage.local and
  // drained here; idempotent by pending-record id.
  drainExposures: (service, args) => service.drainExposures(args),
  // M2c: declared interests + autonomously prepared curriculum. Generating one
  // batch is a model call, so the page gives it a longer RPC timeout.
  declareInterest: (service, args) => service.declareInterest(args),
  removeInterest: (service, args) => service.removeInterest(args),
  seedCurriculum: (service, args) => service.seedCurriculum(args || {}),
  curriculumNeeds: (service) => service.curriculumNeeds(),
  generateCurriculum: (service, args) => service.generateCurriculum(args),
  importPack: (service, args) => service.importPack(args.text),
  grade: (service, args) => service.grade(args),
  quiz: (service, args) => service.quiz(args),
  exportJsonl: (service) => service.exportJsonl(),
  importJsonl: (service, args) => service.importJsonl(args.text),
  clear: (service) => service.clear(),
  diagnostics: (service, args) => service.diagnostics(args),
  flush: (service) => service.flush(),
  // M1a: extraction. All of the model call happens here (the page never talks
  // to the provider); the page only receives plain-JSON plans.
  extractPreview: (service, args) => service.extractPreview(args),
  commitExtraction: (service, args) => service.commitExtraction(args),
  providerTest: (service, args) => service.providerTest(args),
  listModels: (service, args) => service.listModels(args || {}),
  coverageCheck: (service, args) => service.coverageCheck(args),
  graphSummary: (service) => service.graphSummary(),
};

function post(message) {
  self.postMessage({ type: RPC_RESULT, ...message });
}

/** Extraction errors carry validation issues; surface up to 3 without a stack. */
function errorIssues(err) {
  const issues = err && Array.isArray(err.issues) ? err.issues : [];
  return issues.slice(0, 3).map((issue) => ({
    severity: issue && issue.severity === 'warning' ? 'warning' : 'error',
    path: issue && typeof issue.path === 'string' ? issue.path : '',
    message: issue && typeof issue.message === 'string' ? issue.message : String(issue),
  }));
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object' || data.type !== RPC_REQUEST || typeof data.id === 'undefined') return;

  const { id, op, args } = data;
  void (async () => {
    try {
      const { service } = await boot();
      const handler = OPS[op];
      if (typeof handler !== 'function') throw new Error(`未知操作：${String(op)}`);
      const result = await handler(service, args && typeof args === 'object' ? args : {});
      post({ id, ok: true, result });
    } catch (err) {
      console.error(`[Lattice] RPC ${String(op)} 失败`, err);
      const issues = errorIssues(err);
      post({ id, ok: false, error: errorText(err), ...(issues.length > 0 ? { issues } : {}) });
    }
  })();
});

self.addEventListener('unhandledrejection', (event) => {
  console.error('[Lattice] worker 未处理的 Promise 拒绝', event.reason);
});
