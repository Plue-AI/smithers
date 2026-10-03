# T-UI-22 Debug API view

Stage S2 · Size S · Depends on T-UI-01 · Unblocks T-APP-21 · Issue: [#3584](https://github.com/smithersai/smithers/issues/3584)
Spec: spec.md §14.2.1 · Delta: delta.md §9 · Product: mvp.md M-36 · Props: written by this ticket when S2 starts
Ready: 2026-10-03 smithers-8a sha256:2ea993a776a9

## Goal

`DebugApiView` exists as a props-only View matching the design mock, so T-APP-21 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns the View, CSS and copy approval. smithers-b8 approves the app action seam and wires it in T-APP-21. smithers-38 reviews the private rpc TypeScript props change. smithers-8a accepts changes to §14.3 and ui-components.md; Will decides any change to M-36. Required owner review questions are recorded below; review follows the parallel-build directive and runs post hoc, without blocking start. No owner answer is recorded here.

## Scope

In:
- `DebugApiView`: operation list, the request form from the supplied Send action's generated `input`, the supplied in-card confirmation for mutations, response pane (status, headers, body, duration) and typed failure state. Reshape the existing `packages/rpc/src/DebugApiCard.ts` contract into TypeScript props when S2 starts; restore its types if the §11 cut has removed them. Add the View's §14.3 row and ui-components.md props together, preserving the documented fields. Do not recreate View-only Zod schemas or a separate fixture layer.
- Stories for every state, light and dark, desktop and 390 px, using the existing story harness. Reuse or restore the existing DebugApi examples as inline test cases rather than rebuilding a fixture layer.
- T-UI-01 is the only called-code dependency and is recorded as landed. Lands dark until T-APP-21: no production mount, command registration or request binding; an absent or disabled supplied action produces no callable control. C-UI-12 cases below prove this behavior. Build against the specified props contract without waiting for wiring.

Out:
- Content loading, routing, OpenAPI conversion, operation discovery, command registration, requests, session handling and authorization (T-APP-21).
- Deciding mutation policy or inventing Send or Confirm actions; render only supplied actions. Saved requests, persistent history, credential entry, other users' credentials and undocumented endpoints.
- Repository execution, machine provisioning, root steps and backend changes.

## Changes

- Reshape or restore `packages/rpc/src/DebugApiCard.ts` as TypeScript props; update §14.3 and ui-components.md in the implementation change. This private card contract needs no public-API sign-off (ui-components.md Rules); smithers-38 reviews the library seam.
- Reuse `apps/app/src/mainview/styles/cards.css`, `cards/views/Views.test.tsx` and the existing `view-stories.tsx` harness.
- Add `apps/app/src/mainview/cards/views/DebugApiView.tsx` and its story module. No Debug API View or card renderer exists today to reshape. Reuse existing form-control patterns instead of adding a form engine. Every handler uses a supplied `onAction` with matching `data-flow`, `onView`, or local state.

## Tests

- C-UI-12 unit cases in `apps/app/src/mainview/cards/views/Views.test.tsx` render the production `DebugApiView` and operate its DOM controls: empty operation list; selection emits the literal `onView` patch; required and multiline inputs; supplied Send arguments; pending POST, PUT, PATCH and DELETE show only the supplied Confirm control; absent and disabled actions never call `onAction`; 200 response status, headers, body and duration; typed 401 and 403 failures; keyboard selection and activation. Mounting and rerendering make no action calls. Removing an action removes its control.
- Assert literal labels, callback tags, arguments and response values authored in the tests. Never read spec files, implementation constants or runtime-generated expectations as the oracle. The View boundary proves presentation and callback behavior; production dispatcher, authorizer and HTTP-route checks belong to T-APP-21 (C-UI-10, C-UI-13), not a simulated dispatcher here.
- Reuse `apps/app/e2e/playwright/view-stories.spec.ts` at `/view-stories.html` for these production-View stories: keyboard access, both themes, 1,440 px and 390 px, no overflow and no serious or critical axe-core violation. Reuse the existing View handler scan in `apps/app/src/mainview/flows/parity.test.ts` to reject direct request or command bindings (C-UI-08).

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- Copy review: smithers-06 reads every story screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. The wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the View needs but spec §14.3 lacks is a spec change for smithers-8a to accept, with smithers-b8 and smithers-38 reviewing the seam.
- Security review: smithers-b8 verifies that the View executes no repository code, performs no fetch, evaluates no request or response content, and renders bodies and failures as escaped text. C-UI-12 includes hostile HTML in the body and failure message and proves it renders literally without execution; the parity scan proves the callback seam. Requests that execute repository code remain T-APP-21's authorized machine-only boundary under M-29. This ticket has no root step and consumes no root inputs.

## Ready checklist

1. Dependencies: T-UI-01 supplies called primitives and is landed; T-APP-21 is a wiring precondition, not a called-code dependency. Scope keeps the View dark and unavailable actions fail closed (C-UI-12).
2. Exclusions: Scope names routing, OpenAPI generation, requests, authorization, mutation policy, persistence, credentials, repository execution, root steps and backend changes.
3. Tests: C-UI-12 operates the production View DOM and supplied callback boundary with literal expectations; the existing browser story route covers layout and accessibility. T-APP-21 owns real dispatcher and HTTP checks.
4. Decisions: smithers-06 approves design and copy; smithers-b8 approves app actions; smithers-38 reviews private props; smithers-8a accepts spec changes; Will decides product scope.
5. Owner review: required reviews run post hoc under the parallel-build directive; no answers are recorded. smithers-06: Does every state match the design and minimal-copy rule? Are all controls keyboard accessible at both widths? smithers-b8: Do selection, Send and Confirm use only supplied seams? Does the dark View expose no production request path? smithers-38: Does reshaping or restoring the private props preserve the documented fields without View-only Zod or a fixture layer?
6. Security: smithers-b8 reviews escaped response and failure text and the callback-only seam; hostile-content cases and the parity scan verify them. No repository code executes here; execution stays machine-only. No root step or root input exists.
