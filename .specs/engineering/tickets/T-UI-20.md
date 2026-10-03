# T-UI-20 Proposal view and lessons receipt

Stage S3 · Size S · Depends on T-UI-01, T-UI-04, T-UI-06 · Unblocks T-FLW-06 · Issue: [#3590](https://github.com/smithersai/smithers/issues/3590)
Spec: spec.md §14.2.1, §13, §14.3 (Proposal) · Delta: delta.md §9 · Product: mvp.md J5.5, J8.1, §4.1, M-15 · Props: written by this ticket when S3 starts
Ready: 2026-10-03 smithers-8a sha256:e4a49a8b6b0d

## Goal

`ProposalView` and the lessons receipt exist as props-only Views matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns visuals and copy approval under §14.6b. Engineering wires it in T-FLW-06. smithers-b8 accepts the app callback and receipt seams; smithers-38 accepts changes in packages/rpc. smithers-8a decides model changes beyond §14.3. Owner review questions are recorded below; the parallel-build directive permits post-hoc review and preserves recorded owner answers.

## Scope

In:
- `ProposalView` with evidence, refs, Make TODO and Dismiss, the TODO it became once accepted, and the lessons receipt on a merged TODO.
- Props: reshape the existing `packages/rpc/src/ProposalCard.ts`, or restore it if the S1 cut removed it, with its ui-components.md section at S3. View props are TypeScript types; T-FLW-06 owns HTTP/storage validation.
- Reuse the existing View tests and browser story runner for open, accepted and dismissed proposals and absent, zero, one and multiple lessons, light and dark, 1,440 px and 390 px. No separate fixture or golden layer.
- Land dark against the specified contracts: while any unlabeled dependency is unavailable, keep the new rendering unmounted and preserve existing rendering. No live Proposal mount or learning action binding ships here; T-FLW-06 owns activation through `CardRenderers.tsx`. Missing actions render no controls, and absent lessons render no receipt. `Views.test.tsx` proves these fail-closed states.

Out:
- Topic subscriptions, production card mounting, catalog dispatch, permissions, proposal accept/dismiss persistence, learning execution and wiki writes (T-FLW-06).
- New proposal storage, suppression policy, changes to Merged, wiki co-editing (T-COL-09), planning citations (T-FLW-10), triggers and schedules.
- New public library APIs or shared primitives; reuse `@smthrs/ui`. Copy policy changes belong to product, not this ticket.

## Changes

- `packages/rpc/src/ProposalCard.ts` → reuse or restore its fields; reshape view-only schemas into TypeScript types without duplicating the HTTP/storage boundary owned by T-FLW-06.
- `apps/app/src/mainview/cards/views/TodoView.tsx` and `HomeView.tsx` → reshape the merged TODO receipt using the existing lessons count rendering (`HomeRowView.tsx:39`, folded into HomeView by the design-layer cleanup). Reuse existing action controls and Paper styles in `apps/app/src/mainview/styles/cards.css`; no second receipt renderer or stylesheet.
- `apps/app/src/mainview/cards/views/ProposalView.tsx` (new) → props-only proposal rendering. No Proposal View exists today; the existing TODO and Home renderers do not render proposal evidence, refs or accepted TODOs. Every handler uses `onAction` with the supplied action and `data-flow`, `onView`, or local state as ui-components.md Rules allows.

## Tests

- Unit, `apps/app/src/mainview/cards/views/Views.test.tsx`: mount the production ProposalView and the changed TODO/Home receipt rendering. Named cases: open evidence and refs; accepted TODO; dismissed proposal; omitted actions; supplied action order; Make TODO and Dismiss click/keyboard callbacks; absent, zero, one and multiple lessons; receipt navigation; hostile evidence and refs. Assert literal labels, counts, URLs and callback arguments authored in tests, not computed from the model, source or spec. Missing actions produce no button or callback; absent lessons produce no receipt; learning does not change the displayed Merged state.
- Browser, `apps/app/e2e/playwright/view-stories.spec.ts`: reuse `/view-stories.html` to render these production Views in both themes at 1,440 px and 390 px; verify keyboard activation and focus, no overflow and no serious or critical axe-core violation. No new harness.
- Extend `apps/app/src/mainview/flows/parity.test.ts` for the changed Views: no fetch, runtime RPC/flow import or handler outside the allowed seam. Copy assertions use a fixed term list and literal block limits in the existing tests. No test reads `.specs/` or derives expectations from production code.
- This ticket's boundary is the production View and its DOM events. It does not claim dispatcher, route or persistence coverage; T-FLW-06 proves those through the mounted card and production commands.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- Copy review: smithers-06 reads every screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. The wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the mock needs but spec §14.3 lacks is a spec change: smithers-8a decides before implementation.
- Security: proposal evidence, refs and lesson titles are untrusted data. Render text without evaluating code or injecting HTML; reject executable URL schemes. `Views.test.tsx` tests script markup, `javascript:` and control-character URL payloads through the production rendering. smithers-b8 reviews this boundary; smithers-3f reviews any proposed execution seam. This ticket adds no root step and consumes no root inputs. Repository code and test execution run only in machines (M-29); no host execution, sudo or root provisioning is introduced. Learning execution remains T-FLW-06’s machine-only responsibility.

## Ready checklist

1. Dependencies: T-UI-01 supplies primitives; T-UI-04 and T-UI-06 supply the TODO/Home rendering reshaped here. All are S1. Scope defines dark landing for unavailable dependencies; activation and runtime providers remain T-FLW-06’s responsibility, avoiding a cycle.
2. Exclusions: Scope names mounting, dispatch, permissions, persistence, execution, wiki writes/co-editing, citations, storage, suppression, schedules and public API expansion.
3. Tests: Views.test.tsx exercises production Views through DOM events with literal expectations; the existing browser route proves layout, keyboard and accessibility. T-FLW-06 owns production dispatcher/route checks. No runtime-derived or spec-derived oracle.
4. Decisions: smithers-06 approves visuals/copy; smithers-b8 accepts app seams; smithers-38 accepts rpc changes; smithers-8a decides model/spec changes. No new public API is authorized.
5. Owner pre-review: smithers-06: Does the receipt reuse the TODO/Home rendering and match the approved mock? Does every state meet copy and keyboard rules? smithers-b8: Are actions supplied without permission decisions or direct dispatch? Does dark landing leave unavailable actions unreachable? smithers-38: Does the rpc change retain one contract with zod only at HTTP/storage boundaries? These questions are the review record; owners review post hoc under the parallel-build directive, and recorded answers stand.
6. Security: smithers-b8 reviews untrusted text/URL rendering and its named hostile-input cases; smithers-3f reviews any execution seam. Repository code runs only in machines. No root step or root input exists in scope; adding one requires an input/source inventory and a named validation test for every branch-sourced input before proceeding.
