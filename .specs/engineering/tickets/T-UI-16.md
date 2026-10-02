# T-UI-16 File and Diff live states

Stage S2 · Size S · Depends on T-UI-01, T-APP-19 · Unblocks T-APP-11 · Issue: to file
Spec: spec.md §14.2.1, §9.2.3, §9.3.5 · Delta: delta.md §9 · Product: mvp.md J3.4, §6.8 · Props: [ui-components.md § T-UI-16](../ui-components.md)

## Goal

The File and Diff live states exist in `CodeEditorView` and `DiffView` as props-only states matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-11 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- The deleted banner with Restore and the renamed banner with Follow (`gone`), the snapshot caption, the "Changed outside Smithers" flag with Compare against the outside `version`, and the Compare view.
- Props exactly as `ui-components.md` § T-UI-16 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
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

- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.
- [C-J3-08](../checks/C-J3-08.md): File deleted or renamed while open: the card says so; Restore and Follow work

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
