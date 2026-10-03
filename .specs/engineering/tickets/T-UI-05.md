# T-UI-05 Confirm view

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-APP-04, T-MNT-03 · Issue: [#3542](https://github.com/smithersai/smithers/issues/3542)
Spec: spec.md §14.2.1, §5.4, §14.3 (Confirm) · Delta: delta.md §9 · Product: mvp.md §6.2, B.6 · Props: [ui-components.md § T-UI-05](../ui-components.md)
Ready: 2026-10-03 smithers-8a sha256:a33da6b2b67c

Landed (c90e3383a, 97d3874b1).

## Goal

`ConfirmView` renders both confirmation kinds and their receipts from props, so T-APP-04 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns visual and copy decisions. smithers-b8 accepts the app View/action seam; smithers-8a accepts any change to the documented props contract. Engineering wires it in T-APP-04. Pre-review owners and questions are recorded below; existing owner answers stand, and owners review these draft changes post hoc.

## Scope

In:
- Landed: `one_click` (verb, the exact text sent, Cancel, receipt) and `review_merge` (title, place, PR link, the subject revision's evidence, a stale approval "You approved <rev>", the `merge` control, on GitHub ↗, Cancel). Subjects are todo, branch, flow, agent and wiki only. Receipts are done, cancelled or expired. Controls dispatch their supplied `actions[]` entries, never `model.action.tag`. Cancel binds `confirm.cancel` with `{confirmation, revision}`.
- Already consolidated: Confirm rules are in `apps/app/src/mainview/styles/cards.css`; `styles/views/confirm.css` and `styles/views.css` are absent. Reuse the existing View, CSS and tests.
- Landing stays dark: this ticket adds no production mount, subscriptions or command bindings. T-UI-01 is landed; if its primitives are unavailable, leave the Confirm mount disabled. T-APP-04 owns activation through the catalog authorizer and refuses unavailable confirmation or execution handlers before effects (§5.4.1, C-ACC-02).

Out:
- Confirmation creation, audience filtering, authorization, expiry timers, approval persistence, revision checks and merge execution (T-APP-04). No confirmation for Members, Secrets or Settings. No new View, container, schema, fixture layer, golden layer, catalog policy, runtime or public API; no production mounting or repository-code execution.

## Changes

- Keep `cards/views/ConfirmView.tsx` and the consolidated `styles/cards.css` rules. Do not repeat the completed CSS migration.
- Reshape the existing Confirm cases in `cards/views/Views.test.tsx` only where expectations call production helpers: replace `actorName(story.model.asked_by)` with independently written literal labels. Keep fixture data as input, not as the assertion oracle.
- Mounting stays in T-APP-04: migrate `cards/ApprovalCard.tsx` in place into the props/action container and delete its old markup plus `cards/ApprovalAnswer.tsx` in that same change (§14.2.1a). Keep `CardRenderers.tsx` as the only mount point; do not delete the container file.

## Tests

C-UI-12 is a View-unit check: the Confirm cases in `apps/app/src/mainview/cards/views/Views.test.tsx` mount the production `ConfirmView`, click its DOM buttons and observe `onAction`. Use independently written literal labels, tags, arguments and receipts; never compute expectations from spec files, production helpers or fixture action arrays. These cases cover:
- approval and Cancel dispatch their literal supplied bindings once, never the initiating command;
- Cancel emits `confirm.cancel` once with the literal `{confirmation, revision}`;
- merge binds the reviewed revision once; a disabled action shows its reason and cannot dispatch;
- a missing approval action leaves only the supplied controls;
- a stale approval is distinct from an expired receipt; receipts have no controls;
- hostile command text renders exact and inert.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA. Confirm CSS remains in `styles/cards.css`; no `styles/views/confirm.css` or `styles/views.css` import remains. No replacement production mount lands here.

## Risks and notes

- Other-viewer privacy is a production test in T-APP-04 ([C-ACC-02](../checks/C-ACC-02.md)), not a View claim. T-APP-04 tests the composed router, production dispatcher and session approve/deny routes; View-unit tests do not prove authorization or execution.
- Security: props are data; render hostile command text inertly and dispatch only supplied actions. This ticket adds no repository-code execution or root step, so it consumes no root inputs from main or a branch. Any repository-executing target must run only in a machine (§17.3, M-29); smithers-3f reviews that execution and authorization seam in T-APP-04 before activation (C-ACC-02).

## Ready checklist

1. Dependencies: T-UI-01 supplies the landed primitives. No runtime provider is added here; Scope keeps the View dark if primitives are unavailable and leaves activation to T-APP-04.
2. Exclusions: Scope excludes backend confirmation behavior, production mounting, Members/Secrets/Settings confirmations, new layers, public APIs and repository-code execution.
3. Tests: C-UI-12 mounts the production View and clicks its controls; assertions use independent literals, including actor labels. T-APP-04 owns route/dispatcher tests under C-ACC-02.
4. Decisions: smithers-06 decides visuals/copy, smithers-b8 accepts the app action seam, and smithers-8a accepts props-contract changes. No ADR or public API is added.
5. Owner pre-review: smithers-06: Does the existing View/CSS cover both kinds, stale approval and receipts? smithers-b8: Do controls forward only supplied bindings with literal revision payloads? Does T-APP-04 retain ApprovalCard as the container while deleting duplicate markup and ApprovalAnswer? Recorded owner answers stand; review draft changes post hoc.
6. Security: no root step or repository execution, hence no root-input inventory is required. C-UI-12 covers inert hostile text; smithers-3f reviews session authorization and machine-only execution in T-APP-04 under C-ACC-02 before activation.
