# T-FLW-11 ahead-of-time test plan: one `todo` run per attempt

Author: QA, 2026-10-02. Read-only study of ~/qa-repo. No code was run.
Sources: tickets/T-FLW-11.md, T-STK-12.md, checks C-CAT-01, C-J5-01, C-STK-03, C-STK-06, C-J10-09, C-DUR-01, spec.md §4.1, §10.4, §10.7, §11, §12.4.1, §19, delta.md §6, today's `packages/backend/internal/services/mythical_items.go` (and `mythical_receipts.go`, `mythical_failure.go`, `mythical_view.go`), `flows/coding/{request,vibe,verify,todo,steering}.ts`, `flows/review/change/flow.mdx`.
Not read in full: `mythical.go` (fold, adoption), `mythical_placement.go`, `mythical_land_todo.go`, workspace lane code. Their launch paths are not in the four-run set; rows that depend on them say so.
`flows/todo/` does not exist yet. All new test paths below are proposed.

Falsifier (overview.md "Top risks"): a first pass runs one TODO end to end as one run id with section 2 green. Section 2 rows marked CHANGED or UNSPECIFIED cannot be green until the tech lead rules (section 5).

Process names used in kill points: BE = Go backend (stack engine, signals), CH = coding host (executes the run on the branch machine), PG = PostgreSQL.

---------------------------------------------------------------------
## 1. Requirement trace

| Req | Source (line) | Proving test | Layer | File |
|---|---|---|---|---|
| Composition `flows/todo/flow.ts` is `Flow.make("todo", ...)`, steps route, plan, implement, candidate, check, review, propose | ticket Scope-In 1; spec §10.4.1 | U01 | unit | flows/test/todo.composition.test.ts |
| Step flows come from `flows/coding/` exports, one implementation per step | ticket Changes 2 | U02 | unit | same |
| Reserved `candidate`, `propose` steps are system ops, not flow steps; override cannot skip them | ticket Scope-In 2; spec §10.4.1, §11.1.1 | U03, I14 | unit, integration | same; todo_run_db_test.go |
| Engine launches one run per attempt and signals rebased, edited, steer, changes_requested, merged, dropped | ticket Scope-In 3; spec §10.4.1 | I01-I09 | integration | todo_run_db_test.go |
| Four registrations deleted; steps stay exported | ticket Scope-In 4; C-CAT-01 step 8 (spec §6.1.2c) | U04, U05 | unit | catalog tests + flows/test |
| Launch sites `:1681 :1775 :1905` and `mythicalReviewFlow` (`:2277`, launched `:2408`) replaced by one launch plus durable signals | ticket Changes 3 | U06 (grep guard), I01 | unit, integration | |
| Item states keep meaning as phases the run reports | ticket Changes 3; spec §4.1.0 | U07, I10 | unit, integration | |
| `todo` overridable; `stack.candidate`, `stack.propose` reserved | ticket Changes 5; spec §11.1.1-§11.1.2; M-30 | U03, U04 | unit | |
| Test fixtures that assume four runs updated | ticket Changes 6 | U06 (no `coding/request` literal in `flows/test` fixtures) | unit | |
| E2E as one run id; rebase re-enters candidate; edited re-enters candidate; steer re-enters implement; merged ends | ticket Tests 1 | I01-I06 | integration | todo_run_db_test.go |
| C-STK-06 A-D on the real composition | ticket Tests 2; C-STK-06 | I10-I13 | integration | todo_candidate_flow_db_test.go |
| Kill between propose and PR open: resume waiting, PR opens once | ticket Tests 3; spec §12.4.1b, §19.2 | F17, F19, F20, F21 | fault | |
| Step graph equals route, plan, implement, candidate, check, review, propose plus loop edges | ticket Tests 4 | U01 | unit | |
| Regression: every behavior of the four runs has a named test | ticket Tests 5; overview Top risks | section 2 (R01-R52) | all | |
| 50 waiting runs survive a host restart and resume on signals | ticket Risks | F30 | fault | |
| C-CAT-01: four Replaced entries have no registrations | ticket Acceptance | U04, U05 | unit | |
| C-J5-01: running A keeps D1; retry pins D1; C pins D2 | ticket Acceptance; spec §11.4.1-§11.4.2 | I20-I23, P2 | integration | |
| C-STK-03 steps 1-6 (stop, resume, fail, retry with steer) | ticket Acceptance; spec §10.7.1 | I24-I29 | integration | todo_control_db_test.go |
| C-STK-06 PR head tree equals checked tree | ticket Acceptance; spec §10.4.4 | I10-I13, INV8 | integration | |
| C-J10-09: `/review` runs the overridable `review` flow on its own | ticket Risks; C-J10-09 | U05, I30 | unit, integration | |

Check-step coverage:

| Check step | Test |
|---|---|
| C-STK-03 s1-s2 stop, observe `working(stop: requested)` then `paused` after wait-opened | I24 |
| C-STK-03 s3 resume, same run id, counters s1,s2 = 1 | I25 |
| C-STK-03 s4 failure `{step,class,message,retryable}` | I26 |
| C-STK-03 s5-s6 retry with steer, new attempt, digest D, steer first message | I27, I28 |
| C-STK-06 part A (edit in check) | I10 |
| C-STK-06 part B (edit in capture, hook) | I11 |
| C-STK-06 part C (steer in check) | I12 |
| C-STK-06 part D (main move in check, replay refused `stale_generation`) | I13 |
| C-STK-06 part E (prefix) | T-STK-12/T-STK-03; I31 only asserts the run starts on the prefix base |
| C-J5-01 s7-s8 | I20-I23 |
| C-CAT-01 s8 (tags per registry) | U04 |

---------------------------------------------------------------------
## 2. Regression list: what the four-run path provides today

Source of record: today's launches are `start` `:1618` (coding/request, maxRounds 3 `:1673`), `deliver` `:1765` (coding/vibe), `integrate` `:1812` (coding/verify `:1905`), `review` `:2349` (review/change `:2408`). All in `packages/backend/internal/services/mythical_items.go` unless noted.
Disposition: KEEP (must hold unchanged), CHANGED (spec changes it; test asserts the new rule), MOVED (another ticket owns it; this ticket tests only the seam), UNSPECIFIED (spec silent; blocks green, see section 5).
"Today's test" names the existing Go test that pins the current behavior; each new test must be at least as strict.

### 2.1 Launch, identity, projection

| ID | Behavior today | Where | Disp | New test |
|---|---|---|---|---|
| R01 | Admission and the item row commit in one transaction, so a crash never leaves a launch the item doesn't know about | `commit` `:1437-1491`, comment `:1434-1436` | KEEP | I01 (attempt row + run admission atomic; fault F02 kills between) |
| R02 | Lost COMMIT acknowledgment: the persisted row decides, no second launch | `:1480-1486` | KEEP | F02 |
| R03 | Launch request id is deterministic per attempt, so a replayed admission is a no-op | `:1464` `mythical:<id>:<attempt>:<phase>:<generation>` | KEEP, new id = `<todo>:<attempt>` | U08, I02 |
| R04 | Two workers or a worker that loses its lease launch a TODO once | today's tests `TestMythicalConcurrentWorkersLaunchOneTodoOnce`, `...LosesItsLeaseMidPassLaunchesNothingTwice` | KEEP | I02 |
| R05 | A queued TODO survives a restart and launches once | `TestMythicalQueuedTodoSurvivesARestartAndLaunchesOnce` | KEEP | F01 |
| R06 | Run is admitted with no per-plan approval (`ApprovalAuto`); items reach main only via a PR a person merges | `:1470` | KEEP | I03 (no `approval` wait unless the flow raises one) |
| R07 | A projection from an older generation changes nothing | `ProjectFlowRuntime` `:605` | KEEP as attempt identity: a late event from attempt n changes nothing of attempt n+1 | U09, I28 |
| R08 | Run id recorded as soon as known, outcome only at terminal, first outcome wins | `:611-650` (`item.RequestOutcome == ""`) | KEEP | U09 |
| R09 | Legacy per-phase run ids `RequestRunID`, `VibeRunID`, `VerifyRunID` and `Runs{Request,Vibe,Verify}` in the view | `:427`, `mythical_view.go:451` | CHANGED: one `run_id` per attempt; delete the three fields (AGENTS.md zero tech debt) | U06, I04 (API schema and Inspect link) |
| R10 | Issue comments name the run (`Run: <url> (<id>)`) using request run id, else vibe run id | `runLine` `:3280-3298` | CHANGED: attempt's one run id | I04 |
| R11 | Launch binds run to item, workspace, generation in the authorization context; the resolver refuses a run acting on another item | `commit` `:1456`, `ResolveFlowHostTarget` `:2583` | KEEP and EXTEND to `stack.*`: a run may call candidate/propose only for its own TODO and attempt | I14, I15 |
| R12 | Phase states (`running, delivering, integrating, verifying, proposing, waiting, retrying`) shown on the card | `advance` `:1372`; spec §4.1.0 | CHANGED: `current_step` from run events within 1 s | U07, I10 |

### 2.2 Prompt, route, plan

| ID | Behavior today | Where | Disp | New test |
|---|---|---|---|---|
| R13 | Prompt is the pinned (approved) issue text, framed as untrusted, never the live issue | `prompt` `:1723-1763` | KEEP (C-SEC-03, §10.4.2: revision 1 + steers + acceptance + issue context quoted with author) | U10 |
| R14 | Prompt cap: issue body 24 KiB, whole prompt 48 KiB | `:54`, `:176`, `:1759` | KEEP | U10 |
| R15 | Other open issue titles supplied for duplicate detection | `:1736-1745` | UNSPECIFIED | gap 9 |
| R16 | An earlier failure's reason is fed back into the next attempt's prompt | `:1752` | CHANGED: Retry steer is the first message; failure reason is not auto-fed | I27 asserts first message = steer only |
| R17 | Jev routes once (implement, bug, feature, close); route is recorded on success and on failure; leaf feedback per route (bug: failing regression test first; feature: lint then decline with at most 3 questions; close: decline with evidence) | `flows/coding/todo.ts` `leafFeedback`, `mythicalRoute` `:830` | KEEP in `route` step | I05 (each route), U11 (feedback text per route) |
| R18 | Planner declines: item ends `declined`; author's edit or a maintainer re-label revives it | `:1393-1404`, `mythicalFailedOutcome` `:808-818` | CHANGED (§10.8.1a): decline raises `needs_you{question}`, run waits | I06 |
| R19 | Plan summary (title, amends, inserts, appends, steps) projected for the card; plan carries its checks to verification | `mythicalPlanSummary` `:847-923` | KEEP: plan output feeds `check` | I07 |
| R20 | Plan needs at least two checks (`flows/coding/planning.ts:38`); a rebased result with no checks replans (`:1856`) | | CHANGED: one check minimum; none detected runs build-only and says "no checks detected" (§11.2) | I08 |
| R21 | Plan cites published wiki; the lane never re-reviews wiki pages | `:1676`, `suppliedWiki` | KEEP (§10.4.1 "plan (cites wiki revisions)") | I09 |
| R22 | Plan approval policy (`never`, `always`, `timeout:Ns`): confirm waits; refusal ends as `declined`-style failure; timeout approves | `flows/coding/request/flow.ts` `approve` | KEEP as an `approval` wait | I06b (inside I06 family) |
| R23 | Steering at boundaries `after-poc`, `before-implementation`, `after-correction`; feedback capped at 8 planning passes (`maximumPlanningPasses`) | `steering.ts:91`, `request.ts` | KEEP and EXTEND: every step boundary and between implement turns (§10.7.3) | I40-I47 |

### 2.3 Implement and correction rounds

| ID | Behavior today | Where | Disp | New test |
|---|---|---|---|---|
| R24 | Correction rounds: a failing check sends the atom back for up to `maxRounds` (3) corrections before the plan fails | `:1673`, `flows/coding/correction.ts`, `Cursor.maxRounds <= 8` | KEEP; default and where configured UNSPECIFIED (gap 13) | I16 (check seeded to fail twice then pass: one run, step `implement` re-entered by correction, finished steps not re-run; fails 4 times: run `failed{step:"implement" or "check"}`) |
| R25 | Implementation writes one native change per atom with fenced descriptions | `flows/coding/implementation/flow.ts`, `vibe-cleanup.ts` | CHANGED: working copy history is never rewritten; one commit is written by `stack.candidate` | I17 |
| R26 | Agent `ask` mid-implement | spec §10.7.2a (new) | NEW | I18 |
| R27 | Check failures typed: `fault infra` vs `factory` per receipt; infra fault preserves the plan attempt | `mythical_receipts.go:55`, `TestMythicalCheckInfraFaultPreservesPlanAttempt` | KEEP | I19 |

### 2.4 Candidate, one commit, verification after rebase

| ID | Behavior today | Where | Disp | New test |
|---|---|---|---|---|
| R28 | Result handed to the stack only from the current attempt's run id, on the tip the lane was given, by the stack's own account, retained in the workspace source ref, replay idempotent | `SubmitLane` `:443-536` (checks `:445`, `:455`, `:459`, `:517`, `:522`) | KEEP as `stack.candidate` preconditions | I15 (stale attempt's run id refused; replay with same tree answers the same generation, no second pin) |
| R29 | One commit per item: the PR head is one commit whose tree is exactly the verified candidate on `main`'s tip | `propose` `:2029-2040`, PR text `:2126` | KEEP (spec §10.4.4) | I10, INV8 |
| R30 | PR head commit is deterministic (author stamp from the item's `CreatedAt`), so a replay recomputes the same sha and does not push again | `:2031-2038` (`item.PRHead == commit`) | KEEP | F19, U12 (same inputs, same sha) |
| R31 | Candidate is pinned (`refs/smithers/keep/<sha>`) before anything depends on it; PR head pinned, then intended head recorded, then pushed | `pin` `:2540`, `:1823`, `:2043-2050` | KEEP (spec §10.4.4 step 1) | I21, F10, F11, F17 |
| R32 | Commit message hygiene: title from the summary's first line (250 cap), closing keywords rewritten to `Refs #n`, so only `complete` closes the issue | `proposal` `:2126-2160` | KEEP | U13 (table of keywords, cross-repo, URL forms) |
| R33 | Re-verification after a rebase: checks run on the rebased tree, with `writes` = paths changed on the tip so affected checks select targets | `integrate` `:1880-1905` (`changedPaths`) | CHANGED: `check` step after `rebased` re-runs on the new generation; keep the changed-paths input | I03b in I03 family: affected-check fixture selects by `base..head` paths |
| R34 | A new generation voids the earlier one's verification (`CandidateVerified=false`) | `:1901` | KEEP (T-STK-12 `Candidate`) | I13b (assert at most one verified generation) |
| R35 | Candidate that was never verified is not proposed; unverified fast-forward replans | `:1830-1832`, `:1953-1955` | KEEP: propose refuses without evidence naming g | U14 |
| R36 | Fast-forward when the candidate is already on the tip, else rebase | `:1829-1840` | MOVED (T-STK-08 rebase); seam test: `rebased` signal re-enters candidate | I03 |
| R37 | Rebase of an amend/insert candidate: replan on the new tip (`errMythicalRewrite`) | `:1842` | MOVED | none here |
| R38 | Rebase conflict: retry up to 3 attempts, then blocked | `:1844-1847`, `mythicalRetry` | CHANGED (§10.5.4: agent once, then `needs_you{conflict}`) | I32 (seam only: a conflict raises the wait on the same run) |
| R39 | Outsider-started work: protected-path changes stop the item (`policy: protected_paths`); outsider lane egress narrowed | `protectedChanges` `:1785-1810`, `:1822-1826` | UNSPECIFIED (maintainer release keeps trust rules "intact"; AGENTS.md) | I33 |
| R40 | Check receipts (check, tier fast/slow/delivery, status, fault, commit, duration), bounded to 200, kept only when they measure the candidate head | `mythical_receipts.go:12-170` | CHANGED: evidence entries tagged by generation (§10.4.3) | U15, I34 |

### 2.5 Propose, PR, follow

| ID | Behavior today | Where | Disp | New test |
|---|---|---|---|---|
| R41 | Push uses a lease on the recorded old head; the intended head is recorded before the push; on restart a recorded push is settled from `git ls-remote` (head = intended: done; head = expected: repeat; else blocked "moved outside Smithers") | `propose` `:1970-1993`, `pushProposal` `:2066-2078` | KEEP, expressed as `outbound_writes` kind `push` (§12.4.1b) | F17, F19 |
| R42 | PR open is find-then-create: an existing PR for the branch is reused; a closed-unmerged one is replaced | `openPull` `:2081-2112` | KEEP for update; reopen window handled by §10.7.4 | F19, I35 |
| R43 | Foreign push to the PR branch: stack neither reviews nor merges, holds for a person | `follow` `:2203-2210`, `mythicalHold` | MOVED (T-GH-04, `foreign_push` wait) | seam: I36 |
| R44 | PR closed without merge becomes rejected/dropped; merged becomes landed | `follow` `:2198-2202` | CHANGED: `merged`/`dropped` signals end the run | I09b = I06 family: merged and dropped end the run, same run id, no later launches |
| R45 | PR behind or dirty and stack tip moved: refresh by re-integrating | `follow` `:2203-2205` | CHANGED: `rebased` signal | I03 |
| R46 | The stack polls the PR every 5 min | `mythicalPullPollEvery` `:51` | CHANGED: no run-side timer; durable wait on signals | F30 (no polling load: 50 waiting runs issue zero GitHub reads) |
| R47 | Issue/PR comments and labels once-only via `Notice`/`Noticed` keys | `:3466-3478`, `deliverNotice` `:3084` | MOVED (T-GH, outbound keys); seam: the run itself makes no GitHub write | I37 (write log shows only system-op writes) |

### 2.6 Review (today a separate run, `review/change`)

| ID | Behavior today | Where | Disp | New test |
|---|---|---|---|---|
| R48 | Review is read-only: `capabilities fs:read:**`, no commands, writes nothing | `flows/review/change/flow.mdx:3` | KEEP | I38 (fs write attempts and exec attempts in the review step fail; GitHub write log empty) |
| R49 | Reviewer reads the candidate's own diff only, framed as untrusted title and diff; escapes any tag spelling | `:2399-2402`, `mythicalUntrusted` `:2330` | KEEP (ticket: `base..C`, never the working copy) | I38, U16 (existing `TestMythicalUntrustedEscapesEverySpelling` and `...DefaultIgnorables` move to the new location) |
| R50 | Reviewer never runs in the box the coding agent wrote to, so agent-written AGENTS.md can't reach it unframed | `:2367-2373`, `:2391-2394` | UNSPECIFIED; the one-run review step runs in the TODO machine | I39 (fixture: working copy contains injected `AGENTS.md`; review prompt must not contain it) |
| R51 | Verdict contract: first line exactly `approve` or `request-changes`, otherwise `failed: unread`; diff over 96 KiB is not reviewed and waits for a person | `mythicalReviewVerdict` `:756-773`, `:2344`, `:2375-2380` | KEEP verdict parse; `request-changes` effect and over-size handling UNSPECIFIED | U17 (existing `TestMythicalReviewVerdict`), I41 |
| R52 | Review re-runs per new head; a held/failed review is retried by a person with bounds lifted | `gate` `:2238-2268`, `RetryItem` `:2723-2740` | CHANGED: review is a step of every generation; a patch-id-equal rebase reuses the earlier summary (§10.4.3) | I13c (C-STK-06 step 6 check) |
| R53 | Review lane counts toward the lane cap and waits for a free lane | `:2362` | MOVED (T-MCH/T-STK-03 admission) | none here |

### 2.7 Failure, retry, bounds (today's recovery ladder)

| ID | Behavior today | Where | Disp | New test |
|---|---|---|---|---|
| R54 | Typed failure by fault class: factory spends an attempt; wait/infra/dependency are outages that spend none; user/policy/bug stop for a person; unregistered fault is an outage | `mythicalFailedOutcome` `:791-828` | KEEP the typing (`failure{step,class,message,retryable}`); who retries an outage UNSPECIFIED | U18 (table, today's `TestMythicalRunOutcomeReadsTheTypedFault`), gap 9 |
| R55 | A completed run with no readable domain output is a factory contract fault, not success | `:722` | KEEP | I19b = U18 row |
| R56 | Cancelled run stops the item and never relaunches | `mythicalCancelled` `:748`, `TestMythicalCancelledRunStopsTheTodo` | CHANGED: Drop cancels the run (attempt outcome `dropped`); Stop never cancels; an outside cancel of the run: UNSPECIFIED | I42, gap 22 |
| R57 | Replan ladder: up to 3 attempts, then "very hard" continuation (append only), then blocked | `mythicalRetry` `:1215-1253`, `:1753-1757` | UNSPECIFIED (spec has Retry only) | gap 9, test is a placeholder P-skip |
| R58 | Outage retry: backoff 2,4,8,16,32,60 min; 6 consecutive outages park the item, "not the TODO's fault" | `mythicalOutageRetry` `:1298-1318`, `mythicalOutageBound` `:75` | UNSPECIFIED | gap 9 |
| R59 | Launch bound: 12 launches per TODO, stops loud | `launchable` `:962-965`, `:74` | UNSPECIFIED; one run has one launch, but the candidate/edited loop has no bound (T-STK-12 risk) | I43 (loop bound) |
| R60 | Daily token budget fails closed (no declared budget, no launch) and reserves 60M tokens per run in flight | `launchable` `:967-1002`, `:81` | UNSPECIFIED; budget is checked at admission only, but a run lives days | I44 (budget at admission), gap 9 |
| R61 | Person-only Retry for typed stops; a run may retry only an untyped block; Retry past a bound resets the bounds | `RetryItem` `:2739-2749`, `resume` `:3453` | KEEP authority; bounds UNSPECIFIED | I45 |
| R62 | Retry keeps an open PR (push again to the same branch); a closed PR starts a new proposal round | `RetryItem` `:2765-2770`, `TestMythicalRetryKeepsAnOpenPullRequest` | KEEP | I46 |
| R63 | Retry overwrites attempt evidence today (`start` clears run ids `:1653`, `Attempt=0` `:2757`) | | CHANGED: attempt n kept, immutable (C-STK-03) | INV4, I28 |
| R64 | Resume (a person's retry after a stop) opens a fresh lane and replans, because outage retry alone reuses the lane | `reusesLane` comment `:1698-1703` | CHANGED: Resume continues the same run on the same working copy | I25 |
| R65 | Chat items (no issue) can't be retried by the stack; the author requests again from the workspace | `RetryItem` `:2751-2753`, `start` `:1621-1626` | CHANGED: chat TODOs are TODOs (§10.2.1) and retry normally | I47 |
| R66 | Placement before retiring the previous lane; a lane missing a declared tool stops with `policy: placement` | `start` `:1638-1646`, `placementToolsMissing` `:803` | MOVED (T-MCH) | seam: I48 (`failed{step:"start"}`) |
| R67 | Lane (machine) held from launch through proposal, retired when settled, and kept across waits | `mythicalHoldsLane` `:1008-1018`, `releaseLane` `:1182` | CHANGED: held until the TODO settles; released safe-idle when paused | I49 |
| R68 | Human take-over of the run is recorded and listed in the item's note | `mythicalDrivers` `mythical_git.go:299`, `:3383` | UNSPECIFIED | gap 24; I50 as placeholder |

R-count: 68 rows (R01-R68). By disposition, counting the first-listed label per row: 30 KEEP, 18 CHANGED, 6 MOVED, 13 UNSPECIFIED, 1 NEW (R26). Rows R15, R39, R50, R57-R60, R68 are wholly UNSPECIFIED; R51, R54, R56, R61 are KEEP or CHANGED with an UNSPECIFIED part. Sub-assertions tagged I03b, I06b, I09b, I13b, I13c, I19b live inside the named test and are not counted separately.

---------------------------------------------------------------------
## 3. Invariants as oracle tables

Notation: `A(n)` = `todo_attempts` row n of a TODO; `J` = engine journal attempt rows per `(run_id, step_key)`; `E` = `todo_events`; `W` = `outbound_writes`; `V` = `flow_versions`.

### INV1 One run id per attempt, admission to merge or drop

| Situation | Oracle | Expected |
|---|---|---|
| any sequence of signals (rebased, edited, steer, changes_requested), stop, resume, answer, host or PG restart | `select count(distinct run_id) from runs where binding = todo and attempt = n` | exactly 1 |
| Retry or Retry-with-current-flow | `count(todo_attempts)` | +1, new run id, old row untouched |
| any attempt | runs with `flow_id in ('coding/request','coding/vibe','coding/verify','review/change','coding/Request','coding/Vibe','coding/Verify')` bound to the TODO | 0 (U06, I01) |
| merged or dropped | run state; later admissions for the TODO | terminal, 0 later admissions (except the reopen rule below) |
| PR reopened within 7 days of drop (§10.7.4) | runs after reopen until first input | 0; first work input then creates attempt n+1 |
| `/review #n` on a PR, draft-version run | TODO runs created | 0 (`not_a_todo_run`) |

### INV2 Pinned flow digest never changes within an attempt

| Event | Oracle | Expected |
|---|---|---|
| Starting entered | `A(n).flow_digest` written once with the entering transition | equals `flow_activations` Active at that instant |
| flow D2 activated while A(n) runs, host restart, Resume, rebased, steer | digest on every run record and loaded closure blob hash | = A(n).flow_digest |
| the TODO's own branch edits `flows/todo/` or `pnpm-lock.yaml`, rebases onto such a change | closure restored from blob, no `lockfile_changed` | digest unchanged (C-J5-01 s8) |
| Retry | A(n+1).flow_digest | = A(n).flow_digest |
| Retry with current flow | A(n+1).flow_digest | = Active now; same TODO number; A(n) untouched |
| `todo` imports `review` flow; override of `review` merges mid-run | closure digest covers imported `review` (§11.3.0) | the run keeps the old `review` |

### INV3 Resume continues from the last finished step, re-running none

| Step state when Stop lands | After Resume | Oracle |
|---|---|---|
| finished steps s1..sk | not re-dispatched | `J` attempts for s1..sk = 1 each (counter rows keyed by run id and step, C-STK-03) |
| step in flight (model call) | finishes before `paused` (<= 60 s), then not repeated | J attempts = 1 unless the kill crossed it, then <= 2 for model calls only |
| step in flight is `check` | completes or re-runs once if declared idempotent | J attempts <= 2, one result in evidence |
| `stack.candidate` / `stack.propose` complete | not repeated; replay is idempotent (gap 4) | one generation row, one `W` row per key |
| parked in post-propose wait | Resume of a TODO that was stopped there | same wait continues; no steps re-run |
| state path | `paused -> queued -> starting -> working` | same run id; `run_attached` event before `working` |

### INV4 Retry starts a new attempt and keeps the earlier one's evidence

| Oracle | Expected |
|---|---|
| hash of A(n) row, its evidence rows, its `E` rows, its generations, its run id before and after Retry | identical |
| A(n+1).run_id | new; first step is `route` (starts from the first step, §4.1) |
| A(n+1) first message | the steer when given, else the TODO prompt revision |
| evidence tagged with attempt and generation | no entry of A(n) appears on A(n+1)'s PR evidence unless same patch-id (§10.4.3) |
| `E` for the Retry | one row, actor, `via` |
| Retry on a TODO whose PR is open | same PR updated, not a new PR (R62) |

### INV5 Steers are delivered exactly once, at the right boundary

Rulings of 2026-10-02 and spec §10.7.3. "Consumed" = the run recorded the steer's `seq` in its consumed-inputs list.

| TODO state at steer | Boundary | Delivered how | Settles anything | Oracle |
|---|---|---|---|---|
| queued | held; delivered when the run starts | first message of the run, before any model turn | no | steer seq in A(n).consumed, `delivered_at` < first model call timestamp |
| starting | held until the first step | as queued | no | same |
| working, in a step | next step boundary, or between agent turns inside implement (<= one model turn) | durable signal consumed once | no | `consumed` once; latency <= 1 model turn |
| working, in `check` or `review` | at the step boundary; `stack.propose` then refuses `stale_inputs`; run re-enters implement | consumed once | no | next generation `inputs_seq >= steer.seq` |
| needs_you (question) | at once, as context | consumed once, question stays open, agent may re-ask (same wait id) | no (G27) | wait unsettled; one consumption |
| needs_you (other wait) | same | context | no | |
| paused | on resume | consumed once, first thing after `run_attached` | no | not delivered while paused; delivered once after |
| failed | is Retry with that steer | new attempt, steer first message | creates attempt | A(n+1) |
| in_review | moves the TODO to working; run re-enters implement | consumed once | no | state `working` |
| merged, dropped | refused `todo_closed` | none | none | no `E` row, no consumption, API code `todo_closed` |
| merged under the merge fence | committed and held; delivered when the fence clears | (§10.6.2b) | no | exactly once or recorded undelivered |
| across any crash or replay | | consumed set has the steer once; model sees it once | | duplicate delivery count = 0 |

### INV6 Crash at each step boundary: resume, or interrupted with Retry

Kill points (the fault suite, section 4). "Next" is what must be true after restart.

| K | Point | Process killed | Next |
|---|---|---|---|
| K1 | `route` finished, projection not committed | CH | resumes; route not re-asked (Jev call counted) |
| K2 | `plan` finished, before result journaled | CH, BE | resumes at `implement`; plan not re-run |
| K3 | mid model call in `implement` | CH, BE, PG | model call re-issued at most once |
| K4 | between agent turns with a steer pending | CH | steer consumed once |
| K5 | `implement` done, before `stack.candidate` called | CH | proceeds to candidate |
| K6 | inside `stack.candidate`, after snapshot, before generation write (test hook) | BE | no half generation; next generation has the snapshot tree |
| K7 | after generation write and pin, before step result journaled | BE, CH | replay answers the same generation (no second commit, no second pin) |
| K8 | mid `check` command | CH (run), machine | check re-runs once (idempotent declared) or `interrupted` with Retry |
| K9 | `check` passed, before `review` starts | CH | review runs once |
| K10 | mid `review` | CH | review re-runs once or `interrupted` |
| K11 | `review` done, before `stack.propose` | CH | propose called once |
| K12 | inside `stack.propose` after second capture, before accept write | BE | refusal or accept, never half |
| K13 | accepted, `pending_op` recorded, before push | BE, PG | restart settles via `ls-remote`: push happens once |
| K14 | after push, before PR open (ticket) | BE, host | PR opened exactly once; the run resumes waiting |
| K15 | after PR open, before `in_review` projection | BE | TODO shows in_review only after the event; no second PR |
| K16 | post-propose wait, signal committed but not delivered | BE, CH | delivered once after restart |
| K17 | signal delivered, before `candidate` re-entry | CH | one re-entry |
| K18 | Stop sent, before the `paused` wait opens | BE, CH | Stop not lost; `paused` appears only after wait-opened (§19.3) |
| K19 | while `paused` | whole install | still paused, same wait id, machine released |
| K20 | Resume sent, before `run_attached` | BE, CH | continues from next unfinished step |
| K21 | `merged` signal committed, run not yet ended | BE | run ends terminal; no relaunch |
| K22 | machine killed (not the host) at K8 or K3 | machine | `failed{step,class infra,retryable}` or resumes; never stuck `working` > 5 min |
| K23 | drop while inside `stack.propose` PR write (gap 22) | BE | one of: PR closed and run cancelled, or write reconciled; never an open PR on a dropped TODO |

Pass for every K: each finished step has exactly one attempt row; the run reaches in_review or shows `interrupted` with Retry within 5 min; no state shown before its `E` row; no duplicate `W` key effect; one recovery receipt per reconciled step or write (G33).

### INV7 `stack.propose` (and `stack.candidate`) as system operations

Where it lives: packaged, never overridable, registered `reserved` (M-30). The composition has a reserved step that calls the engine; a repository `flows/todo/flow.ts` imports steps but the engine, not the flow, decides acceptance.

`stack.propose` MAY:

| Effect | Condition | Recorded as |
|---|---|---|
| second capture of the working copy (read-only snapshot) | any call | generation capture row |
| accept or refuse a generation | five rules of §10.4.4 | refusal reason `stale_generation`, `edited`, `stale_inputs`, `rebase_pending`; nothing recorded on refusal |
| set `candidate_verified`, `pr_head`, `pending_op`; set todo state `in_review` | accepted only | one `E` row, same tx |
| write the PR head commit (tree T on `main` tip), pin it | accepted only | ref `refs/smithers/keep/<sha>` |
| push `smithers/<slug>` with lease | accepted only, after the `W` row commits | `W` kind `push`, key = intended head |
| open or update the PR; update body; mark ready or draft | accepted only | `W` rows with keys per §12.4.1 |
| wait while a merge fence is set | `todos.merging` set | resumes when the fence clears |
| signal the run the outcome | always | |

`stack.propose` MAY NOT:

| Forbidden | Test |
|---|---|
| merge, close, label, or comment on an issue | I37, I51 |
| push anything but its own `smithers/<slug>` or write `main` / the mythical bookmark | I37 |
| write or rewrite the working copy or its history | I11 (working-copy op log unchanged) |
| run checks, models, or agents | I51 |
| write to GitHub on refusal or on a stale replay | I13, F16 |
| run for a run that is not the TODO's current attempt, or for a draft-version run (`not_a_todo_run`) | I15, I52 |
| be skipped, replaced, or reordered by an override; or be callable by a member, an agent shell, or a CLI as a free-standing action | U03, I14 |
| accept evidence that does not name g | U14 |
| accept twice for one decision (one `W` key, one effect) | F19, P3 |
| exceed its effects when the host restarts mid-way | F16-F21 |

`stack.candidate` MAY: jj snapshot in the workspace, fetch/push the snapshot commit to the host store, write one commit C (tree T, parent prefix head), pin it, record generation g, set `rebase_pending{onto}`, void earlier verification. MAY NOT: touch GitHub, run checks, rewrite working-copy history, create a second commit for one generation, record a generation when `rebase_pending` or when the prefix head is not an ancestor (it refuses `rebase_pending`).

### INV8 Generation and tree (from C-STK-06)

| Oracle | Expected |
|---|---|
| for every accepted g: tree of check line in `check-trees.log`, tree of `pr_head`, `base..head` read by review | equal to g.tree |
| every recorded head resolves through `refs/smithers/keep/<head>` | same tree at end |
| a steer committed before propose | in the proposed change |
| at most one generation `candidate_verified` per TODO at any time | true |

### INV9 Signals

| Oracle | Expected |
|---|---|
| each signal (rebased, edited, steer, changes_requested, merged, dropped, pause, resume) | consumed once or superseded visibly, never lost across restart |
| two signals pending at once (rebased + edited; steer + rebased) | one deterministic path (gap 5); the model-based property asserts the path equals the reference |
| signal to a run that isn't waiting | queued durably, applied at the next boundary |

### INV10 Honest projection (§19.3, P1)

State on the card follows an `E` row; `current_step` within 1 s of the runtime event; `paused` only after wait-opened; `in_review` only after PR open.

---------------------------------------------------------------------
## 4. Test list by layer

IDs are stable. Paths: Go tests in `packages/backend/internal/services/`, flows in `flows/test/`, faults in `packages/smithers/test/faults/host/`.

### 4.1 Unit (19)

| ID | Test | Assert |
|---|---|---|
| U01 | composition graph | steps and edges equal route, plan, implement, candidate, check, review, propose with the §10.4.1 loop edges (the ticket's unit test); no other node |
| U02 | step exports | each step flow comes from a `flows/coding/` export; the file has no second node or graph model (AGENTS.md "Flow layering"); about 60 lines |
| U03 | reserved steps | `stack.candidate` and `stack.propose` are `reserved`; `todo` is overridable; an override fixture without `propose` is rejected at load or ends `no_proposal` (per gap 6) |
| U04 | catalog | the four Replaced tags have no registration in the host flow runtime registry nor the coding host registry (C-CAT-01 s8); both registries built twice |
| U05 | `/review` | slash `/review` resolves to the overridable `review` flow, not `review/change` (C-J10-09) |
| U06 | grep guard | no source or fixture under `flows/`, `packages/backend`, `apps/app` launches `coding/request|vibe|verify` or `review/change`; `RequestRunID`, `VibeRunID`, `VerifyRunID` absent from Go, RPC schemas, SQL |
| U07 | phase projection | each step id maps to the item phase and `current_step` (table of 7 steps plus wait) |
| U08 | admission key | `<todo>:<attempt>` is stable for replay and differs per attempt |
| U09 | stale projection | an event for attempt n after attempt n+1 admitted changes nothing; first outcome wins |
| U10 | prompt | revision 1 + steers + acceptance + issue context framed untrusted with author; caps 24 KiB and 48 KiB; no live issue text |
| U11 | route feedback | `leafFeedback` text per route (implement, bug, feature, close) |
| U12 | PR head determinism | same tree, main tip, summary, `CreatedAt` give the same sha; one differing input gives a different sha |
| U13 | closing keywords | `close(s|d)`, `fix(es|ed)`, `resolve(s|d)` with `#n`, `org/repo#n`, issue URL are rewritten to `Refs`; title cap 250 |
| U14 | propose acceptance table | each of the five rules fails alone with its reason and no write; evidence naming another g is refused (shared with T-STK-12 U) |
| U15 | receipts | bound 200 keeps the latest; only receipts that measure the candidate head are shown; generation tag required |
| U16 | untrusted escaping | all tag spellings and default-ignorables (ported from today's tests) |
| U17 | verdict parse | first line `approve` / `request-changes` only; quoted "approve" later in text can't flip |
| U18 | outcome typing | failed-run table: declined, factory, user, policy, bug, wait, infra, dependency, unregistered, placement; completed-without-output is a contract fault |
| U19 | steer disposition table | every TODO state x steer gives the INV5 row, including `todo_closed` |

### 4.2 Integration, real PostgreSQL, real flow host, fake GitHub (53)

Files: `todo_run_db_test.go`, `todo_candidate_flow_db_test.go` (C-STK-06), `todo_control_db_test.go` (C-STK-03), `todo_flow_pin_db_test.go` (C-J5-01 parts).

| ID | Test | Assert |
|---|---|---|
| I01 | TODO end to end | one run id from admission to merge; zero launches of the four old flows; `E` rows per transition |
| I02 | double admission | two workers and a lost lease admit one run; replayed admission no-op |
| I03 | rebase loop | `rebased` re-enters `candidate`, check re-runs, propose again, same run id; affected check receives `base..head` paths |
| I04 | run id surfaces | API `runs` carries one id per attempt; completion comment names it; Inspect link works |
| I05 | route variants | each of the four routes; route recorded on failure too |
| I06 | decline raises a wait | planner decline is `needs_you{question}`, run waits, answer continues; plan approval `always/never/timeout` |
| I07 | plan checks | plan's checks reach `check` and are the ones run |
| I08 | no checks | none detected runs build-only; evidence says "no checks detected" |
| I09 | merged and dropped end the run | `merged` signal and `dropped` signal end the same run; no later admission; waits settled |
| I10 | C-STK-06 part A | edit during check refused `edited`; run re-enters candidate on same run id |
| I11 | C-STK-06 part B | edit during capture; next generation has it; working-copy op log unchanged by the engine |
| I12 | C-STK-06 part C | steer during check refused `stale_inputs`; re-enters implement with steer first |
| I13 | C-STK-06 part D | main move during check `rebase_pending`; replay `stale_generation`, no GitHub write; review reused by patch-id |
| I14 | system-op binding | candidate/propose accepted only from the run bound to the TODO's current attempt; refused for a member, an agent shell, another TODO's run |
| I15 | stale attempt | result from attempt n's run after Retry refused; replay with same tree idempotent |
| I16 | correction rounds | check fails twice then passes: one run, corrections inside, no finished step re-run; fails past the limit: `failed` with step |
| I17 | one commit | working-copy history after the run has no engine-written rewrite; C is the item's one commit with the prefix head as parent |
| I18 | agent `ask` | question wait opens mid-implement; answer continues; stop refused while open |
| I19 | check fault classes | infra-fault receipt does not fail the plan; factory fault does |
| I20 | digest pin at Starting | A pins D1 |
| I21 | activation mid-run | D2 activates; A continues on D1; C pins D2 |
| I22 | lockfile change | A adds a dev dependency; Resume and Retry restore D1 from blob |
| I23 | retry-current-flow | pins Active D2; same TODO number; one event |
| I24 | stop | `working(stop requested)` then `paused` only after wait-opened; run waiting not cancelled; lane released |
| I25 | resume | `paused, queued, starting, working`, same run id; counters s1,s2 = 1; s3 continues |
| I26 | failure | `failed{step,class,message,retryable}` |
| I27 | retry with steer | steer is first message; before first model turn |
| I28 | attempts | two `todo_attempts` rows; attempt 1 hash unchanged; late events of attempt 1 ignored |
| I29 | `E` rows | every transition has a row with actor |
| I30 | `/review` independence | `/review` creates no TODO, no stack item, no write to GitHub (C-J10-09 seam) |
| I31 | prefix start | the run's first generation base is the available prefix head |
| I32 | conflict seam | rebase conflict raises `needs_you{conflict}` on the same run |
| I33 | outsider work | outsider-started candidate touching protected paths is refused as policy stop (R39) |
| I34 | evidence tags | each entry carries generation; PR body shows only the accepted one |
| I35 | PR exists | existing PR for branch is updated, not recreated |
| I36 | foreign push seam | outside push to `smithers/<slug>` raises `foreign_push`; run not advanced |
| I37 | GitHub write log | writes come only from system ops; no merge, no close, no label from the run |
| I38 | review read-only | write and exec attempts in review fail; reads `base..C` only |
| I39 | review isolation | planted `AGENTS.md` in working copy absent from review prompt |
| I40 | steer queued | held; first message once |
| I41 | review verdict effect | `request-changes` and over-96 KiB behavior per gap 8 ruling |
| I42 | drop | Drop cancels the run, outcome `dropped`; Stop never cancels |
| I43 | loop bound | a check that rewrites tracked files forces `edited` each time; run stops with a typed fault at the bound (gap 10) |
| I44 | budget | no declared budget: not admitted, reason shown; budget spent: stays queued (gap 9) |
| I45 | retry authority | Retry for typed stop needs a person; run may retry only untyped |
| I46 | retry keeps PR | open PR kept and updated; closed PR starts a new proposal round |
| I47 | chat TODO | chat TODO retries normally |
| I48 | start failure | machine or host start failure `failed{step:"start"}` with Retry (G28) |
| I49 | machine hold | machine kept across the post-propose wait, released on merge/drop and safe-idle on pause |
| I50 | take-over | human take-over recorded (placeholder, gap 24) |
| I51 | no model or check in `propose` | propose performs no run, no agent call |
| I52 | draft-version run | `todo` run with no TODO ends before propose with `not_a_todo_run`, no GitHub write |
| I53 | steer dispositions | steers: starting, needs_you(question), needs_you(other), paused, failed (becomes Retry), in_review, merged/dropped (`todo_closed`), queued; exactly-once each |

I-count by ID range: I01-I53 = 53. Steer rows I40 and I53 overlap on queued; keep both (I40 asserts timestamp ordering before first model call).

### 4.3 Fault, kill points (36)

Harness: real backend, CH, PG, fake GitHub, recorded model provider, launcher supervisor (as C-DUR-01). Each test kills, restarts, then checks INV3, INV6 pass line. Files: `case41-todo-run-kill-points.test.ts` and `todo_run_fault_db_test.go`.

| ID | Kill |
|---|---|
| F01 | queued TODO, BE restart: launches once |
| F02 | between attempt row commit and admission ack: one run |
| F03 | K1 |
| F04 | K2 |
| F05 | K3 x CH |
| F06 | K3 x BE |
| F07 | K3 x PG |
| F08 | K4 |
| F09 | K5 |
| F10 | K6 |
| F11 | K7 |
| F12 | K8 x CH |
| F13 | K9 |
| F14 | K10 |
| F15 | K11 |
| F16 | K12 |
| F17 | K13 x BE |
| F18 | K13 x PG |
| F19 | K14 (ticket) x BE: PR opened once |
| F20 | K14 x host+PG: PR opened once, outbound key reused |
| F21 | K15 |
| F22 | K16 |
| F23 | K17 |
| F24 | K18 |
| F25 | K19 |
| F26 | K20 |
| F27 | K21 |
| F28 | K22 (machine kill) at K8 |
| F29 | K22 at K3 |
| F30 | 50 waiting runs: restart host, then signal each (steer for 25, rebased for 25): all resume on the signal, zero GitHub reads while waiting, resume latency recorded |
| F31 | K23 drop during PR write |
| F32 | PG outage during signal commit: signal not lost, not duplicated |
| F33 | GitHub 5xx / timeout on PR open: row `unknown`, reconcile finds or repeats once (C-GH-09 seam) |
| F34 | each reconciled step writes one recovery receipt (G33) |
| F35 | upgrade with an in-flight old-shape item (gap 11): resumes under the new run or is shown interrupted with Retry; old run ids remain readable |
| F36 | stop persisted across restart (Stop lost = fail) |

### 4.4 Property (5)

Model-based, Go, real PostgreSQL, seeded generator, counterexamples saved to `testdata/todo_run_counterexamples/` and replayed in CI. 200 sequences of length 3-40 per CI run, 5,000 nightly. File: `todo_run_property_db_test.go`.

| ID | Property |
|---|---|
| P1 | main: a random sequence of {place, admit, stop, resume, steer(state-aware text), retry, retry-current-flow, crash(K1-K23, process), answer(first, second concurrently), rebase signal, outside edit, main move, PR merged on GitHub, PR closed, flow activation D2, seeded check failure, drop, reopen} over one TODO. After every step: INV1 (one run id per attempt), INV2 (digest constant per attempt), INV3, INV4 (earlier attempts hash-stable), INV5 (each steer consumed once at its boundary, refused with `todo_closed` when closed), INV6 (resume or interrupted+Retry), INV8, INV9, INV10; only §4.1 table edges occur; merged absorbing; dropped leaves only by reopen <= 7 days |
| P2 | extends QA P16: random `main` commits with valid and invalid flow versions while runs live: pinned runs never change digest; Active never empty |
| P3 | extends QA P11: random kill points x all outbound kinds during propose: at most one effect per key, every repeat preceded by its lookup |
| P4 | signal interleavings: random permutations of simultaneously pending signals reach the reference model's single path (gap 5) |
| P5 | steer fuzz: random steer text and timing against random states: exactly-once and boundary (INV5), no steer settles a wait |

### 4.5 Counts

| Layer | Count |
|---|---|
| Unit | 19 |
| Integration | 53 |
| Fault | 36 |
| Property | 5 |
| Total | 113 |

Gate before the lane starts: U01, U04, U06 (these fail on today's tree, so they are the red tracer); I01 with a fixture flow of four steps (copy of C-STK-03 fixture); I24-I28 next. Everything else in section 2 must be green before the falsifier is called.

---------------------------------------------------------------------
## 5. Spec gaps for the tech lead

1. Steer to `failed`: §10.7.3 doesn't say it is Retry with that steer (today's ruling); neither does it list the `todo_closed` code for merged and dropped. Add both.
2. Steer to `starting` after a Resume: "delivered when its run starts" is wrong for a resumed run that already ran steps; define "first step" as the next step boundary after `run_attached`.
3. Stop in the post-propose wait (state `in_review`) and while a system op runs: §4.1 only lists `working -> paused`. Define both.
4. A replayed `stack.propose{g}` after g was accepted (kill at K13-K15): §10.4.4 refuses a non-current g but says nothing for an accepted current g. Define idempotent success, not `stale_generation`.
5. Signal contract: ordering, coalescing and precedence when `rebased`, `edited` and `steer` are pending together; §10.4.1 lists single-event paths only. `changes_requested` appears in the ticket and diagram but §10.4.4 treats a review comment as a steer; pick one.
6. An override of `todo` that never calls `candidate` or `propose`: "an override can't skip them" has no mechanism stated (load rejection, or the engine ends the run `no_proposal`).
7. Where the system ops run: the ticket says "host flow runtime", §10.4.1 says the run executes on the branch machine, §11.1.2 says overridable flows run in a machine. State how a coding-host run reaches the engine and what binds run id to TODO and attempt (R11).
8. Review: today it runs on a fresh lane with only the framed diff so agent-written `AGENTS.md` can't reach it (`:2367-2373`); the one-run `review` step runs in the TODO machine. Also `request-changes` and the 96 KiB cap have no stated effect.
9. Today's bounds are absent from the spec: 12-launch bound, 6-outage park with backoff, replan ladder and "very hard", daily token budget with 60M-per-run reserve, protected paths for outsiders. Delete or keep, per row R54-R61, R39. A budget checked only at admission cannot bound a run that lives for days.
10. No bound on the candidate, check, propose loop: a formatter check forces `edited` forever (T-STK-12 risk names it but sets no policy).
11. Upgrade: in-flight items with `request_run_id`, `vibe_run_id`, `verify_run_id` at the moment the new build starts. Spec §21.1 requires old records to decode; say whether they finish under the old path, restart as a new attempt, or show interrupted.
12. `attempt` meaning: today it is the replan counter (max 3, `:50`); `todo_attempts` is a user-visible attempt. State that the old counter is gone and what `launches` becomes.
13. Correction rounds: default 3 and cap 8 live in the request payload (`:1673`, `request.ts`); §11.2 `flow_config` doesn't name them.
14. Steer to a TODO blocked on `ask`: "reaches the agent as context" needs a delivery point (the agent is not between turns); define it, and exactly-once when the answer arrives at the same moment.
15. Dropped TODO: `todo_closed` for steers contradicts §10.7.4 ("the first input that needs work starts a new attempt") only after reopen; say a steer to `dropped` is refused and to the reopened `in_review` is accepted.
16. No observable event named for "first step started" or "first model turn"; the steer timing oracles need one in `E` or the run record.
17. T-FLW-11 asserts the digest pin (C-J5-01) but depends only on T-FLW-01, T-STK-01, T-MCH-14, T-STK-12; pin recording is T-FLW-03/04. State the stub the lane may use, or add the dependency.
18. Run-terminal outputs of `todo` (merged versus dropped) and the `current_step` value during the post-propose wait are not defined.
19. 50 waiting runs: no budget for restart-to-resume latency or idle cost; C-PERF has none for it.
20. Rebase result with no checks: today replans (`:1856`); §11.2 says build-only. Confirm the build-only rule applies after rebase too.
21. External cancel of a TODO's run (`smthrs runs cancel`) outside Stop and Drop: failed, paused, or dropped? Today it stops the item (`mythicalCancelled`).
22. Drop concurrent with an in-flight outbound write (PR open or push): order of cancel, fence, and `W` reconcile (§10.7.2 vs §12.4.1a).
23. Replay of `stack.candidate` with an unchanged tree: same generation or a new one? Today `SubmitLane` replays idempotently (`:517`); T-STK-12 doesn't say.
24. Human take-over (`mythicalDrivers`, recorded in the item's note) has no home in the spec; delete or keep.
