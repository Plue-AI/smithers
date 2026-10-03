# T-UI-06 Home view with the main sync row

Stage S1 · Size M · Depends on T-UI-01, T-APP-19 · Unblocks T-APP-01, T-GH-08, T-REL-02 · Issue: [#3543](https://github.com/smithersai/smithers/issues/3543)
Spec: spec.md §14.2.1, §4.1.2a, §12.6, §14.3 (Home) · Delta: delta.md §9 · Product: mvp.md J4, J10.6 · Props: [ui-components.md § T-UI-06](../ui-components.md)

## Goal

`HomeView`, with the `main` sync row, exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-01, T-GH-08 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `HomeView`: the `main` row in each sync health (fresh: synced ago; stale: gold with Retry; limited: when it retries; refused: the cause with Fix), attention rows, stack rows with their actions, `present` avatars (agents included), elapsed, Rebase pending and the `merge` reason, counts as filters, merged since last look, machine slots with who holds each, and background runs queued, running, waiting or failed with Retry and Dismiss.
- Props exactly as `ui-components.md` § T-UI-06 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).

## Changes

- Home `mvp-stack*`, `mvp-filter*`, `mvp-machines` and synced N s ago from `last_success_at` on a 1 s clock. Check: C-UI-12.


- `apps/app/src/mainview/cards/views/<Card>View.tsx` and CSS, or `@smthrs/ui` for shared primitives. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
- Fixtures from `@smthrs/rpc` (`packages/rpc/test/fixtures/`, written with T-APP-19).

## Tests

- unit (C-UI-12): every fixture of the card renders with its actions and shows its `expect` strings, in light and dark at 1280 and 390 px; each press calls `onAction` or `onView` once. The View-seam rule passes on the View's file (C-UI-08).
- copy: C-UI-02 (T-CAT-01's term list) renders every card fixture, this View's included once it lands. No test reads `.specs/`.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
