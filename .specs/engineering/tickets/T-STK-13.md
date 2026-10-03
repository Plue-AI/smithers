# T-STK-13 TODO projection for independent waits and attached resumed runs

Stage S1 · Size M · Depends on T-STK-01, T-STK-07, T-FLW-11 · Unblocks T-GH-05, T-REL-02, T-STK-05 · Issue: [#3534](https://github.com/smithersai/smithers/issues/3534)
Spec: spec.md §2, §3, §3.1, §3.2, §3.3, §4.1, §4.1.0, §4.1.0a, §4.1.2a, §6.2, §6.3, §7.2, §8.1.1, §10.1, §15.1.5, §19.3 · Delta: delta.md §6 (Add tables, state machine), §4 (`activity` table [S1]) · Product: mvp.md §3 (TODO `T12`), §4.1, §6.6, J1.6, J2.3, M-07, M-16, E-07 (overview)

## Goal

Project independent waits and resumed or re-admitted runs without waiting for a new first step.

## Scope

- Bind run_attached to the current attempt: its payload includes `attempt`, and `Checkpoint.RunID` must equal the current `todo_attempts.run_id` recorded at launch in the `starting` transaction. Generation alone is not an attempt identity; it changes within an attempt. Check: C-STK-01.

In:
- Follow-up §4.1 transitions for Stop in review, resumed input delivery, daily_limit admission and owner-named daily-token-budget pauses (§10.7.1, §15.2). Engine pause waits do not rank as question/approval; independent branch waits retain precedence. Checks: C-STK-03, C-STK-06.
- Domain attempt outcomes merged/dropped in the same transaction as run cancellation and wait settlement; external cancellation without domain settlement is failed/cancelled_external. Held post-propose runs have current_step null and monitor state held with since. Checks: C-STK-03, C-STK-06.
- The §4.1.0 projection of the 15 `mythical_items.state` values, written by the engine in the same transaction as the item change. `queued` and `skipped` project to `queued`; a launched or re-admitted item whose run isn't attached yet projects to `starting`; open waits and a set `paused_at` override a non-terminal item state in the §4.1.0a order (needs_you, then paused, then failed); terminal item states always win.

Out:
- The landed scope of T-STK-01, except the follow-up changes stated here.
- New wait storage or answer policy (T-STK-07), new launch/resume machinery, retry attempt allocation, changes to terminal precedence, UI Views/Containers and parsing spec prose at runtime.

## Changes
- Reuse the shared primary-wait/state helper wired by T-STK-07 through todo_state.go; runtime attachment projection consumes its wait facts and introduces no second state formula or writer.

- Persist `todo_attempts.run_id` at launch in the same transaction that enters `starting`. Add `attempt` to the projection payload. Accept run_attached only if both its attempt and Checkpoint.RunID match the current attempt row; stale or mismatched attachments change no TODO, event or projection. Fix the lane's FirstStep test so attachment resumes working without another first step. Fix migration 0105's `request_run_id=''` backfill: retain valid run bindings and refuse an attachment with no authoritative launch binding. Check: C-STK-01.
- Replace ProjectFlowRuntime's non-transactional three-pass optimistic loop with `pgx.BeginFunc`. Read and guard the current attempt and mutate TODO state, primary wait, todo_events and projection_events in that transaction. Roll back every write on failure. Check: C-STK-01.
- Extend the owned transition TSV and its renderer with in_review → paused for Stop and working/in_review → paused for daily-token-budget waits. A held live nonterminal run satisfies Stop's executing guard; question/approval still blocks it. Keep the PR open; terminal settlement wins. The Resume path restores the stack wait or next unfinished boundary after run_attached, without repeating finished effects. Check: C-STK-03.
- Project queued.queue.reason daily_limit and exact copy "Daily limit reached · starts tomorrow" for blocked admission, with no failed attempt. Project pause.reason daily_token_budget with install owner id/name and "Paused · daily token budget · <owner>" only after the engine pause opens. Preserve run, inputs and attempt evidence; clearing the budget pause cannot clear an independent person Stop. Checks: C-STK-03, C-STK-06.
- Project runtime cancellation according to the first committed domain settlement; cancellation alone cannot imply dropped. Preserve first attempt outcome and ignore stale attempt events. A held run has no active current_step, and model_turn_started/steer_received consumption records are inspectable in run order (§11.6.1). Checks: C-STK-03, C-STK-06.

- Owner smithers-3f: author `.specs/engineering/state/todo-transitions.tsv` (new) with `from | trigger | guard-predicate | to | outcome: transition|noop|attention | flags`. Go embeds it; `Transition` is lookup plus named predicates. `todoItemPath` searches the same rows. Behavioral tests use independent checked-in literal cases, never this TSV or the Go lookup as their oracle. `scripts/render-spec-tables.mjs` (new) renders §4.1 from the TSV; documentation parity is separate from behavioral acceptance. Check: C-STK-01.
- Extend T-STK-01's planned `packages/backend/internal/services/todo_state.go` and the production `packages/backend/internal/services/mythical_items.go:577` (`ProjectFlowRuntime`) so persisted wait, pause and attachment facts update the TODO and its event/projection in the same transaction. Consume T-STK-07's independent waits and T-FLW-11's run-attached event for the current attempt; ignore a stale attachment for another attempt. Resume and re-admission must not wait for another first-step event.

## Tests

- C-STK-01 production-ingestion integration cases use literal attempt and run ids: a matching run_attached enters working without FirstStep; a prior attempt, wrong run id or empty binding changes nothing; a generation change within the same attempt does not invalidate its matching run. Run the FirstStep regression and the production 0105 migration against existing bound and unbound rows. Preserve valid bindings; unbound rows cannot authorize an attachment. Inject failure between TODO, event and projection writes to prove rollback, and race wait changes against attachment to prove one committed transaction.
- FLW11 QA G02/G03/G18/G21/R56/R60: literal projection matrices cover terminal merge/drop vs Stop/budget/external cancellation, open run/branch waits and attach after Resume. Stop held review keeps PR; budget pause names owner; external cancel preserves branch/PR and offers person Retry without relaunch. Null current_step while held and first outcome survive restart. Checks: C-STK-03, C-STK-06.
- FLW11 QA G12/R59: 12 admissions followed by queued/daily_limit, with no new run/attempt; restart retains queue and exact copy. Owner allowance update/person reset/UTC rollover reconsider once and preserve cumulative history; Resume/wake/replay consume no launch. Check: C-STK-06.

- Unit, `packages/backend/internal/services/todo_state_test.go` (new), C-STK-01: `TestTodoTransitionLiteralCases` drives engine entry points over independent literal allowed/refused cases; `TestTodoProjectionLiteralCases` covers all 15 item states × independent run/branch wait combinations × paused_at × launched-not-attached, with literal precedence and primary-wait expectations. No test derives expectations from a spec file, TSV or production lookup at runtime.
- Integration, `packages/backend/internal/services/todo_projection_db_test.go` (new), real PostgreSQL: feed ordered events through the production flowdispatch runtime-event ingestion and registered ProjectFlowRuntime callback, and open/settle waits through T-STK-07's production command dispatcher. Read GET /api/todos/{n} through the production router and committed todo_events/projection_events. Literal cases include a resumed run attached without a new first step, re-admission, a stale prior-attempt attachment, two open waits with only one settled, paused/blocked precedence and terminal items with stale waits. Assert persisted state and primary wait, attribution, and atomic event/projection writes; invoke no direct projection helper as the acceptance boundary.

## Acceptance
- [C-STK-03](../checks/C-STK-03.md): Stop and budget pauses obey the durable state and restored-wait rules.
- [C-STK-06](../checks/C-STK-06.md): queued daily limit, domain outcome and held/null-step projections pass through the real composition.

- [C-STK-01](../checks/C-STK-01.md): projection table covers independent waits and launched-not-attached runs; terminal states win.

## Risks and notes

- Terminal precedence remains in T-STK-01 under the product exception. The scope above retains the full changed line verbatim for context; this ticket adds the remaining wait and attachment rules.

## Ready checklist
1. Dependencies: T-STK-01 supplies stored TODO/event/projection facts, T-STK-07 supplies independent wait mutation and T-FLW-11 supplies the machine run's attachment event. Added edges are S1 and acyclic in the current index. This ticket consumes those producers; it builds no launcher.
2. Exclusions: Scope names wait/answer policy, launch/resume machinery, retry allocation, terminal precedence, visual components and runtime spec-prose parsing. The copied frozen-ticket header is removed; no frozen ticket is edited.
3. Boundary tests: C-STK-01's literal unit cases supplement todo_projection_db_test.go at production runtime ingestion, wait dispatch and GET /api/todos/{n}. Both expected states and guards are literal fixtures independent of spec files, embedded TSV and implementation at runtime. The documentation renderer checks parity separately and supplies no acceptance oracle.
4. Decisions: smithers-3f accepts transition predicates, primary-wait ordering and transaction/attachment ownership; smithers-8a accepts the TSV/documentation seam and resolves normative text conflicts. Terminal precedence and independent waits are fixed product rules, not implementation options.
5. Owner pre-review before start: smithers-3f: answered, BLOCKING edits applied (tech lead adopts). Current attempt and Checkpoint.RunID bind attachment; the starting transaction persists run_id; pgx.BeginFunc commits TODO/event/projection writes together. C-STK-01 covers FirstStep, migration backfill, stale binding and rollback. No TypeScript library, app or View code is changed.
6. Security: smithers-3f reviews attachment credential/attempt binding and the inherited T-INS-02/T-FLW-11 execution boundary before start. Projection consumes data and never executes a repository flow on the host. Resumed/re-admitted repository code runs only inside an isolated branch machine (M-29, §1.3), with no host fallback; C-SEC-02 verifies isolation refusal and the boundary tests reject stale-attempt attachments.
