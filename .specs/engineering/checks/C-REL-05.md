# C-REL-05 24 h soak: live tool logins stay valid across two machines

Proves: mvp.md §6.8 Terminals (log in once per install), J6.1 · spec.md §8.7.3 · Layer: e2e (release gate) · Stage: R · Tickets: T-MCH-15, T-REL-02
Automation: `scripts/release/credential-soak.sh` (new) · Runs in: reference host, with Ben's live Claude Code, Codex and `gh` logins

## Setup
Ben is signed in once, on branch A, to Claude Code, Codex and `gh`. Branches A and B stay awake for 24 h, with B slept and woken every 4 h.

## Steps
1. Every 10 min on each machine, as Ben, run one non-interactive call per tool (`claude -p "ok"`, `codex exec "ok"`, `gh api user`).
2. Log every call's exit status, any login prompt text, and every `credential_changed` event with its machine and `written_at`.

## Pass when
- Every call on both machines succeeds for 24 h with no login prompt.
- Each refresh made on one machine reaches the other before its next scheduled call.
- After each wake, B's first call succeeds.

## Fail when
- Any login prompt appears, or a call fails with an authentication error.

## Evidence
`.artifacts/checks/C-REL-05/<ts>/`: the call log, the `credential_changed` log (no token values), and the commit.
