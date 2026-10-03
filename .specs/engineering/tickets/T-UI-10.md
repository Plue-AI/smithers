# T-UI-10 Flow view

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-APP-05 · Issue: [#3547](https://github.com/smithersai/smithers/issues/3547)
Spec: spec.md §14.2.1, §11, §14.3 (Flow) · Delta: delta.md §9 · Product: mvp.md J5, J11 · Props: [ui-components.md § T-UI-10](../ui-components.md)
Ready: 2026-10-03 smithers-8a sha256:358321acb5d7

Landed (214c4feff).

## Goal

`FlowView` renders a flow's source, versions and steps from props, so T-APP-05 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns visual decisions and the View. smithers-b8 approves the app seam and shared CSS changes; smithers-8a accepts changes to the props contract or ticket boundary. Engineering wires it in T-APP-05. Owner pre-review questions are in the Ready checklist; under Will’s 2026-10-03 directive, owners review post hoc and recorded answers stand.

## Scope

In:
- Landed: the source label, versions with their states, steps with their agent and the supplied `added` mark, and Source, Plan, Run, Edit. The version chip is React local state.
- Remaining: reshape the existing Flow rules in `apps/app/src/mainview/styles/cards.css` and their `FlowView.tsx` class names to drop `mvp-` from `mvp-version*`, `mvp-flow-*` and `mvp-signal`. The CSS move is already complete: `styles/views/flow.css` and `styles/views.css` are absent. Reuse the landed View and action renderer; add no second renderer, container, schema or fixture layer (delta.md §9; C-UI-12).
- Land dark if T-UI-01 is unavailable: keep the View unmounted by `cards/CardRenderers.tsx`; do not enable commands or execution. T-APP-05 owns cutover and its fail-closed action bindings. No flow loader, dispatcher or machine provider is a runtime precondition for this props-only change (C-UI-12).

Out:
- Flow loading, activation, digests, pinning, source edits and draft execution (T-FLW-03, T-FLW-04, T-APP-05).
- Card mounting, legacy card deletion, subscriptions, catalog dispatch, permission filtering and persisted version selection (T-APP-05). Triggers, graph editing, monitor rendering and model controls are outside this View change.

## Changes

- Rename the existing Flow selectors in `apps/app/src/mainview/styles/cards.css` and their matching classes in `apps/app/src/mainview/cards/views/FlowView.tsx`; update selectors in `FlowView.stories.tsx` and `Views.test.tsx` in the same change. Keep one rule set and preserve the Paper tokens, focus styles and rendered behavior (C-UI-12).
- Mounting: T-APP-05 mounts `FlowView` through the landed `cards/FlowContainer.tsx` and deletes `cards/WorkflowCards.tsx` in the same change (pair: FlowView; v1 §2).

## Tests

C-UI-12 is folded into the Flow cases in `apps/app/src/mainview/cards/views/Views.test.tsx`. Render the production `FlowView` and `FlowActionView`, then click their DOM controls; do not substitute a test View or call callbacks directly. Keep expected words, tags, arguments and counts as authored literals, independent of spec files and production code at runtime. This ticket tests the production View boundary; T-APP-05 tests `CardRenderers`, `flows/cardActions.ts` and the production dispatcher. The Flow cases cover:
- active, proposed, merged-syncing, merged-failed and previous versions; built-in and repository source labels;
- `added` true, false and absent, marked relative to the supplied Active version;
- selecting a version changes the display and sends no `onAction` or `onView`;
- `Flow actions retain literal order and bindings; omitted and disabled controls`: Source, Plan, Run and Edit emit their literal tags and `{name: "todo"}` once through `onAction`; omitted actions render no control and disabled actions emit nothing. These are callback assertions, not claims of completed execution.
- `Flow source is inert text and merge signals use supplied targets`: script-shaped source text creates no script element; merge signals show the literal supplied targets.
- `Flow load failure belongs to selected version` and `Flow failed version without diagnostics has no disclosure`: selecting a failed version shows its error; Active stays usable; absent or blank errors invent no details.
- After renaming, the same cases render the production View with `actions: []` while unmounted by the app: no action control or callback. Verify the Flow selectors match the renamed DOM classes, with no old Flow selector or duplicate CSS file remaining (C-UI-12).

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA. No `mvp-version*`, `mvp-flow-*` or `mvp-signal` class remains in the Flow View or its selectors. `styles/views/flow.css` and `styles/views.css` remain absent; the existing Flow rules live only in `styles/cards.css`.

## Risks and notes

- Source text, labels, diagnostics and signals are inert data. FlowView never imports or evaluates a repository flow (M-29, spec.md §1.3). This ticket adds no execution or root step and consumes no main- or branch-sourced root inputs. smithers-b8 reviews the browser boundary; smithers-3f owns the machine execution boundary in T-APP-05. C-UI-12’s inert-source and disabled-action cases verify this View’s boundary.

## Ready checklist

1. Dependencies: T-UI-01 is the only prerequisite for this props-only reshape. Scope states dark landing if it is unavailable; loading, execution and production mounting stay in T-APP-05.
2. Exclusions: Scope names loading, activation, pinning, source editing, draft execution, mounting, legacy deletion, permissions, subscriptions, persisted selection, triggers, graph editing, monitor and model controls.
3. Tests: C-UI-12 exercises production FlowView/FlowActionView DOM controls with literal expectations; T-APP-05 owns dispatcher and journey tests. No runtime spec or implementation-derived oracle is allowed.
4. Decisions: smithers-06 decides visuals, smithers-b8 accepts the app/CSS seam, and smithers-8a accepts props or scope changes. No public API or new schema is introduced.
5. Owner pre-review: smithers-06: Do renamed classes preserve Paper styling and keyboard focus? Does the View retain the supplied version states, errors and added marks? smithers-b8: Are all shared CSS consumers and test/story selectors updated together? Does this reshape leave mounting and action authority in T-APP-05? Owners review post hoc under Will’s directive; recorded answers stand.
6. Security: repository data remains inert, omitted/disabled actions cannot emit callbacks, and this ticket executes no repository code or root step. smithers-b8 reviews that View boundary; smithers-3f reviews machine execution in T-APP-05. C-UI-12 names the inert-source and disabled-action tests.
