# C-MCH-09 Homes are per machine, created at first session, never shared

Proves: mvp.md §6.8 Terminals (2026-10-02), M-18 · spec.md §5.5.4, §8.7.1, §8.7.2 · Layer: integration · Stage: S2 · Tickets: T-MCH-11
Automation: `packages/backend/internal/compose/real_users_test.go` (extend; step 6 ports the T-MCH-02 spike workload) · Runs in: reference host (real microVMs)

## Setup
Members Ben and Alice. Branches A and B, both awake.

## Steps
1. On A, Ben and Alice each open a terminal. `stat` both homes. As Alice and as `agent`, read a file in Ben's home.
2. On A, Ben creates a fresh `~/.marker` using a regular file create mode 0666 under session umask 002, writes known bytes, and records its uid and mode 0664. On B, Ben opens a terminal and looks for it.
3. `mount` on A and B.
4. Sleep A, wake it, and `stat` Ben's `~/.marker`.
5. A maintainer adds Carol while A is awake. Carol opens a terminal on A.
6. Load: on A and B at once, as Ben, run the T-MCH-02 spike workload (`concurrent-worker.cjs` from spike change `lzksvnqm`, ported into the test): 1,000 iterations each in `~/.claude`, `~/.config/gh` and `~/.npm/_cacache` of independent files, shared append logs, atomic renames and SQLite in DELETE and WAL modes (2,000 interleaved writes per directory across the two machines).
7. Restart the host service (`smthrs host stop && smthrs host start`), wake A and B, and repeat the `stat` and `~/.marker` reads.

## Pass when
- Each home is `/home/<login>`, owned by its member's uid and gid, mode 0700; Alice and `agent` get `EACCES`.
- `~/.marker` is absent on B.
- No virtiofs mount is under `/home` on either machine.
- After wake, `/home/ben` remains owned by Ben with mode 0700; `~/.marker` retains Ben’s uid, mode 0664 and its exact recorded bytes. The directory and file modes are separate assertions.
- Carol's terminal opens in `/home/carol` with her uid and 0700, without restarting A.
- Step 6: on each machine, zero missing or corrupt append records, every atomic read parses (no ENOENT), zero SQLite errors or rollbacks, zero lost acknowledged WAL rows, and `PRAGMA integrity_check` is `ok`. The spike's shared-home run lost all of these (C-SPK-02).
- Step 7: every home, owner, mode and `~/.marker` is unchanged after the host restart.

## Fail when
- Any file written in a home on one machine appears on another (C-MCH-10 also proves tool tokens stay local).
- A newly added member needs a restart to get a home.

## Evidence
`.artifacts/checks/C-MCH-09/<ts>/`: `stat`, `mount` and `id` output per machine, the test log and the commit.

## Authored reference-host coverage (2026-10-08)

The helpers run inside `TestInstalledMemberTerminalAndSSHChain`, using its approved-bundle preflight, composed install router, GitHub fake, authenticated terminal WebSocket and real broker. They live in `internal/compose` to reuse the production composition rather than add a second microVM harness. They are not passing reference-host receipts.

The composed native chain now runs two member-terminal workers concurrently:
1,000 independent creates, append records and atomic replacements in each of
`.claude`, `.config/gh` and `.npm/_cacache` per machine, plus 1,000 committed
rows in each directory's DELETE and WAL database. It checks every literal row,
JSON read, append record and reopened database, including integrity checks.
`TestInstalledHomeWorkloadFixture` validates the workload on Linux; that is
supplemental fixture evidence, not this check's real-machine receipt.


Step 7 is authored in `TestInstalledPhysicalHomeRestart`; see the
[physical host campaign](../campaigns/mch-host-restart.md). It stops and starts
the installed launchd service and checks per-machine bytes/ownership/modes
through replacement authenticated terminals. Execution on the reference Mac
remains pending; Linux cannot supply that receipt.
