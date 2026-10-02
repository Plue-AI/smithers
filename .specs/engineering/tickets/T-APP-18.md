# T-APP-18 Browser notifications on secure origins

Stage S2 · Size S · Depends on T-APP-07, T-UI-08, T-APP-19 · Unblocks — · Issue: to file
Spec: spec.md §14.6, §14.4.1, §16.3.2 · Delta: delta.md §9 · Product: mvp.md §6.4 Browser notifications (v2.5), Appendix B.1 `notifications.allow`

## Goal
A member with Smithers in a background tab is notified by the browser when a TODO of theirs needs them, is ready for review or fails.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: the Allow notifications toast and the notification text. Engineering wires them: the Notification API controller and secure-context detection. The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

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
- `apps/app/src/mainview/state/controller/notifications.ts` (new) → subscribes to the member's toasts, which the shared toast collection already holds (`state/controller/failures.ts`), and raises `new Notification(title, {body, tag: entry id})` when hidden and permitted. One notification per entry (`tag` dedupes).
- `apps/app/src/mainview/flows/entries/notifications.ts` → replace the hidden notifications-center entries with `notifications.allow` (person-only, `agent: never`). Delete the old notifications-center card and flows that §8 hides, in the same change.
- `ToastStack.tsx` → the Allow action on the first Needs you toast when `window.isSecureContext` is true and permission is `default`.

## Tests
- Unit: a hidden tab with permission granted gets one notification per entry. A visible tab gets none, and a plain-HTTP context (`isSecureContext = false`) offers no Allow and raises nothing.
- Playwright (`apps/app/e2e/playwright/notifications.spec.ts`, new): grant permission in the browser context, hide the page, trigger Needs you, and assert one notification whose click opens the TODO card.
- Unit: `notifications.allow` isn't in the agent's tool list.

## Acceptance
- [C-UI-03](../checks/C-UI-03.md)

## Risks and notes
- Risk: Safari requires the permission request inside the click handler itself. Confirm in the Playwright WebKit project. Keep the request synchronous in the toast action.
