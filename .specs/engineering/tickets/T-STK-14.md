# T-STK-14 Existing-item backfill and Plue confirmation

Stage S1 · Size M · Depends on T-STK-01 · Unblocks T-REL-02, T-STK-09 · Issue: [#3535](https://github.com/smithersai/smithers/issues/3535)
Spec: spec.md §3, §4.1.0 · Delta: delta.md §6 · Product: mvp.md M-16, M-31

## Goal
Backfill existing mythical_items without creating duplicate TODOs or PRs. Obtain the tech lead's Plue confirmation before landing.

## Scope
In:
- Scope moves by reference from frozen T-STK-01; do not edit that ticket. The source bullets are quoted verbatim below.
> - Backfill in the same migration: one `todos` row and one `branches` row per existing item that a member committed, with state per §4.1.0. `skipped` items (issues no member acted on, M-16) get no TODO. Each open PR's head branch is copied into `branches.github_branch`, so no in-flight item opens a second PR.
> - Integration, same file: the backfill maps a fixture of the other 14 item states per §4.1.0, makes no TODO for a `skipped` item, and keeps an open PR's head branch in `branches.github_branch`.
> - Risk: Plue composes this backend and holds `mythical_items` rows, so the backfill changes its data. Confirm the backfill with the tech lead before landing.

Out:
- New-install schema, transition writer and projections remain in T-STK-01.
- J1/J2 fresh-install gates do not depend on this ticket.
- Live GitHub issue sweeps, new admission, issue-text trust changes, PR creation or updates, run launch, terminal access and View changes. T-STK-09 owns skipped-row deletion and the later NOT NULL constraint.

## Changes
- After T-STK-01 lands, add the next forward-only SQL migration under `packages/backend/db/product/migrations/` and register it with `packages/backend/db/product/migrate.go`. Apply it through the production migration runner over T-STK-01's real schema. The quoted "same migration" instruction describes the source scope; this follow-up owns its landing. Do not change an already-recorded migration checksum.
- Check for work already delivered by the frozen lane and implement only the remaining backfill. Keep existing PR heads and member-commit identity.
- smithers-8a confirms Plue data treatment; smithers-3f pre-reviews migration safety. Record confirmation before landing.

## Tests
- C-STK-01 integration extension in `packages/backend/db/product/todo_backfill_db_test.go` (new), real PostgreSQL: seed the pre-backfill schema with literal existing-item fixtures, then invoke the production `product.Apply` migration runner. Cover the 14 non-skipped states, skipped exclusion and open-PR branch preservation. Assert literal counts, state and branch identity, member-commit attribution and retained PR number/head. Invoke Apply again and assert no duplicate TODO or branch and unchanged PR identity. Neither expected states nor member-commit identity are derived from spec files or production projection code at runtime.

## Acceptance
- C-STK-01 backfill integration rows pass with recorded Plue confirmation.
- Land before dogfood (M-31). No J1/J2 dependency is added.

## Risks and notes
- T-STK-01 is frozen. This reference assigns follow-up ownership without changing its file or reopening its Ready stamp.

## Ready checklist
1. Dependencies: T-STK-01 supplies the new schema and migration ledger contract. No other runtime writer is needed for this SQL-only backfill. T-STK-09 depends on this ticket before deleting skipped rows and setting NOT NULL; J1/J2 fresh-install gates stay independent.
2. Exclusions: Scope explicitly excludes new-install schema, projections, issue sweeps, admission, trust changes, GitHub writes, run launch, terminal access and Views.
3. Boundary tests: C-STK-01's backfill extension invokes product.Apply on real PostgreSQL, including a second startup application, with checked-in literal old rows and expected identities/states. It tests the registered production migration, not a copied SQL statement or the projection function. No runtime spec or implementation-derived expectation is allowed.
4. Decisions: smithers-8a confirms Plue's member-commit classification and treatment of existing rows before landing; unresolved identities must be decided in that confirmation, not guessed by the migration. smithers-3f accepts migration ordering, registration and safety before start. Record both decisions with the ticket.
5. Owner pre-review before start: smithers-3f: Does the registered forward-only migration preserve each member-committed item's TODO, branch and open PR identity? Does it handle already-backfilled rows without duplicates or checksum changes? Does its order precede T-STK-09's skipped-row deletion and NOT NULL constraint? No app or View code is changed.
6. Security: smithers-3f reviews that the backfill only transforms database rows and performs no repository-code execution, GitHub call or run admission. SQL migration tests use literal data. Any later work on a migrated TODO must use the machine-only execution path of §1.3 (M-29); this ticket provides no host execution path.
