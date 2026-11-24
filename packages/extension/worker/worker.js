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
 * There is no timer, no network, and no background work in M0.
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
  importPack: (service, args) => service.importPack(args.text),
  grade: (service, args) => service.grade(args),
  quiz: (service, args) => service.quiz(args),
  exportJsonl: (service) => service.exportJsonl(),
  importJsonl: (service, args) => service.importJsonl(args.text),
  clear: (service) => service.clear(),
  diagnostics: (service) => service.diagnostics(),
  flush: (service) => service.flush(),
};

function post(message) {
  self.postMessage({ type: RPC_RESULT, ...message });
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
      post({ id, ok: false, error: errorText(err) });
    }
  })();
});

self.addEventListener('unhandledrejection', (event) => {
  console.error('[Lattice] worker 未处理的 Promise 拒绝', event.reason);
});
