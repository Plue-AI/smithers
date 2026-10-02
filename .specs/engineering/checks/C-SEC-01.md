# C-SEC-01 Provider keys, the App PEM and main-only secrets never appear in any branch machine

Proves: mvp.md M-18, M-29, M-30, §6.15 Secrets, §9 Isolation · spec.md §8.8.2, §8.8.3, §17.2, §17.4, §15.2 · Layer: integration · Stage: S2 · Tickets: T-MCH-12, T-FLW-01
Automation: `packages/backend/internal/services/machine_secret_scan_integration_test.go` (new) · Runs in: reference host (real microVM, real PostgreSQL)

## Setup

- The reference host at the commit under test. Four sentinels, each a unique random 40-character string:
  - P: a provider model key, set through the install's model access;
  - K: a line inside the GitHub App PEM, sealed in `$STATE/config/secrets.json`;
  - M: a main-only secret;
  - A: an all-branches secret (positive control).
- Machines awake at scan time: an item branch running a TODO step (coding agent active), a scratch branch with a member terminal and an SSH session, and an ephemeral background machine running a maintainer's manual flow run on `main`.

## Steps

1. On each machine, as root through the guest helper: `grep -rIl -e P -e K -e M -e A /` over every mounted filesystem except `/proc` and `/sys`; then the same over `/proc/*/environ` and `/proc/*/cmdline`.
2. Capture each branch machine (`capture()`) and search the captured tree and jj operation log in the host repository store.
3. Read the egress relay audit for the item branch's run and search request headers for P, K and M.
4. In the TODO step, make one model call. Record the credential it presented to the host model proxy.

## Pass when

- Item and scratch branch machines: P, K and M are found 0 times in steps 1–3. A is found in `/run/smithers/env` and in session environments.
- The `main` background machine: M and A are found. P and K are found 0 times.
- Step 4: the call carries the run's `run` credential, and P appears nowhere in the machine.

## Fail when

- P appears in any machine environment (a provider key passed to the coding agent instead of the proxy).
- K appears anywhere in a guest, in any form.
- M reaches an item or scratch branch, an agent run, or a capture.
- A is missing on a branch machine, which means the scan isn't seeing secrets at all.

## Evidence

`.artifacts/checks/C-SEC-01/<UTC timestamp>/`: per machine, the scan command, its exit code and its hit list with paths (values shown as SHA-256 only), the relay audit query result, the model proxy request log entry (credential kind only), the commit and the `msb` version.
