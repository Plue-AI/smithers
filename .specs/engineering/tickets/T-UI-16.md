# T-UI-16 File and Diff live states

Stage S2 · Size S · Depends on T-UI-01, T-APP-15 · Unblocks T-APP-11 · Issue: [#3580](https://github.com/smithersai/smithers/issues/3580)
Spec: spec.md §14.2.1, §14.3 (File, Diff), §9.2.3, §9.2.6, §9.3.5 · Delta: delta.md §9 · Product: mvp.md J3.4, §6.8 · Props: ui-components.md § T-APP-15 File (read-only) and Diff
Ready: 2026-10-03 smithers-8a sha256:04caefbc0073

## Goal

The File and Diff live states exist in the File surface (`cards/CodeSurface.tsx`) and the Diff surface (`cards/DiffSurface.tsx`, where T-APP-15 folds `DiffView`) as props-only states matching the design mock, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns visual and copy acceptance. smithers-b8 owns the app callback seam; smithers-38 reviews use of the package types. They are the pre-review owners named in the Ready checklist; recorded owner answers stand, and parallel-build owner review may follow landing. Engineering wires runtime data and actions in T-APP-11. smithers-8a decides contract changes before implementation; this ticket adds no public API or ADR.

## Scope

In:
- The deleted banner with Restore and the renamed banner with Follow (`gone`), the snapshot caption and the read-only Compare layout. The "Changed outside Smithers" flag and Compare against `outside.version` are presentation cases only here; T-APP-14 enables the live-document flag in S3.
- Reuse the existing File and Diff contracts in `packages/rpc/src/FileCard.ts` and `DiffCard.ts`: File already has `gone` and `outside.version`; Diff already has `renamed_to`. Use TypeScript props for presentation, not new schemas. T-APP-11 owns boundary-schema changes. CodeMirror is S3 (T-APP-14a).
- Reuse the existing story runner for these presentation states, light and dark, 1,440 px and 390 px.
- Land dark against any unlanded dependency: T-UI-01 primitives and T-APP-15 read-only surfaces use their specified contracts; unavailable integration stays unbound. Before T-APP-11 supplies live props and filtered actions, no new live state, subscription, restore write or Compare fetch is enabled. Missing actions render no control; disabled actions cannot dispatch. The tests below prove this gate; no host fallback or new feature flag is added.

Out:
- Topic subscriptions, content routes, command registration, permissions, restore writes, stale-write handling, watcher events and language-server execution (T-APP-11, T-COL-04).
- CodeMirror, editing, Yjs, live-document conflict detection, presence/name flags, per-character authors and saved/unsaved recovery controls (T-APP-14a, T-APP-14, T-UI-19).
- Line comments, per-entry Undo and replaced-edit flags; new View or Container files, fixture layers, golden layers and public APIs. Copy follows spec §14.6b; smithers-06 accepts it.

## Changes

- Reload with no remount, preserving scroll and line; gone banners and Compare; no line-comment affordance.
- Reshape `apps/app/src/mainview/cards/CodeSurface.tsx` and `DiffSurface.tsx` and reuse their existing adapters and `styles/cards.css`. Reuse `DiffCardSurface` already in `DiffSurface.tsx`; do not recreate `DiffView`. Keep one rendering path. Every presentation handler follows ui-components.md Rules: `onAction` with `data-flow`, `onView`, or local state/focus/clipboard. No new shared primitive is required.

## Tests

- Unit (`apps/app/src/mainview/cards/views/Views.test.tsx`, C-UI-12): mount the production File and Diff surfaces with literal props. Deleted and renamed cases show the literal actor and path; snapshot and Compare cases show literal revisions and bytes. Rerender the same surface with changed text/patch; its DOM identity, scroll position and selected line survive. Missing actions render no control; disabled actions dispatch nothing. Keyboard activation of Restore, Follow, Restore this file and Compare sends each supplied tag and literal arguments once; only burst diffs offer Restore this file.
- Unit (`apps/app/src/mainview/cards/CardRenderers.test.tsx`): enter through the production `renderCardBody` File and Diff family entries with literal legacy payloads and unavailable S2 actions. No new live banner or executable S2 control appears, and no command or fetch runs. Do not invoke a surface directly for this dark-landing test. T-APP-11 owns enabled dispatch and route tests, including stale restore and unavailable machine providers.
- Playwright (`apps/app/e2e/playwright/view-stories.spec.ts`): use the production surfaces in the existing story runner, in both themes at 1,440 px and 390 px. Reload keeps scroll and line; Compare is keyboard operable; no page overflow or serious/critical axe-core violation occurs. Hostile file text and paths render as data and run no script.
- Copy assertions in this ticket's `Views.test.tsx` cases pin literal labels and the forbidden words/12-word limit from §14.6b. Expectations are committed literals, independent of production schemas, story metadata and spec files; no test reads `.specs/` or calculates expected values from production code.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- Copy review: the design reviewer reads every story screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. The wiring ticket's own checks prove the card end to end.

## Risks and notes

- A prop the mock needs but spec §14.3 lacks is a spec change: smithers-8a decides it before implementation; smithers-b8 accepts the callback seam and smithers-38 accepts package-type changes.
- Security: file bytes, paths and patches are untrusted display data. This ticket executes no repository code, starts no language server or machine, performs no file write and adds no root step. Root inputs: none. Repository execution remains machine-only (M-29); T-APP-11 owns runtime confinement. smithers-b8 reviews presentation isolation and the hostile-content/dark-landing tests before start, or post hoc under the parallel-build directive.

## Ready checklist

1. Dependencies: T-UI-01 supplies primitives; T-APP-15 supplies the read-only surfaces. Both are S1. Scope and the production renderer test keep unavailable dependencies and T-APP-11 wiring dark and fail closed.
2. Exclusions: Scope names runtime wiring, writes, watchers, language servers, S3 editing and recovery, deferred diff controls, duplicate rendering and new API/layer work.
3. Tests: production surfaces prove presentation; `renderCardBody` proves dark landing at the app mount boundary; the existing browser runner proves layout and keyboard use. Assertions use literal expectations, not spec files or production-derived values. Enabled dispatcher/route checks belong to T-APP-11.
4. Decisions: smithers-06 accepts visuals/copy, smithers-b8 accepts callbacks, smithers-38 accepts package-type use, and smithers-8a decides contract changes. No ADR or public API is introduced.
5. Owner pre-review: smithers-06: do reload, gone states and Compare match the accepted design and preserve scroll/line? smithers-b8: do callbacks carry only supplied actions, and does the mount stay dark without S2 wiring? smithers-38: can existing File/Diff types be reused without new schemas or a public API change? Recorded answers stand; parallel-build review may follow landing.
6. Security: smithers-b8 reviews data-only rendering, hostile-content tests and absence of execution/fetch fallbacks. M-29 confines any later repository execution to machines. This ticket has no root step and consumes no root inputs.
