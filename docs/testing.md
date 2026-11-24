# M0 human test script

Goal: in about ten minutes, decide whether the M0 skeleton does what it claims.
You do not need to read code. Follow the steps, note what breaks, and send back
the diagnostics text (one button copies it).

> M0 is deliberately **not** a product yet: there is no content extraction, no
> knowledge graph, no path planning, no push policy. Reporting those as missing is
> expected; the value of this test is whether the **data spine** is trustworthy.

---

## Part A — load it (2 minutes)

1. `cd E:\QA\lattice`
2. `npm install` (first time only)
3. `npm run build` — you should see `vendor ready: lattice-core (... KiB) + sqlite-wasm`
4. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → choose `E:\QA\lattice\packages\extension`
5. Open a new tab.

**Expected:** the Lattice title, three counters, and an empty state with three buttons.
**If instead:** a blank page → open DevTools (F12) → Console → copy the first red error.

---

## Part B — the spine (5 minutes)

1. Click **载入示例包**. Expect `8 命题 / 11 张卡`.
2. Open **诊断** → note `存储: OPFS` (or `回退(chrome.storage)` — tell me which).
3. Review 5 cards:
   - click **显示答案** (or press Space), then pick a grade with `1`–`4`;
   - deliberately get one wrong (**重来**) and one right (**简单**).
4. Watch the numbers on the card change: `掌握 x% ±y · 可用 z%`.
   - Mastery should start near 50% ± wide and move after each grade.
   - Retrievability should be absent on the first sight of a card.
5. Close the tab, open a new tab again.
   **Expected:** the counters remember what you did (e.g. 复习 count changed).
6. Open **诊断** → the digest is a 16-character hex string. Keep it.

**This is the critical check:** the digest must be identical across a reload.
If it changes on reload with no new reviews, storage is not persisting.

---

## Part C — portability (2 minutes)

1. In 诊断, click **导出 JSONL** → save the file (e.g. `E:\QA\lattice\m0-export.jsonl`).
2. In a terminal:

```bash
cd E:\QA\lattice
npm run cli -- replay --in m0-export.jsonl
npm run cli -- eval   --in m0-export.jsonl
npm run cli -- doctor --in m0-export.jsonl
```

3. Compare the **digest** printed by `replay` with the digest in 诊断.

**Expected:** identical. If they differ, the export/replay path is broken and that is the most important bug to report.
`eval` will say `样本数: 0` or a small number — that is correct, you have only a few reviews. `doctor` should exit 0.

---

## Part D — destructive paths (1 minute)

1. 诊断 → **清空数据** → type `DELETE` → confirm.
2. Expect: empty state, `0 命题`.
3. Reload the tab. Expect: still empty (deletion persisted).

---

## Part E — file the report

Send me:

1. `存储:` line from 诊断 (OPFS or fallback).
2. The digest before/after reload, and whether `replay` matched it.
3. Anything that felt wrong — especially:
   - numbers that did not move when they should;
   - a card that repeated in a way that made no sense;
   - layout that breaks at your window width;
   - Chinese text that renders with the wrong font/line-height.
4. Console errors (F12 → Console) if any.
5. A screenshot of the card view and the diagnostics panel.

---

## What is intentionally not here yet

| Missing | When |
|---|---|
| capturing a web page or PDF | M1 |
| knowledge graph / prerequisite tree | M1 |
| "why am I seeing this card" explanation | M1 (needs sources) |
| push to sidebar/notifications | M2 |
| multi-device sync | M3 |
| search | M2 (CJK tokenizer decision pending) |
| settings screen beyond diagnostics | M1 |
