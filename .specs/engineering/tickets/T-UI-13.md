# T-UI-13 Agent card and model roles

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-FLW-08, T-UI-02, T-REL-02 · Issue: [#3550](https://github.com/smithersai/smithers/issues/3550)
Spec: spec.md §14.2.1, §11.5a, §15 · Delta: delta.md §9 · Product: mvp.md J11, §11 item 3 · Props: [ui-components.md § T-UI-13](../ui-components.md)

Restore, not new code (minimal-code synthesis v2 ruling 5).

## Goal

The owner assigns a model to each of the three roles from the restored model-assignment card, and the Agent card stays the existing `cards/AgentCards.tsx`. No new `AgentView`.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns the visuals. Engineering wires model writes in T-FLW-08.

## Scope

In:
- Restore the model-assignment slice from `39e43c0f^`, without the laboratory:
  - `apps/app/src/mainview/cards/ModelCards.tsx` (365 lines then): `Seats` (lines 243-279), `ModelsCardBody` without the laboratory rows, and `modelCardFamily` with the `models` kind only;
  - `apps/app/src/mainview/flows/entries/model.ts` (209 lines then): `model.list` and `model.assign` (lines 198-208);
  - `apps/app/src/mainview/state/controller/models.ts` (473 lines then; 25 today): `listModels` and `assignSeat`.
- Reshape the restored slice to the product contract: seats render as "Fast model", "Coding model" and "Decisions" (role id `jev`), and the assign entry takes the catalog tag `settings.model.set` with `{role, model}` (Appendix B.4, product 79eb1a66), owner session only, never an agent.
- `SettingsView`'s model slot (T-UI-02) renders this card.
- The Agent card is `cards/AgentCards.tsx`: the three roles with their model, the instructions path and runs. Edit instructions forwards the supplied Draft-opening action with prefilled text, never `todo.new`.

Out:
- The laboratory: the `model-call` kind, `ObservedModelCall`, `model.compose`, `model.ask`, `model.recall`, `model.fixture`, `model.prompt`, `model.state`, `model.question` and `model.option` stay deleted.
- Key entry, provider tests, persistence, fallback and effective-model selection (T-INS-06, T-FLW-08); tools, permissions and budgets.

## Changes

- Restore the three slices above with `git show 39e43c0f^:<path>`; register `modelCardFamily` in `cards/CardRenderers.tsx`.
- Delete `apps/app/src/mainview/cards/views/SettingsModels.tsx` (786f9ac54) as the duplicate, and its import in `views/SettingsView.tsx`.

## Tests

Restore the matching tests from `39e43c0f^` for the kept slice, then cover:
- the literal "Fast model", "Coding model" and "Decisions" labels, with no laboratory control;
- Assign dispatches `settings.model.set` once with the literal `{role, model}`; a non-owner sees no Assign control;
- a record that is gone stays visible in its seat;
- Edit instructions emits the Draft-opening action with the literal prefilled text and never `todo.new`.

## Acceptance

- The tests above pass in CI at the landed SHA.
- [C-UI-13](../checks/C-UI-13.md): the model-assignment card is reachable from `CardRenderers`; `views/SettingsModels.tsx` is deleted.

## Risks and notes

- The restored controller predates the role names. Keep its fetch and error handling; change only labels, tag and arguments.
