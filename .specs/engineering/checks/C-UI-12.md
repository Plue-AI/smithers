# C-UI-12 Each View renders every fixture of its card

Proves: spec.md §14.2.1, §14.3, §14.5.2 (tone), §14.6a · Layer: unit · Stage: S1, S2, S3 · Tickets: T-UI-01, T-UI-02, T-UI-03, T-UI-04, T-UI-05, T-UI-06, T-UI-07, T-UI-08, T-UI-09, T-UI-10, T-UI-11, T-UI-12, T-UI-13, T-UI-14, T-UI-15, T-UI-16, T-UI-17, T-UI-18, T-UI-19, T-UI-20, T-UI-21, T-UI-22, T-UI-23
Automation: `apps/app/src/mainview/cards/views/Views.test.tsx` (new; happy-dom) and `apps/app/e2e/playwright/view-stories.spec.ts` (new; Chromium, fixtures only) · Runs in: CI

## Setup
T-APP-19b's reconciled fixtures in `packages/rpc/test/fixtures/` contain reviewed literal expected strings, action tags, argument objects, view patches and tone token names, committed independently of the implementation. Render production card Views, shared primitives and shell exports, never replicas. No test reads `.specs/` or derives its oracle from schemas, render helpers, action arrays or other production code at runtime. No backend, Container or topic is involved. Each T-UI ticket adds its own harness coverage. Apply action and callback steps only to components whose props expose them; ActorChip and StateWord have no command controls. Import each through `@smthrs/rpc/fixtures/<Card>`, including Monitor, BranchTreeNode, ContextLine, EntryRow, Toast and TimelineEntry.

## Steps
1. Render each fixture with its production View, shared primitive or shell export, with recording callback spies only where its props expose them.
2. Press every rendered control and fire every gesture in `gestures` once. For Confirm, press actions[] approval/denial entries with their bound subject/revision arguments, never model.action.tag. For Draft, assert exact string encodings of acceptance, place and fixes. For the production shell exports, use the declared BranchTree/Earlier callbacks and shared ShellView patches. For Flow, version selection uses local state with no callback.
3. Render the same fixture with its first action removed.
4. In Chromium, render each fixture in light and dark at 1280 × 800 and 390 × 844, screenshot it, and run axe-core.

## Pass when
- T-UI-02 through T-UI-14 each render every T-APP-19b gap fixture: Setup blocked/app_manifest/limit and Settings health/sync; full Draft input; simultaneous TODO waits, steers, removed owner, missing tool and required checks; Confirm forbidden-subject exclusion and expired receipt; Home row actions and owner reset; shell archive_count/tombstone and patches; Members color_index; Flow added; File github_url/content/digest/mode/hover/reveal; Diff bases/burst/change/binary; Monitor settled waits, key/usage, engine/journal/replay/selected/at; Agent Draft-opening instructions and product-approved model action; Commands synopsis/description/agent marks.
- T-UI-11 uses the production Pierre adapter with independently committed unified-patch fixtures for modified/added/deleted/renamed files and multiple or empty hunks. Read-only editor updates preserve editor identity, scroll and cursor. Record the exact shared editor export and CodeMirror/y-codemirror.next pins approved before Ready.
- Hostile code, hover Markdown, journal, output and summaries execute no script or command. Replay emits only onView({at}); the View accepts only a rendered custom slot, never repository modules.
- Step 1: every fixture renders with no error and no console error, and every `expect` string is visible.
- Step 1: each committed literal expected action renders as one control, in order, with its literal label, tag, arguments and disabled reason. ActorChip and StateWord have no command controls.
- Step 2: each press calls the exposed callback once with the committed literal expected tag, arguments or view patch. No other callback fires. Expectations are independent of production action arrays and render helpers.
- Step 3: the removed action has no control.
- Step 4: no horizontal overflow at 390 px; each tone renders the committed literal token expected by its fixture test; no test reads a spec file or derives expectations from production code at runtime; no axe-core violation of serious or critical impact.

## Fail when
- Confirm dispatches its initiating model.action.tag instead of the supplied approval/denial action; an instruction edit commits a TODO instead of opening a Draft; or a Draft field sends a non-string value.
- A props-only shell file lacks production-export fixture coverage, a binary/too-large File lacks its supplied GitHub link, or a Diff uses a second rendering engine.
- A fixture has no story, or a View renders a control for an action it wasn't given.
- A screenshot shows overflow or a missing state in either theme.

## Evidence
`.artifacts/checks/C-UI-12/<UTC>/`: the CI log, the screenshots per View and fixture, the axe report and the commit.
