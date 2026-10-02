# C-UI-09 `/docs` opens bundled pages and anchors from every door

Proves: mvp.md M-35 · spec.md §6.1, §14.2.1 · Layer: e2e · Stage: S2 · Tickets: T-APP-20
Automation: `apps/app/e2e/playwright/docs.spec.ts` (new) · Runs in: CI

## Setup
An install with the bundled docs pages, offline (no network beyond the install origin).

## Steps
1. Type `/docs` in the composer.
2. Run `/docs quickstart#put-https-in-front`.
2a. Ask the app agent "how do I put HTTPS in front?".
3. In Settings on a plain-HTTP origin, press "Notifications need HTTPS ↗".
4. Click every link inside the quickstart and the flows reference.
5. Run `/docs no-such-page`.

## Pass when
- Step 1 opens the first page of `toc.ts`, and the toc rail lists exactly its pages, in order.
- Steps 2 and 3 land on the "Put HTTPS in front" heading.
- Step 2a's answer cites `docs.read quickstart`.
- Step 4: every internal link opens its page and anchor; no request leaves the install origin.
- Step 5 shows the first page with a not-found state and no error toast.

## Fail when
- A page loads from the network, or any link 404s.

## Evidence
`.artifacts/checks/C-UI-09/<ts>/`: the Playwright trace and the commit.
