# C-MCH-09 Homes are per machine, created at first session, never shared

Proves: mvp.md §6.8 Terminals (2026-10-02), M-18 · spec.md §5.5.4, §8.7.1, §8.7.2 · Layer: integration · Stage: S2 · Tickets: T-MCH-11
Automation: `packages/backend/microsandbox/real_users_test.go` (extend) · Runs in: reference host (real microVMs)

## Setup
Members Ben and Alice. Branches A and B, both awake.

## Steps
1. On A, Ben and Alice each open a terminal. `stat` both homes. As Alice and as `agent`, read a file in Ben's home.
2. On A, Ben writes `~/.marker`. On B, Ben opens a terminal and looks for it.
3. `mount` on A and B.
4. Sleep A, wake it, and `stat` Ben's `~/.marker`.
5. A maintainer adds Carol while A is awake. Carol opens a terminal on A.

## Pass when
- Each home is `/home/<login>`, owned by its member's uid and gid, mode 0700; Alice and `agent` get `EACCES`.
- `~/.marker` is absent on B.
- No virtiofs mount is under `/home` on either machine.
- After the wake, `~/.marker` is present with Ben's uid and 0700.
- Carol's terminal opens in `/home/carol` with her uid and 0700, without restarting A.

## Fail when
- Any file written in a home on one machine appears on another (other than the five credential files, C-MCH-10).
- A newly added member needs a restart to get a home.

## Evidence
`.artifacts/checks/C-MCH-09/<ts>/`: `stat`, `mount` and `id` output per machine, the test log and the commit.
