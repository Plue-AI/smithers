# T-UI-04 TODO view: states, questions, failure, evidence, PR and merge

Stage S1 · Size L · Depends on T-UI-01, T-APP-19 · Unblocks T-APP-02, T-REL-02, T-UI-23 · Issue: [#3541](https://github.com/smithersai/smithers/issues/3541)
Spec: spec.md §14.2.1, §4.1, §10.5.4, §10.6.4, §12.5.1, §14.3 (TODO) · Delta: delta.md §9 · Product: mvp.md J2, J4, J7, J10, M-32, M-33 · Props: [ui-components.md § T-UI-04](../ui-components.md)

## Goal

`TodoView`, with every TODO state, the question and approval forms, failure, evidence, the PR line and the merge control, exists as a props-only View matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-02 and reviews nothing visual. The conflict, moved-off and outside-push forms and Fork and Add to stack moved to T-UI-23 (product-approved split, 2026-10-02). Design reviews engineering's wiring when idle.

## Scope

In:
- Add a fixture story with a question and moved_off open together. Render each wait in its own row with its own action, primary first. Use the supplied T-UI-23 moved-off presentation; this ticket owns the combined layout story, not the repair form. Check: C-UI-12.
- `TodoView` in all nine states: prompt revisions ("+n"), steers with their authors, steps with the current one lit, every open wait listed with its own action, primary first, with the question and approval forms, the first answer and Send as steer, failure with Retry and Retry with the current flow, evidence per attempt bound to its revision (diff stat, each machine check with its duration and log link, each GitHub check with `required`, the review summary or "reviewing", an earlier generation's review, usage, flow version and model access; C-J2-04), the PR line with draft and "merges after Tn", `merged_via`, and the one `merge` control in each state and reason. The conflict, moved-off and outside-push forms and Fork and Add to stack are T-UI-23.
- Props exactly as `ui-components.md` § T-UI-04 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, Containers, command dispatch, permission decisions and product copy changes. Will decides copy changes; smithers-06 reviews their presentation (§14.6b).
- State or queue derivation, merge readiness, authorizing actions, running checks, coding-agent execution, PR writes, branch history changes and image builds. Conflict, moved-off and outside-push forms, Resolve/Done, Bring in/Discard, Fork and Add to stack belong to T-UI-23; T-APP-02 owns this View's wiring.

## Changes

- Add a fixture story with a question and moved_off open together. Render each wait in its own row with its own action, primary first. Use the supplied T-UI-23 moved-off presentation; this ticket owns the combined layout story, not the repair form. Check: C-UI-12.

- Removed-owner chip, Take over, inline Edit with prefilled inputs, and Add to machine image. Check: C-UI-12.


- Add `apps/app/src/mainview/cards/views/TodoView.tsx` (new) and CSS. Consume `@smthrs/rpc/TodoCard` and committed fixtures through module subpaths. Every handler calls `onAction` with `data-flow`, `onView`, or local presentation state.
- Fixtures from `@smthrs/rpc` (`packages/rpc/test/fixtures/`, written with T-APP-19).

## Tests

- Render the question and moved_off story at both widths. Assert distinct rows, primary-first order and each supplied action dispatched once with its own wait inputs. Retain the head on the PR line, "Running on <rev>" and "Reviewed <rev> · same change" (States s14; J10 s8; run s11). Check: C-UI-12.

- C-UI-12, named case `TodoView renders states, waits, evidence and merge controls`: render the production exports in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (new harnesses), in light and dark at 1280 and 390 px; each supplied action carries `data-flow`, disabled controls show their supplied reason and do not dispatch, and each enabled press calls only its agreed callback once. Cover all nine states, all three queue reasons, two simultaneous waits in supplied order, first-answer and late-answer text, removed owner, each evidence attempt and revision, previous reviews, required GitHub checks, draft PRs, merged_via and every merge state/reason. Press question, approval, retry, takeover, edit and merge controls using literal expected tags/payloads. Removing an action removes its control; a late-answer fixture preserves typed text for Send as steer.
- Commit reviewed literal expected strings, tags, argument objects, patches and tone token names independently of the implementation. No test reads `.specs/` or derives expectations from schemas, action arrays, rendering helpers or other production code at runtime. C-UI-08 checks the production presentation files and seeded seam violations.
- smithers-06 records copy approval from the screenshots. C-UI-02 includes these fixtures when T-CAT-01 supplies the lint; that downstream audit does not block this props-only ticket.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- T-UI-01 and T-APP-19 are the landing prerequisites. Local props and fixtures allow drafting before the contracts land, not completion. Backend state, checks and MergeReady arrive only through T-APP-02; this ticket can land with their fixed projections. This ticket adds its own C-UI-12 harness coverage with smithers-b8 pre-review.
- smithers-06 decides visuals and accepts screenshots. Will decides product copy and behavior changes. Tech lead smithers-8a accepts any ADR or spec-field change after smithers-b8 approves the app callback seam and smithers-38 approves the shared TypeScript API; update §14.3, ui-components.md and T-APP-19 together before implementation.

## Ready checklist

1. Dependencies: T-UI-01 supplies shared primitives; T-APP-19 supplies contracts and committed fixtures. Backend state, checks and MergeReady arrive only through T-APP-02; this ticket can land with their fixed projections.
2. Exclusions: Out names the runtime effects and adjacent surfaces this presentation ticket must not implement.
3. Tests: C-UI-12 case `TodoView renders states, waits, evidence and merge controls` renders production exports and asserts committed literal output/callback expectations; C-UI-08 checks the seam. No spec or production-derived runtime oracle.
4. Decisions: smithers-06 accepts visuals and screenshots; Will decides product changes; smithers-8a accepts ADR/spec changes after smithers-b8 seam and smithers-38 API approval.
5. Owner pre-review before start: smithers-06: answered 18:10 with these changes (mock 21b445a6) smithers-b8: Do all forms forward literal subject/wait/revision inputs once, and does the View leave merge eligibility and T-UI-23 forms to their owners? smithers-38: Do the T-APP-19 schema and fixture subpaths cover these states and callback payloads without changing the shared public API?
6. Security: This presentation executes no repository code, shell commands or imported tool text. smithers-b8 pre-reviews data-only rendering and absence of RPC/fetch or host execution; wiring that executes repository code requires machine-only execution (M-29) and smithers-3f review.
