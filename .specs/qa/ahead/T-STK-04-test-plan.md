# T-STK-04 ahead-of-time test plan (QA)

Scope: person-session merge, one `MergeReady` predicate, merge fence, sha-bound squash, out-of-order GitHub merge folding.
Spec = ~/qa-repo/.specs/engineering/spec.md (line numbers below). Product = .specs/product/mvp.md.
Rulings applied: GitHub merge counts from working/needs_you/paused (and every unmerged state) once main contains the commit; terminal item states win the projection; every inbound GitHub fact has a defined outcome in every state (duplicates are recorded no-ops). P2 per Codex finding 11: constrains Smithers-issued merges only; G17 only where drafts exist.

Fake-server assertion rule (used everywhere): "zero merge calls" = zero `PUT /repos/{o}/{r}/pulls/{n}/merge`. GETs of the PR, checks and ls-remote are allowed on refusals past row 7. Gap S1 below asks the tech lead to confirm this reading of C-J2-05 "zero GitHub calls".

Seams requested (lane exposes; QA tests against them):

| Seam | Signature | Pure? |
| --- | --- | --- |
| `AuthorizeMerge` | `(cred MergeCredential, role Role, op MergeOp) MergeAuthz` ; op = `merge` or `approve` | pure |
| `MergeReady` | `(f MergeFacts) MergeVerdict{Reason, Detail, Class, Code}` rows 1-9, first failure wins | pure |
| `DecideMerge` | `(in MergeInput) MergeDecision{Kind: Proceed|Confirm|Refuse, Status, Class, Code, Detail}` = Authorize then MergeReady; the route, `merge_block` and the approve of a confirmation call only this | pure |
| `FoldExternalMerge` | `(stack StackFacts, m ExternalMerge) FoldPlan{Merged[], Notes[], ClosePRs[], Attention?, Rebase[], MarkReady?}` | pure |
| `ProjectGitHubMerged` | `(state TodoState, f GitHubMergeFact) InboundOutcome` | pure |
| `MergeWriteKey` | `(target string, reviewedSHA string) string` = `merge:<target>:<sha>` | pure |
| `ReconcileMergeRow` | `(row OutboundRow, pull GitHubPull, ready bool) ReconcileOutcome{Done, RepeatOnce, Superseded}` | pure |
| `ReconcileFence` | `(f MergeFence, pull GitHubPull, onMain bool) FenceOutcome{Keep, Clear}` | pure |
| `MergeHooks` | test-only hook points in `Merge`: `AfterFenceTx`, `AfterRecheck`, `AfterOutboundRow`, `AfterSend`, `AfterResponse`, `AfterMergedTx` (each can return `ErrKill`) | integration |

The "projection of merge_block" must call `DecideMerge`'s predicate, not a copy (C-STK-07 fail-when "merge_block and the route disagree"). Test T-U-30 pins that by calling both from the same facts.

---

## 1. Requirement trace

Test ids: U = unit, I = integration, F = fault, P = property, C = concurrency, E = e2e (owned by the check). Files: `svc/` = `packages/backend/internal/services/`. The unit and fault files below are QA names; the lane may fold them into `todo_merge_test.go` / `todo_merge_db_test.go` as the ticket names them.

### 1.1 Ticket bullets

| Ticket text | Test | Layer | File | Spec |
| --- | --- | --- | --- | --- |
| `POST /api/todos/{n}/merge {reviewed_head_sha}` exists, person only | U-A1..A22, I-01 | unit, integ | svc/todo_merge_test.go, todo_merge_db_test.go | 10.6.2 L929 |
| `/merge Tn` catalog command: person only, agents get Review & merge confirmation | I-14, I-15 (C-ACC-02 steps 1,3) | integ | compose/confirmations_integration_test.go | 5.2 L324, 5.2.1 L339, 5.4 L354 |
| `session` credential + owner/maintainer | U-A1..A22 | unit | todo_merge_test.go | 10.6.2 L929, 5.3 L341 |
| `MergeReady` nine rows with reason codes | U-R1..R44 | unit | todo_merge_test.go | 10.6.2a L931 |
| One predicate behind route, `merge_block`, approve of confirmation | U-30, I-16 | unit, integ | todo_merge_test.go, confirmations_integration_test.go | 10.6.2a L931, 5.4 |
| Fence `todos.merging`, locked predicate, rows 1-7 in one tx locking stack row then TODO row | I-20, I-21, C-01 | integ | todo_merge_race_db_test.go | 10.6.2b L947 |
| Recheck before dispatch: fresh capture, `ls-remote`, PR head, checks, mergeable | I-22..I-27 | integ | todo_merge_race_db_test.go | 10.6.2b step 2 |
| Dispatch; `409 {code: merging}` for Before/Move/Drop and amend | I-30..I-33 (C-STK-07 step 9) | integ | todo_merge_race_db_test.go | 10.6.2b L955 |
| Held steers and review comments | I-34, I-35 (C-STK-07 steps 3,4) | integ | same | 10.6.2b L956 |
| Deferred `rebase_pending` and `stack.propose` during fence | I-36, I-37 | integ | same | 10.6.2b L957 |
| Reconcile on start | F-10..F-14, I-38 | fault, integ | todo_merge_fault_db_test.go | 10.6.2b step 3, 12.4.1b L1144 |
| `todo_approvals`: session only, generation + head, new generation voids | I-03, I-04, I-05, U-31 | integ, unit | todo_merge_db_test.go | 10.6.2c L960, 5.2 |
| GitHub merge `sha = reviewed_head_sha`, `squash` | I-01, I-02 | integ | todo_merge_db_test.go | 10.6.2 L929 |
| `in_review → merged` once GitHub reports merge and main contains commit | I-06, I-07, U-I1..I10 | integ, unit | todo_merge_db_test.go | 4.1 L233, 12.3 |
| Issue closes only when `fixes_issue` | I-08, I-09 | integ | todo_merge_db_test.go | 12.4.1 L1136 |
| `merge_block` on `home` and `todo:<n>` | I-40, U-30 | integ, unit | todo_merge_db_test.go | 10.6.2a, 14.2 `home` L1217 |
| One merge path: delete automerge label, Land, `change.land` | I-50 (no worker pass calls Merge), I-51 (route 404), U-60 (grep guard) | unit/integ | mythical_items_test.go, todo_merge_cut_test.go | mvp rule 6 L58 |
| Completion closes issue only when `fixes_issue` | I-08, I-09 | integ | todo_merge_db_test.go | 12.4.1 |
| After merge later items rebase, PRs force-updated, new generation deletes approvals | I-41, I-42 | integ | todo_merge_db_test.go | 10.6.3 L962, 10.5.3 L919 |
| Migration `todos.merging jsonb`, `todo_approvals.generation` | I-60 (migrate up/down on real PG, column presence) | integ | migrations test | ticket Changes |
| `LockStack(tx)` then TODO rows; every stack mutation calls it | U-61 (AST/grep guard: each mutator calls `LockStack`), C-02 (lock order: no deadlock under crossed mutators) | unit, conc | stack_lock_test.go | 10.6.2b L949 |
| Refusal envelope: `permission`, `conflict` + code, `github` | U-40..U-47 | unit | todo_merge_test.go | 6.2.3 L411, ticket Changes |
| Merge fence read by `host upgrade` and `install/quiesce` | I-39 | integ | todo_merge_race_db_test.go | 10.6.2b L958, 16.4 |
| Risk: `mergeable: null`, retry once after 2 s | U-R40, I-28 | unit, integ | todo_merge_test.go | ticket Risks |
| Out of scope but touched: out-of-order GitHub merge | I-70..I-79, U-F1..U-F14 | integ, unit | stack_order_attention_test.go (T-GH-05), todo_merge_fold_test.go | 10.6.4 L964, C-STK-04 |

### 1.2 Check steps

C-J4-03 (todo_merge_db_test.go + e2e):

| Step | Test | Expected |
| --- | --- | --- |
| 1 Ben merges T2 with H2 | I-10 / U-R6 | 409 conflict `order`, detail "T1", `Merges after T1`, 0 PUT |
| 2 stale H1' | I-11 / U-R37 | 409 conflict `stale_head`, 0 PUT |
| 3 Alice, run cred, delegated | I-12, I-13, I-14 | 403 permission (Alice, run); 202 `{confirmation, state:"requested"}` exactly those keys; 0 PUT |
| 4 required check fails | I-26 / U-R32 | 409, detail = check name |
| 5 open order attention | I-72 / U-R5 | 409 conflict `attention` |
| 6 405 with GitHub sentence | I-29 | class `github`, message verbatim, not "HTTP 405" |
| 7 Ben merges T1 | I-01 | exactly one PUT, `sha=H1`, `squash`, one approval row (Ben, session, H1) |
| 8 after rebase H2' | I-41 | H2 refused stale, H2' merges, approval names H2' |
| 9 Home card | E-01, I-40 | only T1 Merge; T2,T3 "Merges after T1"; after, T2 Merge, T3 "Merges after T2" |
| 10 branch protection | E-02 (needs T-GH-05) | GitHub sentence verbatim |

C-ACC-02 (compose/confirmations_integration_test.go): steps 1-10 map to I-14 (delegated, smithers-delegated, run, machine → 202/202/403/403), I-15 (approval route: delegated 403 `never`, run/machine 403 `permission`), I-16 (confirm body keys), I-17 (approve by each credential), I-18 (head moved → 409 conflict, row `expired`), I-19 (deny then approve → 409), I-19b (E member create → 403), I-19c (list shapes), I-19d (`/todo.new` A-check, owned by T-ACC-05), I-19e (steer then approve → 409 `state`, then g+1 → `expired`). Whole-run assertion: fake log has exactly 1 PUT.

C-STK-07 (todo_merge_race_db_test.go): step 1 → U-R1..R44 + I-20; step 2 → I-30; 3 → I-34; 4 → I-35; 5 → I-22; 6 → I-24; 7 → I-23; 8 → I-25; 9 → I-31..I-33; 10 → C-01; 11 → F-05.

C-STK-04 (stack_order_attention_test.go, T-GH-05, but the fold decisions are U-F*): steps 1-2 → I-70, U-F1; 3 → I-72; 4 → I-73; 5 → I-74.

C-J2-05 S1: I-06, I-08, I-09, I-52 (optional failed + required passed permits; pending required blocks both doors with 0 PUT).

---

## 2. Oracles (spec text only)

### 2.1 Who may merge (route `POST /api/todos/{n}/merge`)

Authorize runs first (5.2.1 L339): scope and role first, then eligible-delegated policy. Only after Proceed does `MergeReady` run (10.6.2).

| # | Credential | Role of the person | Op | Result | Status / class / code | Merge call | Spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | session | owner | merge | proceed to MergeReady | - | only if all rows hold | 10.6.2 L929, 5.2 |
| A2 | session | maintainer | merge | proceed | - | same | 10.6.2, 5.2 |
| A3 | session | member | merge | refuse | 403 permission | none | 5.2 (Merge row blank for Member), 5.2.1 |
| A4 | delegated via=cli | owner | merge | confirmation | 202 `{confirmation,state:"requested"}` only | none | 5.2, 5.4 L354, C-ACC-02 s1 |
| A5 | delegated via=claude-code | maintainer | merge | confirmation | 202 same | none | same |
| A6 | delegated via=codex | owner | merge | confirmation | 202 | none | same |
| A7 | delegated via=smithers (app agent) | owner | merge | confirmation | 202 | none | C-ACC-02 s1 |
| A8 | delegated via=terminal | owner | merge | confirmation or permission | gap S5 (terminal token scope excludes confirmations, 5.3.2 L346) | none | 5.3.2 |
| A9 | delegated, any via | member | merge | refuse at create | 403 permission | none | C-ACC-02 s7 |
| A10 | run (own TODO) | any | merge | refuse | 403 permission | none | 5.3 L341-348, C-ACC-02 s1 |
| A11 | run (other branch) | any | merge | refuse | 403 permission | none | same |
| A12 | machine | any | merge | refuse | 403 permission | none | 5.2 note under table, 5.3 |
| A13 | session + delegated bearer together | owner | merge | treated as delegated (202) | 202 | none | C-ACC-02 fail-when |
| A14 | setup session / no credential | n/a | merge | refuse | 401 (gap S6 on code) | none | 5.1 L310 |
| A15 | session, suspended or removed | n/a | merge | refuse; sessions are deleted | 401 (gap S6) | none | 5.6.1 L363 |
| A16 | session | owner | approve (review_merge confirmation, own) | proceed to MergeReady | - | one PUT if holds | 5.4 |
| A17 | session | maintainer | approve another member's confirmation | refuse | 403 permission | none | 5.4 "that member's session"; C-ACC-02 s4 |
| A18 | session | member (demoted since create) | approve | refuse | 403 permission (role rechecked) | none | 5.4 |
| A19 | delegated | owner | approve | refuse | 403 never | none | 5.2 "approvals that gate a merge: never", C-ACC-02 s2 |
| A20 | run | any | approve | refuse | 403 permission | none | C-ACC-02 s2 |
| A21 | machine | any | approve | refuse | 403 permission | none | same |
| A22 | token auth (`AuthInfo.IsTokenAuth`) of any kind | owner | merge | never reaches a merge | 403 permission or 202 per credential kind above | none | ticket Changes |

Wire shape for A4-A7: body keys exactly `confirmation`, `state` (5.2.1, 5.4); the id carries no subject data.

### 2.2 Position, review state, head match (session owner or maintainer, A1/A2)

Rows evaluated in order; the first that fails gives the reason (10.6.2a L931). Rows 1-7 are in the fence tx; 8-9 in the recheck.

| Row | Fixture violating this row alone | Reason (`code`) | Class | `merge_block` detail | Spec |
| --- | --- | --- | --- | --- | --- |
| 1 | state queued / starting / working / needs_you / paused / failed / merged / dropped (8 cases); in_review with `paused_at` set; in_review with an open wait | `state` | conflict | none | 10.6.2a r1, 4.1.0a L257 |
| 2 | in_review but an earlier unmerged item exists (any state, incl. working) | `order` | conflict | "T<k>" of the first unmerged | r2, 10.6.1 L927 |
| 2b | earlier items are merged or dropped only | passes | - | - | 10.6.1 ("first unmerged") |
| 3 | one `stack_attention` open (order or force_push) | `attention` | conflict | none | r3, 4.1.2a L274 |
| 4 | `todos.merging` set (by anyone, also by the same person) | `merging` | conflict | none | r4, 10.6.2b |
| 5a | generation not `candidate_verified` | `rechecking` | conflict | none | r5 |
| 5b | `pending_op` non-empty (PR push unsettled) | `rechecking` | conflict | none | r5 |
| 5c | `pr_head` unset | `rechecking` | conflict | none | r5 |
| 6a | `rebase_pending` set | `rechecking` | conflict | none | r6 |
| 6b | generation base != mirror `main` tip (PR head unchanged) | `rechecking` | conflict | none | r6, C-STK-07 s7/s8 |
| 7a | steer event with seq above `inputs_seq` | `pending_work` | conflict | none | r7, 10.4.5 |
| 7b | amendment event above `inputs_seq` | `pending_work` | conflict | none | r7 |
| 7c | newest capture tree != generation tree | `pending_work` | conflict | none | r7, C-STK-07 s5 |
| 8a | `reviewed_head_sha` != `pr_head` | `stale_head` | conflict | none | r8, C-J4-03 s2 |
| 8b | `pr_head` != GitHub's current PR head | `stale_head` | conflict | none | r8 |
| 8c | `reviewed_head_sha` empty or not 40 hex | `stale_head` or 400 `user` (gap S7) | | | |
| 9a | a required check fails on head | `checks` | gap S2 (class) | the check's name | r9, C-J4-03 s4 |
| 9b | a required check pending | `checks` | gap S2 | the check's name | r9, C-J2-05 s5 |
| 9c | optional check fails, required all pass | passes | - | - | C-J2-05 |
| 9d | no required checks configured | passes | - | - | r9 ("Required GitHub checks pass") |
| 9e | GitHub `mergeable=false` / `dirty` | `github` | gap S2 | GitHub's text as received | r9 |
| 9f | `mergeable=null` first read, true on re-read after 2 s | passes | - | - | ticket Risks |
| 9g | `mergeable=null` twice | refuse; reason gap S3 | | | ticket Risks |
| P | rows 2 and 5 both fail | `order` (first wins) | | | 10.6.2a ("first row that fails") |
| P | rows 4 and 7 both fail | `merging` | | | same |
| P | rows 1 and 8 both fail | `state` | | | same |
| P | rows 7 and 9 both fail | `pending_work` | | | same |
| OK | all hold, merged by A1/A2 | Proceed | - | - | |

`merge_block` for a TODO that holds all rows 1-7 but whose last synced PR head or checks are unknown: gap S4.

### 2.3 What each refusal returns

| Refusal | HTTP | `class` | `code` | `message` | Zero PUT | Side effects allowed | Spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| credential kind or role | 403 | permission | `permission` (gap S8: code value) | any | yes | none: no fence, no approval row, no `outbound_writes` row, no event | 5.2.1, 6.2.3 |
| delegated approve | 403 | never | - | | yes | none (no confirmation row) | 5.2.1 |
| delegated create, eligible | 202 | - | - | `{confirmation,state}` only | yes | one `person_confirmations` row `pending` | 5.4 |
| row 1-8 | 409 | conflict | row's reason | order: "Merges after Tn" | yes | none; fence cleared if it was set | ticket Changes, 10.6.2b step 2 |
| row 9 checks | 409 | gap S2 | `checks` | check name | yes | fence cleared | 10.6.2b |
| placement/amend while fence set | 409 | conflict | `merging` | | n/a | none | 10.6.2b L955 |
| GitHub refuses the PUT (405/409/422) | pass through | github | gap S9 | GitHub's `message` verbatim | one PUT happened | fence cleared; approval row kept or removed (gap S10) | 10.6.2 L929, 10.6.2b step 3, C-J4-03 s6 |
| GitHub 5xx / timeout / reset | | github or infra | | | one PUT | `outbound_writes` row `unknown`; fence stays until reconcile | 12.4.1a L1142 |
| approve with moved head | 409 | conflict | `stale_head` | | yes | row becomes `expired` | C-ACC-02 s5, 10.6.2c |
| approve after deny | 409 | conflict | - | | yes | none | C-ACC-02 s6 |
| approve while TODO working (steer) | 409 | conflict | `state` | | yes | row stays `pending` | C-ACC-02 s10, 10.6.2c L960 |
| replay, same `Idempotency-Key` | original status and body | | | | no new PUT | none | 6.2.1 L407 |
| duplicate press, new key, T1 already `merged` | 409 | conflict | `state` | | no new PUT | none | 10.6.2a r1 |
| duplicate press, new key, while fence set | 409 | conflict | `merging` | | one PUT total | none | C-STK-07 s10 |

### 2.4 Inbound GitHub merge fact, every state (ruling: every inbound fact has an outcome)

Fact M = "GitHub reports the TODO's PR merged". `OnMain` = main contains the merge commit. A fact with `OnMain=false` is held, not applied.

| State when M arrives | OnMain | Outcome | Spec |
| --- | --- | --- | --- |
| queued, starting, working, needs_you, paused, failed, in_review (with an open PR) | true | → merged; same tx cancels run, settles every open wait, clears needs_you, paused_at, merging; if an earlier unmerged item exists, run the out-of-order fold (2.5) | 4.1 L233, 10.6.4 |
| same states | false | no transition; recorded; re-evaluated next poll; fence kept | 4.1 ("and main contains the commit"), 10.6.2b |
| merged | true or false | recorded no-op (duplicate); no second event, no second issue close, no second learning run | ruling |
| dropped | true | terminal wins: stays dropped; recorded; gap S11 (main now holds the change) | 4.1.0 L255, ruling |
| in_review with fence set by Smithers | true | → merged; fence cleared by the merged tx; the Smithers PUT result (200 or 405 "already merged") is a recorded no-op | 10.6.2b step 3 |
| any unmerged with no PR | n/a | not applicable (no PR to report merged); a PR number the TODO never owned is ignored and recorded | 4.1 L233 ("with an open PR") |

### 2.5 Out-of-order fold (external merge of Tk while an earlier item is unmerged)

Stack order T2, T3, T4 unless stated. "Contained" = earlier unmerged items in Tk's candidate prefix (10.3.2 L874, 10.6.4 L964).

| Case | External merge | Merged set | Notes | PR closes | Attention | Later items | Smithers PUT | Spec |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | T2 (first) | {T2} | none | none | none | T3 rebases, ready; T4 draft | 0 | 10.6.3 |
| F2 | T3 (middle) | {T2,T3} | T2: "T3 merged before T2; T2's change is in T3's commit" | T2's PR closed once with "Merged via #<n3> (T3)"; T3's PR is the merged one | one `order` open, same sentence, audience maintainers | T4 rebases onto new main, force-updated, ready | 0 | 10.6.4, C-STK-04 |
| F3 | T4 (last) | {T2,T3,T4} | one note on each of T2, T3 | T2, T3 closed once each with "Merged via #<n4> (T4)" | one `order` (text for several earlier: gap S12) | none | 0 | 10.6.4 |
| F4 | T3, T2 is working | {T2,T3} | T2 note; run cancelled; waits settled | T2's PR closed | one | as F2 | 0 | 4.1 L233 |
| F5 | T3, T2 queued/needs_you/paused/failed | as F4 | | | | | 0 | 4.1 L233 |
| F6 | T3, T2 dropped, T1 unmerged | {T1,T3} (T2 untouched, stays dropped) | T1 note | T1 closed | one | | 0 | 10.6.4 ("unmerged") |
| F7 | T3 duplicate poll | no change | none | none | still one row | | 0 | ruling (duplicates are recorded no-ops) |
| F8 | T3, commit not on main yet | nothing merged | | | none | | 0 | 4.1 L233 |
| F9 | T3 while an `order` row is already open | gap S13 (second row or append) | | | | | | |
| F10 | T3 while Smithers fence on T2 is set | T2 merged by fold; fence cleared; Smithers' PUT answer recorded | | | | | 1 (already sent) or 0 | 10.6.2b, S14 |
| F11 | T3 where T3's head was force-pushed by someone since verification, so its commit does not contain T2 | gap S15 | | | | | | |
| F12 | T3 when drafts unsupported ("[waits for T2]" prefix) | same as F2; also remove prefix and `smithers:waiting` on survivors | | | | | 0 | 12.5.1 L1161, G18 |
| F13 | after fold, the Smithers merge of T4 | refused `attention` until a maintainer presses OK; Alice's OK → 403 permission | | | | | 0 | 10.6.2a r3, C-STK-04 s3-s5 |
| F14 | linked issues of folded earlier items with `fixes_issue=true` | gap S16 (close or not) | | | | | | 12.4.1 |

---

## 3. Tests by layer

### 3.1 Unit (pure, no DB, no network): about 150 table rows

| Id | Test | Seam | Rows |
| --- | --- | --- | --- |
| U-A1..A22 | `TestMergeAuthorizationMatrix` table 2.1 | `AuthorizeMerge`, `DecideMerge` | 22 |
| U-R1..R44 | `TestMergeReadyRows` table 2.2, incl. precedence combos | `MergeReady` | 44 |
| U-30 | `merge_block` and route verdict identical for all U-R inputs | `DecideMerge` vs projection | 44 (same table) |
| U-31 | approval binds generation and head; new generation voids; head change expires | `ApprovalValid(approval, gen, head)` | 6 |
| U-40..U-47 | envelope mapping table 2.3 | `DecideMerge` | 12 |
| U-I1..U-I10 | inbound merged fact table 2.4 | `ProjectGitHubMerged` | 14 |
| U-F1..U-F14 | fold table 2.5 | `FoldExternalMerge` | 14 |
| U-K1..K4 | outbound key = `merge:<target>:<sha>`; same decision same key; new sha new key | `MergeWriteKey` | 4 |
| U-RC1..RC7 | reconcile merge row: merged→done; open+head=sha+MergeReady→repeat once; open+head moved→superseded; merge never superseded by later rows | `ReconcileMergeRow` | 7 |
| U-FN1..FN5 | fence reconcile: PR merged→keep; other→clear | `ReconcileFence` | 5 |
| U-60 | grep guard: no `automerge`, `landedByMaintainer`, `checks.Land`, `/mythical/items/{id}/land`, `change.land`, `history.land` | source scan | 1 |
| U-61 | grep guard: every stack mutator (place, amend, move, drop, steer, answer, admission, rebase_pending, candidate, propose, fold) calls `LockStack` before reading `todos.merging` | AST | 11 |

### 3.2 Integration (real PostgreSQL, real git/jj where the check says, githubfake with write log): 55 tests

| Id | Scenario | Assert |
| --- | --- | --- |
| I-01 | Maintainer session merges T1 at H1 | one PUT, `sha=H1`, `merge_method=squash`; one approval row (member, session, gen g, H1); `merged` only after `OnMain` true |
| I-02 | PUT body has no other merge method; title/message not required | body keys exact |
| I-03 | Approval row written before PUT (fake holds PUT; row visible) | row exists while call pending |
| I-04 | Head change after approval deletes approval; merge with old head refused | `stale_head`, 0 PUT |
| I-05 | New generation (rebase) deletes that TODO's approvals only | other TODOs' rows intact |
| I-06 | `merged` not set while `OnMain` false (fake mirror lags); set after | state timeline |
| I-07 | Merged tx cancels run, settles waits, clears merging and needs_you | rows |
| I-08 / I-09 | `fixes_issue` true closes issue (one outbound row `close issue`); false leaves it open | issue state, outbound rows |
| I-10..I-13 | C-J4-03 steps 1-3 | table 2.1/2.3 |
| I-14..I-19e | C-ACC-02 steps | as 1.2 |
| I-20 | each MergeReady row violated alone (loop 1-9) | reason, `merge_block` same, 0 PUT |
| I-21 | fence tx locks stack row then TODO row (observe `pg_locks`/lock order via two sessions) | no deadlock |
| I-22 | Edit before merge (write src/a.ts under another uid) | `pending_work`, run gets one `edited` signal |
| I-23 | `rebase_pending` with unchanged PR head | `rechecking` |
| I-24 | Edit during dispatch | one PUT; src/c.ts in final capture |
| I-25 | `main` moves right after fence tx (hook) | `rechecking` after `ls-remote`, fence cleared |
| I-26 | required check fails/pending at recheck (fake flips after tx) | `checks`, 0 PUT, fence cleared |
| I-27 | PR head moves on GitHub between tx and recheck | `stale_head`, fence cleared |
| I-28 | `mergeable:null` then true after 2 s (fake clock) | one retry, then PUT |
| I-29 | fake answers 405 with GitHub sentence | class github, message verbatim, fence cleared |
| I-30 | steer first, then merge | `state`, 0 PUT |
| I-31..I-33 | Move, Before, Amend, Drop during held PUT | each `409 {code: merging}`; after 200, T2 first |
| I-34 | steer + review comment during held PUT, release 200 | recorded, never delivered, no `in_review→working` event, run cancelled |
| I-35 | same, release 405 | delivered once each, T1 working |
| I-36 | `rebase_pending` write during fence waits then proceeds | ordering |
| I-37 | `stack.propose` during fence waits | ordering |
| I-38 | engine start with stale fence, PR open → cleared; PR merged → kept until merged tx | rows |
| I-39 | `POST /api/install/quiesce` reports in-flight while fence set | |
| I-40 | `home` and `todo:<n>` carry `merge_block` per state/position | per item |
| I-41 | T2 after T1 merges: rebased, force-updated H2', ready; old H2 refused, H2' merges | |
| I-42 | next PR `markPullRequestReadyForReview` once, T3 stays draft | GraphQL log |
| I-50 | worker pass over first-in-order green item with labels `automerge`, member- or App-applied | 0 PUT, 0 approval rows, 0 state change |
| I-51 | `POST /mythical/items/{id}/land` returns 404 | |
| I-52 | C-J2-05 optional/required checks | 0 PUT on pending |
| I-60 | migration applies/reverts; `todos.merging` jsonb null default; `todo_approvals.generation` not null | |
| I-70..I-79 | out-of-order fold end to end (F1-F13) with real stack engine | notes, closes, attention row, rebase, 0 PUT |
| I-80 | G23 invariant checker run after every integration test in this file: no push/ref update to `refs/heads/main`; every PUT has an approval row at same sha | |

### 3.3 Fault (kill points around `PUT /merge`): 14 tests, `todo_merge_fault_db_test.go`

Each kill is a `MergeHooks` panic/ErrKill followed by a fresh engine on the same PG and the same fake. Common assertions: total PUT <= 1; no fence left set unless PR merged and `merged` tx pending; every repeat preceded by `GET /pulls/{n}` (12.4.1b L1144); one recovery receipt per reconciled row.

| Id | Kill point | Fake state | Expected after restart |
| --- | --- | --- | --- |
| F-01 | after fence tx, before recheck | PR open | fence cleared; 0 PUT; press again works |
| F-02 | after recheck, before outbound row | PR open | fence cleared; 0 PUT; no approval row |
| F-03 | after outbound row `pending`, before send | not merged | row reconciled by GET: open, head = sha, MergeReady holds → send once; or fence cleared if not (gap S17) |
| F-04 | after send, response not read (fake merged) | merged | row `unknown` → GET shows merged → `done`; T1 merged; 1 PUT total |
| F-05 | after fake 200, before result recorded (C-STK-07 s11) | merged | 1 PUT; T1 merged; no fence |
| F-06 | after result recorded, before merged tx | merged | fence kept, then merged tx commits |
| F-07 | after merged tx, before issue close | merged | close-issue row sent once (fixes_issue true) |
| F-08 | response lost (timeout) and fake did NOT merge | open, head=sha | repeat once; 1 PUT total |
| F-09 | timeout, fake did not merge, head moved | open, head≠sha | row `superseded`; fence cleared; Merge returns to card |
| F-10 | timeout, fake did not merge, MergeReady fails now (steer arrived) | open | `superseded`; no PUT |
| F-11 | 405 returned, kill before fence cleared | open | fence cleared; 0 further PUT |
| F-12 | merged on GitHub but mirror `main` lags | merged, OnMain false | fence stays until OnMain; then merged |
| F-13 | double kill (kill during reconcile) | merged | still 1 PUT; one receipt |
| F-14 | kill after approval row inserted, before outbound row | open | approval row for generation g and H remains or is deleted (gap S10); no PUT |

### 3.4 Property (Go `rapid`/`testing/quick` over a model; fake GitHub as oracle): 3 properties

P2-merge (restricted per Codex finding 11).
- Generator: stack of 1-6 TODOs in random states; ops: append, before, amend, move up/down, drop, steer, edit, rebase, head move on GitHub, `main` move, check flip, Smithers merge (random credential kind, role, head sha right or stale), external GitHub merge of a random open PR (out of order allowed), poll, restart engine.
- Invariants, checked at every fake `PUT /merge` and after every op:
  1. Every Smithers-issued PUT targets the first unmerged item at the instant of the call (fake hook snapshots order under the same lock).
  2. PUT `sha` = `todo_approvals.head` = fake's PR head; method = squash; at most one PUT per TODO.
  3. No PUT while an `order` attention is open or a fence is set on another PUT for the same TODO.
  4. After an external merge of Tk: every item that was unmerged and earlier than Tk in the candidate's prefix is `merged`; exactly one `order` attention is opened per such event (zero for first-item merges); no PUT issued by Smithers during the fold.
  5. Terminal states are absorbing under every later inbound fact (merged stays merged, dropped stays dropped unless reopen rule 4.1 L235).
  6. Every inbound merged fact is applied once: replaying the poll twice yields identical rows (duplicate = no-op).
- Not asserted here: tree conservation and draft-ness (P2 in the plan, T-STK-02/T-GH-05). Draft invariant only where `fake.drafts=true` (G17).

P3-merge. Generator: role {owner, maintainer, member, suspended, removed} x credential {session, delegated(via in 5), run own/other, machine, setup, none} x op {merge, approve} x random TODO position/state. Invariants: `AuthorizeMerge` equals table 2.1; refused calls leave all rows unchanged (snapshot of `todos`, `todo_events`, `todo_approvals`, `outbound_writes`, `person_confirmations` before and after); under random sequences no non-session credential produces a PUT; an approve by a session whose role was demoted after create produces none.

P11-merge. Kill at a random hook (F-01..F-14 set) in random interleaving with an external merge, a steer and a restart. Invariants: PUTs for one key <= 1; every repeat preceded by a GET of the PR; no fence remains set after reconcile unless the PR is merged and merged tx is pending; final TODO state is merged iff the fake PR is merged and OnMain.

### 3.5 Concurrency: 5 tests, `todo_merge_race_db_test.go`

| Id | Scenario | Assert |
| --- | --- | --- |
| C-01 | 20 concurrent `POST /merge` for T1 (two maintainers, same head, distinct `Idempotency-Key`s); fake holds PUT 200 ms | exactly 1 PUT, 1 approval row, 1 fence set; the other 19 get `merging` (or `state` if after merged) (G21) |
| C-02 | 20 concurrent mixed ops against T1: 5 merges, 5 steers, 4 moves, 3 amends, 3 drops | no deadlock (all return within 10 s); lock order stack row then TODO row; at most 1 PUT; if PUT happened none of move/drop/amend succeeded after the fence |
| C-03 | 20 concurrent merges across T1..T3 (7 each) | exactly 1 PUT (T1); T2,T3 `order` |
| C-04 | 20 concurrent same-key replays (same `Idempotency-Key`, same body) | 1 PUT; all 20 responses equal |
| C-05 | merge press racing an external GitHub merge poll | either one PUT then fold no-op, or 0 PUT; final merged exactly once; no second `merged` event |

Counts: unit about 150 rows in 12 top-level tests; integration 55; fault 14; property 3 (with about 8 invariants); concurrency 5; e2e owned by checks (E-01, E-02).

---

## 4. Abuse cases

| # | Attack | Test | Expected |
| --- | --- | --- | --- |
| AB1 | Approval for an old head after a rebase: approve at H, rebase makes H', press Merge with H | I-04, I-41, U-31 | 409 `stale_head`; approvals deleted; 0 PUT |
| AB2 | Pending confirmation at H; rebase to H'; owner approves | I-18, I-19e | 409, row `expired`, 0 PUT |
| AB3 | Delegated credential's merge (cli, claude-code, codex, smithers, terminal) | A4-A8, I-14 | 202 only; never a PUT; body leaks nothing |
| AB4 | Delegated credential approves its own confirmation | A19, I-15 | 403 `never` |
| AB5 | Session cookie + delegated bearer on one request | A13 | delegated treatment |
| AB6 | Agent (run credential) merges its own TODO | A10, A11 | 403 permission |
| AB7 | Machine token merges its branch | A12 | 403 permission |
| AB8 | `automerge` label by member, non-member, App on first green TODO | I-50 | no effect, no log line |
| AB9 | `POST /mythical/items/{id}/land` and `change.land` / `history.land` doors | I-51, U-60 | 404 / absent |
| AB10 | Merge while a later PR was un-drafted on GitHub (T3 ready, T1 first) | I-72 variant: before T3 is merged: Merge T1 still allowed, no attention; after T3 merged externally: attention | gap S18: does an un-drafted but unmerged later PR block row 2? Spec says no |
| AB11 | Merge T2 after GitHub-side out-of-order merge of T3 (attention open) | I-72, F13 | `attention`; Alice's OK 403 |
| AB12 | Merge during a rebase (`rebase_pending`, or a rebase running with unchanged PR head) | I-23, U-R17..R19 | `rechecking`, 0 PUT |
| AB13 | Merge during `main` move after fence tx | I-25 | `rechecking`, fence cleared |
| AB14 | Double click (same `Idempotency-Key`) | C-04 | 1 PUT, same response |
| AB15 | Double click with new key | C-01 | 1 PUT; second `merging` or `state` |
| AB16 | Replay of a completed merge's request key hours later | I-81: replay returns original 200 body, no PUT | 6.2.1 |
| AB17 | Same `Idempotency-Key` with a different `reviewed_head_sha` | I-82 | gap S19: spec says "a repeat with the same key returns the original result"; does a changed body 422? |
| AB18 | Merge with `reviewed_head_sha` of the generation's tree-equal but different commit | U-R37 | `stale_head` (commit sha, not tree) |
| AB19 | Member steers during dispatch to unfence a merge | I-34 | held, never delivered to merged TODO |
| AB20 | Member Drops/Moves T1 during the merge | I-31..I-33 | `409 merging` |
| AB21 | Removed/suspended maintainer's old session cookie | A15 | 401, 0 PUT |
| AB22 | Role downgrade between press and recheck | I-83 | gap S20 (role recheck inside step 2?) |
| AB23 | Branch protection requires review; owner merges | E-02 | GitHub text verbatim |
| AB24 | Merge of a TODO whose PR GitHub shows closed | U-R?, I-84 | gap S21 (row 1 reads PostgreSQL; PR closed on GitHub is dropped on next poll) |
| AB25 | PR still draft on GitHub (just became first, ready not yet written) | I-85 | GitHub's refusal verbatim, class github (gap S22) |

---

## 5. Spec gaps (for the tech lead)

- S1 C-J2-05 says pending required check blocks "with zero GitHub calls"; 10.6.2b step 2 requires GitHub reads. State whether "zero" means zero merge PUTs (QA assumes yes).
- S2 The `class` for refusal rows 9 (`checks`, `github` mergeable) is not decided; the ticket gives `conflict` for rows 1-8 and `github` only for GitHub's merge refusal.
- S3 `mergeable: null` twice in a row: which reason and class (QA proposes `github`, detail "GitHub is still computing mergeability").
- S4 `merge_block` for rows 8-9 uses "last synced" GitHub facts; with no sync yet (fresh install, stale sync health) what does the card show?
- S5 `delegated(via=terminal)` S1 token scope excludes confirmations (5.3.2): does the merge create return 403 `permission` instead of 202?
- S6 No credential, setup session, suspended or removed member: status and code (401 `unauthenticated` assumed).
- S7 Malformed or empty `reviewed_head_sha`: 400 `user` or `stale_head`.
- S8 `code` value for credential/role refusals (`permission`?).
- S9 `code` for a GitHub merge refusal (`github`? `github_refused`?) and the passthrough status.
- S10 After a GitHub refusal, is the `todo_approvals` row deleted or kept? 10.6.2b step 3 clears the fence but says nothing of the approval written in step 3 before the call.
- S11 Inbound merged fact on a `dropped` TODO (PR reopened then merged, or closed then merged elsewhere): terminal-wins leaves main holding a change the product calls dropped; specify an attention or an event.
- S12 Out-of-order fold with several earlier items: one `order` row with how many sentences, or one row per earlier item, and does T4-before-T2-and-T3 name both?
- S13 A second external out-of-order merge while an `order` row is open: second row or append.
- S14 External merge of Tk while a Smithers fence is set on an earlier item: the fold must not wait for the fence; spec says every mutation reads `merging` (10.6.2b L949) but the fold is listed as a mutation that does; define precedence and what the in-flight PUT returns.
- S15 Out-of-order merge whose commit does not actually contain the earlier items (head force-pushed outside Smithers): the fold assumes containment from the verified candidate; define a check.
- S16 Do folded earlier items with `fixes_issue=true` close their issues?
- S17 Reconcile row for a merge in state `pending` (never sent) vs `unknown`: 12.4.1b lists only `unknown`.
- S18 A later PR un-drafted on GitHub but not merged: spec says Smithers enforces order; should it re-draft it (12.5.1 only re-drafts on position change)?
- S19 Same `Idempotency-Key` with a different body.
- S20 Role downgrade between fence set and dispatch: is role rechecked in step 2?
- S21 PR closed on GitHub between polls while `in_review`: row 8-9 reads GitHub PR; which reason (`state`? `github`?).
- S22 PR still draft when item becomes first: should `MergeReady` row 9 include "not draft" with its own reason, or defer to GitHub's text?
