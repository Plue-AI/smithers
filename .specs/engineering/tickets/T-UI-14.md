# T-UI-14 Commands view (/help)

Stage S1 · Size S · Depends on T-UI-01, T-APP-19 · Unblocks T-CAT-01, T-REL-02 · Issue: [#3551](https://github.com/smithersai/smithers/issues/3551)
Spec: spec.md §14.2.1, §6.1 · Delta: delta.md §9 · Product: mvp.md Appendix B · Props: [ui-components.md § T-UI-14](../ui-components.md)

## Goal

`CommandsView` exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-CAT-01 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `CommandsView`: groups, the collapsed Advanced group, and each command's synopsis, description and run, confirm or never mark.
- Props exactly as `ui-components.md` § T-UI-14 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).

## Changes

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
