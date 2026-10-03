# C-SEC-05 The stage-1 terminal token is limited to its scope

Proves: mvp.md M-18, J6.1 · spec.md §8.11.1, §5.3.2 · Layer: integration · Stage: S1 · Tickets: T-TRM-02
Automation: `packages/backend/internal/compose/terminal_token_scope_test.go` (new) · Runs in: CI

## Setup
- Ben opens a terminal on T2. Mint person session credentials with stored via terminal and cli, member Ben and no agent session, plus delegated terminal/cli/claude-code/codex credentials with terminal_s1, member Ben and branch T2. Inspect stored kind and via. Include question/conflict/approval waits, append/non-append payloads, and forged headers. Use real PostgreSQL and the composed install router. Run with and without the S1 Confirm-card consumer; use separate S2 full-scope delegated credentials.

## Steps
1. As Ben typing with each person credential, POST append todo.new to `/api/repos/{owner}/{repo}/mythical/todos`. Verify one TODO at stack end and no confirmation.
2. At that same route, each delegated agent requests append. With the card consumer installed, inspect Ben’s private Confirm card and verify no TODO exists. Alice and agents attempt private-card reads and approval; Ben confirms from his app session. Repeat the press to prove no duplicate TODO.
3. Remove the S1 card consumer in an isolated fixture and repeat delegated append. Assert HTTP 403, class permission, code confirm_in_app, message "Confirm in the app", and no TODO, confirmation row, run, machine admission or outbound effect.
4. Repeat steps 1–3 with forged Smithers-Via, actor-kind, agent-session and profile headers or payload assertions. Verify stored kind/via and decisions remain unchanged.
5. Exercise allowed own question/conflict answer, steer and eligible non-private/wiki reads. Refuse drop, move, Merge, explicit confirmation create, non-append creation, other-branch answer/steer, approval-kind answer (including forged question kind), secrets, members and install status.
6. Close the terminal and reuse both credentials. Repeat after Ben suspension/removal. With isolated S2 delegated credentials, verify ordinary todo.new confirmation and eligible Merge confirmation.

## Pass when
- Person append creates exactly one TODO and zero confirmations. Delegated append returns 202 with one private Confirm card for Ben, creates no TODO before his app-session approval and creates exactly one afterward. Other people and agents cannot read private payloads or approve.
- Missing S1 card path returns exact 403 permission/confirm_in_app, "Confirm in the app", with zero side effects. Forged headers never change stored actor authority, profile or scope.
- Allowed reads, own question/conflict answer and steer succeed. Every out-of-scope request returns 403 permission/permission without effects.
- Closed or suspended/removed/absent-member credentials return 401 permission/unauthenticated immediately; physical revocation completes within 5 s. S2 delegated creation and eligible Merge follow ordinary confirmation policy.

## Fail when
- Delegated append creates a TODO before Ben confirms, the missing-card request returns another envelope or produces an effect, or forged headers change authority.
- Any out-of-scope call succeeds or a closed credential remains valid.

## Evidence
`.artifacts/checks/C-SEC-05/<ts>/`: the request/response log and the commit.
