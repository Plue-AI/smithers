# T-UI-13 Agent view and model roles

Stage S1 · Size S · Depends on T-UI-01, T-APP-19b · Unblocks T-FLW-08, T-REL-02 · Issue: [#3550](https://github.com/smithersai/smithers/issues/3550)
Spec: spec.md §14.2.1, §11.5a, §15 · Delta: delta.md §9 · Product: mvp.md J11 · Props: [ui-components.md § T-UI-13](../ui-components.md)

## Goal

`AgentView`, with the model roles, exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-FLW-08 and reviews nothing visual. Design reviews engineering's wiring when idle.

## Scope

In:
- Change model binds `settings.model.set` with `{role, model}` for the owner session only; agent: never (product 79eb1a66). Render the third role as "Decisions" and retain internal role id `jev`. T-APP-19b includes owner/non-owner and instruction Draft-opening fixtures. Check: C-UI-12.
- Render the third model role as "Decisions" (product 79eb1a66). Retain the model picker, instructions and runs without a laboratory (J11 s14–16). Check: C-UI-12.
- `AgentView`: the three roles ("Fast model", "Coding model", "Decisions") with their model and the owner's Change model form; instructions path and runs from AgentModel. `apps/app/src/mainview/cards/ModelCards.tsx` is absent today; its visuals are a historical reference at `5b77095672`, not a current implementation or landing prerequisite.
- Props exactly as `ui-components.md` § T-UI-13 with the zod type reconciled by T-APP-19b from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- No invented model-change tag, direct TODO commit, provider secret access or effective-model policy. Product approved `settings.model.set` in Appendix B.4; T-FLW-08 enforces owner-only model writes. Check: C-UI-08, C-UI-13.
- Topic subscriptions, commands, permissions and copy decisions owned by spec §14.6b (engineering and product).
- Model credential entry, provider tests, persistence, fallback and effective-model selection (T-INS-06, T-FLW-08); editing tools, permissions or budgets; the model laboratory, Compose and model-call cards; direct instruction-file writes. Edit instructions only emits the supplied Draft TODO action.

## Changes

- Edit instructions forwards the supplied Draft-opening action with prefilled text, not todo.new that commits a TODO. Change model forwards `settings.model.set` once with the supplied `{role, model}`. T-APP-19b carries smithers-b8's Agent fixture correction (#3601). Check: C-UI-12.

- Render the third model role as "Decisions" (product 79eb1a66). Retain the model picker, instructions and runs without a laboratory (J11 s14–16). Check: C-UI-12.

- New `apps/app/src/mainview/cards/views/AgentView.tsx` and CSS; shared primitives stay in `packages/smithers/ui/src/`. Every handler is one of the three kinds ui-components.md Rules allows: `onAction` with `data-flow`, `onView`, or local state.
- Fixtures from `@smthrs/rpc/fixtures/Agent` (`packages/rpc/test/fixtures/`, reconciled with T-APP-19b).

## Tests

- Assert the Edit instructions action opens a Draft with literal prefilled instructions text and never emits the TODO-commit tag. Assert literal `settings.model.set` tag and `{role, model}` arguments. Retain owner/non-owner Change model, absent actions and the literal Decisions label. Check: C-UI-12.

- Assert "Fast model", "Coding model" and "Decisions" as literal fixture expectations, with no banned third-role UI copy or laboratory controls. Retain owner/non-owner model selection and keyboard access. Check: C-UI-12.

- unit (C-UI-12): every fixture of the card renders with its actions and shows its `expect` strings, in light and dark at 1280 and 390 px; each press calls `onAction` or `onView` once. The View-seam rule passes on the View's file (C-UI-08).
- copy: use committed literal expected strings for this View under C-UI-12. C-UI-02 is a downstream T-CAT-01 audit, not a prerequisite for landing this View. No test reads `.specs/` or derives expected strings, tags, payloads or tone tokens from production code at runtime.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19b's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- smithers-06 approves visual and copy conformance and records the screenshot decision. Will decides product changes. Tech lead smithers-8a accepts schema or seam changes with smithers-b8 and smithers-38 before implementation; raise §14.3 and ui-components.md gaps through T-APP-19b; UI lanes never raise piecemeal schema changes. Engineering, not the View, selects the effective model and enforces owner-only writes.

## Ready checklist

T-UI-02 through T-UI-14 go Ready together after T-APP-19b lands with smithers-38's §21.1 review. Local props permit drafting only. This UI lane makes no piecemeal schema change. Check: C-UI-08.

1. Dependencies: T-UI-01 supplies primitives and T-APP-19b supplies the landed AgentCard schema, per-module import and committed Agent fixtures. Restored ModelCards, provider access and backend configuration are not runtime prerequisites for this props-only View.
2. Exclusions: Scope excludes provider credentials/tests, model persistence and selection, tools/permissions/budget editing, the model laboratory, Compose, model-call cards and direct instruction writes.
3. Tests: C-UI-12 mounts the production AgentView export in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (both new). Literal assertions cover Fast model/Coding model/Decisions labels, supplied model and available choices, instructions path, empty and populated runs, owner/non-owner fixtures, Change model with the selected value, Edit instructions as the supplied Draft action, absent/disabled actions, keyboard operation, both themes and widths. Expectations come from neither spec files nor production code. T-FLW-08 owns real model routes, owner authorization and C-UI-13.
4. Decisions: smithers-06 signs visual/copy conformance, Will decides product changes, and smithers-8a accepts seam changes with smithers-b8 and smithers-38. Model policy belongs to the wiring ticket.
5. Pre-review before start: smithers-06: answered 18:10 with these changes (mock 21b445a6) smithers-b8: answered 18:2x, ok; smithers-38: answered, BLOCKING edits applied (tech lead adopts).
6. Security: AgentView receives no provider secrets and neither evaluates instructions nor executes repository code. It renders instructions as a path and emits supplied actions only. Owner presentation is not authorization; T-FLW-08 must enforce owner-session writes at its production route. smithers-b8 reviews the View boundary under C-UI-08; smithers-3f reviews any downstream repository execution, which M-29 confines to machines. C-UI-12 checks absent actions and inert instruction text.

