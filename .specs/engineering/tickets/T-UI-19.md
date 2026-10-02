# T-UI-19 Co-editing visuals

Stage S3 · Size M · Depends on T-UI-01, T-APP-19 · Unblocks T-MNT-02, T-MNT-04, T-APP-14 · Issue: to file
Spec: spec.md §14.2.1, §7.3, §7.6, §14.3 (File S3) · Delta: delta.md §9 · Product: mvp.md J3.2, J8, §6.8 · Props: [ui-components.md § T-UI-19](../ui-components.md)

## Goal

The co-editing visuals exist on `CodeEditorView` as props-only visual extensions matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-14 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- On `CodeEditorView` in live mode: install the `EditorBinding` extensions; author colours from the `authorRanges` facet and `authors`; gutter name flags from `editors`, agents included; the Saved state; and "N edits weren't saved" with Reapply and Copy. Design writes every visual extension, and engineering's binding (T-APP-14) adds none.
- Props exactly as `ui-components.md` § T-UI-19 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
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
- [C-J3-04](../checks/C-J3-04.md): Two people co-edit one file, including typing on the same line (both apply): < 1 s, author colours, name flags, saved within 1 s; an outside save merges in, or on overlap shows "Changed outside Smithers · Compare" with the outside version kept, whichever comes first, the watcher or the save

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
