# T-UI-02 Setup and Settings views

Stage S1 · Size M · Depends on T-UI-01, T-APP-19 · Unblocks T-APP-03, T-FLW-12, T-REL-02 · Issue: [#3539](https://github.com/smithersai/smithers/issues/3539)
Spec: spec.md §14.2.1, §12.1.1, §14.3 (Setup / Settings), §8.2.1 · Delta: delta.md §9 · Product: mvp.md J1, §6.1 · Props: [ui-components.md § T-UI-02](../ui-components.md)

## Goal

`SetupView` and `SettingsView` exist as props-only Views matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-03 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `SetupView`: the seven steps in §16.2 order (`address`, `app` with the owning account, `sign_in`, `repository` with the squash check, `models`, `source`, `machine`), each pending, running, done, blocked with its fix link, or failed with Retry; Address; This Mac with the limiting term and its fix when capacity is 0; the three model roles ("Fast model", "Coding model" and "Jev" with its "AI Gateway key") with each key's state and error; Source and Machine percentages. `SettingsView`: the same plus the Machines and TODOs at once steppers, the laptop-agent lines, health (process, PostgreSQL size, disk free, GitHub sync and rate budget), "Notifications need HTTPS ↗" on a plain-HTTP origin, and the Obsidian folder with its last sync (S2 data, built now from fixtures).
- Props exactly as `ui-components.md` § T-UI-02 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).

## Changes

- Setup and Settings rows, unencrypted mark, This Mac, Obsidian row and Add to machine image. Check: C-UI-12.


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
