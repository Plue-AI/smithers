# C-UI-13 Every View is mounted, and no replaced legacy card remains

Proves: spec.md §14.2.1 (one card file per card; a View replaces its old card in the same commit) · Layer: unit · Stage: S1, S2, S3 · Tickets: T-APP-01, T-APP-02, T-APP-03, T-APP-04, T-APP-05, T-APP-06, T-APP-07, T-APP-16, T-APP-15, T-FLW-07, T-FLW-08, T-UI-14
Automation: `apps/app/lint/conformance/CardReachability.test.ts` (new, about 30 lines) in `//apps/app:unitTests` · Runs in: CI

Rewritten by ruling 4 of the minimal-code synthesis (2026-10-03). Part A (per-card Container integration tests) and part B (the spec-transcribed inventory gate) are deleted. Revert `8903feed4` and `94adaa285`: `apps/app/checks/Inventory.test.ts`, `apps/app/src/mainview/inventory/inventory.json` and its stage parser go. Each wiring ticket proves its own dispatch, role gates and data in its own tests.

## Setup
- The app tree at the commit under test.
- One committed literal table in the test file: each View with its wiring ticket and the legacy files that ticket deletes, for example `HomeView`: T-APP-01, `cards/StackCard.tsx`, `cards/RepositoryHomeCard.tsx`; `ConfirmView`: T-APP-04, `cards/ApprovalAnswer.tsx`; `FlowView`: T-APP-05, `cards/WorkflowCards.tsx`. A View not yet wired sits in a literal `pending` list with its ticket. The wiring ticket moves it out of `pending` in the same change.

## Steps
1. List every `apps/app/src/mainview/cards/views/*View.tsx`.
2. Walk static imports from `apps/app/src/mainview/cards/CardRenderers.tsx`, and from `apps/app/src/mainview/App.tsx` for the shell Views (conversation shell, toasts, timeline).
3. For each View not in `pending`, check it is reached and that none of its listed legacy files exists.

## Pass when
- Every View outside `pending` is reached from `CardRenderers.tsx` or `App.tsx`.
- No legacy file listed for a wired View exists.
- Every View file appears in the table or in `pending`. A new View with no row fails.

## Fail when
- A View is wired but its old card still exists, so two renderers serve one card.
- A View leaves `pending` without a mount.
- The test reads spec Markdown or derives expected names from production code.

## Evidence
CI's own check run for `//apps/app:unitTests` at the landed SHA (ruling 3).
