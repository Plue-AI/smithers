# C-STK-06 The PR head's tree is the tree checks ran on; a new item starts on the available prefix

Proves: mvp.md §4.2 Merging ("Each PR is the verified candidate for its item") and Rebase ("checks rerun"), Appendix B.5 (Stack: integrate, Stack: propose) · spec.md §10.3.2, §10.4.1, §10.4.3, §10.4.4, §10.4.5 · Layer: integration · Stage: S1 · Tickets: T-STK-12, T-FLW-11
Automation: `packages/backend/internal/services/todo_candidate_flow_db_test.go` (new) · Runs in: CI (real PostgreSQL, real jj and git in the TODO's working copy, a real flow host as in `packages/backend/flowdispatch/real_host_test.go`, the fake GitHub server)

## Setup
- Product schema at head; owner Will and member Ben; the fake GitHub server with its write log.
- A fixture `todo` flow with the §10.4.1 shape. Its `check` step runs `checks.sh`, which writes the sha256 of every tracked file to `.smithers-test/check-trees.log` (ignored) and then waits on a barrier the test releases. Its `review` step records the diff range it read.
- A second writer: a process in T1's working copy under another uid, as a terminal session would be.
- A test hook pauses `stack.candidate` after its snapshot and before it writes the generation.

## Steps
Part A, an edit during check:
1. Run T1 to its `check` step. Record generation g1 `{base, head, tree}`.
2. While `checks.sh` waits, the second writer changes `src/a.ts`. Release the barrier; the checks pass.
3. Let the run call `stack.propose{g1}` and continue.

Part B, an edit during capture:
4. On T1's next `stack.candidate`, pause after the snapshot. The second writer changes `src/b.ts`. Resume, then release the checks.

Part C, a steer during check:
5. During the check of the next generation, Ben steers T1 ("keep the old name").

Part D, a base move during check:
6. During the check of the next generation, move `main` on the fake GitHub and let the mirror follow; only the agent is on the branch, so the rebase runs (§10.5.2).
7. Replay `stack.propose` for the generation refused in step 6, after a newer one exists.

Part E, the available prefix:
8. On a fresh stack with `parallel = 2`, place T1 and T2. T1's `plan` step blocks. Read T2's state and start base.
9. Release T1 and let it propose. Read T2.
10. Place T3 while T1 has a verified head and T2's `plan` blocks. Read T3's start base.

## Pass when
- Step 3: `stack.propose{g1}` is refused with `edited`; the write log has no push and no PR for g1; the run re-enters `candidate` on the same run id; the next generation's tree contains the step 2 edit.
- Step 4: the generation written in step 4 has the snapshot's tree, without the `src/b.ts` edit; its propose is refused with `edited`; the next generation contains the edit and is accepted.
- For every accepted generation: its check's line in `check-trees.log` equals the file digests of its tree; the PR head commit's tree equals its tree (`git rev-parse <pr_head>^{tree}`); the `review` step read exactly its `base..head`; every evidence entry in the PR body names it.
- Step 5: propose is refused with `stale_inputs`; the run re-enters `implement` with the steer first; the next accepted generation's `inputs_seq` is at least the steer's `todo_events.seq`.
- Step 6: propose is refused with `rebase_pending`; after the rebase, the next generation's base is the new `main` tip; checks run again and `review` doesn't (equal `git patch-id --stable`); the PR shows the earlier generation's review summary.
- Step 7: refused with `stale_generation`; no GitHub write.
- Every recorded `head` still resolves through `refs/smithers/keep/<head>` to the same tree at the end.
- Step 8: T2 is `working` while T1 is still in `plan`, and T2's base is `main`'s tip.
- Step 9: when T1's generation is accepted, T2 gets `rebase_pending{onto: T1's verified head}`; T2's next accepted generation's base is T1's verified head, and T2's PR head tree contains T1's change.
- Step 10: T3's base is T1's verified head.

## Fail when
- An accepted generation's PR head tree differs from the tree its checks ran on.
- A refused or stale `stack.propose` reaches GitHub.
- A steer committed before propose is missing from the proposed change.
- T2 waits for T1 to verify before starting, or fails admission for lack of a predecessor head.
- The engine rewrites the working copy's own history to make the one commit.

## Evidence
`.artifacts/checks/C-STK-06/<UTC>/`: `go test -json`, the generation table per step (`generation, base, head, tree, inputs_seq, outcome`), `check-trees.log`, the fake GitHub write log, `git rev-parse` output for every PR head, the commit SHA.
