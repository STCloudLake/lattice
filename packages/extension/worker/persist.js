/**
 * Fallback persistence for the in-memory SQLite mode.
 *
 * OPFS is not available in every environment (no SharedArrayBuffer, another tab
 * holding the OPFS pool, a browser without sync access handles). In that case the
 * worker runs on `:memory:` SQLite, and this module mirrors the *whole event log*
 * as JSONL into chrome.storage.local after every write, debounced (~300ms) so a
 * burst import is one write.
 *
 * The event log is the source of truth, so storing it verbatim is enough to
 * rebuild every projection on the next start.
 */

export const STORAGE_KEYS = ['latticeDeviceId', 'latticeSeq', 'latticeEventsJsonl'];

/**
 * @param {{get: (keys: string[]) => Promise<object>, set: (items: object) => Promise<void>}} area
 *        chrome.storage.local (or a test double)
 * @param {{debounceMs?: number, setTimer?: Function, clearTimer?: Function}} [options]
 */
export function createStoragePersistence(area, options = {}) {
  const debounceMs = options.debounceMs ?? 300;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((id) => clearTimeout(id));

  let pending = null;
  let timer = null;
  let chain = Promise.resolve();

  async function load() {
    try {
      const got = (await area.get(STORAGE_KEYS)) ?? {};
      const seq = Number(got.latticeSeq);
      return {
        deviceId: typeof got.latticeDeviceId === 'string' ? got.latticeDeviceId : undefined,
        seq: Number.isFinite(seq) && seq >= 0 ? seq : 0,
        jsonl: typeof got.latticeEventsJsonl === 'string' ? got.latticeEventsJsonl : '',
      };
    } catch (err) {
      console.error('[Lattice] chrome.storage.local 读取失败，按空日志启动', err);
      return { jsonl: '' };
    }
  }

  function save(record) {
    chain = chain
      .then(() =>
        area.set({
          latticeDeviceId: record.deviceId,
          latticeSeq: record.seq,
          latticeEventsJsonl: record.jsonl,
        }),
      )
      .catch((err) => {
        // Never throw into the RPC path: a failed mirror must not break grading.
        console.error('[Lattice] chrome.storage.local 写入失败', err);
      });
    return chain;
  }

  /** Marks the persistence snapshot stale; the builder runs at flush time. */
  function mark(buildSnapshot) {
    pending = buildSnapshot;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, debounceMs);
  }

  async function flush() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const build = pending;
    pending = null;
    if (build) save(build());
    await chain;
  }

  return { load, save, mark, flush };
}
