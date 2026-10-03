# T-UI-10 Flow view

Stage S1 · Size M · Depends on T-UI-01, T-APP-19b · Unblocks T-APP-05, T-REL-02 · Issue: [#3547](https://github.com/smithersai/smithers/issues/3547)
Spec: spec.md §14.2.1, §11, §14.3 (Flow) · Delta: delta.md §9 · Product: mvp.md J5, J11 · Props: [ui-components.md § T-UI-10](../ui-components.md)

## Goal

`FlowView` exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-05 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- Flow steps include added? from T-APP-19b. Check: C-UI-12.
- `FlowView`: source label, versions with their states, steps with their agent, and Source, Plan, Run, Edit.
- Props exactly as `ui-components.md` § T-UI-10 with the zod type reconciled by T-APP-19b from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- No version-difference calculation or rpc view-field addition. Check: C-UI-08.
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).
- Flow loading, activation, closure digests, version pinning, source edits and draft execution (T-FLW-03, T-FLW-04, T-APP-05); triggers and flow creation.

## Changes

- The adapter supplies added relative to Active; the View renders it. The version chip uses React local state under seam rule 3, with no invented persisted view field. Check: C-UI-08, C-UI-12.

- `mvp-version*`, flow steps and added-step mark. Check: C-UI-12.


- New `apps/app/src/mainview/cards/views/FlowView.tsx` and CSS; shared primitives stay in `packages/smithers/ui/src/`. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
- Fixtures from `@smthrs/rpc/fixtures/Flow` (`packages/rpc/test/fixtures/`, reconciled with T-APP-19b).

## Tests

- Cover added true, false and absent; assert literal marking relative to the supplied Active version. Selecting a version changes local display and sends no onAction or onView. Check: C-UI-12.

- unit (C-UI-12): every fixture of the card renders with its actions and shows its `expect` strings, in light and dark at 1280 and 390 px; each press calls `onAction` or `onView` once. The View-seam rule passes on the View's file (C-UI-08).
- copy: use committed literal expected strings for this View under C-UI-12. C-UI-02 is a downstream T-CAT-01 audit, not a prerequisite for landing this View. No test reads `.specs/` or derives expected strings, tags, payloads or tone tokens from production code at runtime.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19b's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- smithers-06 approves visual and copy conformance to §14.6b and records the screenshot decision. Will decides product or copy changes. Tech lead smithers-8a accepts schema or seam changes with smithers-b8 and smithers-38 before implementation; raise §14.3 and ui-components.md gaps through T-APP-19b; UI lanes never raise piecemeal schema changes. This ticket adds no command or public API.

## Ready checklist

T-UI-02 through T-UI-14 go Ready together after T-APP-19b lands with smithers-38's §21.1 review. Local props permit drafting only. This UI lane makes no piecemeal schema change. Check: C-UI-08.

1. Dependencies: T-UI-01 supplies primitives and T-APP-19b supplies the landed FlowCard schema, per-module import and committed Flow fixtures. A props-only View needs no loader, execution service or Container to land.
2. Exclusions: Scope excludes loading, activation, digests, pinning, source mutation, draft execution, triggers and flow creation.
3. Tests: C-UI-12 mounts the production FlowView export in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (both new). Committed literals cover active, proposed, merged-syncing, merged-failed and previous versions; built-in and repository source labels; added steps, agents and the merge wait; Source, Plan, Run and Edit callbacks; omitted and disabled actions; keyboard activation; both themes and widths. Expectations come from neither spec files nor production code. T-APP-05 owns real command dispatch and C-UI-13.
4. Decisions: smithers-06 signs visual and copy conformance, Will decides product changes, and smithers-8a accepts seam changes with smithers-b8 and smithers-38.
5. Pre-review before start: smithers-06: answered 18:10, ok (mock 21b445a6) smithers-b8: answered 18:2x, ok; smithers-38: answered, BLOCKING edits applied (tech lead adopts).
6. Security: Source text is data; FlowView never imports or evaluates repository flows. Plan and Run emit supplied actions only. Repository loading and execution must run inside machines (M-29, §11.3.1, §11.4.3); smithers-3f reviews those preconditions in T-FLW-03/T-FLW-04/T-APP-05, and smithers-b8 reviews the View boundary under C-UI-08. C-UI-12 checks inert source text and callbacks.

