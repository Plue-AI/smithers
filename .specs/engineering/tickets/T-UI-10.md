# T-UI-10 Flow view

Stage S1 · Size M · Depends on T-UI-01, T-APP-19 · Unblocks T-APP-05, T-REL-02 · Issue: [#3547](https://github.com/smithersai/smithers/issues/3547)
Spec: spec.md §14.2.1, §11, §14.3 (Flow) · Delta: delta.md §9 · Product: mvp.md J5, J11 · Props: [ui-components.md § T-UI-10](../ui-components.md)

## Goal

`FlowView` exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-05 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- `FlowView`: source label, versions with their states, steps with their agent, and Source, Plan, Run, Edit.
- Props exactly as `ui-components.md` § T-UI-10 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).
- Flow loading, activation, closure digests, version pinning, source edits and draft execution (T-FLW-03, T-FLW-04, T-APP-05); triggers and flow creation.

## Changes

- `mvp-version*`, flow steps and added-step mark. Check: C-UI-12.


- New `apps/app/src/mainview/cards/views/FlowView.tsx` and CSS; shared primitives stay in `packages/smithers/ui/src/`. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
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

1. Dependencies: T-UI-01 supplies primitives and T-APP-19 supplies the landed FlowCard schema, per-module import and committed Flow fixtures. A props-only View needs no loader, execution service or Container to land.
2. Exclusions: Scope excludes loading, activation, digests, pinning, source mutation, draft execution, triggers and flow creation.
3. Tests: C-UI-12 mounts the production FlowView export in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (both new). Committed literals cover active, proposed, merged-syncing, merged-failed and previous versions; built-in and repository source labels; added steps, agents and the merge wait; Source, Plan, Run and Edit callbacks; omitted and disabled actions; keyboard activation; both themes and widths. Expectations come from neither spec files nor production code. T-APP-05 owns real command dispatch and C-UI-13.
4. Decisions: smithers-06 signs visual and copy conformance, Will decides product changes, and smithers-8a accepts seam changes with smithers-b8 and smithers-38.
5. Pre-review before start: smithers-06: answered 18:10, ok (mock 21b445a6) smithers-b8: Do Source, Plan, Run and Edit emit only supplied tags and payloads? Is version selection left to the adapter? smithers-38: Do the FlowCard import and fixtures use agreed package subpaths? Shared primitive changes also need smithers-38 review.
6. Security: Source text is data; FlowView never imports or evaluates repository flows. Plan and Run emit supplied actions only. Repository loading and execution must run inside machines (M-29, §11.3.1, §11.4.3); smithers-3f reviews those preconditions in T-FLW-03/T-FLW-04/T-APP-05, and smithers-b8 reviews the View boundary under C-UI-08. C-UI-12 checks inert source text and callbacks.

