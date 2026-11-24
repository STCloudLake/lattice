# Data format v1

Two formats matter in M0: the **event log** (the only source of truth) and the **proposition pack** (the only way to get content in, until extraction lands in M1).

Everything here is versioned. An absent `format`/version stamp means v1.

---

## 1. Event log (`.jsonl`)

One JSON object per line. **Append-only.** Never edit a line in place — a correction is a new event.

```json
{"id":"01j8x2k4m0001abcdef","deviceId":"ext-a1b2c3","seq":42,"occurredAt":"2026-11-24T09:12:33.000Z","recordedAt":"2026-11-24T09:12:34.000Z","actor":"human","type":"review.rated","subjectId":"p_7f3a","payload":{"cueId":"c_11","grade":3}}
```

| Field | Meaning |
|---|---|
| `id` | Globally unique, time-sortable. Merge key across devices. |
| `deviceId` | Stable per device. |
| `seq` | Monotonic per device. `(deviceId, seq)` is unique. |
| `occurredAt` | When the fact happened. **This is what replay orders by.** |
| `recordedAt` | When it was written (differs when offline / imported). |
| `actor` | `human`, `system`, or `llm:<model>@<promptVersion>`. |
| `type` | See below. |
| `subjectId` | The proposition (or cue) this event is about, when applicable. |
| `payload` | Type-specific object. |

### Event types

| `type` | payload | Projection affected |
|---|---|---|
| `proposition.asserted` | `{statement, name?, aliases?, domain?}` | K |
| `cue.asserted` | `{propositionId, front, back, kind?}` | K |
| `proposition.merged` | `{intoId, reason?}` (subject = from) | K + M + S |
| `review.rated` | `{cueId, grade}` | S + M + review log |
| `quiz.answered` | `{correct, cueId?, latencyMs?}` | M |
| `mastery.reset` | `{}` | M |
| `exposure.shown` / `.engaged` / `.skipped` | `{surface?, dwellMs?}` | C (no-op in M0) |
| `data.cleared` | `{}` | all |

### Ordering and merging

Replay sorts by `(occurredAt, deviceId, seq)` and deduplicates by `id`. Therefore:

- arrival order is irrelevant;
- duplicate delivery is harmless;
- merging two devices is set union;
- the same set of events always yields the same state (and the same digest).

### What is *not* stored

Derived numbers are never written: mastery, stability, due dates, queue order. They are recomputed from the log. If a stored number and a replayed number disagree, the replayed one wins.

---

## 2. Proposition pack (`.json`)

The M0 import format. Hand-writable; extraction in M1 emits the same shape internally.

```json
{
  "format": 1,
  "propositions": [
    {
      "statement": "机会成本是你为了得到某样东西而放弃的最佳替代方案的价值。",
      "name": "机会成本",
      "aliases": ["opportunity cost"],
      "domain": "economics",
      "cues": [
        { "front": "什么是机会成本？", "back": "……", "kind": "recall" }
      ]
    }
  ]
}
```

- `statement` is the claim. It is what mastery is *about*. Required, non-empty.
- `name` is a display label only — not an identity.
- `aliases` help later identity resolution (M1); they do not create nodes.
- `cues` are retrieval routes. One proposition may have several. `kind` ∈ `recall | cloze | apply | contrast`.
- A proposition with zero cues is legal but cannot be reviewed (nothing to ask).

`lattice import --pack p.json --out events.jsonl` turns a pack into `proposition.asserted` + `cue.asserted` events with a fresh `deviceId` and `seq` starting at 1.

---

## 3. Export and portability

`exportJsonl()` produces events deduped and sorted, one per line, with a trailing newline. Exporting an already-exported file is byte-identical.

The acceptance property for M0:

```
digest(replay(parse(export(events)))) === digest(replay(events))
```

`digest` is FNV-1a 64 over a canonical JSON snapshot of the projections (floats rounded to 1e-9 so engine differences cannot change it). Any two implementations that agree on the formulas must agree on the digest.

---

## 4. Versioning

- The event log has no version field yet; v1 is the only dialect. A future v2 must ship a migration function and read v1.
- The pack has `format: 1`.
- Breaking changes to either format require a `docs/` note and a test that the old fixture still imports.
