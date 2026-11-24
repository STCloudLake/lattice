# What Lattice refuses to become

Software that models a person's mind has an obvious dark path. This file exists so the boundary is explicit and reviewable, not implied.

## Refusals

1. **No surveillance.** No page-history tracking, no keystroke logging, no background scraping, no "read everything you do". Capture happens on an explicit user gesture.
2. **No covert measurement.** The one place Lattice deliberately withholds information (the counterfactual hold-back, M2) is disclosed in the UI, recorded locally, and can be switched off. It is never used to save cost or to hide bad results.
3. **No teacher- or employer-facing dashboards.** Lattice does not report one person to another. A user can export their own data and share it; the product does not do it for them.
4. **No ranking of people.** No leaderboards, no "you are in the bottom 20%". The model is about what to learn next, never about sorting humans.
5. **No attention exploitation.** Engagement metrics are not objectives. If pushing more cards raises usage but not day-30 retention, the extra pushes are a bug.
6. **No dependency by design.** The user's data is exportable at any time in a plain format, and the tool keeps working offline. Deleting everything is one action.
7. **No claims without measurement.** We do not say "improves learning" unless the hold-back comparison or the calibration report supports it. When the evidence is absent, the UI says so.

## No impersonation, ever

Knowledge delivered "like an ad" may look native — same typography, same container,
sitting in a comment area or a recommendation list — but it is **always attributed**
(`Lattice` badge). We do not generate fake usernames, avatars, likes, timestamps, or
"网友评论" framing. Reasons:

1. **It is deception.** A comment attributed to a person who does not exist is a lie
   about who said it, regardless of whether the fact is true.
2. **It borrows trust that is not ours.** Native-looking words carry social proof they
   did not earn; that is the definition of a dark pattern.
3. **It breaks the platforms and the store.** Comment injection that fakes user
   content violates most platform terms and gets extensions removed.
4. **It poisons our own data.** If users cannot tell injected content from real
   discussion, their feedback about what works becomes meaningless.

If a surface can only be served by faking user content, we skip that surface.
Attribution may be small and quiet, but it must be present and legible.

## Constraints we accept as costs

- Local-first means **no cross-device sync without the user running something**. We accept the friction.
- No cloud account means **we cannot recover a lost database**. Export is the backup; the UI nags about it.
- Apache-2.0 means **someone may fork this into something we would not build**. We accept that; the license is a promise about adoption, and this document is a promise about intent.

## A specific one: the four ledgers

Mixing "what the learner knows" with "what we want them to do" is how learning tools turn into persuasion tools. Lattice keeps the knowledge ledger (what is true), the mastery ledger (what they understand), the schedule ledger (what they will forget), and the context ledger (when they are receptive) separate. No feature may collapse them into a single "engagement score", because at that point the product optimises the wrong thing.

If a contribution requires breaking that separation, it needs an explicit discussion in an issue first.
