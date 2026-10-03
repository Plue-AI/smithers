# T-STK-01 The stack item is the TODO: extend `mythical_items` in place

Stage S1 · Size L · Depends on first merge: T-INS-06; rest of S1: — · Unblocks T-APP-01, T-APP-02, T-APP-04, T-APP-05, T-APP-07, T-COL-02, T-COL-05, T-FLW-04, T-FLW-06, T-FLW-11, T-GH-02, T-GH-03, T-GH-06, T-GH-07, T-GH-09, T-MCH-04, T-MCH-14, T-REL-02, T-REL-03, T-STK-02, T-STK-04, T-STK-05, T-STK-06, T-STK-08, T-STK-09, T-STK-12 · Issue: [#3433](https://github.com/smithersai/smithers/issues/3433)
Spec: spec.md §3, §4.1, §4.1.0, §4.1.0a, §6.3, §10.8 · Delta: delta.md §6 row 1 · Product: mvp.md §3 (TODO `T12`), §4.1, J1.6, J2.3, J2.4, J2.5, M-07, M-16, E-07

Rescoped by the minimal-code synthesis, 2026-10-03 (v1 §1; v2 ticket merges STK-01+13+07). Absorbs T-STK-01 ([#3451](https://github.com/smithersai/smithers/issues/3451)), T-STK-01 ([#3464](https://github.com/smithersai/smithers/issues/3464)), T-STK-01 ([#3534](https://github.com/smithersai/smithers/issues/3534)) and T-STK-01 ([#3535](https://github.com/smithersai/smithers/issues/3535)).

## Goal
A `mythical_items` row is the TODO. It carries a per-repository number `T<n>`, its prompt revisions, its waits and per-attempt evidence, and one pure Go function projects it to the nine product states.

## Scope
First merge: Expose TODO creation/append, state and evidence over mythical_items and the existing coding path. Check: C-J1-04.
Later dependency integrations land dark until their providers and phase checks pass.
In:
- Phase 1: new columns, the `todoState(item)` projection, `GET/POST /api/todos`, `GET /api/todos/{n}`, `/todo.new` (`agent: confirm`) and `/todo Tn` (`agent: run`).
- Phase 2: Needs you waits with first answer wins (`/todo.answer Tn`, the `ask` binding for `coding/edit-atom` and `coding/dispatch-turn`), evidence per attempt, and run attachment that enters `working` without a new first step.

Out: No parallel TODO, revision, attempt, approval or projection tables; no sync between two records; no backfill. Placement (T-STK-02), merge (T-STK-04), stop and retry (T-STK-05), steers (T-STK-06), other wait producers, cards and the live transport.

The paused lane (`827ceb6e`, +3.3k production lines) never reached main (`git merge-base --is-ancestor` finds no such commit). It does not resume as written.

## Changes
- Use a stable per-item jobs operation stream for lifecycle facts; retain item/attempt identity in payloads and launch receipts. Extend the existing transaction append helper and replay filter; authorize repository/branch membership before selecting only that item’s operations. Never expose an unfiltered principal stream. Check: C-STK-01.
- Reshape `packages/backend/db/product/migrations/` (next number) on `mythical_items` (`0026_mythical_stacks.sql:65`): add `number`, `title`, `stack_position`, `paused_at`, `created_by`, `owner_id`, `flow_digest`, `revisions jsonb`. Existing rows get numbers in `created_at` order in the same migration. `issue_number` is already nullable with a partial unique index (`0026_mythical_stacks.sql:120-122`), so it becomes a link.
- Reshape `SaveMythicalItem` (`internal/db/mythical_ext.go:472`) so every save goes through the one `version` check; the engine stays the only writer. Delete any second transition authority.
- Reshape `internal/services/mythical_view.go` (`MythicalItemView` `:75`, `mythicalTodoView` `:193`): add `todoState(item) State`, the §4.1.0/§4.1.0a projection of the 15 item states, open waits, `paused_at` and launched-not-attached. Terminal states win.
- Reuse the mythical service for `/api/todos`, the routes the landed `TodoSeam` already calls (`apps/app/src/mainview/state/seams/TodoSeam.ts:127`). Delete `POST /mythical/todos` (`internal/compose/router.go:1134`) and the GitHub-issue filing in `FileTodo` (`mythical_file_todo.go:45`).
- Reuse waits: run waits come from the runtime `WaitingReason` (`flowruntime/contracts.go:143`) through `ProjectFlowRuntime` (`mythical_items.go:577`) and answer through `HumanTask.answer` (`packages/smithers/flows/flow/src/HumanTask.ts:929`). Open waits live in the `checks` jsonb beside `Fault` and `ForeignHead` (`mythical_items.go:3333`). First answer wins on the item `version` check, the same guard as `DecideApproval` (`queries/approvals.sql:33-42`); losers get `409 {answered_by}`.
- Reshape evidence: before `mythicalItemStep.start` clears run ids and candidate fields (`mythical_items.go:1651-1654`), snapshot receipts (`mythicalRunReceipts`, `mythical_receipts.go:66`), review, usage, flow digest and diff stat into `checks.attempts[]`. Logs go to `internal/blob` by digest; `GET /api/todos/{n}/attempts/{a}/logs/{digest}` serves only digests that attempt references.
- Reuse `product_job_events`: append item facts in the change transaction and serve the item’s operation streams through `jobs.Replay`; preserve event identity and cursor ordering. Check: C-STK-01.

## Tests
- Replay a shared item across two authors and two attempts: both authorized members see the same ordered facts, and neither sees another item’s or principal’s private events. Rollback publishes nothing. Check: C-STK-01.

C-STK-08 (folded steps and assertions):
1. Question and foreign push: T1 in `s3` raises a question. Alice pushes a commit to T1's branch on the fake; advance one refs cycle. Alice answers the question. Ben selects Discard.
2. Stop with a question open: with T1's question open, Will sends `stop`.
3. Pause and conflict: Will stops a working T1, and it parks. Move `main` with a change that conflicts with T1's, and let the host-side rebase run. Ben resolves the conflict and presses Done. Will resumes.
4. Stop with only a branch wait open: T1 is working with an open `foreign_push`. Will stops it, and the run parks. Ben selects Discard.
5. Resume after the first step: stop T1 while `s2` runs, after `s1` finished; resume.
6. Merge on GitHub during a steer: T1 is `in_review`. Alice steers, so T1 turns `working`. Merge T1's PR on the fake at its last proposed head; advance one pulls cycle.
7. Merge on GitHub with a question open: T1 is `needs_you` with a question. Merge the PR on the fake; advance one cycle; then Alice answers.
8. Merge on GitHub while paused: as step 7, with T1 `paused`.
9. Failed with a branch wait: T1 is `failed`. Alice pushes to its branch; Ben selects Discard; Will retries.

Pass when:
- Step 1: after the push, T1 is `needs_you` with two open waits and `needs_you.kind = foreign_push`. Alice's answer settles only the question: the run receives it, and T1 stays `needs_you` with `foreign_push`. The agent's next push is held. After Discard, T1 is `working`.
- Step 2: refused with class `conflict`; no pause signal is sent.
- Step 3: the conflict wait opens while T1 is paused, and T1 shows `needs_you` (`conflict`). After Done it shows `paused`. After Resume it goes `queued → starting → working` on the same run id.
- Step 4: Stop is accepted. T1 shows `needs_you` while `paused_at` is set, and `paused` after Discard.
- Step 5: `queued → starting → working`, with `working` following `run_attached` within 5 s of the machine grant; `s1`'s counter stays 1; T1 never stays in `starting`.
- Step 6: T1 is `merged` with one event; the run is cancelled; no wait is open; `paused_at` and `merging` are null; the fake's write log has no `convertPullRequestToDraft` for T1 at the steer.
- Step 7: T1 is `merged`; the question wait is closed; Alice's answer gets `409`, and the run receives nothing.
- Step 8: T1 is `merged`; `paused_at` is null; the run is cancelled.
- Step 9: after the push, T1 shows `needs_you` (`foreign_push`), not `failed`. After Discard it shows `failed`. Retry gives attempt 2.
- Every state change has exactly one `product_job_events` row, and the stored state always equals §4.1.0a applied to the stored facts.

Fail when:
- An answer or a Discard settles a wait other than its own.
- A paused or failed TODO with an open branch wait shows paused or failed.
- A resumed TODO stays in `starting` because its first step already ran.
- A merge on GitHub leaves an open wait, `paused_at` or a live run, or the steer turned the PR into a draft.


C-STK-01 (folded steps and assertions):
1. Run TestTodoTransitionLiteralCases over checked-in literal transition and guard cases independent of the production TSV. A mutated production destination must fail the literal behavioral cases. Documentation rendering/parity runs separately and supplies no behavioral expectation.
1a. Load the checked-in literal projection table authored during review, independently of spec files and production code at runtime: `queued`, `skipped` → queued; launched or re-admitted and not yet attached (`run_attached`) → starting; `running`, `delivering`, `integrating`, `verifying`, `proposing`, `waiting`, `retrying` → working; `proposed` → in_review; `landed` → merged; `blocked` → failed; `cancelled`, `rejected`, `declined` → dropped; for a non-terminal item state, the §4.1.0a ranks: any open wait → needs_you, else a set `paused_at` → paused, else `blocked` → failed; terminal states (`landed`, `cancelled`, `rejected`, `declined`) ignore waits and `paused_at`. With several open waits, `needs_you.kind` is the first in the order `moved_off`, `conflict`, `foreign_push`, `approval`, `question`, then the oldest.
2. Call `ProjectItemState` for every input: 15 states × launched × the four wait sets × paused_at, skipping launched for non-launchable states. Compare with the literal projection fixture in step 1a.
3. Load the checked-in literal transition table authored during review, independently of spec files and production code/TSV at runtime:
   - `draft→queued` (place); `queued→starting` (admit: a machine granted, the flow version pinned); `starting→working` (`run_attached`: a new run's first step, or a resumed or re-admitted run continuing);
   - `starting→failed` (start failed, `failure.step = "start"`); `working→failed` (run failed or uncertain); `failed→queued` (retry, and retry with the current flow);
   - `→needs_you` when a wait opens: run waits (question, approval) from `working` only; branch waits (conflict, moved_off, foreign_push) from `queued`, `starting`, `working`, `paused`, `failed` and `in_review`; a wait opening while another is open records an event and keeps needs_you;
   - `needs_you→working` (first accepted answer, including Bring in); `needs_you→queued` (answered after the machine was released at safe-idle; the run resumes when admission grants the machine again); `needs_you→in_review` (Discard, or an answer that needs no new work); `needs_you→paused` and `needs_you→failed` (the last wait settles with `paused_at` set or the item `blocked`); each `needs_you→` row only when the settled wait was the last open one, and settling any other wait records an event and keeps needs_you;
   - `working→paused` (stop, with no run wait open); stop with only a branch wait open sets `paused_at` and keeps needs_you; `paused→queued` (resume); `in_review→queued` (a steer when the machine was released);
   - `working→in_review` (`stack.propose` accepted, §10.4.4); `in_review→working` (changes requested, a member's review comment, steer);
   - self-loops that record an event and keep the state: `in_review` (checks updated, rebased, edited); `queued`, `starting`, `working`, `needs_you`, `paused` (steer, held or delivered per §10.7.3);
   - every unmerged state with an open PR `→merged`: `queued`, `starting`, `working`, `needs_you`, `paused`, `failed`, `in_review` (PR merged on GitHub and `main` contains the commit; the run is cancelled, every wait settled, `needs_you` and `paused_at` cleared); every earlier unmerged item a later squash commit contains `→merged` (§10.6.4);
   - every stored unmerged state `→dropped` (drop; PR closed unmerged); `dropped→in_review` (PR reopened within 7 days; once per reopen event, with no run started, §10.7.4).
4. Drive every (state, trigger) pair through the engine guards: 10 sources × every trigger the guards accept. Add the guard variants: a wait kind outside its source's list, the coding agent's answer to a non-conflict wait, a merge event without the commit on `main`, a reopen at 7 days + 1 s, a second delivery of the same reopen event, a stop while a question is open, an answer to an already-settled wait.
5. Send `learning_done` to a `merged` TODO.
Drive run_attached through production runtime ingestion with literal attempt/run fixtures. Accept only when payload.attempt equals the current attempt and Checkpoint.RunID equals checks.Attempts.run_id written in the starting launch transaction. A matching attachment enters working without FirstStep even after a generation change within that attempt. Prior-attempt, wrong-run and empty-binding events change no TODO, event or projection. Run the FirstStep regression and production migration 0105 with existing bound and unbound rows; preserve valid bindings and refuse unbound attachment. Inject failure between TODO/event/projection writes and race wait changes with attachment; assert pgx.BeginFunc rolls back all writes on failure and commits each accepted update atomically.
- Run backfill with literal states and counts, retaining PR heads. Classify `state <> skipped AND NOT (issue AND cancelled AND approved_digest = empty string)` and select missing links with `WHERE mythical_items.todo_id IS NULL`. Include a fixture where migration 0105 already ran.

Pass when:
- Terminal states win: every input with item state `landed` projects merged, and every input with `cancelled`, `rejected` or `declined` projects dropped, for every combination of `needs_you` and `paused_at`.
- After a merge or a drop from any source state, the TODO has no open wait, `needs_you` is null and `paused_at` is null.
- Merged from `working` (a steer in progress) and merged from `needs_you` (a question open) each write one event, close every wait and leave `merging` null.
- Settling one wait never settles another: with a question and a foreign_push open, answering the question leaves needs_you with `needs_you.kind = foreign_push`.
- Step 2: every projected state equals the step 1a literal table; the test prints the input count.
- Step 4: the allowed (from, trigger) pairs equal the step 3 table exactly, and the test prints both counts.
- Every allowed case writes exactly one `product_job_events` row whose `from`, `to` and `actor` match; every refused case returns `todo_transition_refused` with the from-state and trigger and writes no row.
- Each guard variant is refused.
- Step 5 returns a `lessons` increment and no state change (§4.1.3).
- Backfill attribution is `{"system":"backfill"}`. Literal counts and states match the classification; PR heads are retained. The fixture where migration 0105 already ran creates zero TODO or branch rows. Member-identity fixtures and repeated-Apply idempotency are not acceptance proofs for backfill.

Fail when:
- A shortcut is allowed: `queued→working` without `starting`, `paused→working` without `queued`, `queued→in_review`, `failed→working`, `merged→working`, `dropped→queued`, or `stop` from `starting` or while a `question` or `approval` wait is open.
- An allowed case writes no event row (a state with no event, §3.2), or a refused one writes a row.
- The coding agent's answer settles a `question` or `approval` wait (§5.2 allows only its own conflicts).
- A resumed or re-admitted TODO needs a first-step event to leave `starting`, or settling one wait closes another.
- Either expected table reads spec files or derives expectations from implementation code or the production TSV at runtime.
- The guards are tested on `Transition` alone, so an engine entry point that skips it goes unseen.

- Unit, `mythical_view_unit_test.go`: literal table of 15 item states × open run/branch waits × `paused_at` × launched-not-attached → state and primary wait. No oracle derived from spec text or the function under test.
- Integration, real PostgreSQL: POST with a repeated `Idempotency-Key` returns one TODO and makes no GitHub call; a stale `version` write loses; 20 concurrent answers commit one and return 19 `409`; a resumed run attaches without a first step; a stale attempt's attachment changes nothing; attempt 1's evidence is byte-identical after attempt 2.
- Migration test over literal pre-migration rows: numbers assigned once, no duplicate PR heads.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): first TODO to merged PR, unassisted
- [C-J2-03](../checks/C-J2-03.md), [C-STK-08](../checks/C-STK-08.md), [C-ACC-01](../checks/C-ACC-01.md) (answer doors), [C-J2-04](../checks/C-J2-04.md), [C-STK-03](../checks/C-STK-03.md), [C-STK-06](../checks/C-STK-06.md) (phase 2; the run-attachment rows run after T-FLW-11 lands).

## Risks and notes
- Activation with T-MCH-14: Workspace retention consumes item state; its integration gate does not create that state. Missing providers refuse; joint acceptance gates enabling the path.
- Activation with T-FLW-11: The landed coding composition supplies first-merge execution; the new composition is a later activation. Missing providers refuse; joint acceptance gates enabling the path.
- Activation with T-FLW-07: Monitor presentation consumes stack facts and cannot gate their schema. Missing providers refuse; joint acceptance gates enabling the path.
- Activation with T-ACC-04: Delegated credentials qualify later callers; initial TODO routes accept only the owner session. Missing providers refuse; joint acceptance gates enabling the path.
- About +1.7k / −0.6k production lines (smithers-3f), against +3.3k for the two-table plan.
- Plue composes this backend and holds `mythical_items` rows. Record smithers-8a's confirmation that the new nullable columns and the number migration are safe for Plue before landing (from T-STK-01).
- T-GH-03 writes the GitHub-checks part of attempt evidence when it lands; this ticket does not depend on it.
