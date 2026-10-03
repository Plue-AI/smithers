# T-UI-09 Members view

Stage S1 · Size S · Depends on T-UI-01, T-APP-19 · Unblocks T-APP-06, T-REL-02 · Issue: [#3546](https://github.com/smithersai/smithers/issues/3546)
Spec: spec.md §14.2.1, §5, §14.3 (Members) · Delta: delta.md §9 · Product: mvp.md J1.5 · Props: [ui-components.md § T-UI-09](../ui-components.md)

## Goal

`MembersView` exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-06 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `MembersView`: rows with role, needs access and suspended, and Add by username.
- Props exactly as `ui-components.md` § T-UI-09 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).
- GitHub permission lookups, hourly access rechecks, role changes, member removal and credential revocation (T-ACC-02, T-ACC-06, T-APP-06); owner transfer and invitations by email.

## Changes

- `mvp-members` rows. Check: C-UI-12.


- New `apps/app/src/mainview/cards/views/MembersView.tsx` and CSS; shared primitives stay in `packages/smithers/ui/src/`. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
- Fixtures from `@smthrs/rpc` (`packages/rpc/test/fixtures/`, written with T-APP-19).

## Tests

- unit (C-UI-12): every fixture of the card renders with its actions and shows its `expect` strings, in light and dark at 1280 and 390 px; each press calls `onAction` or `onView` once. The View-seam rule passes on the View's file (C-UI-08).
- copy: use committed literal expected strings for this View under C-UI-12. C-UI-02 is a downstream T-CAT-01 audit, not a prerequisite for landing this View. No test reads `.specs/` or derives expected strings, tags, payloads or tone tokens from production code at runtime.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- smithers-06 approves visual and copy conformance to §14.6b and records the screenshot decision. Will decides product or copy changes. Tech lead smithers-8a accepts schema or seam changes with smithers-b8 and smithers-38 before implementation; update §14.3, ui-components.md and T-APP-19 together. This ticket adds no command or public API.

## Ready checklist

1. Dependencies: T-UI-01 supplies primitives and T-APP-19 supplies the landed MembersCard schema, per-module import and committed Members fixtures. This props-only View needs no member service or Container to land.
2. Exclusions: Scope excludes access checks, membership mutations, revocation, owner transfer, email invitations and production wiring.
3. Tests: C-UI-12 mounts the production MembersView export in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (both new). Committed literals assert role, needs-access and suspended rows; Add, Role and Remove tags and username payloads; omitted and disabled actions; keyboard activation; both themes and widths. Expected values are independent of spec files and production code. T-APP-06 owns real Members command dispatch and C-UI-13.
4. Decisions: smithers-06 signs visual and copy conformance, Will decides product changes, and smithers-8a accepts seam changes with smithers-b8 and smithers-38.
5. Pre-review before start: smithers-06: answered 18:10, ok (mock 21b445a6) smithers-b8: Do Add, Role and Remove only emit supplied actions? Does the View leave authorization to the Container and dispatcher? smithers-38: Do the MembersCard import and fixtures use the agreed package subpaths? Shared primitive changes also need smithers-38 review.
6. Security: The View executes no repository code and makes no permission or credential decisions. It treats names and usernames as data and emits only supplied actions. smithers-b8 reviews this boundary under C-UI-08; any repository execution belongs in machines under M-29 and requires smithers-3f review in the wiring ticket. C-UI-12 checks text rendering and absent actions.

