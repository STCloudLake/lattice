# Storage decision: SQLite in a Web Worker, on OPFS

**Question:** can Lattice keep its entire database in the browser, with no server, and still be queryable?

**Answer:** yes — with three constraints that shape the architecture.

This document records the actual measurements, not estimates. Environment: Chromium (host browser), `@sqlite.org/sqlite-wasm` **3.54.1**, page served from `http://127.0.0.1` with `COOP: same-origin` + `COEP: require-corp`.

## Measurements

| Probe | Result | Consequence |
|---|---|---|
| Module init (in worker) | **35–38 ms** | Acceptable cold start |
| `sqlite3.oo1.DB` on main thread | works | Fine for tests, not for persistence |
| `sqlite3.oo1.OpfsDb` on **main thread** | **not available** (`undefined`) | Persistence *must* live in a worker |
| `sqlite3.oo1.OpfsDb` in **worker** | **works** (`/lattice-spike.db`) | This is the chosen design |
| 1000 inserts, one transaction | **38–45 ms** (~0.04 ms/row) | Batching is not a problem |
| 20 inserts, one transaction each | **384 ms** (~19 ms/tx) | **Never commit per interaction** if avoidable; batch |
| Persistence across reload | **yes** (1002 → 2002 rows after reload) | OPFS survives page reload |
| FTS5, ASCII query | works | English search is fine |
| FTS5, default tokenizer, CJK query | **0 results** | Chinese needs a tokenizer strategy (M2) |
| FTS5, `tokenize='trigram'`, CJK 2-char query | 0 results | Trigram needs ≥3 characters |
| FTS5, `tokenize='trigram'`, CJK 3-char query | **1 result** | Workable fallback for CJK |
| Recursive CTE | works | Prerequisite closure (M1/M2) is feasible in SQLite |
| JSON1 (`json_each`, `json_extract`) | works | `chain.premises` can stay a JSON column |

## Decisions

1. **The database lives in a dedicated Web Worker.** The newtab page never touches SQLite directly; it talks to the worker over a small RPC. This is forced by the OPFS limitation, and it is also good for responsiveness.
2. **One transaction per user action, not per statement.** Reads and writes are batched; M0 writes a review's events in a single transaction with `meta.seq` update.
3. **Replay after write, not incremental mutation.** After appending, the worker reloads the log and replays it. At M0 sizes this is milliseconds and it guarantees the projection matches the log exactly — incremental state is where drift comes from.
4. **OPFS is tried first; `chrome.storage` is the fallback.** If `OpfsDb` throws in the extension's origin (it is a different origin from a normal page), we fall back to an in-memory database and persist the JSONL event log into `chrome.storage.local`. The diagnostics panel always shows which mode is active. The product must never break because a storage API is missing.
5. **Search is deferred.** M0 has no search at all, so the CJK tokenizer problem does not block it. M2 must choose: pre-segment Chinese at write time, use `trigram` with a ≥3-character minimum, or implement a JS tokenizer.

## Why not the alternatives

| Alternative | Why rejected |
|---|---|
| `localStorage` | ~5 MB, synchronous, string-only; the event log outgrows it quickly |
| IndexedDB as the primary store | No SQL; re-implementing projections and queries in JS loses the point of having a queryable ledger |
| Server + Postgres | Contradicts "local-first, no account"; adds an operator |
| Keep the DB in the main thread and snapshot it | Every write risks an inconsistent snapshot; no real transactions |

## Reproduce

```bash
npm i
node spike/serve.mjs          # serves spike/ with COOP/COEP
# open http://127.0.0.1:8788/spike/opfs.html
```

The spike pages are intentionally kept in `spike/` (gitignored) as evidence; `docs/` holds the conclusions.
