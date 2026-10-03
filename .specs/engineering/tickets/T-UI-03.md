# T-UI-03 Draft view

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-APP-02 · Issue: [#3540](https://github.com/smithersai/smithers/issues/3540)
Spec: spec.md §14.2.1, §14.3 (Draft), §14.5.1 (private Draft) · Delta: delta.md §9 · Product: mvp.md J2.2, J7.1 · Props: [ui-components.md § T-UI-03](../ui-components.md)
Ready: 2026-10-03 smithers-8a sha256:5f1a91b936b9

Landed (f18e88958, fbf7c98f7, c60db0f4b).

## Goal

`DraftView` renders the §14.3 Draft from props, so T-APP-02 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns presentation and CSS decisions. smithers-b8 owns the app binding seam; smithers-8a accepts any required spec change. Engineering wires it in T-APP-02. Required owner pre-review questions are in the Ready checklist; under the parallel-build directive, owners review post hoc and recorded answers stand.

## Scope

In:
- Landed: title, prompt, acceptance, the linked issue with its fixes toggle, the place picker (Append, Before Tn, Amend Tn), a read-only seed, Commit and Discard; the "Only you" lock chip until Commit, then the committed receipt. `gestures.set` sends `{field, value}` on blur with string values. Discard binds `draft.discard` with `{draft}` for the author only and never drops a TODO.
- Use the existing `apps/app/src/mainview/cards/views/DraftView.tsx` and Draft rules in `apps/app/src/mainview/styles/cards.css`; the stylesheet consolidation is already present. No new View, container, schema or fixture layer.
- Land dark against the T-UI-01 contract if that dependency is unavailable: keep Draft pending in `cards/CardRenderers.tsx` until T-APP-02 wires it. Missing actions render no controls; disabled actions never dispatch. Do not supply fallback authority or execution. Check: C-UI-12.

Out:
- TODO admission or amendment, placement, seed application, idempotency, audience filtering, publishing, production mounting and dispatcher wiring (T-APP-02). The seed stays read-only.
- Image declaration edits, package installation, repository-code execution, root steps, new commands, public API changes and new UI copy.

## Changes

- Reuse `cards/views/DraftView.tsx` and the existing Draft rules in `styles/cards.css`. Verify that `styles/views/draft.css` and `styles/views.css` remain absent; do not recreate them.
- Reuse the Draft cases in `cards/views/Views.test.tsx`; replace derived expectations with committed literal expectations. Fix only failures of the declared View contract.
- T-APP-02 owns mounting through `cards/CardRenderers.tsx`, reusing the landed `cards/DraftContainer.tsx` and `flows/cardActions.ts` under delta.md §9. This ticket adds no parallel binding path.

## Tests

C-UI-12 uses the Draft cases in `apps/app/src/mainview/cards/views/Views.test.tsx` at the production `DraftView` DOM and `onAction` boundary. Drive rendered inputs and buttons, not internal handlers. Expected text, payloads and control presence are committed literals, never read from spec Markdown or computed from production code or input fixtures. Cover:
- literal blur payloads: acceptance `'["passes checks","keeps edits"]'`, place `'{"mode":"before","n":12}'`, append `'{"mode":"append"}'`, fixes `"true"` and `"false"`;
- Commit forwards the full supplied input once; Discard forwards `draft.discard` once with `{draft}` and never a TODO-drop action;
- the lock chip before Commit and its absence on the receipt; the read-only seed; the "+1" amendment receipt;
- a removed Commit action renders no Commit control; disabled actions and missing or disabled edit gestures dispatch nothing;
- the existing Draft controls, focus ring and receipt use the consolidated Paper styles in light and dark; seed text containing `<script>` renders as text and creates no script element.

Production command and privacy acceptance belongs to T-APP-02: C-J2-01 runs Make TODO and Commit through the production dispatcher, `CardRenderers` and the real Draft binding; C-UI-13 proves mounting. Direct View tests do not prove admission, author authorization or idempotency.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA. `styles/views/draft.css` is gone.

## Risks and notes

- Private styling is not a security boundary; T-APP-02 enforces the Draft audience. Draft prompts, issue content and seed files are untrusted data. The View renders them without evaluating code, applying seeds or invoking a shell. Repository code runs only in machines (M-29); smithers-3f reviews execution isolation in T-APP-02, and smithers-b8 reviews this View boundary. C-UI-12 covers inert seed text and unavailable actions.
- This ticket has no root step and consumes no root inputs from main or a branch. Adding a root step changes scope and requires an input/source inventory and a named validation test for each branch-sourced input before landing.

## Ready checklist

1. Dependencies: T-UI-01 supplies the presentation contract; Scope keeps the View dark and fails closed if unavailable. T-APP-02 owns runtime wiring and is not a dependency of this props-only change. No dependency or index-row change is needed.
2. Exclusions: Scope names admission, placement, seed application, privacy enforcement, mounting, dispatch, installation, repository execution, root steps and new API/UI surfaces.
3. Tests: C-UI-12 exercises production DraftView DOM events and onAction with literal expectations. T-APP-02 owns dispatcher and route evidence under C-J2-01 and mounting under C-UI-13.
4. Decisions: smithers-06 decides presentation/CSS; smithers-b8 accepts the app seam; smithers-8a accepts spec changes. No public API change or ADR is in scope.
5. Owner pre-review: smithers-06: Does the consolidated CSS preserve Draft controls, focus and receipts in both Paper modes? smithers-b8: Does the existing props/onAction seam remain unchanged? Do missing or disabled actions fail closed and seed content remain inert? Record answers in #3540; recorded answers stand and owner review is post hoc under the parallel-build directive.
6. Security: untrusted Draft content stays data; C-UI-12 proves inert seed rendering and unavailable-action behavior. smithers-b8 reviews the View boundary; smithers-3f reviews M-29 execution isolation in T-APP-02. No root step or root input is in scope.
