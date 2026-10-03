# T-UI-04 TODO view: states, waits, repair, evidence, PR and merge

Stage S1 · Size M · Depends on T-UI-01 · Unblocks T-APP-02, T-FLW-10, T-GH-06, T-MCH-08, T-STK-08, T-UI-20 · Issue: [#3541](https://github.com/smithersai/smithers/issues/3541), [#3552](https://github.com/smithersai/smithers/issues/3552)
Spec: spec.md §14.2.1, §4.1, §4.1.0a, §8.5, §9.3.8, §10.5.4, §10.6.4, §12.3, §12.5.1, §14.3 (TODO) · Delta: delta.md §9 · Product: mvp.md J2, J4, J7, J10, J10.3, M-32, M-33 · Props: [ui-components.md § T-UI-04](../ui-components.md)
Ready: 2026-10-03 smithers-8a sha256:9d1b0952780f

Landed (7d73b0720). Absorbs T-UI-04 (minimal-code synthesis v1 §7).

## Goal

`TodoView` renders every TODO state, wait, repair form, evidence, PR line and merge control from props, so T-APP-02, T-STK-08, T-MCH-08 and T-GH-06 only bind data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns presentation and keyboard decisions. smithers-b8 reviews the app seam and action bindings; smithers-8a accepts changes to the specified props. Engineering wires it in T-APP-02; T-STK-08, T-MCH-08 and T-GH-06 bind the repair actions. These owners review post hoc under Will's parallel-build directive; their review does not gate starting this draft.

## Scope

In:
- Landed: the nine states; prompt revisions ("+n"); steers with authors; steps with the current one lit; every open wait in its own row, primary first, with its own actions; question and approval forms with the first answer and Send as steer; failure with Retry and Retry with the current flow; the removed-owner chip and Take over; Add to machine image; evidence per attempt bound to its revision (C-J2-04); the PR line, `merged_via` and the one `merge` control.
- Remaining:
  - Repair waits from T-UI-04, rendered by the existing wait row (`apps/app/src/mainview/cards/views/TodoView.tsx:159`) and its actions; no new form components (smithers-06). `conflict`: paths, Resolve, a terminal slot and the SSH line, Done; from S2 Resolve opens the Branch card (§10.5.4). `moved_off` with Resolve (§9.3.8); Return to Tn and Keep for now stay on the Branch card (T-UI-15). `foreign_push`: the pusher, the commit, Bring in and Discard (§12.3, M-33). Bring in and Discard dispatch only supplied actions; T-APP-04 and T-GH-06 own confirmation creation and rendering.
  - Fork and Add to stack as supplied card actions (§8.5, M-32).
  - Reuse the inline `TodoActionView` in `apps/app/src/mainview/cards/views/TodoView.tsx` and the TODO rules in `apps/app/src/mainview/styles/cards.css`; both folds are already present.
- Dark landing: T-UI-01 is the only landing dependency. If its primitives are unavailable, keep the TODO renderer unregistered in `CardRenderers.tsx` and do not substitute a second implementation. T-APP-02 owns production registration; until its wiring and the repair providers pass their named checks, no unavailable action or terminal slot is supplied. The View renders no missing action and cannot dispatch it (C-UI-12).

Out:
- State and queue derivation, merge readiness, authorization, checks, PR writes and image builds (T-APP-02).
- Conflict-marker validation, wait settlement, precedence, stale-sha checks, history mutation and fork placement (T-STK-08, T-GH-06, T-MCH-08). The View never connects a terminal or runs a command.
- Topic subscriptions, production registration and container cutover (T-APP-02); conflict terminal wiring and serialized repair fields (T-STK-08); confirmation creation and ConfirmView (T-APP-04); S2 Branch-card controls, Return to Tn and Keep for now (T-UI-15). No separate repair component, command dispatcher, host shell, root step or machine-image installer.

## Changes

- Reshape `apps/app/src/mainview/cards/views/TodoView.tsx`: extend its app-local props with `conflictTerminal?: ReactNode` and place the supplied slot in the selected conflict wait row (§14.2.2b). Reuse its existing wait row and inline action renderer. Keep React slots outside `packages/rpc`.
- Reuse `apps/app/src/mainview/styles/cards.css` for repair layout. `views/TodoActionView.tsx`, `styles/views/todo.css` and `styles/views.css` are already absent; do not recreate them.
- `apps/app/src/mainview/cards/TodoContainer.tsx` exists but TODO remains pending in `CardRenderers.tsx:57`. T-APP-02 owns registration and folding the container into the card file; T-STK-08 supplies the selected-conflict slot. This ticket does not claim production mounting.

## Tests

Extend the TODO cases in `apps/app/src/mainview/cards/views/Views.test.tsx` (C-UI-12). Drive the real `TodoView` DOM with native input, submit and click events; do not invoke handlers directly. Bind dispatch cases through the production `apps/app/src/mainview/flows/cardActions.ts` adapter and assert literal command tags and payloads at `CardCommandDispatch`. Use hand-written inputs and expected text, order and payloads in the tests; do not read spec files, derive expectations from schemas or action definitions, or use story `expect` arrays as the oracle. Name cases for:
- all nine states, two simultaneous waits in supplied order with independent actions, a late answer kept as Send as steer;
- question, approval, Retry, Take over, Edit and Merge each dispatch their literal tag and wait inputs once; a removed action removes its control; a disabled Merge is text;
- conflict: the literal paths and SSH line, the supplied terminal slot, Resolve and Done each once with the wait id; the View opens no terminal connection;
- moved_off with Resolve; foreign_push with the pusher, commit, Bring in and Discard, each carrying the supplied `sha` unchanged; a missing Discard renders no control;
- Fork and Add to stack dispatch their literal tags once;
- the conflict form stacks vertically at 390 px and keyboard order follows reading order;
- hostile path, commit and actor text renders as inert text.

Production registration, routes, authorization, confirmation and machine execution are acceptance tests of T-APP-02, T-APP-04, T-STK-08, T-GH-06 and T-MCH-08, not claims of these props-only tests.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA. `TodoActionView.tsx` and `styles/views/todo.css` are gone.

## Risks and notes

- smithers-8a accepts props-contract changes; smithers-06 decides presentation and keyboard order; smithers-b8 approves the app seam. T-STK-08 owns missing serialized repair fields (§14.2.2b). Any resulting public `packages/rpc` API change requires smithers-38 sign-off under §21.1 in that ticket.
- Security review: smithers-b8 reviews the inert View and supplied-action boundary (C-UI-12). This ticket executes no repository code and adds no root step, so there are no root-consumed inputs. Paths, commits, actor text and SSH lines remain inert; the View never evaluates or runs them. Repository execution and terminal attachment stay in machines under M-29, reviewed by smithers-3f in the wiring tickets; an unavailable execution provider supplies no terminal or executable action.

## Ready checklist

1. Dependencies: T-UI-01 supplies the only runtime precondition for this props-only change. Scope specifies dark landing without its primitives; downstream wiring and repair providers are not reverse dependencies.
2. Exclusions: Scope names state derivation, authorization, backend writes, confirmation, terminal wiring, production registration, S2 Branch controls and root execution; reuse replaces completed fold work.
3. Tests: C-UI-12 exercises native events on TodoView through production cardActions to CardCommandDispatch with literal test-owned expectations; wiring tickets own route and machine tests.
4. Decisions: smithers-06 decides presentation and keyboard order; smithers-b8 approves the app seam; smithers-8a accepts props changes; smithers-38 signs any public API change in its owning wiring ticket.
5. Owner pre-review, recorded for post hoc review under the parallel-build directive: smithers-06: Does the existing wait row cover each repair state? Does the slot preserve 390 px layout and keyboard order? smithers-b8: Does the app-local slot stay outside the serialized model? Do supplied actions pass unchanged through cardActions without gaining authority? Does dark landing suppress unavailable providers?
6. Security: smithers-b8 reviews inert text and supplied-action tests in C-UI-12; no repository execution or root step consumes inputs here. smithers-3f reviews machine-only execution in the wiring tickets before those providers are enabled.
