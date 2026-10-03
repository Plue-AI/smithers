# T-APP-18 Browser notifications on secure origins

Stage S2 · Size S · Depends on T-APP-07, T-UI-08 · Unblocks T-REL-02 · Issue: [#3558](https://github.com/smithersai/smithers/issues/3558)
Spec: spec.md §14.6, §14.4.1, §16.3.2 · Delta: delta.md §9 · Product: mvp.md §6.4 Browser notifications (v2.5), Appendix B.1 `notifications.allow`

## Goal
A member with Smithers in a background tab is notified by the browser when a TODO of theirs needs them, is ready for review or fails.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the Allow notifications toast variant, with the CSS, in T-UI-08. This ticket builds no View, CSS or editor presentation. It owns the Notification API controller, secure-context detection and the Allow action on the first Needs you toast.

## Scope
In:
- `notifications.allow`: a person-only in-card gesture on the first Needs you toast, calling `Notification.requestPermission()`.
- A notification for each toast of kind Needs you, In review or Failed that targets this member (§14.4.1) while `document.hidden`.
- Click focuses the tab and opens the card.
- Detecting secure contexts: on a plain-HTTP origin, no Allow toast and no notifications.

Out:
- Email and phone ([D], #3423).
- Service workers and Web Push.

## Changes
- `apps/app/src/mainview/state/controller/notifications.ts` (new): subscribes to the member's toasts, which the shared toast collection already holds (`state/controller/failures.ts`), and raises `new Notification(title, {body, tag: entry id})` when hidden and permitted. One notification per entry (`tag` dedupes). Titles and bodies come from `actorName` and the toast's title.
- `apps/app/src/mainview/flows/entries/notifications.ts`: add `notifications.allow` (person-only, `agent: never`). T-CUT-01 deletes the notifications-center entries and card in the same file.
- `apps/app/src/mainview/ToastStack.tsx` (T-APP-07's toast card file): adds the Allow action to the first Needs you toast when `window.isSecureContext` is true and permission is `default`. T-UI-08 renders the variant.

## Tests
- Unit (`notifications.test.ts`): a hidden tab with permission granted gets one notification per entry. A visible tab gets none, and a plain-HTTP context (`isSecureContext = false`) offers no Allow and raises nothing.
- Unit (`ToastStack.test.tsx`): the Allow action appears on the first Needs you toast only on a secure context with permission `default`.
- Unit: `notifications.allow` isn't in the agent's tool list.
- Playwright (`apps/app/e2e/playwright/notifications.spec.ts`, new; Chromium and WebKit; Ben owns TODO T3 on `http://localhost:4000` and on a plain-HTTP LAN origin):
  - On localhost, T3's first Needs you shows the Allow action once, and the permission prompt appears from that click and never without one.
  - With the tab hidden, a second question on T3, T3 reaching In review and a failed retry of another TODO Ben owns raise exactly three notifications (Needs you, In review, Failed), one per entry; none repeats.
  - Clicking the In review notification focuses the tab and opens T3's card.
  - No notification fires while the tab is visible.
  - On the plain-HTTP origin the toasts appear, no Allow action shows, no notification is raised or attempted, and the console has no error.

## Acceptance
- [C-UI-03](../checks/C-UI-03.md): passes for this ticket’s phase at its stated layer.
- [C-UI-13](../checks/C-UI-13.md): passes for this ticket’s phase at its stated layer.
- The notifications spec passes in Chromium and WebKit on both origins.

## Risks and notes
- Risk: Safari requires the permission request inside the click handler itself. Confirm in the Playwright WebKit project. Keep the request synchronous in the toast action.
