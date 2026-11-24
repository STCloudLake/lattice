/**
 * SQLite access layer for the Lattice worker.
 *
 * The worker can only run inside a dedicated Web Worker: the browser OPFS
 * sqlite3_vfs needs `Atomics.wait()` and therefore a worker context. This module
 * owns "which database do we actually get", and exposes a tiny wrapper so the
 * service layer never touches sqlite-wasm APIs directly.
 *
 * Opening order (each step is tried only if the previous one throws):
 *   1. classic OPFS VFS (`sqlite3.oo1.OpfsDb`) — needs cross-origin isolation
 *      (SharedArrayBuffer), which the manifest's COOP/COEP policies request.
 *   2. OPFS SAH pool VFS (`installOpfsSAHPoolVfs`) — worker-only, does NOT need
 *      SharedArrayBuffer, so it also works when cross-origin isolation is
 *      unavailable. Single-writer: a second tab holding the pool makes this
 *      throw, which is why step 3 exists.
 *   3. in-memory SQLite — the product must never brick. Persistence in this mode
 *      is handled by worker/persist.js (whole event log as JSONL in
 *      chrome.storage.local).
 */

/**
 * Wraps a sqlite-wasm oo1 handle in a minimal, promise-free interface.
 * Only object-form exec/select calls are used: in sqlite-wasm 3.54 the second
 * argument of `exec(sql, bind)` is NOT a bind array.
 */
export function wrapDb(handle) {
  const selectObjects = (sql, bind) =>
    bind && bind.length > 0 ? handle.selectObjects(sql, bind) : handle.selectObjects(sql);
  const selectValue = (sql, bind) =>
    bind && bind.length > 0 ? handle.selectValue(sql, bind) : handle.selectValue(sql);

  return {
    /** Run one or more statements (no result rows). */
    exec(sql) {
      handle.exec(sql);
    },
    /** Run one statement with bind parameters. */
    run(sql, bind = []) {
      if (bind.length > 0) handle.exec({ sql, bind });
      else handle.exec(sql);
    },
    /** Select rows as plain objects. */
    all(sql, bind = []) {
      return selectObjects(sql, bind);
    },
    /** Select the first row (or undefined). */
    get(sql, bind = []) {
      return selectObjects(sql, bind)[0];
    },
    /** Select a single scalar. */
    value(sql, bind = []) {
      return selectValue(sql, bind);
    },
    close() {
      handle.close();
    },
  };
}

/**
 * Opens the best database available in this worker.
 * Never throws: if every persistent option fails, it resolves to an in-memory DB
 * and reports why, so the UI can show the fallback state.
 *
 * @param {object} sqlite3 result of sqlite3InitModule()
 * @param {{filename?: string, poolName?: string, poolDirectory?: string, initialCapacity?: number}} [options]
 * @returns {Promise<{db: object, mode: 'opfs'|'fallback', detail: 'opfs'|'opfs-sahpool'|'memory', errors: string[]}>}
 */
export async function openDatabase(sqlite3, options = {}) {
  const filename = options.filename ?? '/lattice.sqlite';
  const errors = [];

  // 1) Classic OPFS VFS. Available only when the worker is cross-origin isolated.
  try {
    if (typeof sqlite3.oo1?.OpfsDb === 'function') {
      const handle = new sqlite3.oo1.OpfsDb(filename);
      handle.selectValue('SELECT 1');
      return { db: wrapDb(handle), mode: 'opfs', detail: 'opfs', errors };
    }
    errors.push('opfs: sqlite3.oo1.OpfsDb 不可用（缺少 SharedArrayBuffer / 跨源隔离）');
  } catch (err) {
    errors.push(`opfs: ${errorText(err)}`);
  }

  // 2) OPFS sync-access-handle pool VFS: worker-only, no SharedArrayBuffer.
  try {
    if (typeof sqlite3.installOpfsSAHPoolVfs === 'function') {
      const pool = await sqlite3.installOpfsSAHPoolVfs({
        name: options.poolName ?? 'lattice-opfs',
        directory: options.poolDirectory ?? 'lattice-opfs',
        initialCapacity: options.initialCapacity ?? 4,
      });
      const handle = new pool.OpfsSAHPoolDb(filename);
      handle.selectValue('SELECT 1');
      return { db: wrapDb(handle), mode: 'opfs', detail: 'opfs-sahpool', errors };
    }
    errors.push('opfs-sahpool: installOpfsSAHPoolVfs 不可用');
  } catch (err) {
    errors.push(`opfs-sahpool: ${errorText(err)}`);
  }

  // 3) In-memory fallback: persistence is chrome.storage.local JSONL.
  const handle = new sqlite3.oo1.DB(':memory:');
  return { db: wrapDb(handle), mode: 'fallback', detail: 'memory', errors };
}

function errorText(err) {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof err.message === 'string') return err.message;
  return String(err);
}
