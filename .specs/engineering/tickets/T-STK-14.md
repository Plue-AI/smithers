# T-STK-14 Existing-item backfill and Plue confirmation

Stage S1 · Size M · Depends on T-STK-01 · Unblocks T-REL-02 · Issue: [#3535](https://github.com/smithersai/smithers/issues/3535)
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

## Changes
- After T-STK-01 lands, apply the backfill in the next migration over its real schema. The quoted "same migration" instruction describes the source scope; this follow-up owns its landing.
- Check for work already delivered by the frozen lane and implement only the remaining backfill. Keep existing PR heads and member-commit identity.
- smithers-8a confirms Plue data treatment; smithers-3f pre-reviews migration safety. Record confirmation before landing.

## Tests
- C-STK-01 integration extension in `todo_backfill_db_test.go`, real PostgreSQL: migrate literal existing-item fixtures through the production migrations; cover the 14 non-skipped states, skipped exclusion and open-PR branch preservation. Assert counts, state and branch identity; read no spec file at runtime.

## Acceptance
- C-STK-01 backfill integration rows pass with recorded Plue confirmation.
- Land before dogfood (M-31). No J1/J2 dependency is added.

## Risks and notes
- T-STK-01 is frozen. This reference assigns follow-up ownership without changing its file or reopening its Ready stamp.
