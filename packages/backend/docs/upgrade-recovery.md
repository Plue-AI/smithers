---
title: "Recover a failed self-host upgrade"
description: "Restore the verified pre-upgrade backup without overwriting the failed installation."
---

## Keep the failed installation stopped

If `upgrade.sh` fails, do not start the old or new app against that database.
Earlier migrations may have committed. An incomplete-upgrade marker blocks startup,
backup, and another upgrade; only a clean restore clears this condition. Do not
remove the marker to bypass recovery.
Keep the failed database and data volume for diagnosis. Do not edit `version.env`,
copy live PostgreSQL or SQLite files, or retry with an older bundle.

Use the verified backup created before the upgrade. Record its `MANIFEST` and
select the exact old bundle digest from that release's receipt. A missing or
unverified backup is not a recovery path.

## Restore into a clean destination

The Mac recovery command and its release qualification belong to T-INS-07.
The retained shell guards are port sources only; there is no supported production
invocation until that port lands. Keep the failed database and backup for diagnosis.

## Reproduce the recovery regression

The shell-boundary integration test uses two disposable PostgreSQL instances.
It backs up the old database, commits a schema/data change before a simulated
migration failure, then restores the backup into the other instance. It checks
old database state, archived file content and permissions, credentials, and the
version manifest. The simulated failing migrator is a command double; PostgreSQL,
`pg_dump`, and `pg_restore` are real. This test does not qualify a packaged bundle,
a parked run, or a hosted deployment.

```bash
SMITHERS_POSTGRES_TEST_BIN=/opt/homebrew/opt/postgresql@18/bin \
SMITHERS_POSTGRES_TEST_MAJOR=18 \
go test -p 1 ./distribution -run 'FailedUpgradeReportsRecovery|FailedUpgradeRecovery|IncompleteUpgrade' -count=1 -v
```
