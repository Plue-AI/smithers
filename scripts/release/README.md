# Credential soak recording

On each machine, Ben signs into Claude Code, Codex and GitHub independently
through his personal Terminal card. On the recording Mac, use the released
`smthrs` CLI signed into the install as Ben. No login is copied or seeded.

Run once for machine A and once for machine B, using each machine's allocated
non-root personal UID and a new evidence directory:

```sh
export SMITHERS_SOAK_BEN_INDEPENDENT_LOGIN=1
scripts/release/credential-soak.sh smithers-mvp-canary/2026-10-05 MACHINE UID .artifacts/checks/C-REL-05/RUN-A
```

The parent directory must already exist. The recorder uses the production
`workspace shell` personal terminal and runs the reviewed guest script there.
It retains only numeric reports; raw terminal and tool output is discarded.
Each tool runs every ten minutes, including observations at the start and at
24 hours. Guest `timeout` must exist. A wrong UID, missing tool, late observation
or missing version refuses the capture. The script never uses sudo or root,
installs tools, copies credentials, or executes the canary's code on the host.
The recorder requires all three versions and all 435 calls, in order, including
the 24-hour endpoint. A missing, repeated or late call, a mismatched guest UID,
or a record after completion fails capture even when the terminal exits zero.
`capture.json` retains the call count and first failure without raw tool output.

Record B's sleep and wake every four hours through the install, with UTC times
and owner-signed evidence. Also retain the candidate commit/version, host
profile, Ben's account and independently created login attestations, and
C-MCH-10 evidence. These remain manual prerequisites. This recorder neither
creates check receipts nor qualifies a run: `scripts/check-run.mjs` and its
approved reference-host mapping own qualification. Terminal completion alone
is not proof that any call succeeded. Inspect every redacted call and both
machines' complete duration, including the first observation after every wake.

## Host maintenance recording (T-INS-07)

The C-REL-03/C-REL-06 recorders require the tap-installed CLI on an Apple Silicon
Mac, an unprivileged installing owner, and the bundled PostgreSQL 18 programs.
They refuse on Linux. They do not install a candidate bundle or authorize guest
root execution. Keep the configuration and artifacts private (they include
install profiles and command transcripts). Diagnostic JSON is not an authenticated
C-PRC-03 completion receipt.

An owner configuration names `commit`, an absolute `evidence` directory outside
STATE, `psql` (the absolute bundled executable), `database` (the owner's libpq
connection string), and `tables`: a complete roster of `{ "name": "table_name",
"exclude": [] }`. List only the N+1 migration's rewritten columns in `exclude`;
retain that list for review. The recorder hashes ordered JSON rows without
retaining raw rows, and independently hashes files, modes and symlink targets.
PostgreSQL queries run read-only. Files exclude backups, logs, live PostgreSQL,
the host socket, version.env and the incomplete-upgrade marker. These exclusions
are explicit limitations; the transient install_settings.quiesce row is excluded from the database digest.
All other database/journal exclusions require owner review.

Run C-REL-03 stages on the reference Mac:

```sh
node scripts/journeys/upgrade.mjs capture /absolute/owner-config.json
node scripts/journeys/upgrade.mjs refuse-merge /absolute/owner-config.json
node scripts/journeys/upgrade.mjs refuse-burst /absolute/owner-config.json
node scripts/journeys/upgrade.mjs upgrade /absolute/owner-config.json
node scripts/journeys/upgrade.mjs failed-upgrade /absolute/owner-config.json
```

Before each stage, arrange the workload/release that C-REL-03 names. Use a new
recording directory for each run; existing receipts are never overwritten. The
failed-upgrade stage runs the printed restore argv without evaluating shell
source and checks that it matches the durable marker. The owner still records
sign-ins, wake/resume controls, secrets, versions and the screen recording.

For C-REL-06, run `backup` on A under the specified concurrent load. It captures
independent database/tree digests while the actual ready freeze holds, verifies
the produced manifest against observed files, and stops A. Copy the archive and
A's receipts to B's evidence directory using the owner's normal transport.
Run `restore` on B with B's configuration and the absolute transferred directory:

```sh
node scripts/release/backup-restore.mjs backup /absolute/host-a-config.json
node scripts/release/backup-restore.mjs restore /absolute/host-b-config.json '/absolute/backup-dir'
```

The B stage checks physical host UUID, user name and STATE path differ before
restoring; it compares independent row and file digests afterward. Stage runners
do not replace C-REL-06's mutation probes, machine-disk home/credential controls,
GitHub exactly-once reconciliation, five-minute observation, corrupt-backup,
free-space and retention checks. Those remain acceptance requirements.

The fault suite drives six actual installed backup processes on A. Add `api`,
`authHeaders` (owner cookie/CSRF or delegated authorization), and a literal `todo`
request body to the configuration. Set `SMITHERS_HOST_BACKUP_FAULT_CONFIG` to its
absolute path and run:

```sh
cd packages/smithers
pnpm exec vitest run test/host-backup.fault.test.ts --coverage.enabled=false
```

It observes durable freezes and branch release states, owned PostgreSQL dump
processes and partial-tree/manifest creation. It kills only its own detached
command process group, waits 31 seconds, checks no new manifest was published,
and creates a TODO through the served API. A missed checkpoint fails; it never
inserts a test-only gate or substitutes a fake provider. Polling observes states,
not instruction-exact boundaries: retain the observations and qualify them on
the reference Mac before accepting the six fault receipts. The host flow drain
and dependency barriers must be composed before these stages can succeed.
Linux skips all six faults explicitly. Recorder logic has a separate portable
check: `node --test scripts/release/host-maintenance-evidence.test.mjs`.

C-REL-06's remaining command checks have explicit stages. Run
`refuse-incomplete` and `refuse-hash` with a complete backup as the third argv;
they clone it into the private evidence directory and damage only that copy,
assert the literal installed-command refusal and compare independent live
digests afterward. Run `refuse-space` after the owner prepares the disposable
low-space volume; it checks the actual 40 GiB floor and database size before
calling backup. It never fills a volume itself. After restoring normal free
space, `retention` takes four backups and verifies that exactly the newest three
remain. These stages require the composed maintenance providers and have not
been qualified on Linux.
