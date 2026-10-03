# T-UI-01 Primitives: actor chip, state word, tone

Stage S1 · Size S · Depends on T-APP-19 (landed) · Unblocks T-AGT-03, T-APP-09, T-REL-02, T-UI-02, T-UI-03, T-UI-04, T-UI-05, T-UI-06, T-UI-07, T-UI-08, T-UI-09, T-UI-10, T-UI-11, T-UI-12, T-UI-13, T-UI-15, T-UI-16, T-UI-17, T-UI-18, T-UI-19, T-UI-20, T-UI-21, T-UI-22 · Issue: [#3538](https://github.com/smithersai/smithers/issues/3538)
Spec: spec.md §14.2.1, §14.6a, §14.5.2, §4.1 · Delta: delta.md §9 · Product: mvp.md §3, B.3 · Props: [ui-components.md § T-UI-01](../ui-components.md)

Landed (788a3ad7e, ad4d02f45).

## Goal

`ActorChip`, `StateWord` and the tone tokens exist as props-only components, so wiring tickets only bind data.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-09.

## Scope

In:
- `ActorChip` for every `Actor` (§14.6a): a person with an SSH, terminal or CLI badge; each agent with its own avatar and "for Ben" when it acts for someone (M-34); Smithers and "Smithers, for Ben"; @login; outside; the `live` pulse; the eight `color_index` colours. `StateWord` for the nine TODO states with the step. The five tones as Paper tokens in light and dark.
- Remaining: merge `apps/app/src/mainview/styles/views/primitives.css` into `styles/cards.css` and drop the `mvp-` prefix (minimal-code synthesis v1 §6).

Out:
- Actor labels. `views/actorName.ts` duplicates the app's actor-label module; T-APP-09 deletes it and keeps one (v1 §6).
- Topic subscriptions, commands, permissions and copy decisions (§14.6b).

## Changes

- Move the rules from `styles/views/primitives.css` into `styles/cards.css`, renaming `mvp-avatar*`, `mvp-state*` and the other `mvp-` classes, and update `ActorChip.tsx` and `StateWord.tsx`. Delete `primitives.css` and its import in `styles/views.css`.

## Tests

`apps/app/src/mainview/cards/views/ActorChip.test.tsx` and the primitives cases in `Views.test.tsx` cover:
- each actor kind renders its literal label and badge, including "Smithers, for Ben";
- each of the nine states renders its literal word and step;
- each tone resolves to its literal Paper token name in light and dark.

## Acceptance

- The tests above pass in CI at the landed SHA. No `mvp-` class or `styles/views/primitives.css` remains.

## Risks and notes

- A prop the components need and `ui-components.md` lacks is a spec change for the tech lead.
