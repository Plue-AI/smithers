# C-MCH-10 Log in once per install; credentials sync, history stays local

Proves: mvp.md §6.8 Terminals (2026-10-02), J6.1 · spec.md §5.6, §8.7.2, §8.7.3, §9.1.2 · Layer: integration · Stage: S2 · Tickets: T-MCH-15
Automation: `packages/backend/microsandbox/real_credentials_test.go` (new) · Runs in: reference host (real microVMs, a fixture credential set in place of live provider logins)

## Setup
Ben on branches A and B, both awake. Fixture files for the five tracked paths. Ben's `~/.claude.json` on B already holds 40 unrelated keys and a `projects` history.

## Steps
1. On A, write the five fixture files as Ben (a login).
2. Open Ben's terminal on B and read the five paths and `~/.claude.json`.
3. On B, rewrite `~/.claude/.credentials.json` (a token refresh). Read it on A.
4. Within the same second, rewrite `~/.codex/auth.json` on A and on B with different content.
5. On A, write `~/.claude/history.jsonl` and `~/.npm/_cacache/x`. Look for them on B.
6. Wake branch C for the first time and open Ben's terminal there.
7. Query every API route and CLI command that lists members, secrets or settings for credential content.
8. Suspend Ben.

## Pass when
- Step 2: B has all five files, byte-equal except `~/.claude.json`, where only the account fields changed and the 40 keys and `projects` are untouched. Mode 0600, Ben's uid.
- Step 3: A has the refreshed file within 5 s.
- Step 4: both machines end with the copy that has the newest `written_at`, and the store matches it.
- Step 5: neither file appears on B or in the store.
- Step 6: C has the five files before the terminal's first prompt.
- Step 7: no response contains any credential byte; the PostgreSQL rows hold only ciphertext.
- Step 8: the store rows are gone and the five files are gone from A and B within 5 s.

## Fail when
- `~/.claude.json` is replaced whole or loses a non-account key.
- A machine keeps a superseded token after step 4.
- Any history, cache or database file crosses machines.

## Evidence
`.artifacts/checks/C-MCH-10/<ts>/`: per-step file hashes per machine, the store rows (ciphertext only), timings, the test log and the commit.
