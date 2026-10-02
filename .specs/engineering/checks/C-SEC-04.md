# C-SEC-04 Only the setup token claims the install

Proves: mvp.md J1.1 · spec.md §5.1.0 · Layer: integration · Stage: S1 · Tickets: T-ACC-01
Automation: `packages/backend/internal/services/setup_claim_integration_test.go` (new) · Runs in: CI

## Setup
A fresh install bound to loopback and `0.0.0.0`, with no owner. The printed token is T. A fake GitHub OAuth provides two users.

## Steps
1. A LAN request completes GitHub sign-in without a token.
2. A loopback request completes sign-in with a wrong token.
3. A LAN request completes sign-in with T as user A.
4. A second request with T completes sign-in as user B.

## Pass when
- Steps 1 and 2 are refused, with no owner created.
- Step 3 creates owner A, and the stored token digest is deleted.
- Step 4 is refused, because the install already has an owner.
- The token appears in no log line or response body.

## Fail when
- Any listener accepts a claim without T.
- T works twice.

## Evidence
`.artifacts/checks/C-SEC-04/<ts>/`: test output, a log scan for T and the commit.
