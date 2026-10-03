# T-STK-14 Existing-item backfill and Plue confirmation

Stage S1 · Size M · Depends on T-STK-01 · Unblocks T-REL-02, T-STK-09 · Issue: [#3535](https://github.com/smithersai/smithers/issues/3535)
Spec: spec.md §3, §4.1.0 · Delta: delta.md §6 · Product: mvp.md M-16, M-31

## Goal
Backfill existing mythical_items without creating duplicate TODOs or PRs. Obtain the tech lead's Plue confirmation before landing.

## Scope

- Apply the existing retained-work classification, not a member identity inferred from nonexistent columns. Keep the quoted frozen source scope unchanged; the implemented predicate and system actor above govern this follow-up. Check: C-STK-01.
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
- Check for work already delivered by the frozen lane and implement only the remaining backfill. Keep existing PR heads. Classify retained work with `state <> 'skipped' AND NOT (issue AND cancelled AND approved_digest = '')`; no member source column exists. Attribute backfill as `{"system":"backfill"}`. Use the idempotency predicate `WHERE mythical_items.todo_id IS NULL`. Check: C-STK-01.
- smithers-8a confirms Plue data treatment; smithers-3f pre-reviews migration safety. Record confirmation before landing.

## Tests
- C-STK-01 integration extension in `packages/backend/db/product/todo_backfill_db_test.go` (new), real PostgreSQL: seed literal pre-backfill rows and invoke the registered production `product.Apply` migration. Cover retained states under `state <> 'skipped' AND NOT (issue AND cancelled AND approved_digest = '')`, skipped exclusion and cancelled issue rows with empty approved_digest. Assert literal TODO/branch counts, states, `{"system":"backfill"}` actor and retained PR number/head. Seed a fixture where 0105’s backfill already ran; the forward migration’s `WHERE mythical_items.todo_id IS NULL` inserts zero new TODO or branch rows. Do not use a second Apply call as proof: the ledger skips applied versions. Expected values come from literal fixtures, not spec files or production helpers.

## Acceptance
- C-STK-01 backfill integration rows pass with recorded Plue confirmation.
- Land before dogfood (M-31). No J1/J2 dependency is added.

## Risks and notes
- T-STK-01 is frozen. This reference assigns follow-up ownership without changing its file or reopening its Ready stamp.

## Ready checklist
1. Dependencies: T-STK-01 supplies the new schema and migration ledger contract. No other runtime writer is needed for this SQL-only backfill. T-STK-09 depends on this ticket before deleting skipped rows and setting NOT NULL; J1/J2 fresh-install gates stay independent.
2. Exclusions: Scope explicitly excludes new-install schema, projections, issue sweeps, admission, trust changes, GitHub writes, run launch, terminal access and Views.
3. Boundary tests: C-STK-01's backfill extension invokes product.Apply on real PostgreSQL, including a fixture where 0105 already backfilled the rows, with checked-in literal old rows and expected identities/states. It tests the registered production migration, not a copied SQL statement or the projection function. No runtime spec or implementation-derived expectation is allowed.
4. Decisions: smithers-8a confirms Plue’s retained-work classification and treatment of existing rows before landing; unresolved identities must be decided in that confirmation, not guessed by the migration. smithers-3f accepts migration ordering, registration and safety before start. Record both decisions with the ticket.
5. Owner pre-review before start: smithers-3f: Does the registered forward-only migration preserve each member-committed item's TODO, branch and open PR identity? Does it handle already-backfilled rows without duplicates or checksum changes? Does its order precede T-STK-09's skipped-row deletion and NOT NULL constraint? No app or View code is changed. smithers-3f: answered, BLOCKING edits applied (tech lead adopts).
6. Security: smithers-3f reviews that the backfill only transforms database rows and performs no repository-code execution, GitHub call or run admission. SQL migration tests use literal data. Any later work on a migrated TODO must use the machine-only execution path of §1.3 (M-29); this ticket provides no host execution path.
