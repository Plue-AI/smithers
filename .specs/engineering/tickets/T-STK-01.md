# T-STK-01 TODO tables, state machine, events, the `activity` table and topic, projection

Stage S1 · Size L · Depends on — · Unblocks T-ACC-02, T-ACC-06, T-APP-01, T-APP-02, T-APP-08, T-COL-02, T-FLW-04, T-FLW-11, T-GH-02, T-GH-03, T-GH-05, T-GH-09, T-MCH-04, T-MCH-14, T-REL-02, T-REL-03, T-STK-02, T-STK-04, T-STK-05, T-STK-06, T-STK-07, T-STK-09, T-STK-10, T-STK-12, T-STK-13, T-STK-14 · Issue: [#3433](https://github.com/smithersai/smithers/issues/3433)
Spec: spec.md §2, §3, §3.1, §3.2, §3.3, §4.1, §4.1.0, §4.1.2a, §6.2, §6.3, §7.2, §8.1.1, §10.1, §15.1.5, §19.3 · Delta: delta.md §6 (Add tables, state machine), §4 (`activity` table [S1]) · Product: mvp.md §3 (TODO `T12`), §4.1, §6.6, J1.6, J2.3, M-07, M-16, E-07 (overview)

## Goal
A TODO created from chat is a row with its own number `T<n>`, prompt revision and stored state. Every state change appends one `todo_events` row and one `projection_events` row in the same transaction, so the `todo:<n>` and `home` topics show a state only after its event commits.

## Scope
In:
- Tables `todos`, `todo_revisions`, `todo_events`, `todo_attempts`, `todo_approvals`, `branches` (item rows; `machines` arrives with T-MCH-04) and `stack_attention` (§3, §4.1.2a); `mythical_items.todo_id` (1:1, E-07).
- The `projection_events` migration and its writer (§3.1, retention §3.3). T-COL-02 builds the live transport on them.
- The `activity` table (§3) and the `branch:<id>:activity` topic (§7.2) with `GET /api/branches/{b}/activity`. S1 writers are steers (T-STK-06), answers (T-STK-07), agent steps (the runtime projection), GitHub comments (T-GH-04) and stack-service history writes (T-STK-08, T-MCH-08). Bursts arrive in S2 (T-COL-04).
- The activity actor for history writes is the system actor with its requester, rendered "Smithers, for Ben" (§8.5.0, M-32).
- Nine product states: `queued`, `starting`, `working`, `needs_you`, `paused`, `failed`, `in_review`, `merged`, `dropped`.
- One pure transition function over the §4.1 table, called by every engine guard that decides a transition (§10.1).
- The §4.1.0 projection of the 15 `mythical_items.state` values, written by the engine in the same transaction as the item change. `queued` and `skipped` project to `queued`; a launched item whose run hasn't reported its first step projects to `starting`; an open `needs_you` or a set `paused_at` overrides the item state. Terminal item states always win.
- Item branch names `smithers/<todo-slug>`: slug from the title, ≤ 48 characters, unique (§8.1.1), recorded once in `branches.github_branch`.
- `POST /api/todos` with `place: append` only, `GET /api/todos`, `GET /api/todos/{n}`; the `todo:<n>` snapshot and `home` item deltas.
- `/todo.new` and `/todo Tn` in the command catalog. `/todo.new` is `agent: confirm` (Appendix B.2 A✓): the app agent or an external agent posts a one-click confirmation that the member presses (§15.1.5). `/todo Tn` is `agent: run`.

Out:
- Before, amend, move (T-STK-02); stop, resume, retry, drop (T-STK-05); steer (T-STK-06); answers and Needs you kinds (T-STK-07); merge (T-STK-04); Make TODO from an issue and the label door (T-STK-09); the `stack_attention` writers (T-GH-05, T-GH-07).
- The Home and TODO cards (T-APP-01, T-APP-02); the live channel transport (T-COL-02).
- A second stack engine. `mythical_items` stays the engine's work record; this ticket adds no worker.

## Changes
- `packages/backend/db/product/migrations/0104_todos.sql` (new; next free number at landing) → the tables of §3, with `todos.number` sequential per install, `todos.stack_position` (append keys only; T-STK-02 adds placement), a `todos.state` CHECK over the nine states and `todo_events(todo_id, seq)` unique. Add `mythical_items.todo_id uuid UNIQUE REFERENCES todos` and `mythical_items.paused_at`. Relax `mythical_items_issue_idx` (`0026_mythical_stacks.sql:120-122`) so the issue number is a link, not the item's identity.
- Backfill in the same migration: one `todos` row and one `branches` row per existing item that a member committed, with state per §4.1.0. `skipped` items (issues no member acted on, M-16) get no TODO. Each open PR's head branch is copied into `branches.github_branch`, so no in-flight item opens a second PR.
- `packages/backend/db/product/queries/todos.sql` (new, sqlc) → insert, conditional state update (`WHERE version = $v`), event append, list in `stack_position` order.
- `packages/backend/internal/services/todo_state.go` (new) → `Transition(from, trigger, guard) (Event, error)` over §4.1, and `ProjectItemState(item, todo)` implementing §4.1.0. The engine writes `starting` at the machine grant and `working` when the runtime reports the run's first step. `advanceItems` (`services/mythical_items.go:1061`) skips an item whose TODO is `paused` or `needs_you`.
- `packages/backend/db/product/migrations/<next>_projection_events.sql` and `<next>_activity.sql` (new) → `projection_events(topic, seq, at, payload)` with a per-topic monotonic `seq` and the §3.3 retention job; `activity` with the full §3 shape (`burst_id`, `snapshot_before`, `snapshot_after` and `files` stay null until S2).
- `packages/backend/internal/services/projection.go` (new) → `Publish(tx, topic, payload)` appends the row and queues `NOTIFY live, '<topic>'` for commit. Every card-visible writer in the backend calls it. Shared topics carry only shared state (§7.2.2).
- `packages/backend/internal/services/activity.go` (new) → `Append(tx, branch, actor, kind, summary)` writing the row and its `branch:<id>:activity` event; agent steps come from the runtime projection (`ProjectFlowRuntime`, `services/mythical_items.go:577`).
- `packages/backend/internal/services/todo_service.go` (new) → every state write runs `Transition`, saves `todos`, appends `todo_events` and writes one `projection_events` row per affected topic (`todo:<n>`, `home`) through `Publish` in the same transaction (§3.1). The engine writes in `mythical_items.go` (`commit` :1437, `releaseLane` :1182, `mythicalLanded` :3118, `follow` :2163) call it inside their transaction.
- `packages/backend/internal/routes/todos.go` (new), mounted in `internal/compose/router.go` → `GET/POST /api/todos`, `GET /api/todos/{n}` and `GET /api/branches/{b}/activity`. POST requires `Idempotency-Key` (§6.2.1) and returns `202 {state:"requested"}` (§6.2.2); errors use the typed envelope (§6.2.3).
- Delete: `MythicalService.FileTodo` GitHub-issue creation (`services/mythical_file_todo.go:45`), route `POST /mythical/todos` (`router.go:1122`, `routes/mythical.go:293`), its OpenAPI row (`docs/api/openapi/repositories.yaml:12212`), `history.todo` (`apps/app/src/mainview/flows/entries/history.ts:87`) and `StackSeam.fileTodo` (`apps/app/src/mainview/state/seams/StackSeam.ts:767`). Chat TODOs have no issue.
- `docs/api/openapi/todos.yaml` (new, with the activity route), referenced from `docs/api/openapi.yaml`; regenerate `packages/smithers/src/internal/backend/ProductApi.ts` with `smthrs run //:openapiClients`.
- `packages/rpc/src/Todo.ts` (new) → wire schema with the nine states and the §14.3 TODO fields. `packages/rpc/src/StackIssues.ts:45` stops grouping `proposed` as Needs you; the old groups go when T-APP-01 moves the Home card.
- `packages/backend/docs/todos.md` (new) → states and routes; run `pnpm docs:sync`, `pnpm docs:check` and `smthrs docs //packages/backend:docs`.

## Tests
- Unit, `packages/backend/internal/services/todo_state_test.go` (new), for C-STK-01: `ProjectItemState` for all 15 item states × open `needs_you` × set `paused_at` × launched-without-first-step, against a table written from §4.1.0.
- Unit, same file: every engine guard that decides a transition allows only the §4.1 rows and returns exactly one event per allowed case.
- Integration with real PostgreSQL, `todo_service_db_test.go` (new, `newProductTestPool`): a refused transition writes no `todos`, `todo_events` or `projection_events` row; an allowed one writes all three in one transaction; a concurrent writer with a stale `version` loses.
- Integration, `projection_db_test.go` (new): `seq` is gap-free per topic under 20 concurrent writers; a rolled-back transaction leaves no row and sends no `NOTIFY`; retention keeps the larger of 24 h and 10,000 rows.
- Integration, `activity_db_test.go` (new): an agent step from the runtime projection appends one `step` entry; a system write with a requester stores both actors; `GET /api/branches/{b}/activity` returns the last 200 in order.
- Integration, same file: the backfill maps a fixture of the other 14 item states per §4.1.0, makes no TODO for a `skipped` item, and keeps an open PR's head branch in `branches.github_branch`.
- Integration, `routes/todos_test.go` (new): POST with a repeated `Idempotency-Key` returns the first TODO, and no GitHub call is made.

## Acceptance
- [C-STK-01](../checks/C-STK-01.md): the projection is exhaustive, and the engine's guards allow only §4.1's transitions, each with an event.
- [C-UI-05](../checks/C-UI-05.md): no TODO state reaches a subscriber before its `todo_events` row commits.
- [C-J1-04](../checks/C-J1-04.md): First TODO to merged PR, unassisted, within 60 minutes of starting the install

## Risks and notes
- Risk: an engine path writes `mythical_items.state` outside `todo_service`, so `todos.state` drifts. Observation: an integration run where `ProjectItemState(item) != todos.state` after any worker pass. Add that assertion to the worker tests.
- Risk: Plue composes this backend and holds `mythical_items` rows, so the backfill changes its data. Confirm the backfill with the tech lead before landing.
- `skipped` items stay `mythical_items` rows without a TODO. A member's `todo` label or Make TODO commits them (T-STK-09).
- Do not decide alone: whether the `/api/repos/{o}/{r}/mythical*` read routes stay until T-APP-08 deletes their last consumer (proposed: yes).
