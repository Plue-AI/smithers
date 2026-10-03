# T-UI-09 Members view

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-APP-06 · Issue: [#3546](https://github.com/smithersai/smithers/issues/3546)
Spec: spec.md §14.2.1, §5, §14.3 (Members) · Delta: delta.md §9 · Product: mvp.md J1.8, §6.15, M-05, M-29 · Props: [ui-components.md § T-UI-09](../ui-components.md)
Ready: 2026-10-03 smithers-8a sha256:68dcfe460295

Landed (56ff44a03).

## Goal

`MembersView` renders the member list from props, so T-APP-06 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) decides visual and copy changes. smithers-b8 accepts the app View/action seam; smithers-8a accepts changes to the documented props contract. Engineering wires it in T-APP-06. Pre-review owners and questions are below; recorded owner answers stand and owners review draft changes post hoc.

## Scope

In:
- Landed: rows with role, needs access and suspended, the supplied `color_index`, and Add by username.
- Already consolidated: `MemberAction` is local to `apps/app/src/mainview/cards/views/MembersView.tsx`; Members rules are in `apps/app/src/mainview/styles/cards.css`. `MembersActionView.tsx`, `styles/views/members.css` and `styles/views.css` are absent.
- Remaining: reshape the existing Members markup, CSS and test selectors to remove the Members-owned `mvp-` prefixes (minimal-code synthesis v1 §6).
- Land dark: add no production mount or command binding. T-UI-01 is landed; if its primitives are unavailable, keep Members unmounted. T-APP-06 owns activation and refuses unavailable roster or authorization providers before effects; do not substitute fixture data or a permissive callback (C-UI-12 here; C-J1-05 and C-UI-13 in T-APP-06).

Out:
- GitHub permission lookups, access rechecks, role changes, removal and revocation (T-ACC-02, T-APP-06); owner transfer and email invitations. No role policy in the View, production mounting, subscriptions, command implementation, new View/container/schema/fixture layer, public API, machine launch or repository-code execution.

## Changes

- Reuse `cards/views/MembersView.tsx` and its inline `MemberAction`; do not recreate or repeat the completed sub-View fold.
- Rename the Members-owned `mvp-` classes in `MembersView.tsx` and their existing rules in `styles/cards.css`; update selectors in `MembersView.stories.tsx` and `Views.test.tsx` in the same change. Coordinate shared primitive selectors with T-UI-01; do not rename unrelated cards or duplicate shared rules. Keep the deleted CSS files and import absent.
- Mounting: T-APP-06 mounts `MembersView` from `cards/CardRenderers.tsx`. No members card exists under `cards/` today, so there is no legacy pair to delete.

## Tests

C-UI-12 tests the production `MembersView` at its props/DOM/callback boundary in `apps/app/src/mainview/cards/views/Views.test.tsx`, including `MembersView.stories.tsx` cases in light and dark. Submit its actual forms and click its buttons; do not call `onAction` directly. Keep expected copy, colour tokens, tags and payloads as independent literals, never computed from spec files, production helpers or supplied action arrays. These cases cover:
- reordered members keep their `color_index` and the literal colour token;
- role, needs-access and suspended rows;
- Add, Role and Remove emit their literal tags and login/role payloads once; omitted actions render no control; disabled ones do not dispatch; changed choices and refreshed inputs submit their displayed values; hostile names render as text.

The existing named regressions are `Members reordered colors and absent owner actions`, `Members disabled actions and names rendered as text`, `Members choice default and refreshed input match submitted values`, and `Members story renders unexpected supplied owner actions for oracle detection`. The last case proves the View renders supplied actions, not that owner removal is permitted. T-APP-06 owns authorization tests at the production dispatcher and composed `/api/members` routes, plus `e2e/real/members.spec.ts` through `/members`, `CardRenderers` and this View (C-J1-05); those are not bypassed by View-unit receipts.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA. Members-owned classes have no `mvp-` prefix; shared primitive classes follow T-UI-01. `MembersActionView.tsx`, `styles/views/members.css` and the old stylesheet import remain absent. No production mount lands here.

## Risks and notes

- The View makes no permission decision; T-APP-06 and T-ACC-02 enforce roles. Will decides changes to role, owner or person-only policy. No ADR or public API change is needed.
- Security: render member names as inert text and emit only supplied actions. This ticket adds no repository-code execution or root step and consumes no root inputs from main or a branch. Repository-executing validation runs only in a machine (M-29); smithers-b8 reviews the View boundary and smithers-3f reviews authorization and execution in T-APP-06 before activation. C-UI-12 covers hostile names and disabled controls; T-APP-06 owns the production refusal tests.

## Ready checklist

1. Dependencies: T-UI-01 supplies the landed primitives; no runtime service is needed for this props-only cleanup. Scope keeps Members dark if primitives are unavailable and leaves runtime activation to T-APP-06.
2. Exclusions: Scope explicitly excludes role policy, backend mutations, production wiring, invitations, owner transfer, new layers, public APIs and repository execution.
3. Tests: C-UI-12 submits production View forms and observes callbacks with independent literal expectations. T-APP-06 owns dispatcher/route and `/members` e2e acceptance; View receipts prove no authorization claim.
4. Decisions: smithers-06 decides visuals/copy, smithers-b8 accepts the app action seam, smithers-8a accepts props-contract changes, and Will decides product permission changes. No ADR or public API is added.
5. Owner pre-review: smithers-06: Does prefix cleanup preserve the light/dark roster and narrow layout? Do Members selectors remain compatible with T-UI-01 primitives? smithers-b8: Does the View forward only supplied actions and displayed inputs without importing policy or runtime clients? These are the owners required before implementation starts; recorded answers stand and draft changes receive post hoc review.
6. Security: no root step, hence no root-input inventory; no production repository execution. C-UI-12 proves inert names and disabled controls. smithers-b8 reviews this boundary; smithers-3f reviews T-APP-06 authorization/execution before activation, and repository-executing validation runs only in machines (M-29).
