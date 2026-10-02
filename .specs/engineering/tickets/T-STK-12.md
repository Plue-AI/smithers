# T-STK-12 Candidate generations: capture, propose receipts, pending work, the item's prefix

Stage S1 · Size M · Depends on T-STK-01 · Unblocks T-FLW-11, T-STK-04 · Issue: to file
Spec: spec.md §4.1 (`working → in_review`, `in_review → in_review`), §10.3.2, §10.4.1, §10.4.3, §10.4.4, §10.4.5, §10.5.3 · Delta: delta.md §6 (one `todo` run per attempt; PRs stay based on `main` as verified candidates) · Product: mvp.md §4.2 Merging ("Each PR is the verified candidate for its item") and Rebase ("checks rerun"), §6.10 PR card, Appendix B.5 (Stack: integrate, Stack: propose)

## Goal
Every PR head's tree equals a candidate tree that checks ran on with no edit in between. An edit, a steer, an amendment or a base move after the capture yields a new generation before anything is proposed, and a new item starts on whatever verified prefix exists.

## Scope
In:
- The generation record on the engine's work record: today's `mythical_items.generation`, `candidate_base`, `candidate_head`, `candidate_verified` and `pr_head`, plus `candidate_inputs_seq` (§10.4.4).
- `stack.candidate`: refuse with `rebase_pending` off the prefix; capture; write the one commit from the captured tree on the prefix head; pin it; record generation g.
- `stack.propose`: the second capture and the five acceptance rules of §10.4.4; the refusals `stale_generation`, `edited`, `stale_inputs` and `rebase_pending`; on acceptance, today's propose path (pin, record, push with lease, open or update the PR).
- The item's prefix (§10.3.2) for admission and for `stack.candidate`, and `rebase_pending{onto}` for later items when an earlier item's verified head changes.
- Pending work (§10.4.5): compare each later capture's tree with the accepted generation's tree and signal `edited`.
- The `generation` tag on every evidence part (T-STK-10's schema).
- S1 captures from the workspace: a jj snapshot and the head push that `workspace_head.go` already makes.

Out:
- The `todo` flow's `candidate`, `check` and `review` steps and the run's signal loop (T-FLW-11).
- `MergeReady` and the merge fence (T-STK-04); this ticket's writes take its stack lock once T-STK-04 lands.
- The daemon's `capture()` (T-COL-03). S2 swaps the capture source, not the rules.
- Presence-aware rebase scheduling (T-STK-11) and conflict handling (T-STK-08).

## Changes
- `packages/backend/db/product/migrations/01xx_candidate_inputs.sql` (new) → `mythical_items.candidate_inputs_seq bigint NOT NULL DEFAULT 0`.
- `packages/backend/internal/services/todo_candidate.go` (new) → `Candidate(todo, inputsSeq) (Generation, error)` and `Propose(todo, generation, evidence) error`, each in one transaction inside the stack claim. The S1 capture runs `jj` in the TODO's workspace and fetches the commit. The candidate commit is written like today's PR head commit (`writeCommit`, `mythical_items.go:2029`), with the prefix head as its parent, and pinned with `pin` before the generation row commits.
- `packages/backend/internal/services/mythical_items.go` → `start` (`:1665`) launches from the item's prefix instead of `r.row.TipCommit`; `propose` (`:1951`) runs only after `Propose` accepts, keeping its pin → record → push order; the `CandidateVerified` reset at `:1901` moves into `Candidate`.
- `packages/backend/internal/routes/workspace_head.go` (`ReportWorkspaceHead`, `:49`) → after recording a head for an item branch whose TODO is `in_review`, compare its tree with the accepted generation's tree and signal `edited` once per new tree.
- If `stack.candidate` registers as a `Flow.make` tag, its Appendix C row lands in the same change (§6.1.2).
- `packages/backend/docs/todos.md` → generations, refusals and pending work; docs gates.

## Tests
- Unit, `todo_candidate_test.go` (new): the acceptance table. Each of the five rules fails alone and yields its reason with no write. Prefix selection for: no earlier item verified; N−1 verified; N−2 verified and N−1 not; the first item.
- Integration with real PostgreSQL and a real jj working copy, `todo_candidate_db_test.go` (new): `Candidate` writes one commit with the captured tree on the prefix head and pins it. An edit after `Candidate` makes `Propose` refuse `edited`. An edit injected between the snapshot and the generation write lands in the next generation, not this one. A steer event above `inputs_seq` refuses `stale_inputs`. A replayed `Propose` for an old generation is refused with no GitHub write.
- Integration, same file: after acceptance, a head report with a different tree signals `edited` once; a report with the same tree signals nothing.
- Integration, same file: with T1 still planning, T2 starts on `main`'s tip; T1's acceptance writes T2's `rebase_pending{onto: T1's verified head}`.

## Acceptance
- [C-STK-06](../checks/C-STK-06.md): the PR head's tree is the tree checks ran on; a new item starts on the available prefix. Its run-side parts also need T-FLW-11.

## Risks and notes
- Risk: a check that rewrites tracked files on every run (a formatter with `--write`, a generated file with a timestamp) makes every propose refuse `edited`. Observation: three consecutive `edited` refusals in C-STK-06's log whose only writer is the run's own check. Bring the failure policy to the tech lead; don't add a retry cap alone.
- Risk: the S1 capture through the workspace adds a snapshot to every `Candidate` and `Propose`. Observation: `Propose` p95 over 2 s on the smithers repository. T-COL-01 measures snapshot latency (target 500 ms).
- Decision not to make alone: detecting an edit reverted inside the window. §10.4.4 accepts it as a limit.
