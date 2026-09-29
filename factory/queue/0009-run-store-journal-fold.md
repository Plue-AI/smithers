---
status: queued
issue: https://github.com/smithersai/smithers/issues/2052
priority: p1
---

# Fold run and attempt state into the journal

Implement the run/attempt row in the fold table from the "Journal Consensus"
spec: `flows_runs` status/lineage and
`flows_attempts` become rebuildable materializations of journal events.

- Keep `@smthrs/run-store`'s public `RunStore` and `AttemptStore` APIs while
  moving their durable contract to journal events.
- The materialized tables may stay for fast recovery, but dropping them and
  replaying the journal must rebuild equivalent state.
- Preserve the Stage 1 consensus seam: owner/claim lease data remains
  strategy-private in `SqlConsensus`, not a fold.
- Preserve `DurableWriter` savepoint atomicity between appends and
  materialization updates.
- Add rebuild/conformance tests that compare the live materialization with a
  replayed fold across lifecycle, cancellation, waiting, terminal, and attempt
  mutation paths.

Stage 1 has landed (archived flows repository, `361677714`; item 0008 done).
Build on it:
`Consensus` + `SqlConsensus` + `layerLocal` are in `@smthrs/journal`,
`emitDurable`/`checkpoint`/`compact` admit through `Consensus.guard`,
`RunStore` already delegates arbitration and appends R6 transitions with
`meta.lineageId`. Read the "Journal Consensus" spec first — its "Stage 1,
round 2/round 3" sections are normative and were paid for in three verify
rounds.

Lessons from item 0008 that apply directly to this fold:

- **Test the COMPOSED system, not just the touched packages.** Every 0008
  rejection came from packages that were not in the diff: `engine-store`,
  `engine-harness`, `control`, `time-travel`. This fold changes what
  recovery reads, so those four plus `sync`, `kernel`, and `cli` are the
  real gate. Run them before declaring done.
- **Take a baseline control.** Clone at the merge-base and run the suites
  there first, so a red is provably yours and not pre-existing. 0008's
  verify did this and it settled two arguments.
- **A journal entry that no projection can place is a hole in the journal.**
  R6 entries shipped without lineage meta and crashed `time-travel`'s folds.
  Every event this fold introduces carries the same meta every durable
  append carries, and every consumer that reads a stream positionally must
  select by namespace.
- **A migration must not orphan live state.** 0008's first migration created
  an empty lease table and would have made every already-running run
  permanently undrivable. This fold moves the tables recovery reads: state
  written by the OLD code must still be readable, or be backfilled, and a
  test must prove it.
- **Budget the node's 90 minutes.** 0008 lost an entire attempt to the CLI
  timeout during `pnpm --recursive run check`. Run targeted package gates
  first, commit early and often, and never leave the wide check for last.
- **Commits may fail in the lane sandbox** (`HEAD.lock` permission, and no
  DNS for fetch/push) — smithers bug `01m0e9rmj943cv327vke20vp1k`. Do not
  fight it: report exactly what changed and the operator commits and lands.
