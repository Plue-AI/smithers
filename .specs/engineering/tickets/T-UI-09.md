# T-UI-09 Members view

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-APP-06, T-REL-02 · Issue: [#3546](https://github.com/smithersai/smithers/issues/3546)
Spec: spec.md §14.2.1, §5, §14.3 (Members) · Delta: delta.md §9 · Product: mvp.md J1.5 · Props: [ui-components.md § T-UI-09](../ui-components.md)

Landed (56ff44a03).

## Goal

`MembersView` renders the member list from props, so T-APP-06 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-06.

## Scope

In:
- Landed: rows with role, needs access and suspended, the supplied `color_index`, and Add by username.
- Remaining:
  - Fold `views/MembersActionView.tsx` (one caller) into `MembersView.tsx` (minimal-code synthesis v1 §6).
  - Merge `apps/app/src/mainview/styles/views/members.css` into `styles/cards.css` and drop the `mvp-` prefix (`mvp-members*`).

Out:
- GitHub permission lookups, access rechecks, role changes, removal and revocation (T-ACC-02, T-APP-06); owner transfer and email invitations.

## Changes

- Inline `MemberAction` in `views/MembersView.tsx`; delete `MembersActionView.tsx`.
- Move `styles/views/members.css` into `styles/cards.css`, renaming `mvp-` classes; delete it and its import in `styles/views.css`.
- Mounting: T-APP-06 mounts `MembersView` from `cards/CardRenderers.tsx`. No members card exists under `cards/` today, so there is no legacy pair to delete.

## Tests

The Members cases in `apps/app/src/mainview/cards/views/Views.test.tsx` cover:
- reordered members keep their `color_index` and the literal colour token;
- role, needs-access and suspended rows;
- Add, Role and Remove dispatch their literal tags and username payloads once; omitted actions render no control; disabled ones do not dispatch.

## Acceptance

- The tests above pass in CI at the landed SHA. `MembersActionView.tsx` and `styles/views/members.css` are gone.

## Risks and notes

- The View makes no permission decision; T-APP-06 and T-ACC-02 enforce roles.
