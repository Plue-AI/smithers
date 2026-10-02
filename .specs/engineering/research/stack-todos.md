# Stack, TODOs, coding flow — current state (main, 2026-10-02)

Paths are relative to /Users/williamcory/smithers. "Svc" = packages/backend/internal/services, "Rte" = packages/backend/internal/routes. Inferences are marked "inferred".

## Summary

- The Mythical stack service is real and large (17.9k Go lines non-test). It is a per-repository worker that owns `refs/heads/mythical` and a `mythical_items` table of "items" (one per GitHub issue or chat result). It never writes `main`.
- A TODO today is a GitHub issue plus a `mythical_items` row. Prompt = pinned issue title/body (`issue_body`). There is no TODO table, no prompt column that is separate from the issue, no amendment history, no user-chosen position.
- Order today is not user-controlled: items advance sorted by issue number (chat first) (Svc/mythical_items.go:1113-1123). Items integrate serially onto the stack tip; PR base is the default bookmark (`main`) (mythical_items.go:2095), not the previous item. "Merges after #n", Move up/down, Drop, Before #n, Amend #n do not exist as user operations. "Amend/insert" exist only as the planner's edits to existing stack changes (mythical_items.go:866-920), and a candidate that does so is re-run, not rebased (mythical_git.go:529-539).
- Merge is gated by label/Land authorization + green CI + review approve + head match (mythical_items.go:2440-2535), via GitHub PR merge. D-23 approval gating lives in the separate plue landing path (Svc/landing.go:1697), not in the Mythical path.
- States are one 15-value enum (migration 0053). Needs you / Paused / Failed / In review are not states; `StackIssues.ts` buckets them into 3 groups (needs-you/working/done) and puts `proposed` under needs-you.
- Steering exists for the planning boundaries of `coding/request` only (flows/coding/steering.ts); implementation waits for the next boundary. No steer route from a stack item to its lane run. `runs.steer` works on any run id through the workspace gateway.
- Rebase on main move: fold of main into the stack, then a candidate not on the tip is rebased; conflict => `retrying` with `integration.conflict.paths`, re-plan on the new tip, up to 3 attempts, then `blocked`. No "Needs you / Resolve" for a conflict; no checkpoint/present-person scheduling.
- Learning: `improve.mine` is only a name in factory rules (no flow in `flows/`). Failed review rounds write pending notes (flows/coding/learnings.ts). Wiki refresh after fold exists (mythical_wikis).

## Inventory

| Component | Path:line | What it does today | Spec row it serves |
| --- | --- | --- | --- |
| Stack row + worker claim | packages/backend/db/product/migrations/0026_mythical_stacks.sql:11-39 | `mythical_stacks`: state bootstrapping/active/frozen, `max_parallel` default 2 (1..8), tip/landed_main, generation/requested/processed/claim/lease, `pending_op` | §6.6 Parallel work, M-07 |
| Stack changes | 0026:46-58 | `mythical_changes(repository_id, position, change_id, commit_id, title, kind bootstrap/fold/item, item_id, issue_number)`; position = order of git history | §3 Stack |
| Items | 0026:64-122 | `mythical_items`: issue_*, `issue_body` (pinned prompt), `approved_digest`, `source` issue/chat, `state` enum, `lane`, `workspace_id`, `candidate_base/head/verified`, `request/vibe/verify_run_id`, outcomes, `plan`, `integration`, `checks` jsonb, `pr_*`, `attempt`, `proposal_round`, `version` (optimistic lock) | §3 TODO, §6.6 |
| Lanes | 0026:128-140 | `mythical_lanes(workspace_id, item_id, name, retired_at)` binds provisioned lane workspaces | §6.6 Parallel work |
| Later columns | 0029 (`lane_started_at`), 0053 (state `declined`), 0036 (`mythical_wikis`), 0081 (`factory_state/error`) | | §6.12 Learning (wiki), §6.9 |
| Worker loop | Svc/mythical.go:142 `Start`, :163 `PollOnce`, :224 `runClaimed`, :335 `run`, :593 `fold` | One claim per repo; poll 3s, sweep 5m, lease 10m (mythical.go:24-35) | §4.2 Rebase |
| Main moved hook | Svc/mythical.go:125 `MainMoved`; wired internal/compose/main.go:902 `SetMainMoved` | Bumps requested_generation so the next claim folds main | §4.2 Rebase |
| Item advance | Svc/mythical_items.go:1061 `advanceItems`; :1038 `slot`; :1050 `freeLane`; :3506 `mythicalLaunchSlot` | Per pass: sort (chat first, then issue number), launch into free lane under cap (one lane reserved for chat when max>1), max 4 launches/pass | §6.6 Parallel work |
| Admission from GitHub | mythical_items.go:165 `ObserveIssue`, :300 `Backfill`, :2827 `ObserveGitHubEvent`; label consts :64-65 (`todo`, `automerge`) | Issue becomes a TODO when a maintainer person applies `todo`; digest pinned; edit after approval needs re-approval | J2 step 2, M-16 |
| File a TODO | Svc/mythical_file_todo.go:45 `FileTodo`; Rte POST `/mythical/todos` | Creates a GitHub issue as the App, labels `todo`, admits it; idempotent via `request` id; title <=256 runes, body <= 24 KiB | §6.6 Create (chat) |
| Chat items | mythical_items.go:443 `SubmitLane` via Rte `PUT /mythical/lanes` (handler `Lanes`, Rte/mythical.go:223) | Workspace hands a validated result to the stack with no issue (`source=chat`, unique on candidate_head) | §6.6 Create (chat; "chat items exist") |
| Run projection | mythical_items.go:577 `ProjectFlowRuntime` | Records request/vibe/verify run outcomes onto the item (version-checked, generation-qualified) | §6.6 TODO card (steps) |
| Integrate/rebase | mythical_items.go:1815-1880 `integrate`; mythical_git.go:493-539 `rebaseCandidate` | Fast-forward if candidate base == tip, else rebase and re-verify; conflict -> retry with feedback; rewrite -> re-plan | §4.2 Rebase |
| Open PR | mythical_items.go:2080-2110 `openPull`; mythical_github.go:283 | One PR per item, head `smithers/...` branch, base = default bookmark | §4.2 Merging, §6.10 |
| Review | mythical_items.go:2275 `mythicalReviewFlow = "review/change"`; verdict at :2260-2269 | Read-only review of proposed head; approve + automerge => merge step | §6.10 PR card |
| Merge gate | mythical_items.go:2440-2535 | CI green (6h wait bound, :3435), PR head == reviewed head, `automerge` label by maintainer person or Land record, still a TODO, version unchanged, then GitHub merge | §6.10 Merge, D-23 (partial) |
| Land | Svc/mythical_land_todo.go:44 `LandTodo`; Rte POST `/mythical/items/{id}/land`; app `history.land` | Applies `automerge` label as the App for a maintainer, records `{by, account, head}`; never merges itself | §6.10 Merge |
| Retry | mythical_items.go:2708 `RetryItem`; Rte POST `/mythical/items/{id}/retry`; app `history.retry` (userOnly) | Fresh attempts for blocked/rejected/declined or review-held | §4.1 Failed -> Retry |
| Lane cap | mythical_items.go:2686 `SetMaxParallel`; Rte PUT `/mythical/config`; app `history.parallel` | 1..8 | §6.6 Parallel work |
| Bootstrap/Backfill | mythical.go:109 `RequestBootstrap`; Rte POST `/mythical/bootstrap`, `/mythical/backfill` | Create history from main commits; admit all open issues | n/a |
| Read API | Svc/mythical_view.go:261 `Snapshot`; mythical_item_read.go:19 `Item`; Rte GET `/mythical`, `/mythical/items/{ref}`, SSE `/mythical/events` (internal/compose/router.go:718, 1113-1125) | Stack snapshot; `MythicalItemView.DependsOn` always `[]` (mythical_view.go:454) | §6.6 TODO card |
| Wiki on fold | Svc/mythical_wiki.go; Rte POST `/mythical/wiki` | Refreshes wiki after each fold, publishes verified pages | §6.11, §6.12 |
| Wire schema + state words | packages/rpc/src/Mythical.ts:197 (enum), StackView.ts:25-85, StackIssues.ts:30-70 | `itemStateLabel`, `retryable`, `landable`, groups needs-you/working/done | §4.1 states (projection) |
| StackCard | apps/app/src/mainview/cards/StackCard.tsx (482 lines); seam apps/app/src/mainview/state/seams/StackSeam.ts (950) | History card: groups, lanes, wiki, TODO toast tracking; `landStackItem` :613 | §6.6 TODO card, J4 home |
| `history.*` commands | apps/app/src/mainview/flows/entries/history.ts:29 show, :38 view (issues\|metrics), :53 bootstrap, :65 backfill, :77 parallel, :87 todo (confirm), :102 retry (userOnly), :120 land (userOnly) | `show` embeds StackCard; `todo` -> `fileTodo` -> POST todos then follows the item to PR/landed/stopped | App. A |
| `change.land` / `change.diff` | entries/change.ts:62 diff, :76 land; seam ChangeSeam.ts:1347-1364 | Operates on plue landing requests (1 -> N stack), NOT Mythical items | §6.10 (different path) |
| `runs.steer` | entries/runs.ts:136; controller/runs.ts:657 `steerRun` -> `gateway.steer` :650 | Sends a Message steer to a run id via workspace gateway | §6.6 Steer (needs item -> run mapping) |
| `runs.resume` | entries/runs.ts:88; controller/runs.ts:533 | `gateway.resume` of a parked run; no stack item involvement | §6.6 Stop and resume |
| `flow.run.stop` | entries/flow.ts:87; controller/workflow-pump.ts:591 | Cancels the run (or denies the runaway guard); hidden, confirm | §6.6 Stop |
| `approval.approve` | entries/approval.ts:16; turns.ts:1114 `decideApproval` | userOnly; decides a chat approval card | §4.1 Needs you |
| TODO flow head | flows/coding/todo.ts:78 `factory/Todo` (Jev routes implement/bug/feature/close; :61 `leafFeedback`) | Route once, then plan through `coding/Request` | §6.9 route |
| Request flow | flows/coding/request/flow.ts:158 `coding/Request`; registration flows/coding/request.ts (+ preparation.ts, planning.ts, planning-memory.ts) | Stack request: `admitStackBase` -> install dependency pages -> `Todo` -> `PrepareRequest` -> `AdmitSource` -> `Coordinate` (implement atoms, checks, correction rounds) | §6.9 plan, implement, check |
| Vibe flow | flows/coding/vibe/flow.ts:13 `coding/Vibe` = AdmitVibe -> CleanVibeHistory -> LandVibe | Clean history, deliver one commit / PR | §6.9 open PR |
| Verify flow | flows/coding/verify/flow.ts:16 `coding/Verify` | Re-run checks on rebased candidate | §6.9 check |
| Host config | flows/coding/project-config.md:7-13 | Host reads `<root>/.smithers/coding-project.json` or `SMITHERS_CODING_PROJECT`; absent => only manual plan route; invalid => refuses startup. Keys: wiki, implementation, checks[], historyLimit, maxMemoryBytes, landing, seats | §6.9 Status, §11.10 |
| Steering | flows/coding/steering.ts:1-60, steering.md | `ReceiveFeedback` at boundaries `after-poc`, `before-implementation`, `after-correction`; Message steers admitted only for active `coding/request` runs; closed after the empty final receipt | §6.6 Steer |
| Learnings | flows/coding/learnings.ts:1-64 | Changes-requested review round -> pending note (`status: pending`); only accepted notes reach planning (max 20) | §6.12 Learning (partial) |
| `improve.mine` | packages/rpc/test/FactoryProjection.test.ts:86; packages/smithers/build/targets/test/Factory.test.ts:120; flows/pack.test.mjs:490 | Only appears in factory rule fixtures: `change.landed -> wiki, history.fold, improve.mine`. No `flows/improve*`. | §6.12 Learning (Missing) |

## State mapping

Today: `mythical_items.state` (migration 0053): queued, skipped, declined, cancelled, running, delivering, integrating, verifying, proposing, waiting, proposed, landed, rejected, retrying, blocked. Computed in the worker (`advanceItems`/`step.advance`), written with version check; projected to the wire by `mythicalItemView` (Svc/mythical_view.go:~440) and `StackView.ts`/`StackIssues.ts`.

| Spec state | Today | Gap |
| --- | --- | --- |
| Queued | `queued` (also `retrying` backoff, `waiting` = verified, awaiting main). Reason string only; no position, no "waiting for a machine #2" | position missing |
| Working | `running` (plan+implement), `delivering` (vibe), `integrating`, `verifying`, `proposing`, `waiting`, `retrying` (`ACTIVE_ITEM_STATES`, StackView.ts:25) | OK (inferred: conflict retry shows as `conflict` word, StackView.ts:~54) |
| Needs you | None as a state. UI group "needs-you" = `blocked`, `rejected`, `proposed` (StackIssues.ts:~47). `declined` = planner asked up to 3 questions (todo.ts:61). No mid-run question, no conflict-needs-human | agent question/approval/conflict not modeled; `proposed` is misgrouped vs spec (In review) |
| Paused | None. No pause field; Stop = cancel the run via `flow.run.stop`, not tied to the item. Bound-stopped TODOs sit `blocked` until a maintainer re-applies `todo` (mythical_items.go:247-258) | missing |
| Failed | `blocked` (after 3 attempts, 12 launches, 6 outages) with typed `failure` (mythical_failure.go kinds: provisioning, runtime, model, checks, plan, landing, review, stopped) | OK; earlier attempts kept? `attempt` counter only, run ids overwritten per attempt (inferred) |
| In review | `proposed` (PR open) | maps 1:1; evidence pieces partial |
| Merged | `landed` (PR merged commit recorded, `pr_merge_commit`) | OK |
| Dropped | `cancelled` (issue closed or `todo` removed, mythical_items.go:133, 251); `skipped` = not a TODO yet; `rejected` = PR closed | no person "Drop" action; PR close on drop not implemented as a command |

## Gaps vs mvp.md

| # | Spec ref | Missing | Where the change goes | Size |
| --- | --- | --- | --- | --- |
| 1 | M-16, §6.6 Create, §11.7 | First-class TODO: own prompt, id, link to issue, amendment history. Today the prompt is `issue_body`, items are keyed by issue number (`mythical_items_issue_idx`), and a chat item has no prompt text. Needs `mythical_todos` (id, repo, prompt, acceptance, issue_number/issue_revision nullable, created_by, state-independent) + `mythical_todo_revisions` (todo_id, rev, prompt, author, at, reason) and `mythical_items.todo_id`. Run reads `todo.prompt` at the current revision. Existing issue-digest pin becomes the issue_revision link | migration after 0081; Svc/mythical_items.go ObserveIssue/FileTodo/Backfill; mythical_view.go; packages/rpc/src/Mythical.ts; relax the unique issue index | L |
| 2 | §4.2 Place | Append (default: today's only behavior), Before #n, Amend #n. Needs explicit `position` (or ordered key) on items, because order now = issue number sort (mythical_items.go:1113). Amend = new revision on the existing item, keep branch/PR, continue on its lane | same files + new routes (`POST /mythical/todos` with `place`, `PATCH /mythical/todos/{id}`) + `history.todo` args | L |
| 3 | §4.2 Merging, M-07 | "Only the next item merges", "Merges after #n", PR base = previous PR, retarget after merge. Today PR base is `main`, candidates are cumulative on the tip, and there is no ordering check in the merge gate (mythical_items.go:2440-2535 checks CI/labels/head only) | mythical_items.go integrate/openPull/merge; mythical_github.go | L |
| 4 | §4.2 Move up/down/Drop | No operations. Drop only via issue close/label removal. Need item ordering mutation + cancel + close PR + rebase later items | Svc new `MoveItem`/`DropItem`; routes under `/mythical/items/{id}/…`; `history.move`, `history.drop` entries (userOnly or confirm) | M |
| 5 | §4.1 Paused/Stop/Resume | State `paused` (or `paused_at`), cancel run durably, release machine when idle, Resume relaunches continuing from the last finished step. `runs.resume` resumes a parked run by id only; stack item has no stop/resume | migration (state check), Svc `PauseItem/ResumeItem`, wire enum, StackView labels | M |
| 6 | §6.6 Steer | Steer a working stack lane. Delivery point exists for planning only (steering.ts boundaries); no item -> (run_id, workspace_id) steer route. `MythicalItemView.runs` carries run ids; workspace id in item. Needs `POST /mythical/items/{id}/steer` -> workspace gateway `steer`, plus a coordinator boundary during implementation (steering.md says implementation waits for the next safe boundary; implementation/flow.ts has no ReceiveFeedback) | Rte/Svc new steer + `flows/coding/implementation/flow.ts` boundary + app `history.steer` | M |
| 7 | §4.1 Needs you | Agent question / approval / unresolvable conflict as a first-class pending state with first-answer-wins. Today: `declined` with questions; plan approval is `HumanTask` in request/flow.ts (`approve`, planApproval policy); conflicts retry up to 3 then block | add `needs_you` state + `needs_you_reason/kind`, project from HumanTask pending approvals; Resolve action opens branch | L |
| 8 | §4.2 Rebase | Agent-only checkpoint vs people-present scheduling, "Rebase pending / Rebase now", snapshot writers first, "Rebased onto #2" activity, approval invalidation on revision change. Today: rebase happens inside the worker at integration, headless on lane machines | Svc integrate + presence input from branch/workspace layer (not in stack service) | L |
| 9 | §4.2 Rebase conflict | Conflicts the agent can't resolve become Needs you with Resolve. Today `retrying` + feedback, then `blocked` (mythical_items.go:1840-1847); `change.resolve` (entries/change.ts) targets plue changes | tie to gap 7 | M |
| 10 | §6.10 PR card, D-23 | Approval bound to reviewed revision for Mythical PRs: Land records `Head` (mythical_land_todo.go:36) and merge re-reads the head (mythical_items.go:2457) so a moved head blocks. After a rebase the approval is dropped only because the head changes (inferred). Agent-credential merge is refused for `LandTodo` (RequirePerson). The 3 spec rules (person approval, revision bound, "Merge" enabled only for next item) are 2 of 3 | add ordering check (gap 3) | S |
| 11 | §6.10 Line comments / §6.9 address review comments | Review comments becoming steers. `foreignHead` stops the stack when someone else pushes (mythical_items.go:3346; `landable` conflict message "a person decides on GitHub"). Review verdict `changes-requested` re-runs lane; GitHub PR review comments are not read by the lane (inferred; grep of review comments in mythical_items.go/mythical_github.go found none) | mythical_github.go + steer (gap 6) | M |
| 12 | §6.12 Learning, M-15 | Learning run after merge. `improve.mine` has no flow. Receipt "N lessons" on merged item absent. Pending notes exist from failed review rounds only, not from failed checks (learnings.ts:20 requires `status === "changes-requested"`) | new `flows/improve/mine/flow.ts` (or `flows/memory`), rule fires `change.landed`; `mythical_items` receipt field or `checks` jsonb; StackCard receipt row | L |
| 13 | §6.9 Status, §11.10 | Automatic configuration for fresh repo. Today routes need `.smithers/coding-project.json` (project-config.md:7) or the host runs only the manual plan route | flows/coding/host.ts + project-config.ts: generate default config stored in install | L |
| 14 | §4.1 Failed "earlier attempts and evidence kept" | `mythical_items` holds one set of run ids; retry overwrites (inferred from columns). Need `mythical_attempts` | migration + RetryItem | M |
| 15 | §6.6 TODO card "flow's steps with current one lit" | Item exposes run ids, `plan`, `todo` (replans), `checks`; steps come from run projection through the app run card, not item (inferred) | StackCard + run-trace link | S |

## Existing tests

- Go services: 125+ test funcs across `Svc/mythical_*_test.go`; biggest `mythical_todo_test.go` (50), `mythical_wiki_test.go` (15), `mythical_placement_test.go` (13), `mythical_service_test.go` (10), `mythical_items_test.go` (10), `mythical_policy_unit_test.go` (10), `mythical_failure_test.go` (9), `mythical_github_test.go` (8), `mythical_file_todo_test.go` (7), `mythical_land_todo_test.go` (4), plus concurrency, adversarial, terminal_e2e. Routes: `Rte/mythical_test.go` (6).
- TS: packages/rpc/test/{Mythical,StackView,StackIssues}.test.ts; apps/app StackCard.test.tsx, StackIssues.test.tsx; flows/test/{factory-todo, coding-steering, coding-stack-base, coding-learnings, coding-request-coordinator, coding-vibe-landing, coding-project-config, coding-builtin-routes, coding-gates, coding-host}.test.ts, canary-coding-setup.test.mjs.
- Not found (no test names matching): Before/Amend placement, move/drop, pause/resume of an item, steer into a stack lane (inferred from absence of the features).
- Not run by me (read-only task); pass/fail unknown.

## Configured/measured numbers

| Number | Value | Source |
| --- | --- | --- |
| Default lanes / allowed | 2 / 1..8 (DB check) | 0026:21 |
| Chat lane reserve | one lane held for chat when max>1 (issues see max-1) | mythical_items.go:3506 |
| Launches per pass | 4 | mythical_items.go:55 (`mythicalLaunchesPerRun`) |
| Attempts / launch bound / outage bound | 3 / 12 / 6 | mythical_items.go:52, :70-73 |
| Claim lease / poll / sweep | 10 min / 3 s / 5 min | mythical.go:24-28 |
| Backfill / PR poll | 15 min / 5 min | mythical_items.go:53-54 |
| CI wait bound | 6 h | mythical_items.go:3435 |
| Token reserve per run in flight | 60,000,000 | mythical_items.go:78 |
| Prompt bytes / title runes | 24 KiB / 256 | mythical_items.go:56, mythical_file_todo.go:19 |
| Item list cap in worker | 1000 | mythical_items.go:1070 |
| Bootstrap depth | default 100, max 500 | 0026:19 |
| Planning passes / correction rounds default | 8 / 3 | request/flow.ts:14, :183 |
| Steer queue capacity | 128 pending | steering.md |
| Learnings reaching planning | newest 20 accepted | learnings.ts:12 |
| Measured latencies (rebase, lane start) | none found | n/a |

## Related GitHub issues

- #1745 S1 Approved coding work on one mythical stack: open epic, updated 2026-10-02.
- #1921 Real E2E scenarios for mythical stack actions: open, hard, updated 2026-10-02.
- #1727 Pin and deploy a coding host with the mythical stack flows: open, easy, updated 2026-10-01.
- #2198 One coding host per box (Worker relay vs Go flow seam): open, 2026-10-02.
- #2780 S3 Run relevant checks for every factory change: open.
- #2782 S5 Use the same coding factory from the web app: open.
- #1934 Complete role flows on the existing factory, retire standalone host: open, hard.
- #1923 Refresh wiki on landed source changes via Smithers Cloud: open, hard (wiki after fold exists; learning does not).
- #1780 Epic: Smithers coding factory on Smithers Cloud: open.
- #3385 / #3404 MVP scope cuts: open; relevant boundary (pair, marketplace removed).
- No open issue found for: first-class TODO object, Before/Amend placement, Move up/down/Drop, Pause/Resume of a TODO, stack-lane steer, `improve.mine`, Make TODO (searches: "TODO object", "steer", "Make TODO", "learning improve", "TODO flow coding-project"). Per AGENTS.md each needs an issue before work (inferred gap).

## Risks and unknowns

1. Cumulative-vs-stacked PRs. Claim: PRs target `main` with a tree = verified candidate on the tip, so two proposed PRs can both claim the same earlier commit. Confirm: read `mythical_items.go` integrate/openPull for whether item N+1 waits until item N lands (inferred: `waiting` = "verified, waiting on main"), then test two items proposed at once.
2. Order is issue-number order. Confirm: `mythical_items.go:1113-1123` sort; adding `position` must keep the unique chat/issue indexes and `freeLane` lane identity.
3. The spec says a TODO "may link the issue"; the DB forces `issue_number` unique per repo. Confirm: 0026 index `mythical_items_issue_idx`; a TODO with no issue today is `source='chat'`, which needs `candidate_head` (a result), not a prompt.
4. Whether approval is revoked on rebase. Confirm: the merge gate compares `pull.HeadSHA != item.PRHead` (mythical_items.go:2457); a rebase changes head, so it should; add a test that a rebase after Land clears `checks.Land`.
5. Plue landing (D-23, `change.land`) and Mythical Land are two merge paths. AGENTS.md "zero tech debt; one backend" and MVP "send-upstream via PR" suggest the plue path should not be the TODO merge; confirm with the stack's `send-upstream` flag in the repository record before choosing which gets "Merge".
6. Steer into a working lane: confirm `item.workspace_id` + `request_run_id` suffice for `gateway.steer` (controller/runs.ts:650 needs `{workspaceId}`), and that a `coding/vibe` run (not `coding/request`) accepts a Message (steering.ts admits only `coding/request` roots, line ~45). Probably not; vibe/verify need their own policy.
7. Resume continuing from the last finished step: engine is durable-replay by design (flows/coding/README.md "replay state through its injected database"; `gateway.resume`). Confirm by killing a run mid-atom in an integration test; none found.
8. `StackCard` places `proposed` in "Needs you" (StackIssues.ts NEEDS_YOU), contradicting spec "In review". Confirm by reading J4's counts (Needs you 2, In review 4): current projection cannot produce them.
9. Pending notes "from failed checks" (spec) vs code "from changes-requested review rounds" (learnings.ts:20). Confirm by grep `recordLearning` callers (correction.ts); falsified if a check failure also calls it.
10. Fresh-repo configuration: `.smithers/coding-project.json` is read once at host start (project-config.md); generating it in the install requires a restart or a reload path; unknown if the lane host already supports reload.
