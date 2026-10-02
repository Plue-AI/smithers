# C-MCH-09 Homes are per machine, created at first session, never shared

Proves: mvp.md §6.8 Terminals (2026-10-02), M-18 · spec.md §5.5.4, §8.7.1, §8.7.2 · Layer: integration · Stage: S2 · Tickets: T-MCH-11
Automation: `packages/backend/microsandbox/real_users_test.go` (extend; step 6 ports the T-MCH-02 spike workload) · Runs in: reference host (real microVMs)

## Setup
Members Ben and Alice. Branches A and B, both awake.

## Steps
1. On A, Ben and Alice each open a terminal. `stat` both homes. As Alice and as `agent`, read a file in Ben's home.
2. On A, Ben writes `~/.marker`. On B, Ben opens a terminal and looks for it.
3. `mount` on A and B.
4. Sleep A, wake it, and `stat` Ben's `~/.marker`.
5. A maintainer adds Carol while A is awake. Carol opens a terminal on A.
6. Load: on A and B at once, as Ben, run the T-MCH-02 spike workload (`concurrent-worker.cjs` from spike change `lzksvnqm`, ported into the test): 1,000 iterations each in `~/.claude`, `~/.config/gh` and `~/.npm/_cacache` of independent files, shared append logs, atomic renames and SQLite in DELETE and WAL modes (2,000 interleaved writes per directory across the two machines).
7. Restart the host service (`smthrs host stop && smthrs host start`), wake A and B, and repeat the `stat` and `~/.marker` reads.

## Pass when
- Each home is `/home/<login>`, owned by its member's uid and gid, mode 0700; Alice and `agent` get `EACCES`.
- `~/.marker` is absent on B.
- No virtiofs mount is under `/home` on either machine.
- After the wake, `~/.marker` is present with Ben's uid and 0700.
- Carol's terminal opens in `/home/carol` with her uid and 0700, without restarting A.
- Step 6: on each machine, zero missing or corrupt append records, every atomic read parses (no ENOENT), zero SQLite errors or rollbacks, zero lost acknowledged WAL rows, and `PRAGMA integrity_check` is `ok`. The spike's shared-home run lost all of these (C-SPK-02).
- Step 7: every home, owner, mode and `~/.marker` is unchanged after the host restart.

## Fail when
- Any file written in a home on one machine appears on another (other than the five credential files, C-MCH-10).
- A newly added member needs a restart to get a home.

## Evidence
`.artifacts/checks/C-MCH-09/<ts>/`: `stat`, `mount` and `id` output per machine, the test log and the commit.
