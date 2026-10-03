# T-UI-03 Draft view

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-APP-02, T-REL-02 · Issue: [#3540](https://github.com/smithersai/smithers/issues/3540)
Spec: spec.md §14.2.1, §14.3 (TODO), §14.5.1 (private Draft) · Delta: delta.md §9 · Product: mvp.md J2.1, J7 · Props: [ui-components.md § T-UI-03](../ui-components.md)

Landed (f18e88958, fbf7c98f7, c60db0f4b).

## Goal

`DraftView` renders the §14.3 Draft from props, so T-APP-02 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-02.

## Scope

In:
- Landed: title, prompt, acceptance, the linked issue with its fixes toggle, the place picker (Append, Before Tn, Amend Tn), a read-only seed, Commit and Discard; the "Only you" lock chip until Commit, then the committed receipt. `gestures.set` sends `{field, value}` on blur with string values. Discard binds `draft.discard` with `{draft}` for the author only and never drops a TODO.
- Remaining: merge `apps/app/src/mainview/styles/views/draft.css` into `styles/cards.css`.

Out:
- TODO admission or amendment, placement, seed application, idempotency, audience filtering and publishing (T-APP-02). The seed stays read-only.

## Changes

- Move `styles/views/draft.css` into `styles/cards.css`; delete it and its import in `styles/views.css`.
- Mounting: T-APP-02 mounts `DraftView` through the landed `cards/DraftContainer.tsx`.

## Tests

The Draft cases in `apps/app/src/mainview/cards/views/Views.test.tsx` cover:
- literal blur payloads: acceptance `'["passes checks","keeps edits"]'`, place `'{"mode":"before","n":12}'`, append `'{"mode":"append"}'`, fixes `"true"` and `"false"`;
- Commit forwards the full supplied input once; Discard forwards `draft.discard` once with `{draft}` and never a TODO-drop action;
- the lock chip before Commit and its absence on the receipt; the read-only seed; the "+1" amendment receipt;
- a removed Commit action renders no Commit control.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA. `styles/views/draft.css` is gone.

## Risks and notes

- Private styling is not a security boundary; T-APP-02 enforces the Draft audience.
