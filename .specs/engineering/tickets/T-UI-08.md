# T-UI-08 Toasts, edge map and timeline

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-APP-07, T-APP-18 · Issue: [#3545](https://github.com/smithersai/smithers/issues/3545)
Spec: spec.md §14.2.1, §14.4, §14.5.4, §14.6 · Delta: delta.md §9 · Product: mvp.md §6.4 · Props: [ui-components.md § T-UI-08](../ui-components.md)

Landed (406436c02).

## Goal

The toast stack, edge map and timeline render from props, so T-APP-07 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-07 and T-APP-18.

## Scope

In:
- Landed in `apps/app/src/mainview/`: `ToastStackView.tsx` (three notices plus "+N more", one action each, Hide; the S2 Allow notifications variant), `EdgeMap.tsx` (two rows plus a count per edge, one pill on narrow screens) and `Timeline.tsx` with the band, shown at 1,180 px and wider.
- Remaining:
  - Fold `views/ToastNoticeView.tsx` into `ToastStackView.tsx`, and `views/EdgeGroupView.tsx` with its only child `views/EdgeRowView.tsx` into `EdgeMap.tsx`; each has one caller (minimal-code synthesis v1 §6). `views/TimelineLineView.tsx` folds into `Timeline.tsx` for the same reason.
  - Merge `apps/app/src/mainview/styles/views/shell.css` into `styles/chat.css` and drop the `mvp-` prefix.

Out:
- Event delivery, audience selection, debounce, timeline summaries, browser permission and notification delivery (T-APP-07, T-APP-18).

## Changes

- Inline the four sub-Views in their parents; delete the files.
- Move `styles/views/shell.css` into `styles/chat.css`, renaming `mvp-` classes; delete it and its import in `styles/views.css`.
- Mounting: T-APP-07 mounts these through the existing `ToastStack.tsx` (fed by the shared toast stack in `state/controller/failures.ts`), `ChatRunTimeline.tsx` and `EdgeMap.tsx`, and deletes their old markup, folding `ToastStackView.tsx` into `ToastStack.tsx` and `Timeline.tsx` into `ChatRunTimeline.tsx`. Never both copies (v2: mount and delete the old copy, or revert 406436c0).

## Tests

The shell cases in `apps/app/src/mainview/cards/views/Views.test.tsx` cover:
- more than three notices show exactly three and the literal hidden count; opening "+N more" by pointer and keyboard reveals every hidden entry;
- Hide emits its literal patch and deletes no timeline or edge entry;
- clicking a timeline line emits a literal `jump_to` patch;
- at 1,179 px the timeline is absent and edges are pills; at 1,180 px it is present;
- a supplied Allow action forwards `notifications.allow`; without the action there is no Allow control, and the View never calls `Notification.requestPermission`.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA. The four sub-View files and `styles/views/shell.css` are gone.

## Risks and notes

- Until T-APP-07 lands, `ToastStackView.tsx` and `Timeline.tsx` are unused twins of live files. T-APP-07 removes the twin; this ticket adds no third copy.
