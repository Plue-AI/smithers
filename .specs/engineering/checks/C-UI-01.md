# C-UI-01 Every P0 journey completes keyboard-only

Proves: mvp.md §9 Keyboard, §6.4 Input and theme · spec.md §14.7 · Layer: e2e · Stage: R · Tickets: T-REL-02
Automation: `apps/app/e2e/real/keyboard-journeys.spec.ts` (new), with a guard in `apps/app/e2e/real/support/keyboardOnly.ts` (new); `apps/app/e2e/playwright/browser-keyboard.spec.ts` (existing) stays as the unit-level keyboard test · Runs in: reference host plus a second Mac on the same network

## Setup
- Install at commit X with stages S1 to S3 built; scratch repository `smithers-mvp-canary/<date>`; members owner, Ben (Maintainer), Alice (Member).
- Playwright Chromium and WebKit on the second Mac B, through the install's configured public origin.
- Steps outside the app are driven by the harness, not counted as browser input: `brew install` and `smthrs host start` on the Mac, GitHub-hosted pages (App creation, App installation, OAuth consent), GitHub-side teammate actions (review comment, laptop push, unrelated merge, merge on GitHub) through the GitHub API, and SSH or terminal tools in J3.

## Steps
1. Install the guard: on any page served by the install, a call to `click`, `dblclick`, `hover`, `tap`, `dragTo`, `check`, `setChecked`, `fill`, `selectOption` or `mouse.*` fails the test. Allowed input: `keyboard.press`, `keyboard.type`, `keyboard.down`, `keyboard.up`, `locator.press`, `locator.pressSequentially`.
2. Open the setup URL that `smthrs host start` printed, then run J1 steps 1 to 8 (claim, setup, Settings address fields, first TODO, merge, members, secrets), J2 steps 1 to 6, J3 steps 1 to 6, J4 steps 1 to 3, J5 steps 1 to 5 and J10 steps 1 to 6 on the app's surfaces.
3. After each app action, read `document.activeElement` and its computed `outline` under `:focus-visible`.
4. In every overlay (palette, form card, Confirm card, maximized card), press Escape; then cycle Tab through the page.

## Pass when
- Every listed step completes with the guard active, in both browsers.
- After every action, focus is on an element other than `body` and it shows the focus ring (`--ring-border` outline).
- Escape leaves every overlay and returns focus to the element that opened it; Tab never gets stuck (no keyboard trap).
- Every card action is reachable by Tab or by ⌘K.

## Fail when
- A control appears only on hover, or a card action responds only to a pointer.
- Focus drops to `body` after a toast, a card update or a live delta.
- `fill` or a pointer call slips past the guard on an app page (the guard log lists every input call).

## Evidence
`.artifacts/checks/C-UI-01/<UTC timestamp>/`: Playwright traces and videos per journey and browser, the guard's input log, the list of excluded GitHub-hosted and SSH steps, commit X and install version.
