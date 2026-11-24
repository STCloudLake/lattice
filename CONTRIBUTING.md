# Contributing to Lattice

Lattice is an attempt to build a learning tool whose claims can be checked. That sets the bar for contributions.

## The two rules that are not negotiable

1. **Algorithm changes need evidence.** If you change FSRS parameters, the mastery formula, or the queue policy, include a before/after result from `lattice eval` on a checked-in fixture (or the synthetic learner, once it exists). "Feels better" is not a result.
2. **Format changes need a version bump.** The event log and the proposition pack are contracts. Add a migration, keep a fixture from the old version, and prove it still imports.

## Where help is most useful

| Area | Why |
|---|---|
| Chinese tokenization / search (FTS5) | Default tokenizers do not segment CJK (see `docs/storage.md`) |
| Content capture adapters (PDF, subtitles, notes) | M1's biggest chunk of work |
| Synthetic learner + eval fixtures | The project's credibility depends on measurement |
| Extension surface work (popup, options, keyboard) | Plain JS, low risk, high visibility |
| Accessibility audit | Keyboard-only use and contrast are part of the acceptance criteria |

## Ground rules

- `packages/core` is pure: no `fs`, no `chrome.*`, no DOM, no network. IO goes through ports.
- Never store derived numbers. If it can be replayed, it is not persisted.
- Attention events never write to the mastery ledger. This is a design invariant, not a preference.
- No new runtime dependency in the extension. It must stay loadable as plain files.
- User-facing strings in Chinese; identifiers in English.

## Workflow

```bash
npm install
npm test            # must be green
npm run build       # must produce packages/extension/vendor/
```

Open a PR with: what changed, what you ran, and the result. If you cannot measure it, say so explicitly.

## Data and privacy

- Do not add telemetry, analytics, or a remote logging endpoint.
- Do not send learner content anywhere except the model provider the user configured.
- Do not build features that let a third party observe a learner without their explicit, revocable consent. See `ETHICS.md`.

## License

By contributing you agree your work is licensed under Apache-2.0.
