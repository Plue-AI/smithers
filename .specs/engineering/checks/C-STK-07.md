# C-STK-07 One merge predicate and an in-flight fence: races against Merge merge nothing stale

Proves: mvp.md §4.2 Merging and Rebase ("any earlier approval no longer applies"), §6.10 PR card ("approval of the exact revision they reviewed"), M-05, M-22 · spec.md §4.1, §10.4.5, §10.6.2, §10.6.2a, §10.6.2b, §10.6.2c, §10.7.3, §16.4 · Layer: integration · Stage: S1 · Tickets: T-STK-04, T-STK-12, T-STK-06, T-STK-15
Automation: `packages/backend/internal/services/todo_merge_race_db_test.go` (new) · Runs in: CI (real PostgreSQL, real git and jj, a real flow host, the fake GitHub server)

## Setup
- Stack T1 and T2 `in_review`, T3 `queued`; T1 first. T1's accepted generation g has base = `main`'s tip and PR head H; its required checks are green and GitHub reports it mergeable.
- Maintainers Ben and Maya and member Alice have sessions.
- The fake GitHub server records every request. It can hold a merge call until the test releases it with 200 or 405.
- T1's machine is awake, and the test can write into its working copy under another uid.
- Each step starts from this fixture.

- Placement landing slice, T-STK-02: run packages/backend/internal/services/todo_place_db_test.go through the production create/move router and dispatcher. Before and Move touching a fenced item return 409 merging with no position, event or rebase writes. Fixed request/result fixtures supply expectations; full GitHub merge races complete with T-STK-04.

## Steps
Approved-ruling fixtures below are independent cases on the same real-dependency harness. Exercise Candidate and Propose through the production dispatcher and captures through the composed head-report route. Record generation rows, manifests, input acknowledgements, capture ordering, signals, waits and GitHub writes. Use fixed file bytes and literal expected outcomes; do not derive oracles from implementation decisions.

1. For each `MergeReady` row 1-9 (§10.6.2a), violate that row alone. Read T1's `merge_block`, then have Ben merge T1 with H.
2. Steer first: Alice steers T1. Then Ben merges T1 with H.
3. Steer during dispatch: Ben merges T1 with H. While the fake holds the call, Alice steers T1 and a poll brings Ben's review comment on T1's PR. Release with 200.
4. As step 3, but release with 405.
5. Edit before merge: write `src/a.ts` in T1's working copy, then Ben merges T1 with H before the next periodic capture.
6. Edit during dispatch: Ben merges T1 with H. While the fake holds the call, write `src/c.ts`. Release with 200, then read the branch's final capture.
7. Rebase pending with an unchanged PR head: move `main` on the fake and let the mirror follow, so T1 has `rebase_pending` while its PR head is still H. Ben merges T1 with H.
8. `main` moves after the transaction: a hook moves `main` on the fake right after the fence transaction commits. Ben merges T1 with H.
9. Reorder during dispatch: Ben merges T1 with H. While the fake holds the call, Alice moves T2 up, places T3 Before T1, amends T1 and drops T1. Release with 200.
10. Concurrent merges: Ben and Maya merge T1 with H at the same instant.
11. Restart: stop the engine after the fake answers 200 and before the result is recorded. Start a new engine on the same database.

## Pass when

- T-STK-04 Land-deletion gate: StackCard and ChangeCards render no legacy Land dispatch. AppController bindings, Flows import/policy rows, flow entries, TODO Land routes, the prs.land handler and its install route and their obsolete test expectations are removed. Source search and existing app type/flow-parity checks find no executable history.land/change.land door. T-APP-04 binds or removes the control only. Production TODO Merge/Confirm routes exercise the authorized merge route; Plue-only LandingService and landing routes remain intact.

- Required checks pass but protected reviews are unsatisfied: the readiness reason is `review_required`, the same route/confirmation/projection decision holds on identical facts, and no merge PUT occurs. Refreshing satisfied reviews permits the remaining draft and mergeability checks.


- S11 exception already in §12.3.0a item 3: a dropped change proven contained in a later merged PR becomes merged with `merged_via`. Terminal-absorption fixtures must preserve this exception.


- Required reviews unsatisfied: `merge_block.reason = review_required`, zero merge PUTs. Role refusals come from T-ACC-03 before readiness reads. Satisfied reviews permit readiness evaluation through every eligible execution door.


- S22: Add first-but-draft with mergeable=true and required checks passed → github/github, zero PUT, confirmation pending; pending required check still wins checks. Ready-write settled plus fresh non-draft facts enables merge. No new reason enum; draft support unavailable remains the §12.5.1 waiting-label fallback.


- S21: Add closed-between-polls: merge GET sees closed/unmerged → state, zero PUT, ordinary dropped event once; repeat poll is recorded no-op. Add closed+stale-head/check-fail → state. Merged+mirror-lag → lookup/done but no premature merged projection.


- S20: Add fence→demotion and recheck→revocation interleavings: 403 permission/permission or 401 permission/unauthenticated, zero PUTs, no fresh approval; preserve/annotate any existing receipt. Recovery by demoted/expired-session approver → superseded. Claim-before-demotion → at most one initial PUT, GitHub result wins.


- S19: E_replay_same_key/C-04 unchanged for same request; add different SHA/TODO/operation → 409 conflict/idempotency_mismatch with zero new PUTs. Uppercase SHA and reordered JSON keys normalize to same request. A revoked actor cannot retrieve a cached protected success.


- S18: Add later-undrafted-not-merged fixture → synced draft=false, order/Tfirst, zero convert-to-draft writes and zero PUTs. Keep C-STK-04 external undraft/merge path and placement-triggered draft fixtures.


- S17: Add pending/done/send-first/superseded cases; F-03 tests first send, F-04/F-05 lookup-done/no-repeat, F-08 lookup then one authorized repeat, F-09/F-10 superseded. F-14 no outbound intent → no PUT. Amend P11/P2 unconditional PUT-per-key/TODO ≤1: an uncertain unsuccessful first call may have one lookup-authorized repeat, never two successful merges. FN3 may clear a boot fence but must not bypass target serialization or resume without reacquiring it.


- S16: Add F2/F3 true/false issue fixtures → one durable close/comment per fixing item; false stays open unless a person independently closed it. Unproven S15 items get none. C-J10-05 no-approval/no-PUT invariant remains; already-existing genuine approvals are not erased merely to meet a fixture expecting none.


- S15: F11/new partial-proof rows: foreign merged head that excludes T2 → T3 merged, T2 unchanged, zero T2 PR/issue closes, one order attention with unverified sentence, zero merge PUTs. Add missing manifest, superseded retained candidate and missing-head-read fixtures. F2 proof must be explicit fixture input; head equality alone without inclusion evidence is insufficient.


- S14: F10/C-05: fold-before-claim → zero PUT; claim-before-fold → at most one initial PUT, one merged event, no duplicate cancellation/issue close/steer delivery. Add retained unknown outbound row despite cleared TODO fence. The fold changes only items proved contained under S15.


- S13: F9/TestQAFoldWhileAttentionOpen → one row, two entries, original preserved. Add duplicate, append-vs-OK and current-revision OK fixtures. Amend P2 “one attention per event” to one entry per event and at most one open row.


- S12: F3 → one attention text `T4 merged before T2; T2's change is in T4's commit` followed by newline and the T3 sentence; two notes and two close comments. F2/C-STK-04 stays byte-for-byte unchanged.


- S10: Add S10 refusal row: approval retained for unchanged g/H, failure receipt, confirmation pending, no automatic PUT. F-14 receipt survives restart without an outbound row and causes no send. I-04 checks clearing receipt before active-row deletion; C-STK-07 step 4 held steer may then void the approval with recorded reason. Narrow P3's blanket “refusals change no rows” to pre-dispatch refusals.


- S9: E_github_merge_refusal expands into 405/409/422 github/github_refused with exact upstream text; one PUT, fence cleared only on confirmed non-merge. Add 405-already-merged → GET/done/202, eventual merged, no second PUT. F-11 distinguishes known refusal from unknown outcome.


- S8: E_permission gets code permission; A3/A9–A12/A17/A18/A20/A21 agree. E_never and A19 get 403 never/never, without confirmation creation; retain bearer-over-cookie behavior A13.


- S7: R8c splits into syntax-error cases and valid-but-stale cases; add uppercase normalization and malformed delegated creation. Replace symbolic h1/h2 in HTTP fixtures (including C-ACC-02) with actual 40-hex SHAs; pure test symbols must not accidentally exercise parsing.


- S6: A14/A14b/A15/A15b → 401 permission/unauthenticated; add provisional-owner → 403 permission/owner_unverified. No readiness reads or merge side effects.


- S5: A8 → refused, 403 permission/permission in S1, no confirmation or PUT; add S2 owner/maintainer → 202 and member → 403. Do not classify solely by `via` when an explicit full-scope CLI login is used.


- S4: Add no-sync, stale-pulls, stale-checks and unknown-check-configuration fixtures: card blocked/rechecking, zero PUTs from the same facts. Live reads may resolve the unknowns and proceed; parity is asserted on identical fact inputs, not across different observation times. U-30 calls DecideMerge for all doors.


- S3: R9f passes only with matching head and required checks on the reread; R9g becomes 409 github/github with exact detail. I-28 asserts two reads separated by 2 seconds, zero PUTs on repeated null, and stale_head if the reread head moves.


- S2: R9a/R9b → 409 conflict/checks; R9e → 409 github/github. Add both-fail and multiple-check rows; optional failures and a known empty required-check set still pass. Route, confirmation approve and projection agree on identical facts.


- S1: Plan §2.3, I-20/I-52 and C-J2-05: count PUTs separately from GETs; pending required check gives zero PUTs through both doors. A3/A9–A12 authorization refusals have no readiness GETs.

- Approved S2: TC-12 / U-X / U-R: after T2 accepts g1 then captures g2, T3 still selects g1; T2 Merge is rechecking; accepting g2 fans out. Obsolete g1 is skipped rather than used..
- Approved S9: F-16 / C-STK-07 race: fence + Candidate yields no snapshot, pin, row or verification change; merge succeeds yields delayed call todo_closed; definitive refusal yields capture may proceed after release..
- Approved S11: U-C / U-P boundary rows: negative, future, unacknowledged, non-input, regressing yields invalid_inputs_seq; valid 0 baseline passes; later run answer yields stale_inputs; other-item amendment yields no input-cursor failure, normal rebase rules apply..
- Approved S12: I-27–32 / F-14 / P-G3: in_review differs yields one signal; working differs yields stored, no signal; seq12 X then seq11 T yields newest X and merge held; same seq/tree yields no effect; same seq/different tree or missing ordering yields refusal..
- Approved S14: F-06–10 / P-G4 corrected row: GitHub H1 during pending H2 is valid; every outgoing head maps to an accepted tree; external H1 merge projects merged after main contains commit, uses H1 manifest, preserves unlanded edits..
- Approved S16: TC-05 / TC-07 / U-G / C-STK-06 D6: same T, changed base, nonempty own delta yields g+1, fresh checks tagged g+1, old approval void; equal patch-id permits review reuse only..
- Step 1: each refusal carries that row's reason code, `merge_block` names the same reason, and the fake records zero merge calls.
- Step 2: refused with `state`; zero merge calls.
- Step 3: T1 is `merged`. The steer and the comment are recorded with activity entries and never delivered: no `steer` signal reaches the run and no `in_review → working` event exists. The run is cancelled.
- Step 4: record the refusal and retain approval/failure receipt; the confirmation stays pending while revision and lifetime remain valid. Clear the fence and deliver the held steer and comment once. T1 becomes `working`; record why they void the active approval. No automatic merge retry occurs.
- Step 5: refused with `pending_work` from the fresh capture; zero merge calls; the run gets one `edited` signal.
- Step 6: one merge call; T1 is `merged`; `src/c.ts` is in the branch's final capture.
- Step 7: refused with `rechecking`; zero merge calls.
- Step 8: refused with `rechecking` after the `ls-remote` recheck; the fence is cleared; zero merge calls.
- Step 9: Move, Before, amend and Drop each get `409 {code: merging}` while the fence is set; after the merge, T2 is first.
- Step 10: exactly one merge call; the other request gets `merging`.
- Step 11: one merge call in total; T1 is `merged`; no fence stays set.
- Every merge call carries `sha = H` and `merge_method = squash`, and each `todo_approvals` row names g and H.

## Fail when
- Approved S2: Recapture erases the usable accepted prefix, an obsolete accepted head is selected, or acceptance omits atomic rebase fanout.
- Approved S9: A fenced Candidate captures, pins, allocates a generation or changes verification, or its delayed fresh call captures after the TODO becomes merged.
- Approved S11: An invalid input cursor passes, an answer is skipped, or another item advances this item's input cursor.
- Approved S12: An unordered or older report overwrites newest capture or clears the merge hold, a conflicting sequence passes, or a non-review state emits edited.
- Approved S14: Smithers writes an unaccepted tree, folds using the pending head instead of the actual merged head, loses unlanded bytes, or fabricates another merge or approval.
- Approved S16: A changed base or manifest reuses the generation, checks or approval; review reuse lacks equal own-diff patch-id.
- A refused request reaches GitHub's merge endpoint.
- A steer, edit or rebase committed before the fence doesn't refuse the merge.
- A held steer is delivered to a merged TODO, or lost when the merge fails.
- A reorder changes T1's position while its merge is in flight.
- `merge_block` and the route disagree on a reason.

## Evidence
`.artifacts/checks/C-STK-07/<UTC>/`: `go test -json`, the fake GitHub request log, and per step the `todos.merging`, `todo_events`, `todo_approvals` and activity dumps; the final-capture file list for step 6; the commit SHA.
