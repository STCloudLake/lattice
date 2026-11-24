# M0 report

**Scope:** prove the data spine. M0 is not a product; it is the smallest thing that can be *wrong in an interesting way*.

Date: 2026-11-24 · Version: `0.1.0-m0`

---

## 1. Acceptance criteria (from the product report, §0)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Storage verdict: `sqlite-wasm + OPFS + FTS5` measured in a real Chromium | **GO** | `docs/storage.md`; 35 ms init, 0.04 ms/insert, survives reload, worker-only |
| 2 | Core: four ledgers, event log, FSRS, Beta mastery, deterministic ids, unit tests ≥80% | **done** | 30 core tests; `npm test` (37 total with CLI) |
| 3 | MV3 extension: newtab review, 4 grades, quiz, import, export, delete | **done** | loaded in real headless Edge over CDP; see §3 |
| 4 | Import/export: proposition JSON in, JSONL out | **done** | CLI `import`/`export`; extension 导入/导出 |
| 5 | Export → replay → identical projection | **done** | digest equality asserted in CLI tests, the extension smoke test, and the real-browser E2E |
| 6 | `replay` + calibration report (Brier/ECE) | **done** | `lattice replay`, `lattice eval` |

One command reproduces the whole gate:

```bash
npm run verify        # 7 checks
npm run verify:e2e    # + real MV3 browser E2E (8 checks)
```

M0 deliberately contains **no LLM calls**. Content enters through a proposition pack or the sample pack. This keeps the verification offline and cheap.

---

## 2. What was built

| Package | What it is |
|---|---|
| `@lattice/core` | Pure TypeScript, zero IO. Event log, replay into the four ledgers, FSRS-6 adapter, Beta mastery, queue, calibration, JSONL/proposition-pack IO, digest. |
| `@lattice/cli` | `replay`, `eval`, `import`, `export`, `doctor`, `sample`. Chinese output, CJK-aware tables, exit codes 0/1/2. |
| `extension` | MV3: newtab review UI, dedicated worker owning sqlite-wasm + OPFS, RPC, import/export/clear, diagnostics panel. Plain JS, no framework, no build step. |

### The invariant everything rests on

```
event log (append-only)  ──replay──▶  K / M / S / C projections
```

Derived numbers are never persisted. `stateDigest()` fingerprints the projection so two implementations — or two devices — can prove they agree. This is what makes export/replay a real guarantee instead of a hope.

---

## 3. Verification evidence

```
$ npm test
 Test Files  5 passed (5)
      Tests  37 passed (37)

$ npm run cli -- sample --out pack.json && npm run cli -- import --pack pack.json --out events.jsonl
已导入 3 条命题、6 张卡片 · 事件数 9

$ npm run cli -- replay --in events.jsonl
  命题数 3 · 卡片数 6 · 新学数 3
  digest  d36d88e4d330d6e2

$ npm run cli -- export --in events.jsonl --out e2.jsonl   # twice
export idempotent: OK

$ npm run cli -- doctor --in events.jsonl
  结论：未发现问题。   (exit 0)
```

Storage measurements (real Chromium, not estimates):

| Probe | Result |
|---|---|
| OPFS on main thread | unavailable → **worker required** |
| OPFS in worker | works, persists across reload |
| module init | 35–38 ms |
| 1000 inserts / one tx | 38–45 ms |
| FTS5 default tokenizer, CJK | 0 hits (needs a strategy in M2) |

### 3.1 Real MV3 evidence (headless Edge + `--load-extension` + CDP)

```
ext id:  nbdlhmmiplaijkoggonamgmehghcppid（background.js service worker 已启动）
import:  复习 0 / 新学 8 / 共 8 命题
card:    什么是机会成本？
meta:    掌握 50% ±29% · 可用 0% · 复习 0 次 · 新学
grade:   数字键 3 → 新学 7          ← 真实 Input.dispatchKeyEvent
diag:    存储: OPFS · VFS: opfs
reload:  新学 7 / 共 8 命题（事件日志持久化成功）
2nd tab: 共 8 命题 · 存储: OPFS     ← 多标签共享同一库
console: 无错误 / 无 CSP 违规
E2E OK
```

This is the only test that can prove the combination that matters in production: MV3 CSP + module worker + WASM + OPFS + keyboard interaction + persistence across reload.

Two manifest keys turned out to be load-bearing and are **not** optional decoration:

- `content_security_policy.extension_pages` must include `'wasm-unsafe-eval'`, or `WebAssembly.instantiate` is refused by MV3 CSP;
- `cross_origin_embedder_policy` + `cross_origin_opener_policy` are what enable SharedArrayBuffer, which the classic OPFS VFS needs. Without them the extension falls back to the SAH-pool VFS (still persistent) or to `chrome.storage` (persistent but slower) — the diagnostics panel always names the mode.

---

## 4. Deliberate deviations from the design (M0 simplifications)

Recorded here so they are not mistaken for unknowable behaviour later.

| Design said | M0 does | Why / when to fix |
|---|---|---|
| Mastery interval = Beta quantiles | normal approximation (`mean ± 1.28σ`) | avoids a numerical-inverse-beta dependency; upgrade when the UI shows intervals prominently (M1) |
| Evidence decays with time | no decay; weights `quiz 1.0 / recall 0.6 / explain 0.4` | M0 has too little history for decay to matter; add with calibration data (M2) |
| Cue selection = weighted by weakness | deterministic: fewest reviews, then creation order | deterministic makes tests meaningful; weighted comes with the context ledger (M2) |
| Context ledger (attention events) | event types accepted, projection is a no-op | needs the interruption policy to have something to consume (M2) |
| Incremental projection updates | replay the whole log after each write | at M0 sizes this is milliseconds and removes a whole class of drift bugs |
| Multi-device merge | union by event id; last-writer-wins is meaningless because events are immutable | sync is M3 |
| FTS5 / search | none in M0 | the CJK tokenizer decision is a real design choice, deferred to M2 |
| `data.cleared` as an event | the UI hard-deletes rows; the event type exists for future use | deletion must be deletion, not another row |

---

## 5. What M0 proves, and what it does not

**Proves:**

- a learner model can be stored entirely in the browser, queryable, and survive reloads;
- the same event log produces the same projection everywhere (digest equality);
- FSRS scheduling and a separate Beta mastery estimate can coexist without contaminating each other;
- exporting is lossless and idempotent, so the data is genuinely the user's.

**Does not prove:**

- that any of this improves learning (needs the hold-back experiment, M2);
- that automatic extraction produces decent propositions (M1, acceptance: ≥70% user acceptance);
- that the mastery model is calibrated in practice (needs real review history; the report exists but has ~0 samples at M0).

---

## 6. How to reproduce

```bash
git clone https://github.com/STCloudLake/lattice
cd lattice
npm install
npm test          # 37 tests
npm run build     # core + extension vendor
npm run cli -- sample --out /tmp/pack.json
npm run cli -- import --pack /tmp/pack.json --out /tmp/events.jsonl
npm run cli -- replay --in /tmp/events.jsonl
```

Human test script: [testing.md](testing.md).

---

## 7. Next (M1)

1. Capture: selection + whole page (Readability) + PDF, all user-gesture initiated.
2. Extraction pipeline: LLM extractor → identity auditor → **deterministic merger** + coverage ledger.
3. Knowledge graph in SQLite: `proposition` / `chain` projections, `prereq` as a derived view.
4. Minimal prerequisite tree + frontier (first real "what should I learn next").
5. Settings screen and a proper capture-review-confirm flow.

The M0 gate for starting M1: the digest survives export/replay, and a human can complete Part B of `testing.md` without console errors.
