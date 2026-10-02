# T-STK-13 TODO projection for independent waits and attached resumed runs

Stage S1 · Size M · Depends on T-STK-01 · Unblocks — · Issue: to file
Spec: spec.md §2, §3, §3.1, §3.2, §3.3, §4.1, §4.1.0, §4.1.0a, §4.1.2a, §6.2, §6.3, §7.2, §8.1.1, §10.1, §15.1.5, §19.3 · Delta: delta.md §6 (Add tables, state machine), §4 (`activity` table [S1]) · Product: mvp.md §3 (TODO `T12`), §4.1, §6.6, J1.6, J2.3, M-07, M-16, E-07 (overview)

## Goal

Project independent waits and resumed or re-admitted runs without waiting for a new first step.

## Scope

In:
- The §4.1.0 projection of the 15 `mythical_items.state` values, written by the engine in the same transaction as the item change. `queued` and `skipped` project to `queued`; a launched or re-admitted item whose run isn't attached yet projects to `starting`; open waits and a set `paused_at` override a non-terminal item state in the §4.1.0a order (needs_you, then paused, then failed); terminal item states always win.

Out:
- The landed scope of T-STK-01, except the follow-up changes stated here.

## Changes

- `packages/backend/internal/services/todo_state.go` (new) → `Transition(from, trigger, guard) (Event, error)` over §4.1, and `ProjectItemState(item, todo)` implementing §4.1.0. The engine writes `starting` at the machine grant and `working` when the coding host reports the run attached (`run_attached`, §4.1): a new run's first step, or a resumed or re-admitted run continuing. `advanceItems` (`services/mythical_items.go:1061`) skips an item whose TODO is `paused` or `needs_you`.
- Apply the moved header references after T-STK-01 lands:

Stage S1 · Size L · Depends on — · Unblocks T-ACC-02, T-ACC-06, T-STK-02, T-STK-04, T-STK-12, T-STK-05, T-STK-06, T-STK-07, T-GH-03, T-FLW-04, T-FLW-11, T-MCH-14, T-MCH-04, T-COL-02, T-APP-08, T-APP-01, T-APP-02, T-REL-03 · Issue: [#3433](https://github.com/smithersai/smithers/issues/3433)
Spec: spec.md §2, §3, §3.1, §3.2, §3.3, §4.1, §4.1.0, §4.1.0a, §4.1.2a, §6.2, §6.3, §7.2, §8.1.1, §10.1, §15.1.5, §19.3 · Delta: delta.md §6 (Add tables, state machine), §4 (`activity` table [S1]) · Product: mvp.md §3 (TODO `T12`), §4.1, §6.6, J1.6, J2.3, M-07, M-16, E-07 (overview)

## Tests

- Unit, `packages/backend/internal/services/todo_state_test.go` (new), for C-STK-01: `ProjectItemState` for all 15 item states × open waits (none, one run wait, one branch wait, both) × set `paused_at` × launched-not-attached, against a table written from §4.1.0 and §4.1.0a.

## Acceptance

- [C-STK-01](../checks/C-STK-01.md): projection table covers independent waits and launched-not-attached runs; terminal states win.

## Risks and notes

- Terminal precedence remains in T-STK-01 under the product exception. The scope above retains the full changed line verbatim for context; this ticket adds the remaining wait and attachment rules.
