# C-STK-06 The PR head's tree is the tree checks ran on; a new item starts on the available prefix

Proves: mvp.md §4.2 Merging ("Each PR is the verified candidate for its item") and Rebase ("checks rerun"), Appendix B.5 (Stack: integrate, Stack: propose) · spec.md §10.3.2, §10.4.1, §10.4.3, §10.4.4, §10.4.5 · Layer: integration · Stage: S1 · Tickets: T-STK-12, T-FLW-11
Automation: `packages/backend/internal/services/todo_candidate_flow_db_test.go` (new) · Runs in: reference host (real microVM, real PostgreSQL, packaged guest flow host, fake GitHub); fixture system-operation coverage lands with T-STK-12, built-in run-loop coverage with T-FLW-11

## Setup
- Product schema at head; owner Will and member Ben; the fake GitHub server with its write log.
- A fixture `todo` flow with the §10.4.1 shape. Its `check` step runs `checks.sh`, which writes the sha256 of every tracked file to `.smithers-test/check-trees.log` (ignored) and then waits on a barrier the test releases. Its `review` step records the diff range it read.
- A second writer: a process in T1's working copy under another uid, as a terminal session would be. Record writer evidence so its concurrent edits remain `edited`, distinct from a check that writes captured files. Add one check that writes a tracked file and one read-only check after pre-capture formatting for S13.
- A test hook pauses `stack.candidate` after its snapshot and before it writes the generation.

## Steps
Approved-ruling fixtures below are independent cases on the same real-dependency harness. Exercise Candidate and Propose through the production dispatcher and captures through the composed head-report route. Record generation rows, manifests, input acknowledgements, capture ordering, signals, waits and GitHub writes. Use fixed file bytes and literal expected outcomes; do not derive oracles from implementation decisions.

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
- Approved S1: TC-02 / P-G1a–c / P-G6: T1 and T3 accepted, T2 unverified yields T4 includes T1,T3,T4 only; after T2 acceptance and rebases, each change appears once..
- Approved S2: TC-12 / U-X / U-R: after T2 accepts g1 then captures g2, T3 still selects g1; T2 Merge is rechecking; accepting g2 fans out. Obsolete g1 is skipped rather than used..
- Approved S3: U-P / I-19 / P-G5: stale inputs + changed tree yields stale_inputs; pending rebase + stale main yields rebase_pending; wrong/missing evidence yields invalid_evidence; explicit zero checks yields eligible; closed item yields todo_closed; refusal leaves durable/outbound state unchanged..
- Approved S7: TC-04 / P-G1b / P-G3: fork keeps dropped bytes, dropped item absent from manifest/state merged; TthenX1thenX1thenTthenX1 yields 2 signals..
- Approved S9: F-16 / C-STK-07 race: fence + Candidate yields no snapshot, pin, row or verification change; merge succeeds yields delayed call todo_closed; definitive refusal yields capture may proceed after release..
- Approved S10: F-04 / U-G / I-03: same key yields same g and no second effects; new key, identical capture yields g+1; attempt restart alone yields same counter; mismatched key yields idempotency_mismatch..
- Approved S11: U-C / U-P boundary rows: negative, future, unacknowledged, non-input, regressing yields invalid_inputs_seq; valid 0 baseline passes; later run answer yields stale_inputs; other-item amendment yields no input-cursor failure, normal rebase rules apply..
- Approved S12: I-27–32 / F-14 / P-G3: in_review differs yields one signal; working differs yields stored, no signal; seq12 X then seq11 T yields newest X and merge held; same seq/tree yields no effect; same seq/different tree or missing ordering yields refusal..
- Approved S13: C-STK-06 / C-J1-04 new fixture: check writes tracked file yields failed check, bytes preserved, zero acceptance/push, no autonomous retry cycle; pre-capture formatting + read-only check yields accept..
- Approved S14: F-06–10 / P-G4 corrected row: GitHub H1 during pending H2 is valid; every outgoing head maps to an accepted tree; external H1 merge projects merged after main contains commit, uses H1 manifest, preserves unlanded edits..
- Approved S15: TC-15 / P-G5 new rows: own delta empty, even with nonempty prefix yields empty_change, g unchanged, no PR; flow opens one question wait; answer resumes implement; item never auto-merged..
- Approved S16: TC-05 / TC-07 / U-G / C-STK-06 D6: same T, changed base, nonempty own delta yields g+1, fresh checks tagged g+1, old approval void; equal patch-id permits review reuse only..
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
- Approved S1: An unverified predecessor blocks admission, the manifest lists omitted work, or convergence duplicates a change.
- Approved S2: Recapture erases the usable accepted prefix, an obsolete accepted head is selected, or acceptance omits atomic rebase fanout.
- Approved S3: Refusal precedence differs, malformed evidence is accepted, unknown configuration is treated as empty, or a refusal writes durable or outbound state.
- Approved S7: The dropped item appears in the manifest or becomes merged, preserved fork bytes disappear or duplicate, or transition signaling differs from the fixture counts.
- Approved S9: A fenced Candidate captures, pins, allocates a generation or changes verification, or its delayed fresh call captures after the TODO becomes merged.
- Approved S10: A replay allocates again, equal-tree distinct keys deduplicate, attempt restart increments the counter, or key mismatch has effects.
- Approved S11: An invalid input cursor passes, an answer is skipped, or another item advances this item's input cursor.
- Approved S12: An unordered or older report overwrites newest capture or clears the merge hold, a conflicting sequence passes, or a non-review state emits edited.
- Approved S13: A tree-writing check passes, its files are reverted, Propose accepts or pushes, or the run enters an automatic retry cycle.
- Approved S14: Smithers writes an unaccepted tree, folds using the pending head instead of the actual merged head, loses unlanded bytes, or fabricates another merge or approval.
- Approved S15: An empty own change pins a candidate, allocates a generation, opens a PR, becomes merged, or creates duplicate question waits.
- Approved S16: A changed base or manifest reuses the generation, checks or approval; review reuse lacks equal own-diff patch-id.
- An accepted generation's PR head tree differs from the tree its checks ran on.
- A refused or stale `stack.propose` reaches GitHub.
- A steer committed before propose is missing from the proposed change.
- T2 waits for T1 to verify before starting, or fails admission for lack of a predecessor head.
- The engine rewrites the working copy's own history to make the one commit.

## Evidence
For S3, assert each literal refusal code has class `conflict` and zero generation, event, acceptance and outbound writes. For S11–S12, assert `invalid_inputs_seq`, `invalid_capture` and `capture_mismatch` with class `conflict`. For S13, assert `check_modified_tree`, changed paths and preserved bytes. For S15, assert `empty_change`, one durable question with the exact §10.4.4b prompt, `needs_you`, answer-to-implement recovery and explicit Drop. Repeat Candidate after a crash following generation commit and before receipt delivery; replay returns the committed generation without new effects.

`.artifacts/checks/C-STK-06/<UTC>/`: `go test -json`, the generation table per step (`generation, base, head, tree, inputs_seq, outcome`), `check-trees.log`, the fake GitHub write log, `git rev-parse` output for every PR head, the commit SHA.
