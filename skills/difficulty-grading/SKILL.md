---
name: difficulty-grading
description: Grade a knowledge point on two independent axes — acquisition difficulty (★1–5) and the cognitive operation it demands — and return strict JSON. Use when seeding a curriculum, reviewing generated cards, or backfilling an existing library so a learner model can pace content by stage instead of treating every fact as equally hard.
license: Apache-2.0
compatibility: Any agent with a model API. The output is strict JSON; no tools, files, or network beyond the model call are required.
---

# Difficulty grading

Grade **the knowledge point**, never the learner. The same proposition is ★2 for
one person and ★4 for another; that difference belongs to the learner model
(mastery), not here.

## Two independent axes

| Axis | Question | Values |
|---|---|---|
| `tier` | How hard is this to acquire *without prerequisites in place*? | 1–5 |
| `cognitive` | What operation must the learner perform to count as knowing it? | remember / understand / apply / analyze / evaluate |

They are independent. "用哈希表去重" is **tier 2** (a simple fact about a data
structure) but **cognitive = apply** (you must choose and use it). A long
paragraph is not automatically hard; a short formula can be ★4.

## The tier rubric (anchors)

| tier | Anchor | Test question | Example |
|---|---|---|---|
| ★1 | Terminology / single fact | Can it be held by one lookup or one sentence? | 哈希表平均查找是 O(1) |
| ★2 | Concept relation / why | Does understanding require relating two ideas? | 二分查找要求数据有序 |
| ★3 | Multi-step application / conditional choice | Must the learner pick a procedure and execute it in context? | 给定数据规模与查询模式选数据结构 |
| ★4 | Derivation / boundary / counterexample | Must the learner derive it, or decide when it fails? | 从预算约束推导需求曲线 |
| ★5 | Evaluation / cross-domain synthesis | Must the learner compare alternatives and weigh trade-offs? | 判断 MoE 与循环深度在你场景中的取舍 |

**Marginal rule**: `tier` measures difficulty *given its own prerequisites*. A
conclusion can be ★2 even when its premises are ★4 — once the premises are
held, the step is small. Never infer tier from the number of prerequisites.

## The cognitive axis

| value | Evidence that would prove it |
|---|---|
| remember | recall the statement or its label |
| understand | explain it in own words / predict a consequence |
| apply | use it in a new but familiar-shaped situation |
| analyze | decompose it, derive a step, find the boundary case |
| evaluate | judge between alternatives, justify a trade-off |

Tie-break: grade by the **lowest operation that still counts as knowing it**.
If someone could plausibly "know" it by reciting, the cognitive level is not
`evaluate`.

## Output contract

```json
{
  "grades": [
    { "ref": "p1", "tier": 3, "cognitive": "apply", "minutes": 10, "why": "需要先判断场景再选结构" }
  ]
}
```

- `tier`: integer 1–5.
- `cognitive`: one of the five values.
- `minutes`: 1–120, first-time understanding (not mastery).
- `why`: ≤120 chars, the anchor you used (not a restatement of the statement).
- One grade per input `ref`; do not invent refs; do not drop inputs silently.

## Batch prompt (delegate to an API)

System prompt: `packages/extract/src/pipeline.ts` → `GRADING_SYSTEM`
(version `grading-v1`). Call `gradeDifficulty(items, { llm })` — it validates
tiers, drops malformed entries, and reports `dropped` refs.

Inputs are `[{ref, statement, domain}]`. Do not include learner history in the
grading call: that is the whole point of separating difficulty from mastery.

## Worked examples

| Knowledge point | tier | cognitive | Why |
|---|---|---|---|
| Transformer 的 QKV 三个投影分别做什么 | 2 | understand | relates three projections to one mechanism |
| MoE 路由的负载均衡损失如何影响专家塌缩 | 4 | analyze | requires deriving a failure mode, not recalling it |
| 给定序列长度与显存，估算 KV cache 大小 | 3 | apply | procedure + arithmetic in a concrete situation |
| 对比 MoE 与循环深度在固定预算下的取舍 | 5 | evaluate | cross-option trade-off under a constraint |

## Quality gates

1. **Spread**: a batch of 20 beginner points should not all be ★3 — check the
   distribution; a flat distribution means the rubric was not applied.
2. **Prerequisite consistency**: no conclusion may be graded ★1 when all its
   premises are ★4, unless the derivation is genuinely trivial.
3. **No learner leakage**: reject grades that cite "the user" or mastery.
4. **minutes sanity**: ★1 ≤ 5 min, ★5 ≥ 20 min, else explain in `why`.
