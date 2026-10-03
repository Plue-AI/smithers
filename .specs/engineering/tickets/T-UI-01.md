# T-UI-01 Primitives: actor chip, state word, tone

Stage S1 · Size S · Depends on T-APP-19 · Unblocks T-AGT-03, T-APP-09, T-REL-02, T-UI-02, T-UI-03, T-UI-04, T-UI-05, T-UI-06, T-UI-07, T-UI-08, T-UI-09, T-UI-10, T-UI-11, T-UI-12, T-UI-13, T-UI-15, T-UI-16, T-UI-17, T-UI-18, T-UI-19, T-UI-20, T-UI-21, T-UI-22 · Issue: [#3538](https://github.com/smithersai/smithers/issues/3538)
Spec: spec.md §14.2.1, §14.6a, §14.5.2, §4.1 · Delta: delta.md §9 · Product: mvp.md §3, B.3 · Props: [ui-components.md § T-UI-01](../ui-components.md)

## Goal

`ActorChip`, `StateWord` and the tone tokens exist as props-only components matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-09 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `ActorChip` for every `Actor` (ui-components.md shared types, §14.6a): a person with an SSH, terminal or CLI badge; each agent participant with its own avatar (coding agent, reviewer, Claude Code, Codex, another external agent) and "for Ben" when it acts for someone (M-34); Smithers and "Smithers, for Ben"; @login; outside; the `live` pulse; the eight `color_index` colours. `StateWord` for the nine TODO states with the step; the five tones as Paper tokens in light and dark, per the ui-components.md Tone table.
- Props exactly as `ui-components.md` § T-UI-01 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).

## Changes

- Actor chip replacing `cards/Actor.tsx`, with mock `mvp-avatar*` rules on Paper tokens and names from `actorName` (T-APP-09). Check: C-UI-12.


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
