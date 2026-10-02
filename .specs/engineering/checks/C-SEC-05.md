# C-SEC-05 The stage-1 terminal token is limited to its scope

Proves: mvp.md M-18, J6.1 · spec.md §8.11.1, §5.3.2 · Layer: integration · Stage: S1 · Tickets: T-TRM-02
Automation: `packages/backend/internal/compose/terminal_token_scope_test.go` (new) · Runs in: CI

## Setup
Ben opens a terminal on T2's branch, and the stage-1 token is minted.

## Steps
1. Using the token, call `todo.answer` and `todo.steer` on T2, `todo.new`, and a wiki read.
2. Using the token, call `todo.drop`, `stack.move`, `/merge`, `todo.steer` on T5 (another branch), a secret write and a member change.
3. Close the terminal and reuse the token.

## Pass when
- Step 1 calls succeed and are attributed "Ben's terminal".
- Every step 2 call is refused with `403 {class: permission}`.
- Step 3 is refused, because the token expired with the session.

## Fail when
- Any out-of-scope call succeeds.
- The token outlives the session.

## Evidence
`.artifacts/checks/C-SEC-05/<ts>/`: the request/response log and the commit.
