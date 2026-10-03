# C-REL-05 24 h soak: per-machine tool logins persist

Proves: mvp.md §6.8 Terminals, J6.1 · spec.md §8.7.3 · Layer: e2e (release gate) · Stage: R · Tickets: T-REL-02
Automation: `scripts/release/credential-soak.sh` (new) · Runs in: reference mini, fresh macOS user account, with Ben's live Claude Code, Codex and `gh` logins

## Setup
Ben signs in independently to each tool on machines A and B. Record tool versions. Keep both machines for 24 h; sleep and wake B every 4 h. Store no token bytes in evidence.

## Steps
1. Every 10 min on each machine, as Ben, run one non-interactive call per tool (`claude -p "ok"`, `codex exec "ok"`, `gh api user`).
2. Record each call's exit status, login prompts and each sleep/wake time. C-MCH-10 separately proves tokens are never copied.

## Pass when
- Every call succeeds for 24 h without another login, including B's first call after each wake.
- Each machine uses only its own independently created login.

## Fail when
- A call fails with an authentication error or asks Ben to log in again.
- Smithers copies a token between machines.

## Evidence
`.artifacts/checks/C-REL-05/<ts>/`: redacted call log, sleep/wake log, tool versions, host profile and commit.
