# C-UI-03 Browser notifications on secure origins

Proves: mvp.md §6.4 Browser notifications (v2.5) · spec.md §14.6 · Layer: e2e · Stage: S2 · Tickets: T-APP-18, T-UI-08
Automation: `apps/app/e2e/playwright/notifications.spec.ts` (new) · Runs in: CI (Chromium and WebKit) and the reference host

## Setup
Ben, signed in on `http://localhost:4000` (secure) and on a plain-HTTP LAN origin (insecure), owns TODO T3 while it works.

## Steps
1. On localhost, T3 raises its first Needs you. Ben presses **Allow notifications** on the toast.
2. Ben hides the tab. T3 raises a second question, then reaches In review, then a retry of another TODO he owns fails.
3. Ben clicks the In review notification.
4. Repeat steps 1–2 on the plain-HTTP origin.

## Pass when
- Step 1 shows the Allow action once, and the permission prompt appears from that click.
- Step 2 raises exactly three notifications (Needs you, In review, Failed), one per entry.
- Step 3 focuses the tab and opens T3's card.
- On the plain-HTTP origin, the toasts appear, no Allow action shows, and no notification is raised or attempted (no console error).
- No notification fires while the tab is visible.

## Fail when
- A notification repeats for the same entry.
- The permission is requested without a click.
- The insecure origin throws.

## Evidence
`.artifacts/checks/C-UI-03/<ts>/`: the Playwright trace, the notification log from both origins and the commit.
