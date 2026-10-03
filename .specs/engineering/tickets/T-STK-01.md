# T-STK-01 The stack item is the TODO: extend `mythical_items` in place

Stage S1 · Size L · Depends on phase 1: — · phase 2: T-ACC-04, T-FLW-07, T-FLW-11, T-MCH-14 · Unblocks T-ACC-02, T-APP-01, T-APP-02, T-APP-04, T-APP-08, T-CAT-01, T-COL-02, T-FLW-04, T-FLW-11, T-GH-01, T-GH-02, T-GH-03, T-GH-09, T-INS-04, T-MCH-04, T-MCH-14, T-REL-02, T-REL-03, T-STK-02, T-STK-04, T-STK-05, T-STK-06, T-STK-09, T-STK-12, T-STK-16 · Issue: [#3433](https://github.com/smithersai/smithers/issues/3433)
Spec: spec.md §3, §4.1, §4.1.0, §4.1.0a, §6.3, §10.8 · Delta: delta.md §6 row 1 · Product: mvp.md §3 (TODO `T12`), §4.1, J1.6, J2.3, J2.4, J2.5, M-07, M-16, E-07

Rescoped by the minimal-code synthesis, 2026-10-03 (v1 §1; v2 ticket merges STK-01+13+07). Absorbs T-STK-07 ([#3451](https://github.com/smithersai/smithers/issues/3451)), T-STK-10 ([#3464](https://github.com/smithersai/smithers/issues/3464)), T-STK-13 ([#3534](https://github.com/smithersai/smithers/issues/3534)) and T-STK-14 ([#3535](https://github.com/smithersai/smithers/issues/3535)).

## Goal
A `mythical_items` row is the TODO. It carries a per-repository number `T<n>`, its prompt revisions, its waits and per-attempt evidence, and one pure Go function projects it to the nine product states.

## Scope
In:
- Phase 1: new columns, the `todoState(item)` projection, `GET/POST /api/todos`, `GET /api/todos/{n}`, `/todo.new` (`agent: confirm`) and `/todo Tn` (`agent: run`).
- Phase 2: Needs you waits with first answer wins (`/todo.answer Tn`, the `ask` binding for `coding/edit-atom` and `coding/dispatch-turn`), evidence per attempt, and run attachment that enters `working` without a new first step.

Out: no `todos`, `todo_revisions`, `todo_events`, `todo_waits`, `todo_attempts` or `projection_events` table; no sync between two records; no backfill. Placement (T-STK-02), merge (T-STK-04), stop and retry (T-STK-05), steers (T-STK-06), other wait producers, cards and the live transport.

The paused lane (`827ceb6e`, +3.3k production lines) never reached main (`git merge-base --is-ancestor` finds no such commit). It does not resume as written.

## Changes
- Reshape `packages/backend/db/product/migrations/` (next number) on `mythical_items` (`0026_mythical_stacks.sql:65`): add `number`, `title`, `stack_position`, `paused_at`, `created_by`, `owner_id`, `flow_digest`, `revisions jsonb`. Existing rows get numbers in `created_at` order in the same migration. `issue_number` is already nullable with a partial unique index (`0026_mythical_stacks.sql:120-122`), so it becomes a link.
- Reshape `SaveMythicalItem` (`internal/db/mythical_ext.go:472`) so every save goes through the one `version` check; the engine stays the only writer. Delete any second transition authority.
- Reshape `internal/services/mythical_view.go` (`MythicalItemView` `:75`, `mythicalTodoView` `:193`): add `todoState(item) State`, the §4.1.0/§4.1.0a projection of the 15 item states, open waits, `paused_at` and launched-not-attached. Terminal states win.
- Reuse the mythical service for `/api/todos`, the routes the landed `TodoSeam` already calls (`apps/app/src/mainview/state/seams/TodoSeam.ts:127`). Delete `POST /mythical/todos` (`internal/compose/router.go:1134`) and the GitHub-issue filing in `FileTodo` (`mythical_file_todo.go:45`).
- Reuse waits: run waits come from the runtime `WaitingReason` (`flowruntime/contracts.go:143`) through `ProjectFlowRuntime` (`mythical_items.go:577`) and answer through `HumanTask.answer` (`packages/smithers/flows/flow/src/HumanTask.ts:929`). Open waits live in the `checks` jsonb beside `Fault` and `ForeignHead` (`mythical_items.go:3333`). First answer wins on the item `version` check, the same guard as `DecideApproval` (`queries/approvals.sql:33-42`); losers get `409 {answered_by}`.
- Reshape evidence: before `mythicalItemStep.start` clears run ids and candidate fields (`mythical_items.go:1651-1654`), snapshot receipts (`mythicalRunReceipts`, `mythical_receipts.go:66`), review, usage, flow digest and diff stat into `checks.attempts[]`. Logs go to `internal/blob` by digest; `GET /api/todos/{n}/attempts/{a}/logs/{digest}` serves only digests that attempt references.
- New: `mythical_item_events(item_id, seq, at, actor jsonb, kind, payload)`, one append per state change, steer, answer and rebase. Rejected reuse: `product_job_events` (`0005_durable_product_jobs.sql:79`) is keyed by job, not item, and the `checks` jsonb is current state, not an immutable history of many facts.

## Tests
- Unit, `mythical_view_unit_test.go`: literal table of 15 item states × open run/branch waits × `paused_at` × launched-not-attached → state and primary wait. No oracle derived from spec text or the function under test.
- Integration, real PostgreSQL: POST with a repeated `Idempotency-Key` returns one TODO and makes no GitHub call; a stale `version` write loses; 20 concurrent answers commit one and return 19 `409`; a resumed run attaches without a first step; a stale attempt's attachment changes nothing; attempt 1's evidence is byte-identical after attempt 2.
- Migration test over literal pre-migration rows: numbers assigned once, no duplicate PR heads.

## Acceptance
- [C-STK-01](../checks/C-STK-01.md), [C-UI-05](../checks/C-UI-05.md), [C-J1-04](../checks/C-J1-04.md) (phase 1).
- [C-J2-03](../checks/C-J2-03.md), [C-STK-08](../checks/C-STK-08.md), [C-ACC-01](../checks/C-ACC-01.md) (answer doors), [C-J2-04](../checks/C-J2-04.md), [C-STK-03](../checks/C-STK-03.md), [C-STK-06](../checks/C-STK-06.md) (phase 2; the run-attachment rows run after T-FLW-11 lands).

## Risks and notes
- About +1.7k / −0.6k production lines (smithers-3f), against +3.3k for the two-table plan.
- Plue composes this backend and holds `mythical_items` rows. Record smithers-8a's confirmation that the new nullable columns and the number migration are safe for Plue before landing (from T-STK-14).
- T-GH-03 writes the GitHub-checks part of attempt evidence when it lands; this ticket does not depend on it.
