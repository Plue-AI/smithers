# C-UI-10 `/debug-api` calls only documented operations with the viewer's own permissions

Proves: mvp.md M-36, §6.13 API · spec.md §5.2, §5.2.1, §6.2 · Layer: integration · Stage: S2 · Tickets: T-APP-21
Automation: `apps/app/e2e/playwright/debug-api.spec.ts` (new) with a real backend and PostgreSQL · Runs in: CI

## Setup
An install with members Ben (Member) and Mia (Maintainer).

## Steps
1. As Ben, open `/debug-api`, pick `GET /api/todos`, Send.
2. As Ben, pick a maintainer-only POST, press Send, then confirm the method and path.
2a. Sign Ben out in another tab, then Send a GET.
3. As Mia, repeat step 2.
4. Run `/debug-api` through the app agent and through `smthrs` with a delegated credential.
5. List the operations the playground shows and compare with `docs/api/openapi/`.

## Pass when
- Step 1 returns 200 with the same body as `curl` with Ben's session.
- Step 2: nothing is sent before the confirmation; then it returns 403 `permission`, identical to `curl`.
- Step 2a renders a typed 401 failure, not a crash.
- Step 3 succeeds.
- Step 4 is refused with `never`.
- Step 5: the operation set equals `docs/api/openapi.yaml` exactly.

## Fail when
- The playground sends a request on load or on one press of a mutation, or grants anything `curl` with the same credential wouldn't.

## Evidence
`.artifacts/checks/C-UI-10/<ts>/`: the trace, the request/response log (no credentials) and the commit.
