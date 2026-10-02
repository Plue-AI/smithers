# C-MCH-07 All-branches secrets present in every session and the coding host; values never readable through the API

Proves: mvp.md J1.8, §6.15 Secrets, M-25 · spec.md §8.8.1, §5.2 (Read secret values: nobody), §6.4 · Layer: e2e · Stage: S2 · Tickets: T-MCH-12, T-APP-13, T-UI-18
Automation: `apps/app/e2e/real/secrets-machines.spec.ts` (new) · Runs in: reference host

## Setup

- A fresh install on the reference host at the commit under test, wrapping a scratch repository `smithers-mvp-canary/<date>` whose `pnpm test` reads `process.env.CANARY_TOKEN` and fails when it is unset.
- Owner, Ben (maintainer) and Alice (member) signed in from a second Mac at one of the install's public origins. Alice has a GitHub SSH key.
- No secrets set yet. Branch A for TODO T1 is awake with Alice's terminal open.

## Steps

1. Ben opens the Secrets card and sets `CANARY_TOKEN` (all branches) to a random 32-byte value V, and `DEPLOY_KEY` (main-only) to W.
2. At least 5 s after step 1, Alice opens a new terminal on branch A, which stayed awake. She runs `printenv CANARY_TOKEN DEPLOY_KEY`.
3. Alice runs `ssh -p 2222 <branch>@<install host> 'printenv CANARY_TOKEN'`.
4. A TODO run on the branch executes the check step `pnpm test`.
5. Every member credential kind (owner session, Alice session, Ben delegated CLI) calls `GET /api/secrets` and every documented secrets route. Record the response bodies.
6. Search all response bodies, the run's projected logs and the activity for V and W.
7. Read the terminal opened before step 1 (on branch A): `printenv CANARY_TOKEN`.

## Pass when

- Step 2 prints V and an empty line for `DEPLOY_KEY`.
- Step 3 prints V.
- Step 4 passes, which shows the coding host's step saw V.
- Step 5 returns names and scopes only, with no field holding V or W, for every credential.
- Step 6 finds V and W 0 times. A value echoed by `printenv` into a terminal stream is excluded: any session can print all-branches values by design (§8.8.1).
- Step 7 prints an empty line: running processes keep their environment, and only new sessions load the rewritten file (§8.8.1).

## Fail when

- The secret reaches the terminal but not the coding host, or the reverse.
- A new session opened 5 s after the write lacks V, which means the daemon didn't rewrite `/run/smithers/env`.
- `DEPLOY_KEY` is set in any branch session.
- Any API response, log line or activity entry contains V or W.
- The card shows "set" before the write commits (honest state, §19.3).

## Evidence

`.artifacts/checks/C-MCH-07/<UTC timestamp>/`: Playwright trace and video, terminal and SSH transcripts with V redacted to its SHA-256, API response bodies, the search result counts, the install version and the commit.
