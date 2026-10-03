# C-STK-06 The PR head's tree is the tree checks ran on; a new item starts on the available prefix

Proves: mvp.md §4.2 Merging ("Each PR is the verified candidate for its item") and Rebase ("checks rerun"), Appendix B.5 (Stack: integrate, Stack: propose) · spec.md §10.3.2, §10.4.1, §10.4.3, §10.4.4, §10.4.5 · Layer: integration · Stage: S1 · Tickets: T-STK-12, T-FLW-11, T-STK-01, T-GH-09, T-MCH-14
Automation: `packages/backend/internal/services/todo_candidate_flow_db_test.go` (new) · Runs in: reference host (real microVM, real PostgreSQL, packaged guest flow host, fake GitHub); fixture system-operation coverage lands with T-STK-12, built-in run-loop coverage with T-FLW-11

## Setup
- For FLW11 QA cases, also use the real built-in composition, packaged NativeCoding operation dispatcher, durable flowdispatch jobs, real guest coding host and PostgreSQL. Fake GitHub/model providers record requests and expose barriers; host watchdog, UTC and backoff clocks are injected. Use separate reviewer contexts on the TODO machine with trusted instruction hashes and immutable candidate exports. Fixed fixtures include hostile root/nested AGENTS.md/config/tool-returned data, sized 98,304/98,305-byte diffs, outsider protected-path policy and missing/no-check build commands.
- Record committed sequence, signal identity and disposition, selected continuation, step instance, model_turn_started, run_attached, receipt and outbound keys, active-time/step/cycle/plan/outage/admission counters, run/call reservations, settled token usage and domain outcomes. The literal reference model owns expectations; tests never parse spec files or call decision helpers as their oracle.
- Product schema at head; owner Will and member Ben; the fake GitHub server with its write log.
- A fixture `todo` flow with the §10.4.1 shape. Its `check` step runs `checks.sh`, which writes the sha256 of every tracked file to `.smithers-test/check-trees.log` (ignored) and then waits on a barrier the test releases. Its `review` step records the diff range it read.
- A second writer: a process in T1's working copy under another uid, as a terminal session would be. Record writer evidence so its concurrent edits remain `edited`, distinct from a check that writes captured files. Add one check that writes a tracked file and one read-only check after pre-capture formatting for S13.
- A test hook pauses `stack.candidate` after its snapshot and before it writes the generation.

## Steps
- FLW11 QA G01–G24 and R15/R24/R39/R50/R51/R54/R56/R57/R58/R59/R60/R61/R68 are the named cases in T-FLW-11's Tests. Run unit verdict/counter/order fixtures independently, then repeat production seam cases on this harness. C-STK-03 owns controls; C-J5-01/02 own real pin/activation; C-SEC-02 owns placement and reviewer trust. Receipt fixture coverage cannot substitute for these joint integrations.
- Part F, replay and closure (G04/G07/G22/G23/R39): persist candidate key, replay completed g1 after g2, replay accepted g1 after g2, and attempt fresh unaccepted old propose. Race Drop with acceptance and hold/lose push/open acknowledgements and PR-number return. Exercise server-side binding and trusted-main outsider policy before every fresh acceptance.
- Part G, ordered work and controls (G01/G02/G03/G05/G14/G15/G16/G18/G21/G24/R56/R61/R68): permute duplicate steer/review, edit and prefix signals around pause/Answer/rebase/propose/terminal boundaries. Pause while capture/accept/push or held-review is in progress; resume after two finished steps with held steer. Cancel working and held runs through external controls. Reopen only after authorized transition; record named human takeover and decoder failures.
- Part H, persisted budgets (G06/G09/G10/G12/G13/R24/R54/R57/R58/R59/R60): exercise the host watchdog at 3:59:59/4:00:00 and 1,023/1,024 completed steps; cycle failures 7/8; correction rounds 0/3/8; three full plans plus last-plan continuation; outage delays 2/4/8/16/32/60 minutes and seventh failure; twelve admissions then queued daily_limit. Kill/restart at every counter/reservation transition. Run concurrent per-call accounting across UTC rollover, capacity release and Settings/reset admission release.
- Part I, review/check evidence (G08/G13/G20/R15/R24/R39/R50/R51): candidate files remain framed data, trusted reviewer instructions stay pinned, tools refuse exec/write, 98,304 bytes invokes review and 98,305 bytes opens generation-specific person approval. Test exact first-line verdict, unread failure, request-changes input and generation invalidation. Initial and rebased no-check generations run the configured build and record "no checks detected"; missing build is a typed configuration failure, with no replan or fabricated pass. Admission duplicate titles stay pinned, self-excluded, attributed and capped.
- Part J, retained waits (G11/G17/G19): legacy-drain fixture includes running/verifying checkpoints, queued legacy delivery and accepted-but-unsettled writes; activation refuses until all settle. Restart fifty held built-in runs with staggered machine grants; measure restore and attached input latency independently from queue and wake. D1/D2 immutable fixtures prove the resolver seam; real Active-main acceptance remains pending with T-FLW-03/04.
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
- FLW11 QA replay: same candidate key returns the same generation/receipt/head after restart and after a newer generation; accepted g1 replay returns its existing outbound status with zero captures, pins, new intents or rollback of g2. Unaccepted old g1 still refuses stale_generation. Canonical mismatch and stale/wrong binding deny without effects.
- FLW11 QA Drop: no fresh acceptance crosses its terminal fence, unsent superseded writes never dispatch, sent/unknown writes reconcile before one keyed dependent close, and a late PR creation cannot erase the obligation. Final dropped state retains capture/evidence and has no open PR caused by that decision.
- FLW11 QA order/control: every signal identity has one consumed/superseded disposition; all text survives and is consumed in committed order before the journaled model dispatch. Terminal settlement wins, pause retains pending work, required rebase precedes candidate, question steer leaves its wait open, and resumed delivery uses the next unfinished boundary. Steer-as-Retry honors person-only typed stops, reopen creates a new attempt only after commit, and named takeover changes no pin or merge gate.
- FLW11 QA limits: no_proposal is factory/retryable true at either 4-hour or 1,024-step boundary, or early successful return before acceptance; repository override cannot disable host time enforcement. Idle waits accrue no active time. Eighth nonaccepted proposal cycle fails proposal_loop; duplicates/internal edits do not reset it. Correction default 3 yields at most four check entries; 0–8 configuration is pinned. Three full plan passes plus one very-hard continuation remain in one run; the next dispatch fails very_hard without rewriting history.
- FLW11 QA recovery/admission: only unfinished recoverable operations resume in the same run. Irrecoverably terminal runs require person Retry; user/policy/bug typed stops cannot auto-relaunch. Outage failures 1–6 wait exactly 2/4/8/16/32/60 minutes, failure 7 stops policy/outages, success resets and no outage spends a plan pass. Twelve distinct zero-token admissions count; thirteenth stays queued/daily_limit with "Daily limit reached · starts tomorrow", no run/attempt/refusal/launch charge. Replay/Resume/wake do not count. Actor-attributed reset, owner install-setting increase or UTC rollover reconsider once and preserve historical records.
- FLW11 QA tokens: missing budget/accounting dispatches no model call. Model-active runs reserve 60,000,000 tokens each plus recorded UTC usage, replacing rather than duplicating reservations; held/paused/person-waiting runs release unused capacity after in-flight calls settle. Each request reserves a finite conservative input/output maximum and settles actual usage atomically. Exhaustion projects paused with the install owner and exact copy "Paused · daily token budget · <owner>"; retained inputs resume once on the same run after reacquisition, and an independent person Stop stays open.
- FLW11 QA review: approve/request-changes use exact first-line parsing, unread fails review/unread, request-changes returns to implement in the same run, and >96 KiB uses explicit person review approval as substituted generation-bound evidence. New generation invalidates it. Root/nested AGENTS.md, config and candidate/diff instructions never enter the trusted prompt; exec, filesystem write and GitHub write are denied. Outsider protected paths use current trusted main, with no publication on unreadable policy.
- FLW11 QA projection/performance: merged/dropped attempt outcome is committed with runtime cancellation/wait settlement and cannot be overwritten; external cancellation alone is failed/cancelled_external with branch/PR retained and no auto-admission. Held post-propose current_step is null. Fifty held waits restore within 60 s of backend/PG readiness, with zero model calls/run-side GitHub reads/polling timers; each input is consumed once within 60 s of run_attached. Unavailable guest uses the distinct 15-minute wake failure, never host fallback.
- FLW11 QA activation: legacy running/verifying records, queued deliveries and unsettled writes all drain before activation. Immutable D1/D2 resolver fixtures do not claim real Active-main release acceptance; C-J5-01 and T-FLW-03/04 must pass their production loading/activation gate.
- Approved S1: TC-02 / P-G1a–c / P-G6: T1 and T3 accepted, T2 unverified yields T4 includes T1,T3,T4 only; after T2 acceptance and rebases, each change appears once..
- Approved S2: TC-12 / U-X / U-R: after T2 accepts g1 then captures g2, T3 still selects g1; T2 Merge is rechecking; accepting g2 fans out. Obsolete g1 is skipped rather than used..
- Approved S3: U-P / I-19 / P-G5: stale inputs + changed tree yields stale_inputs; pending rebase + stale main yields rebase_pending; wrong/missing evidence yields invalid_evidence; explicit zero checks yields eligible; closed item yields todo_closed; refusal leaves durable/outbound state unchanged..
- Approved S7: TC-04 / P-G1b / P-G3: fork keeps dropped bytes, dropped item absent from manifest/state merged; TthenX1thenX1thenTthenX1 yields 2 signals..
- Approved S9: F-16 / C-STK-07 race: fence + Candidate yields no snapshot, pin, row or verification change; merge succeeds yields delayed call todo_closed; definitive refusal yields capture may proceed after release..
- Approved S10: F-04 / U-G / I-03: same key yields same g and no second effects; new key with identical (base, tree, inputs_seq) may reuse current g; changed base/input yields g+1; attempt restart alone yields same counter; mismatched key yields idempotency_mismatch..
- Approved S11: U-C / U-P boundary rows: negative, future, unacknowledged, non-input, regressing yields invalid_inputs_seq; valid 0 baseline passes; later run answer yields stale_inputs; other-item amendment yields no input-cursor failure, normal rebase rules apply..
- Approved S12: I-27–32 / F-14 / P-G3: in_review differs yields one signal; working differs yields stored, no signal; seq12 X then seq11 T yields newest X and merge held; same seq/tree yields no effect; same seq/different tree or missing ordering yields refusal..
- Approved S13: C-STK-06 / C-J1-04 new fixture: check writes tracked file yields failed check, bytes preserved, zero acceptance/push, no autonomous retry cycle; pre-capture formatting + read-only check yields accept..
- Approved S14: F-06–10 / P-G4 corrected row: GitHub H1 during pending H2 is valid; every outgoing head maps to an accepted tree; external H1 merge projects merged after main contains commit, uses H1 manifest, preserves unlanded edits..
- Approved S15: TC-15 / P-G5 new rows: own delta empty, even with nonempty prefix yields empty_change, g unchanged, no PR; flow opens one question wait; answer resumes implement; item never auto-merged..
- Approved S16: TC-05 / TC-07 / U-G / C-STK-06 D6: same T, changed base, nonempty own delta yields g+1, fresh checks tagged g+1, old approval void; equal patch-id permits review reuse only..
- Step 3: `stack.propose{g1}` is refused with `edited`; the write log has no push and no PR for g1; the run re-enters `candidate` on the same run id; the next generation's tree contains the step 2 edit.
- Step 4: the generation written in step 4 has the snapshot's tree, without the `src/b.ts` edit; its propose is refused with `edited`; the next generation contains the edit and is accepted.
- For every accepted generation: its check's line in `check-trees.log` equals the file digests of its tree; the PR head commit's tree equals its tree (`git rev-parse <pr_head>^{tree}`); the `review` step read exactly its `base..head`; every evidence entry in the PR body names it.
- Step 5: propose is refused with `stale_inputs`; the run re-enters `implement` with the steer first; the next accepted generation's `inputs_seq` is at least the steer's `product_job_events.seq`.
- Step 6: propose is refused with `rebase_pending`; after the rebase, the next generation's base is the new `main` tip; checks run again and `review` doesn't (equal `git patch-id --stable`); the PR shows the earlier generation's review summary.
- Step 7: refused with `stale_generation`; no GitHub write.
- Every recorded `head` still resolves through `refs/smithers/keep/<head>` to the same tree at the end.
- Step 8: T2 is `working` while T1 is still in `plan`, and T2's base is `main`'s tip.
- Step 9: when T1's generation is accepted, T2 gets `rebase_pending{onto: T1's verified head}`; T2's next accepted generation's base is T1's verified head, and T2's PR head tree contains T1's change.
- Step 10: T3's base is T1's verified head.

## Fail when
- Any named FLW11 QA case fails, or a counter/reservation resets or double-charges on restart. Queued daily-limit work fails, exhausted tokens show generic failure or omit the owner, a closed attempt auto-relaunches, or completed effects repeat.
- An accepted receipt replay is treated as a fresh stale refusal or recreates outbound decisions. Drop loses a close obligation while PR creation is unknown. A reviewer trusts candidate instructions, silently counts oversize data as model approval, or a no-check rebase replans/fabricates evidence.
- Host/watchdog placement, review isolation, real activation or legacy-drain release acceptance is claimed from mocked or immutable-blob-only counterparts.
- Approved S1: An unverified predecessor blocks admission, the manifest lists omitted work, or convergence duplicates a change.
- Approved S2: Recapture erases the usable accepted prefix, an obsolete accepted head is selected, or acceptance omits atomic rebase fanout.
- Approved S3: Refusal precedence differs, malformed evidence is accepted, unknown configuration is treated as empty, or a refusal writes durable or outbound state.
- Approved S7: The dropped item appears in the manifest or becomes merged, preserved fork bytes disappear or duplicate, or transition signaling differs from the fixture counts.
- Approved S9: A fenced Candidate captures, pins, allocates a generation or changes verification, or its delayed fresh call captures after the TODO becomes merged.
- Approved S10: A replay allocates again, a changed base or input prefix reuses a generation, attempt restart increments the counter, or key mismatch has effects.
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
- Retain the FLW11 QA case-name/result map, independent ordered input log, signal dispositions/continuations, runtime journal with model_turn_started and run_attached, watchdog/cycle/plan/outage/admission state across kills, UTC reservation/usage ledger and literal projection snapshots. Include the 50-wait host profile/timing report, zero-idle-request logs, legacy-drain receipts, reviewer instruction hash/tool denials, immutable generation approvals and Drop compensation/outbound keys. Cross-link C-STK-03, C-J5-01/02 and C-SEC-02 joint receipts; absent receipts remain pending.
For S3, assert each literal refusal code has class `conflict` and zero generation, event, acceptance and outbound writes. For S11–S12, assert `invalid_inputs_seq`, `invalid_capture` and `capture_mismatch` with class `conflict`. For S13, assert `check_modified_tree`, changed paths and preserved bytes. For S15, assert `empty_change`, one durable question with the exact §10.4.4b prompt, `needs_you`, answer-to-implement recovery and explicit Drop. Repeat Candidate after a crash following generation commit and before receipt delivery; replay returns the committed generation without new effects.

`.artifacts/checks/C-STK-06/<UTC>/`: `go test -json`, the generation table per step (`generation, base, head, tree, inputs_seq, outcome`), `check-trees.log`, the fake GitHub write log, `git rev-parse` output for every PR head, the commit SHA.
