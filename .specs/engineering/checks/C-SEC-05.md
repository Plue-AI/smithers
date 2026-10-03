# C-SEC-05 The stage-1 terminal token is limited to its scope

Proves: mvp.md M-18, J6.1 · spec.md §8.11.1, §5.3.2 · Layer: integration · Stage: S1 · Tickets: T-TRM-02
Automation: `packages/backend/internal/compose/terminal_token_scope_test.go` (new) · Runs in: CI

## Setup
- Ben opens a terminal on T2's branch through the production authenticated terminal route; the stage-1 token is minted by that lifecycle. The packaged guest smthrs CLI and generated skill call the production router/catalog/Authorize path. No direct mint helper or authorizer bypass supplies the token. Expected statuses and allowed/denied outcomes are literal fixtures, never generated from spec files or the runtime catalog. Mint person session credentials with stored via terminal and cli, member Ben and no agent session, plus delegated terminal/cli/claude-code/codex credentials with terminal_s1, member Ben and branch T2. Inspect stored kind and via. Include question/conflict/approval waits, append/non-append payloads, and forged headers. Use real PostgreSQL and the composed install router. Run with and without the S1 Confirm-card consumer; use separate S2 full-scope delegated credentials.

## Steps
- Adopted T-TRM-02 boundary cases: Open simultaneous A/B terminals for the same member uid through production terminal routes. Rotate B, close A and assert B’s file/credential survives while A is refused and cannot acquire B’s identity after 401. Exercise Session.ts resolution and Client.ts cached-credential eviction with missing, unreadable and foreign-session files; mutation counters stay unchanged after 401. Agent child processes inspect environment/files/descriptors and obtain no person bearer; human UI broker append succeeds directly while guest CLI append remains delegated confirmation/refusal. Repeat close/removal/sleep cleanup and record per-session ownership

1. As Ben typing with each person credential, POST append todo.new to `/api/repos/{owner}/{repo}/mythical/todos`. Verify one TODO at stack end and no confirmation.
2. At that same route, each delegated agent requests append. With the card consumer installed, inspect Ben’s private Confirm card and verify no TODO exists. Alice and agents attempt private-card reads and approval; Ben confirms from his app session. Repeat the press to prove no duplicate TODO.
3. Remove the S1 card consumer in an isolated fixture and repeat delegated append. Assert HTTP 403, class permission, code confirm_in_app, message "Confirm in the app", and no TODO, confirmation row, run, machine admission or outbound effect.
4. Repeat steps 1–3 with forged Smithers-Via, actor-kind, agent-session and profile headers or payload assertions. Verify stored kind/via and decisions remain unchanged.
5. Exercise allowed own question/conflict answer, steer and eligible non-private/wiki reads. Refuse drop, move, Merge, explicit confirmation create, non-append creation, other-branch answer/steer, approval-kind answer (including forged question kind), secrets, members and install status.
6. Close the terminal and reuse both credentials. Repeat after Ben suspension/removal. With isolated S2 delegated credentials, verify ordinary todo.new confirmation and eligible Merge confirmation.

7. Repeat token reuse after member removal and machine sleep; the token is refused within 5 s. Record redacted request/response evidence and no token values.

## Pass when
- Bind each person/delegated credential and file to an immutable terminal session id. In S2, /run/smithers/<uid>/token becomes a mode-0700 per-member directory containing sessions/<session id>/token, each mode 0600; SMITHERS_TOKEN_FILE names only that session’s file. No shared current-token alias exists. Atomic replacement and close deletion require matching session id and credential identity; closing A cannot replace/delete B. Keep person bearer bytes only in a host terminal command broker. Human commands enter through the authenticated person-session terminal UI command channel; the broker dispatches with the stored person credential and sends only results. Never give guest processes a person token, environment bearer, readable file or inherited descriptor. Guest CLI/skill commands always use their session’s delegated credential. Session.ts and Client.ts invalidate only that exact cached credential on 401, re-resolve only the same session file for the next explicit request, and refuse missing/unreadable/mismatched files without fallback. Never automatically replay mutations or switch identity

- Person append creates exactly one TODO and zero confirmations. Delegated append returns 202 with one private Confirm card for Ben, creates no TODO before his app-session approval and creates exactly one afterward. Other people and agents cannot read private payloads or approve.
- Missing S1 card path returns exact 403 permission/confirm_in_app, "Confirm in the app", with zero side effects. Forged headers never change stored actor authority, profile or scope.
- Allowed reads, own question/conflict answer and steer succeed. Every out-of-scope request returns 403 permission/permission without effects.
- Closed or suspended/removed/absent-member credentials return 401 permission/unauthenticated immediately; physical revocation completes within 5 s. S2 delegated creation and eligible Merge follow ordinary confirmation policy.

## Fail when
- Delegated append creates a TODO before Ben confirms, the missing-card request returns another envelope or produces an effect, or forged headers change authority.
- Any out-of-scope call succeeds or a closed credential remains valid.

## Evidence
`.artifacts/checks/C-SEC-05/<ts>/`: the request/response log and the commit.
