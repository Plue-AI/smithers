# T-UI-11 Code editor and Diff views (read-only)

Stage S1 · Size L · Depends on T-UI-01, T-APP-19 · Unblocks T-APP-15, T-REL-02 · Issue: [#3548](https://github.com/smithersai/smithers/issues/3548)
Spec: spec.md §14.2.1, §7.6, §14.3 (File, Diff) · Delta: delta.md §9 · Product: mvp.md J1.5, J9, M-02 · Props: [ui-components.md § T-UI-11](../ui-components.md)

## Goal

`CodeEditorView` (read-only) and `DiffView` exist as props-only Views matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-15 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `CodeEditorView` in `@smthrs/ui` (CodeMirror 6, Paper theme, hover and diagnostics visuals) in read-only mode: text, too-large and binary contents, the hover result, `reveal`, the `hover` and `definition` gestures with `{path, line, col}`, the cursor line through `onView`, and a changed text applied as one minimal transaction with no remount. `DiffView` with hunks and line numbers against an item base, a fork revision or one burst, with Restore this file on a burst diff.
- Props exactly as `ui-components.md` § T-UI-11 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).

## Changes

- Paper highlight theme, hover tooltip, diagnostics, definition keymap and `@codemirror/*` pins; update `@smthrs/ui` docs. Check: C-UI-12.


- `apps/app/src/mainview/cards/views/<Card>View.tsx` and CSS, or `@smthrs/ui` for shared primitives. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
- Fixtures from `@smthrs/rpc` (`packages/rpc/test/fixtures/`, written with T-APP-19).

## Tests

- C-UI-12: five-language screenshot comparison; log the 1 MiB first viewport under 300 ms.


- unit (C-UI-12): every fixture of the card renders with its actions and shows its `expect` strings, in light and dark at 1280 and 390 px; each press calls `onAction` or `onView` once. The View-seam rule passes on the View's file (C-UI-08).
- copy: C-UI-02 (T-CAT-01's term list) renders every card fixture, this View's included once it lands. No test reads `.specs/`.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the mock needs but `ui-components.md` lacks is a spec change: raise it with the tech lead before building around it.
