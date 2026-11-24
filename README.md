# Lattice

**An inspectable learner model for ambient learning.** Local-first, open source (Apache-2.0), no account, no telemetry.

> Status: **M0 skeleton** — the data spine works end to end (event log → four ledgers → FSRS + Beta mastery → queue → export/replay/calibration). Content extraction, the knowledge graph, path planning and the push policy are **not** in M0. See [docs/m0-report.md](docs/m0-report.md) for exactly what is and is not built.

Lattice keeps four separate ledgers about a learner and never mixes them:

| Ledger | Answers | Written by |
|---|---|---|
| **K** knowledge | what claims exist, and what entails what | content pipeline (M1) |
| **M** mastery | does the learner *understand* it? (Beta posterior) | graded answers, explanations |
| **S** schedule | when will they *forget* it? (FSRS-6) | retrieval reviews |
| **C** context | when do they look, and what interrupts them? | attention events (M2) |

Everything except the raw event log is a projection: change an algorithm, replay the log, get the new answer. No data migration.

The one rule that shapes the whole design: **attention is not evidence of understanding.** Exposure and dwell time never raise mastery.

---

## Quick start

```bash
npm install
npm run build          # compiles @lattice/core and bundles the extension
npm test               # 30 core tests + CLI tests
```

### Load the extension

1. Open `chrome://extensions` (Edge: `edge://extensions`)
2. Enable **Developer mode**
3. **Load unpacked** → select `packages/extension`
4. Open a new tab. On first run, click **载入示例包** (load sample pack) to get 8 propositions.
5. Review a few cards, then open **诊断** to see the digest and the calibration report.

The extension stores its database in the browser's OPFS via a dedicated Web Worker (see [docs/storage.md](docs/storage.md)). It falls back to `chrome.storage` if OPFS is unavailable, and says so in 诊断.

### CLI

```bash
npm run cli -- sample --out /tmp/pack.json
npm run cli -- import --pack /tmp/pack.json --out /tmp/events.jsonl
npm run cli -- replay --in /tmp/events.jsonl
npm run cli -- eval   --in /tmp/events.jsonl
npm run cli -- doctor --in /tmp/events.jsonl
```

`replay` prints a state digest. Exporting the extension's log and replaying it in the CLI must produce the **same digest** — that is the M0 acceptance test and the guarantee that your data is portable.

---

## Repository layout

```
packages/core/         @lattice/core — pure TypeScript, zero IO
  src/                 types, event log, replay, FSRS adapter, Beta mastery, queue, calibration, IO, digest
  test/                30 unit tests
packages/extension/    MV3 extension (plain JS/HTML, no build step)
  newtab/              review UI
  worker.js            sqlite-wasm + OPFS, the only place that touches storage
  data/                bundled sample pack
packages/cli/          @lattice/cli — replay / eval / import / export / doctor / sample
scripts/               build-extension.mjs (bundles core + vendors sqlite-wasm)
examples/              sample proposition pack
docs/                  design, storage decision, data format, M0 report, product report, user manual
```

---

## Design docs

- [docs/design.md](docs/design.md) — architecture and the four-ledger model
- [docs/product-report.md](docs/product-report.md) — feature baseline for v1.0 (58 features, M0–M3)
- [docs/user-manual.md](docs/user-manual.md) — user manual (v1.0)
- [docs/storage.md](docs/storage.md) — why SQLite runs in a worker, with the measurements
- [docs/data-format.md](docs/data-format.md) — event log and proposition pack formats
- [docs/m0-report.md](docs/m0-report.md) — what M0 actually delivers and how it was verified

## Roadmap

| Stage | Scope |
|---|---|
| **M0 (current)** | event log, four-ledger projections, FSRS, Beta mastery, queue, newtab review, import/export, replay, calibration |
| M1 | content capture (selection/PDF), LLM extraction with an auditor + deterministic merge, knowledge graph, minimal prerequisite tree |
| M2 | frontier + path planning, interruption budget, counterfactual hold-back, daemon + CLI + MCP, hybrid retrieval |
| M3 | sync, plugin contracts, Anki/Obsidian import, public evaluation |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Algorithm changes need an eval result; data-format changes need a version bump. [ETHICS.md](ETHICS.md) states what this project refuses to become.

## License

Apache-2.0. See [LICENSE](LICENSE).
