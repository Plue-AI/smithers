# T-UI-08 Toasts, edge map and timeline

Stage S1 · Size M · Depends on T-UI-01, T-APP-19 · Unblocks T-APP-07, T-APP-18, T-REL-02 · Issue: [#3545](https://github.com/smithersai/smithers/issues/3545)
Spec: spec.md §14.2.1, §14.4, §14.5.4, §14.6 · Delta: delta.md §9 · Product: mvp.md §6.4 · Props: [ui-components.md § T-UI-08](../ui-components.md)

## Goal

`ToastStack`, `EdgeMap` and `Timeline` exist as props-only components matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-07, T-APP-18 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `ToastStack` (three plus "+N more", one action each, hide), `EdgeMap` (two rows plus a count per edge, one pill on narrow screens), `Timeline` with the band, and the Allow notifications toast variant (S2).
- Props exactly as `ui-components.md` § T-UI-08 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).

## Changes

- Timeline, band, pins, pills, 1,180 px breakpoint, ToastStack replacement and Allow notifications. Check: C-UI-12.


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
