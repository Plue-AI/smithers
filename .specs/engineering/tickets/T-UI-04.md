# T-UI-04 TODO view: states, questions, failure, evidence, PR and merge

Stage S1 · Size L · Depends on T-UI-01, T-APP-19b · Unblocks T-APP-02, T-REL-02, T-UI-23 · Issue: [#3541](https://github.com/smithersai/smithers/issues/3541)
Spec: spec.md §14.2.1, §4.1, §10.5.4, §10.6.4, §12.5.1, §14.3 (TODO) · Delta: delta.md §9 · Product: mvp.md J2, J4, J7, J10, M-32, M-33 · Props: [ui-components.md § T-UI-04](../ui-components.md)

## Goal

`TodoView`, with every TODO state, the question and approval forms, failure, evidence, the PR line and the merge control, exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-02 and reviews nothing visual. The conflict, moved-off and outside-push forms and Fork and Add to stack moved to T-UI-23 (product-approved split, 2026-10-02). Design reviews engineering's wiring when idle.

## Scope

In:
- Consume waits[] with per-wait actions, authored steers, owner_removed, failure.missing_tool and the supplied Add to machine image action, plus required on GitHub evidence checks. T-APP-19b supplies these contracts and fixtures. Check: C-UI-12.
- Add a fixture story with a question and moved_off open together. Render each wait in its own row with its own action, primary first. Use the supplied T-UI-23 moved-off presentation; this ticket owns the combined layout story, not the repair form. Check: C-UI-12.
- `TodoView` in all nine states: prompt revisions ("+n"), steers with their authors, steps with the current one lit, every open wait listed with its own action, primary first, with the question and approval forms, the first answer and Send as steer, failure with Retry and Retry with the current flow, evidence per attempt bound to its revision (diff stat, each machine check with its duration and log link, each GitHub check with `required`, the review summary or "reviewing", an earlier generation's review, usage, flow version and model access; C-J2-04), the PR line with draft and "merges after Tn", `merged_via`, and the one `merge` control in each state and reason. The conflict, moved-off and outside-push forms and Fork and Add to stack are T-UI-23.
- Props exactly as `ui-components.md` § T-UI-04 with the zod type reconciled by T-APP-19b from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Do not derive waits, authorize Take over or build an image. T-APP-19b owns schemas; T-APP-02 and the existing image wiring own runtime effects. Check: C-UI-08.
- Topic subscriptions, Containers, command dispatch, permission decisions and product copy changes. Will decides copy changes; smithers-06 reviews their presentation (§14.6b).
- State or queue derivation, merge readiness, authorizing actions, running checks, coding-agent execution, PR writes, branch history changes and image builds. Conflict, moved-off and outside-push forms, Resolve/Done, Bring in/Discard, Fork and Add to stack belong to T-UI-23; T-APP-02 owns this View's wiring.

## Changes

- Render each waits[] row in supplied primary-first order. Dispatch only that row's actions with its bound wait inputs. Render steers, removed-owner state and missing-tool/image-add control without deriving permission. Check: C-UI-12.

- Add a fixture story with a question and moved_off open together. Render each wait in its own row with its own action, primary first. Use the supplied T-UI-23 moved-off presentation; this ticket owns the combined layout story, not the repair form. Check: C-UI-12.

- Removed-owner chip, Take over, inline Edit with prefilled inputs, and Add to machine image. Check: C-UI-12.


- Add `apps/app/src/mainview/cards/views/TodoView.tsx` (new) and CSS. Consume `@smthrs/rpc/TodoCard` and committed fixtures through module subpaths. Every handler calls `onAction` with `data-flow`, `onView`, or local presentation state.
- Fixtures from `@smthrs/rpc/fixtures/Todo` (`packages/rpc/test/fixtures/`, reconciled with T-APP-19b).

## Tests

- Cover simultaneous question/moved_off waits and distinct per-wait tags/args; authored steers; removed-owner Take over; missing-tool Add to machine image; and required versus optional evidence checks. Remove each action and assert its control is absent. Check: C-UI-12.

- Render the question and moved_off story at both widths. Assert distinct rows, primary-first order and each supplied action dispatched once with its own wait inputs. Retain the head on the PR line, "Running on <rev>" and "Reviewed <rev> · same change" (States s14; J10 s8; run s11). Check: C-UI-12.

- C-UI-12, named case `TodoView renders states, waits, evidence and merge controls`: render the production exports in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (new harnesses), in light and dark at 1280 and 390 px; each supplied action carries `data-flow`, disabled controls show their supplied reason and do not dispatch, and each enabled press calls only its agreed callback once. Cover all nine states, all three queue reasons, two simultaneous waits in supplied order, first-answer and late-answer text, removed owner, each evidence attempt and revision, previous reviews, required GitHub checks, draft PRs, merged_via and every merge state/reason. Press question, approval, retry, takeover, edit and merge controls using literal expected tags/payloads. Removing an action removes its control; a late-answer fixture preserves typed text for Send as steer.
- Commit reviewed literal expected strings, tags, argument objects, patches and tone token names independently of the implementation. No test reads `.specs/` or derives expectations from schemas, action arrays, rendering helpers or other production code at runtime. C-UI-08 checks the production presentation files and seeded seam violations.
- smithers-06 records copy approval from the screenshots. C-UI-02 includes these fixtures when T-CAT-01 supplies the lint; that downstream audit does not block this props-only ticket.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19b's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- T-UI-01 and T-APP-19b are the landing prerequisites. Local props and fixtures allow drafting before the contracts land, not completion. Backend state, checks and MergeReady arrive only through T-APP-02; this ticket can land with their fixed projections. This ticket adds its own C-UI-12 harness coverage with smithers-b8 pre-review.
- smithers-06 decides visuals and accepts screenshots. Will decides product copy and behavior changes. Tech lead smithers-8a accepts any ADR or spec-field change after smithers-b8 approves the app callback seam and smithers-38 approves the shared TypeScript API; raise §14.3 and ui-components.md gaps through T-APP-19b before implementation; UI lanes never raise piecemeal schema changes.

## Ready checklist

T-UI-02 through T-UI-14 go Ready together after T-APP-19b lands with smithers-38's §21.1 review. Local props permit drafting only. This UI lane makes no piecemeal schema change. Check: C-UI-08.

1. Dependencies: T-UI-01 supplies shared primitives; T-APP-19b supplies contracts and committed fixtures. Backend state, checks and MergeReady arrive only through T-APP-02; this ticket can land with their fixed projections.
2. Exclusions: Out names the runtime effects and adjacent surfaces this presentation ticket must not implement.
3. Tests: C-UI-12 case `TodoView renders states, waits, evidence and merge controls` renders production exports and asserts committed literal output/callback expectations; C-UI-08 checks the seam. No spec or production-derived runtime oracle.
4. Decisions: smithers-06 accepts visuals and screenshots; Will decides product changes; smithers-8a accepts ADR/spec changes after smithers-b8 seam and smithers-38 API approval.
5. Owner pre-review before start: smithers-06: answered 18:10 with these changes (mock 21b445a6) smithers-b8: answered 18:2x, ok; smithers-38: answered, BLOCKING edits applied (tech lead adopts).
6. Security: This presentation executes no repository code, shell commands or imported tool text. smithers-b8 pre-reviews data-only rendering and absence of RPC/fetch or host execution; wiring that executes repository code requires machine-only execution (M-29) and smithers-3f review.
