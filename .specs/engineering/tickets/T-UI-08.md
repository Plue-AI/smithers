# T-UI-08 Toasts, edge map and timeline

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-APP-07, T-APP-18 · Issue: [#3545](https://github.com/smithersai/smithers/issues/3545)
Spec: spec.md §14.2.1, §14.4, §14.5.4, §14.6 · Delta: delta.md §9 · Product: mvp.md §6.4 · Props: [ui-components.md § T-UI-08](../ui-components.md)
Ready: 2026-10-03 smithers-8a sha256:01e5023c1156

Landed (406436c02).

## Goal

The toast stack, edge map and timeline render from props, so T-APP-07 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) decides layout, Paper styling and keyboard behavior. smithers-b8 accepts the shell callback seam and security boundary; engineering wires it in T-APP-07 and T-APP-18. smithers-8a accepts any change to the cited props contract before implementation. This ticket changes no public library API. The Ready checklist names the owner pre-review questions; under Will’s 2026-10-03 parallel-build directive, owners review post hoc.

## Scope

In:
- Landed in `apps/app/src/mainview/`: `ToastStackView.tsx` (three notices plus "+N more", one action each, Hide; the S2 Allow notifications variant), `EdgeMap.tsx` (two rows plus a count per edge, one pill on narrow screens) and `Timeline.tsx` with the band, shown at 1,180 px and wider.
- Remaining:
  - Fold `views/ToastNoticeView.tsx` into `ToastStackView.tsx`, and `views/EdgeGroupView.tsx` with its only child `views/EdgeRowView.tsx` into `EdgeMap.tsx`; each has one caller (minimal-code synthesis v1 §6). `views/TimelineLineView.tsx` folds into `Timeline.tsx` for the same reason.
  - Reshape the existing shell rules in `apps/app/src/mainview/styles/cards.css` and drop their `mvp-` prefix. `styles/views/shell.css` and `styles/views.css` are already absent; do not recreate them.
- Land dark against T-UI-01’s props and Paper contract if its remaining work is unavailable: retain the existing tokens and add no fallback primitives. Keep the existing app mounts until T-APP-07 wires these props and removes the replaced markup. Missing actions render no control; disabled actions emit no callback. The S2 Allow variant remains a supplied prop only until T-APP-18 enables it. No new provider, dispatcher or renderer is added.

Out:
- Event delivery, audience selection, debounce, persisted hiding, scroll execution, visibility leases and timeline summaries (T-APP-07, T-APP-16); browser permission and notification delivery (T-APP-18).
- New shell mounts, catalog commands, authorization, model calls, repository execution, root steps, service workers, push, email and phone notifications. Do not change the run card’s scrubber or add a third renderer.

## Changes

- Inline the four sub-Views in their parents; delete the files.
- Rename only the shell `mvp-` classes and animation in `styles/cards.css`, updating the three parent components and their existing test/story selectors together. Reuse the existing rules and Paper tokens; add no stylesheet or fixture layer. Keep the shell paths covered by `flows/parity.test.ts` after inlining.
- Mounting: T-APP-07 mounts these through the existing `ToastStack.tsx` (fed by the shared toast stack in `state/controller/failures.ts`), `ChatRunTimeline.tsx` and `EdgeMap.tsx`, and deletes their old markup, folding `ToastStackView.tsx` into `ToastStack.tsx` and `Timeline.tsx` into `ChatRunTimeline.tsx`. Never both copies (v2: mount and delete the old copy, or revert 406436c0).

## Tests

Extend the shell cases in `apps/app/src/mainview/cards/views/Views.test.tsx` (C-UI-12). Mount the production `ToastStack` export from `ToastStackView.tsx`, `EdgeMap` and `Timeline`; activate their DOM controls and assert the `onAction` and `onView` callbacks. Do not call extracted handlers or dispatch commands from tests to bypass controls. This ticket’s boundary is the props-only shell; production command dispatch, persistence and app mounting are T-APP-07/T-APP-18 checks. Use authored input values and literal expected text, counts and callback patches; never derive expectations from spec files, production code or fixture expectations at runtime. Cover:
- more than three notices show exactly three and the literal hidden count; opening "+N more" by pointer and keyboard reveals every hidden entry;
- Hide emits its literal patch and deletes no timeline or edge entry;
- clicking a timeline line emits a literal `jump_to` patch;
- at 1,179 px the timeline is absent and edges are pills; at 1,180 px it is present;
- a supplied Allow action forwards `notifications.allow`; without the action there is no Allow control, and the View never calls `Notification.requestPermission`;
- empty arrays render no edge controls; missing and disabled actions emit no action callback; hostile titles and summaries render as text and execute nothing;
- visibility changes emit one `timeline_visible` patch per transition, parent rerenders emit none, and unmount removes the listener.

Extend `apps/app/e2e/playwright/view-stories.spec.ts` with a named “Shell breakpoint and keyboard controls” case using the same production components and shipped CSS through the existing story page. In light and dark at literal widths 1,179 and 1,180 px, assert actual timeline and edge visibility, inclusive band entries, and pointer/Tab plus Enter/Space callback receipts for disclosure, Hide, edge jumps and timeline jumps. A mocked `matchMedia` unit test alone does not prove CSS visibility. This is component browser evidence, not app wiring evidence.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA. The four sub-View files are gone, the deleted CSS paths remain absent, and these shell components and their rules have no `mvp-` prefix.

## Risks and notes

- Until T-APP-07 lands, `ToastStackView.tsx` and `Timeline.tsx` are unused twins of live files. T-APP-07 removes the twin; this ticket adds no third copy. Its runtime integrations are consumers, not prerequisites for this props-only reshape, so no dependency edge to T-APP-07 or S2 T-APP-18 is added.
- Security: smithers-b8 reviews inert text rendering and callback-only actions. These Views perform no repository execution, host command, fetch or root step. M-29 execution stays inside machines under the wiring tickets’ execution checks; no root input inventory applies here. The hostile-text, absent-action and disabled-action cases above prove the local boundary.

## Ready checklist

1. Dependencies: T-UI-01 supplies the props/primitives contract; Scope states the dark landing behavior. Event delivery, persistence and notification providers are excluded consumers, not landing preconditions.
2. Exclusions: Scope names persistence, routing, leases, summaries, permission/delivery, new mounts and commands, execution/root, deferred notification channels and the run scrubber.
3. Tests: C-UI-12 mounts production shell components and activates DOM controls at the callback seam; the named browser case proves shipped CSS and keyboard behavior. Expected values are authored literals, independent of spec/code/fixture oracles.
4. Decisions: smithers-06 decides design; smithers-b8 accepts the callback/security seam; smithers-8a accepts props contract changes. No public API change or ADR is in scope.
5. Owner pre-review: smithers-06 and smithers-b8, post hoc under the parallel-build directive. smithers-06: Do renamed shell rules preserve Paper tones, the 1,180 px breakpoint and keyboard focus? smithers-b8: Does inlining preserve callback-only handlers and inert text? Does the dark landing leave app mounts and command execution to T-APP-07/T-APP-18 without another renderer?
6. Security: smithers-b8 reviews inert props and unavailable-action refusal, covered by the named local tests. No repository code or root step executes here; M-29 machine execution remains with wiring tickets.
