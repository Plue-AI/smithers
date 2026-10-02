# T-CUT-01 Delete cut app surfaces; align AGENTS.md scope

Stage S1 · Size L · Depends on — · Unblocks T-CUT-02, T-DOC-03 · Issue: [#3435](https://github.com/smithersai/smithers/issues/3435)
Spec: spec.md §6.1.2, §6.1.3, §14.2 · Delta: delta.md §10 (Delete app rows; Modify AGENTS.md), §11 (AGENTS.md conflicts) · Product: mvp.md §8 (Cut rows), Appendix B (B.1, B.2 Cut rows), §12 release item 3, M-12, §13 (strategy reconciliation)

## Goal
None of the app surfaces mvp.md §8 or Appendix B marks **Cut** exist in the app's source, renderers, flows or specs, so T-CAT-01's allowlist test passes. AGENTS.md describes the MVP scope that mvp.md §8 sets.

## Scope
In (app, `apps/app/src/mainview/` unless noted). Delete each surface with its tests, CSS and e2e specs in the same change:
- **Five-job setup UI; CI, Feature and Chores jobs:**
  - `cards/SetupChecklist.{tsx,css,test.tsx}` (`App.tsx:20,569`) and `cards/RepositorySetupCard.{tsx,css,test.tsx}`;
  - `state/controller/repositorySetup.ts`, `repositorySetupGuide.ts`, `repositoryReadiness.ts`, and their tests, `RepositorySetupQuestion.test.ts`, `repositoryJobObservations.test.ts`;
  - `flows/entries/{setup,chores,ci,feature}.ts`;
  - `e2e/playwright/repository-setup.spec.ts` and `e2e/real/repository-setup.spec.ts`.
- **Signup poll, first-run checklist, practice repository:**
  - `cards/SignupCards.{tsx,css,test.tsx}`, `state/Signup.ts` and `state/controller/signup.ts`;
  - `flows/entries/signup.ts`, `state/controller/tutorialRepository.ts`, `state/FirstRunRepository.ts`;
  - `onboarding/GuideButton.tsx`, `Onboarding.ts`, `state/Onboarding.test.tsx`, `state/controller/onboarding.ts`;
  - `e2e/playwright/{signup,first-run-chat-gate,tutorial-entry}.spec.ts` and `e2e/real/signup-{completion,identity}.spec.ts`.
- **Repository registration and admin review:**
  - `cards/RegistrationCard*.tsx`, `cards/Registration*.ts` and `RegistrationStatus.tsx`;
  - `repository.register` in `flows/entries/repository.ts`, and `state/controller/registration.ts`;
  - `e2e/playwright/registration-ownership.spec.ts` and `e2e/real/registration.spec.ts`.
- **Admin console:**
  - `cards/AdminCards.{tsx,test.tsx}`, `flows/entries/admin.ts`, `state/AdminGrant*.ts` and `state/controller/admin-grant.test.ts`;
  - `apps/app/scripts/admin-grant-backend-consumer.ts` and `e2e/real/admin-operations.spec.ts`.
- **Issue-sweep / burndown:**
  - `cards/Burndown*.{ts,tsx}` and its tests, plus `flows/issueSweep.test.ts`;
  - `issue-sweep` in `flows/entries/issue.ts` and `runs.burndown.*` in `flows/entries/runs.ts`;
  - `e2e/playwright/burndown.spec.ts` and `e2e/real/coverage/deferrals/issueSweep.ts`.
- **Cloud agent sessions outside TODOs; subagent grid:**
  - `SubagentGrid.tsx` (`App.tsx:47`), `subagents` in `flows/entries/agent.ts` and `packages/rpc/src/SubagentCard.ts`;
  - `flows/entries/agentSession.ts`, `state/AgentSession*.test.ts` and `e2e/playwright/agent-sessions.spec.ts`.
- **Splitting and squashing:** `change.split` in `flows/entries/change.ts`.
- **Other Appendix B Cut rows** (the allowlist fails while any is registered): `chat.clear`, `tab.*`, `world.*`, the retired surfaces row (`subagents`, `connect`, `smithers.who`, `workspace.rename`, …), `search.targets`, `search.boxes`, `box.select`, `files.add`, `change.request`, `change.revert`, `prs.create`, `issues.fix|verify|set`, `issues.comment.react|retry`, `wiki.ask`, `runs.takeover|release|handoff`, `notifications.list|read`. The `billing.*`, `cloud.*` and `repo.*` rows go with T-CUT-03.
- **Matching rows:** update `CardRenderers.tsx`, `CardFamily.ts`, `packages/rpc/src/Cards.ts` and `e2e/real/coverage/deferrals/*.ts`.
- **AGENTS.md (root):**
  - "MVP scope boundaries", first bullet: replace "Retain all five maintenance jobs" with mvp.md §8's line. The setup UI and the CI, Feature and Chores jobs are cut. Event admission, dispatch, reproduction, review and approvals stay for the maintainer release.
  - "Instant chat": drop the tutorial and onboarding sentences, which describe cut surfaces, and re-point "Reference implementation" from `state/controller/repositorySetup.ts` to the TODO controller T-APP-02 creates (delta.md §11).
- **`apps/app/AGENTS.md`:** delete or rewrite "Signup onboarding", "First-run experience", "Current onboarding brief" and "App home (D-18)", which describe cut surfaces.

Out:
- **Hide** and **Defer** rows: the T-CAT-01 allowlist and T-CUT-03.
- **Merge** rows: `CommitCards.tsx` and `BranchesCard.tsx` stay until T-APP-01 and T-APP-10 absorb them, because `/branches` uses `branches.list` today.
- Backend routes (T-CUT-02) and branch locks (T-MCH-05).
- Kept surfaces:
  - `GrantConfirm` (general confirm, used by `ChatCards.tsx` and `CardActions.ts`);
  - `FirstSightHint.tsx`/`HelpBubble.tsx` (mvp.md §6.14 keeps one hint);
  - `ChatMeter.tsx` (AGENTS.md keeps usage and budgets);
  - `DevtoolsPanel.tsx` (Hide, not Cut);
  - `findings.*` (review).
- `docs/mvp/*` replacement (T-DOC-03).

## Changes
- Delete the files listed above. In `App.tsx`, remove the signup, first-run and checklist slots (`:568-569`) and the subagent grid.
- `flows/FlowName.ts` (`FLOW_NAMES`) and `flows/registry.ts` `NAMESPACES` (`:362-364`: `setup.namespace`, `ciNamespace`, `choresNamespace`): remove the deleted ids.
- `apps/app/lint/conformance/{Vocabulary,LiteralPin,TestInventory}.test.ts`: refresh the pins the deletions change.
- `AGENTS.md` and `apps/app/AGENTS.md`: apply the edits above, citing mvp.md §8 and M-12.
- `apps/review` and `packages/smithers/create-app` hold no tracked files (`jj file list` returns none), so nothing lands for them.

## Tests
- Unit: `packages/rpc/src/catalog/Cuts.test.ts` (new, the C-CUT-01 app half). Each Cut id in `packages/rpc/src/catalog/cuts.json` (new, one entry per §8 row with its surfaces) must be absent from `FLOW_NAMES`, the card renderer map, `Cards.ts` kinds and the visible catalog.
- Unit: `cards/CardRenderers.test.tsx` stays disjoint and complete after the deletions.
- Unit: T-CAT-01's `AppendixB.test.ts` passes, so no Appendix B Cut id is registered.
- e2e: the full `apps/app/e2e/playwright` and `e2e/real` suites. The spec count may drop only by the specs deleted here, listed in the evidence.

## Acceptance
- [C-CUT-01](../checks/C-CUT-01.md): cut app surfaces are absent from the palette, agent tools, renderers and source.

## Risks and notes
- **AGENTS.md edits:** Will approved reconciling AGENTS.md with mvp.md on 2026-10-02 (mvp.md §13), so the edits land with the code deletions, citing M-12.
- **Contradictions to report, not resolve:**
  - AGENTS.md "Maintainer workflow" runs the factory on Smithers Cloud, while M-31 moves Smithers' development onto the Mac install. The mvp.md §13 reconciliation owns that line; this ticket doesn't change it;
  - open issues #3338 (signup video) and #3336 (issue-sweep card) contradict §8, and should be closed or re-scoped with the evidence from this ticket.
- **Shared code:** `flows/entries/runs.ts` and `issue.ts` hold both cut and kept entries. Delete entries, not files.
- **Falsifiable:** if `rg -l "SetupChecklist|SignupCards|BurndownCard|SubagentGrid|AdminCards|RegistrationCard" apps/app/src` returns anything after the change, the cut is incomplete.
