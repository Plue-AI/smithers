# C-UI-12 Each View renders every fixture of its card

Proves: spec.md §14.2.1, §14.3, §14.5.2 (tone), §14.6a · Layer: unit · Stage: S1, S2, S3 · Tickets: T-UI-01, T-UI-02, T-UI-03, T-UI-04, T-UI-05, T-UI-06, T-UI-07, T-UI-08, T-UI-09, T-UI-10, T-UI-11, T-UI-12, T-UI-13, T-UI-14, T-UI-15, T-UI-16, T-UI-17, T-UI-18, T-UI-19, T-UI-20, T-UI-21, T-UI-22, T-UI-23
Automation: `apps/app/src/mainview/cards/views/Views.test.tsx` (new; happy-dom) and `apps/app/e2e/playwright/view-stories.spec.ts` (new; Chromium, fixtures only) · Runs in: CI

## Setup
T-APP-19's fixtures in `packages/rpc/test/fixtures/`. Each fixture is `{name, model, actions, gestures, view, expect}`; `expect` lists the strings its View must show, for example "Waiting for a machine · #2" or "Merges after T8". No backend, Container or topic is involved. Run it for the Views of one T-UI ticket, or for all Views.

## Steps
1. Render each fixture with its View, with recording `onAction` and `onView` spies.
2. Press every rendered control and fire every gesture in `gestures` once.
3. Render the same fixture with its first action removed.
4. In Chromium, render each fixture in light and dark at 1280 × 800 and 390 × 844, screenshot it, and run axe-core.

## Pass when
- Step 1: every fixture renders with no error and no console error, and every `expect` string is visible.
- Step 1: each action in `actions[]` renders as one control, in order, labelled with its `label` and carrying `data-flow={tag}`. A disabled action shows its reason.
- Step 2: each press calls `onAction` once with the action's tag and `{...args, ...input}`, or `onView` once with a patch. No other callback fires.
- Step 3: the removed action has no control.
- Step 4: no horizontal overflow at 390 px; each tone renders the token the ui-components.md Tone table names; no axe-core violation of serious or critical impact.

## Fail when
- A fixture has no story, or a View renders a control for an action it wasn't given.
- A screenshot shows overflow or a missing state in either theme.

## Evidence
`.artifacts/checks/C-UI-12/<UTC>/`: the CI log, the screenshots per View and fixture, the axe report and the commit.
