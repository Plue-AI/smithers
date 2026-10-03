# T-UI-06 Home view with the main sync row

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-APP-01, T-GH-07 · Issue: [#3543](https://github.com/smithersai/smithers/issues/3543)
Spec: spec.md §14.2.1, §4.1.2a, §12.6, §14.3 (Home) · Delta: delta.md §9 · Product: mvp.md J4, J10.6 · Props: [ui-components.md § T-UI-06](../ui-components.md)

Landed (ab2ab5e0b).

## Goal

`HomeView` renders the `main` sync row, attention, the stack, machines and background runs from props, so T-APP-01 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-01 and T-GH-07.

## Scope

In:
- Landed: the `main` row in each sync health (fresh: synced ago; stale: gold with Retry; limited: when it retries; refused: the cause with Fix), attention rows, stack rows with their actions, `present` avatars, elapsed on the shared 1 s `useClock`, Rebase pending and the `merge` reason, counts as filters, merged since last look, machine slots, and background runs with Retry and Dismiss. Reset to GitHub main renders only when supplied.
- Remaining:
  - Fold `views/HomeRowView.tsx` (with `HomeFilterView`) and `views/HomeActionView.tsx` into `HomeView.tsx`; each has one caller (minimal-code synthesis v1 §6).
  - Merge `apps/app/src/mainview/styles/views/home.css` into `styles/cards.css` and drop the `mvp-` prefix (`mvp-stack*`, `mvp-filter*`, `mvp-machines`).

Out:
- Polling, sync health, machine admission, background-run launch or dismissal, last-look persistence, attention authorization and the reset itself (T-APP-01, T-GH-07).

## Changes

- Inline `HomeRowView`, `HomeFilterView` and `HomeActionView` in `views/HomeView.tsx`; delete both files.
- Move `styles/views/home.css` into `styles/cards.css`, renaming `mvp-` classes; delete it and its import in `styles/views.css`.
- Mounting: T-APP-01 mounts `HomeView` through the landed `cards/HomeContainer.tsx` and deletes `cards/StackCard.tsx` and `cards/RepositoryHomeCard.tsx` in the same change (pair: HomeView; v1 §2, v2).

## Tests

The Home cases in `apps/app/src/mainview/cards/views/Views.test.tsx` cover:
- fresh, stale, limited and refused sync rows; with a fixed clock and literal `last_success_at`, the literal synced-age text before and after one second, with no command sent;
- attention and failed background-run Retry and Dismiss dispatch their literal tags and arguments once;
- with a supplied reset action, Reset to GitHub main dispatches once; without it, there is no reset control;
- clicking a count emits its literal `onView` patch;
- agent presence, queue reasons and zero capacity.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA. `HomeRowView.tsx`, `HomeActionView.tsx` and `styles/views/home.css` are gone.

## Risks and notes

- v2 ruling: if T-APP-01 does not mount HomeView, revert ab2ab5e0b rather than keep two Home stacks.
