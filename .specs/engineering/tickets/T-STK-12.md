# T-STK-12 Candidate generations: capture, propose receipts, pending work, the item's prefix

Stage S1 · Size M · Depends on T-STK-01, T-INS-02, T-FLW-01 · Unblocks T-STK-04, T-STK-06, T-FLW-11 · Issue: to file
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
- The `generation` tag on every evidence part. This ticket owns the minimal generation field and validation needed by the handshake; T-STK-10 adopts it when building full attempt evidence. T-STK-10 depends transitively on this ticket and is not a prerequisite.
- S1 captures from the workspace: a jj snapshot and the head push that `workspace_head.go` already makes.

Out:
- The `todo` flow's `candidate`, `check` and `review` steps and the run's signal loop (T-FLW-11).
- `MergeReady`, GitHub squash dispatch and merge reconciliation belong to T-STK-04. Shared fence primitives are in scope here (C-STK-07).
- The daemon's `capture()` (T-COL-03). S2 swaps the capture source, not the rules.
- Presence-aware rebase scheduling (T-STK-11) and conflict handling (T-STK-08).

- Out of scope: full evidence presentation (T-STK-10), new retry caps, detecting edits reverted before capture, rewriting working-copy history, new flow-engine APIs, and host execution of repository hooks or checks.

## Changes
- `packages/backend/db/product/migrations/01xx_todo_merge_fence.sql` → `todos.merging jsonb`; `packages/backend/internal/services/stack_lock.go` → `LockStack(tx)` (stack row, then TODO rows) and `FenceSet(tx, todo)`. Every stack mutation shares this seam.
- Implement §10.6.2b's held-signal delivery: steers and review comments commit durably while fenced; release them once if the fence clears without merge, and keep them undelivered after merge. Placements and amends return `409 merging`; rebase and propose defer. T-STK-04 owns setting and reconciling the marker around GitHub dispatch. Check: C-STK-07.
- `packages/backend/db/product/migrations/01xx_candidate_inputs.sql` (new) → `mythical_items.candidate_inputs_seq bigint NOT NULL DEFAULT 0`.
- `packages/backend/internal/services/todo_candidate.go` (new) → `Candidate(todo, inputsSeq) (Generation, error)` and `Propose(todo, generation, evidence) error`, each in one transaction inside the stack claim. The S1 capture runs `jj` in the TODO's workspace and fetches the commit. The candidate commit is written like today's PR head commit (`writeCommit`, `mythical_items.go:2029`), with the prefix head as its parent, and pinned with `pin` before the generation row commits.
- `packages/backend/internal/services/mythical_items.go` → `start` (`:1665`) launches from the item's prefix instead of `r.row.TipCommit`; `propose` (`:1951`) runs only after `Propose` accepts, keeping its pin → record → push order; the `CandidateVerified` reset at `:1901` moves into `Candidate`.
- `packages/backend/internal/routes/workspace_head.go` (`ReportWorkspaceHead`, `:49`) → after recording a head for an item branch whose TODO is `in_review`, compare its tree with the accepted generation's tree and signal `edited` once per new tree.
- If `stack.candidate` registers as a `Flow.make` tag, its Appendix C row lands in the same change (§6.1.2).
- `packages/backend/docs/todos.md` (new; absent today) → generations, refusals and pending work; docs gates.

## Decisions and pre-review
- Before start, smithers-3f approves the capture, stack-claim and outbound-write seams and reviews isolation. smithers-b8 approves any public command binding; smithers-38 approves any Flow.make or TypeScript library contract. smithers-8a accepts those seams and decides the failure policy for checks that rewrite files. Will alone changes the accepted reverted-edit limit.
- T-INS-02 and T-FLW-01 must land before capture is enabled: execute the workspace snapshot and all repository checks inside its machine, refuse an unavailable guest, and keep keys on the host. Host commit-object reads and writes use packaged code and must not invoke repository hooks, filters or configuration-driven executables. C-SEC-02 supplies the isolation check.
- This ticket supplies the shared stack lock and fence before T-STK-04 lands. Preserve the existing stack claim's serialization; T-STK-04 and T-STK-06 consume the same seam (C-STK-07).

## Tests
- Integration, real PostgreSQL, `stack_lock_db_test.go` (C-STK-07): concurrent writers serialize in stack-then-TODO order; fenced placements/amends refuse; steers commit but do not signal. Clearing without merge releases each keyed signal once; a merged TODO never releases it. Full GitHub merge races complete with T-STK-04.
- Unit, `todo_candidate_test.go` (new): the acceptance table. Each of the five rules fails alone and yields its reason with no write. Prefix selection for: no earlier item verified; N−1 verified; N−2 verified and N−1 not; the first item.
- Integration with real PostgreSQL and a real jj working copy, `todo_candidate_db_test.go` (new): `Candidate` writes one commit with the captured tree on the prefix head and pins it. An edit after `Candidate` makes `Propose` refuse `edited`. An edit injected between the snapshot and the generation write lands in the next generation, not this one. A steer event above `inputs_seq` refuses `stale_inputs`. A replayed `Propose` for an old generation is refused with no GitHub write.
- Integration, same file: after acceptance, a head report with a different tree signals `edited` once; a report with the same tree signals nothing.
- Integration, same file: with T1 still planning, T2 starts on `main`'s tip; T1's acceptance writes T2's `rebase_pending{onto: T1's verified head}`.

- Boundary integration in `packages/backend/internal/services/todo_candidate_flow_db_test.go` (new, C-STK-06): drive `stack.candidate` and `stack.propose` through the production system-operation dispatcher from a fixture run on a real microVM with real PostgreSQL and fake GitHub. Send pending-work reports through `POST /api/repos/{owner}/{repo}/workspaces/{id}/head` on the composed router. Do not call Candidate or Propose directly as acceptance. Use fixed refusal cases and fixture file bytes; compare observed check digests and PR trees, without loading spec files or deriving expected refusals from implementation code.
- The fixture run proves the system-operation boundary here; C-STK-06's built-in TODO loop, steer routing and rebase orchestration complete with T-FLW-11 and their owning tickets. A pending integration is never counted as a pass.

## Acceptance
- [C-STK-07](../checks/C-STK-07.md): shared lock, fence refusal and held-signal rows pass here; merge-dispatch races complete with T-STK-04.
- [C-STK-06](../checks/C-STK-06.md): the PR head's tree is the tree checks ran on; a new item starts on the available prefix. Its run-side parts also need T-FLW-11.
- [C-J1-04](../checks/C-J1-04.md): First TODO to merged PR, unassisted, within 60 minutes of starting the install

## Risks and notes
- May start now against T-STK-01's final migration contract with test-only schema fixtures. Land after T-STK-01 and the other listed dependencies. C-STK-06 and C-STK-07 use real migrated PostgreSQL before acceptance.
- Risk: a check that rewrites tracked files on every run (a formatter with `--write`, a generated file with a timestamp) makes every propose refuse `edited`. Observation: three consecutive `edited` refusals in C-STK-06's log whose only writer is the run's own check. Bring the failure policy to the tech lead; don't add a retry cap alone.
- Risk: the S1 capture through the workspace adds a snapshot to every `Candidate` and `Propose`. Observation: `Propose` p95 over 2 s on the smithers repository. T-COL-01 measures snapshot latency (target 500 ms).
- Decision not to make alone: detecting an edit reverted inside the window. §10.4.4 accepts it as a limit.

## Ready checklist
1. Dependencies: T-STK-01 supplies TODO/events; T-INS-02 and T-FLW-01 supply safe machine execution. This ticket supplies minimal evidence generation fields and uses the existing stack claim.
2. Exclusions: full evidence UI, flow loop, merge dispatch/reconciliation, daemon capture, presence scheduling, retry caps and reverted-edit detection are explicit.
3. Tests: C-STK-06 exercises the production system dispatcher and head-report route with fixed fixtures on a real machine; later run-loop assertions stay pending until integrated.
4. Decisions: smithers-3f approves backend seams, smithers-b8 public bindings, smithers-38 library contracts; smithers-8a decides failure policy and Will changes product limits.
5. Owner pre-review: smithers-3f: Does capture execute only in the guest? Do generation and propose share the stack claim and retain pin-before-record order? smithers-b8: Is the public system-operation binding complete? smithers-38: Does the flow call use existing library contracts without a new engine API?
6. Security: machine-only snapshots and repository checks, no host hooks or filters, unavailable-guest refusal and host-only keys require smithers-3f review and C-SEC-02.
