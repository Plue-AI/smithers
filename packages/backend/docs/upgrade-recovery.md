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
copy live PostgreSQL or SQLite files, or retry with an older image.

Use the verified backup created before the upgrade. Record its `MANIFEST` and
select the exact old image digest from that release's receipt. A missing or
unverified backup is not a recovery path.

## Restore into a clean destination

Provision an empty PostgreSQL 18 database and an empty Docker volume. Keep the
failed installation's database and volume untouched. Set these values locally:

```bash
export SMITHERS_OLD_IMAGE=ghcr.io/smithersai/smithers@sha256:OLD_RELEASE_DIGEST
# Provision a network that reaches the recovery database with outbound access isolated.
export SMITHERS_RECOVERY_NETWORK=smithers-recovery
export SMITHERS_RECOVERY_VOLUME=smithers-recovery-data
export SMITHERS_BACKUP_PATH=/backups/smithers-YYYYMMDDTHHMMSSZ
# Copy the configuration; point DATABASE_URL and any SMITHERS_DATABASE_URL at the empty database.
cp smithers.env recovery.env
# Edit recovery.env locally before continuing; retain the other settings.
chmod 600 recovery.env
```

Confirm both database URL settings point to the empty recovery database before
restoring:

```bash
docker run --rm --network "$SMITHERS_RECOVERY_NETWORK" \
  --env-file ./recovery.env \
  -v "$SMITHERS_RECOVERY_VOLUME:/var/lib/smithers" \
  -v "$PWD/backups:/backups:ro" \
  --entrypoint /opt/smithers/restore.sh \
  "$SMITHERS_OLD_IMAGE" "$SMITHERS_BACKUP_PATH"
```

Restore checks backup checksums and version compatibility before importing data.
It refuses a nonempty destination and restores PostgreSQL in one transaction.
Use the old image, not the failed upgrade's image. Server backup excludes
browser-only drafts.

## Validate before switching over

Use a recovery network with outbound integrations isolated during validation.
The restored server starts normally and can resume work or connectors. Start it
on a temporary local port:

```bash
docker run -d --name smithers-recovery \
  --network "$SMITHERS_RECOVERY_NETWORK" --env-file ./recovery.env \
  -p 127.0.0.1:4001:4000 \
  -v "$SMITHERS_RECOVERY_VOLUME:/var/lib/smithers" \
  "$SMITHERS_OLD_IMAGE"
ready=0
for attempt in $(seq 1 60); do
  if curl --fail --silent --max-time 5 http://127.0.0.1:4001/readyz; then
    ready=1; break
  fi
  sleep 2
done
test "$ready" = 1
```

Sign in with the restored owner credentials. Check repository content, chat,
artifacts, workspace files, and pending approvals. Confirm each restored active
run's actual state before allowing further work. Restart this recovery container and repeat
the checks. Switch traffic only after these checks pass; retain the failed
installation until diagnosis is complete. Recovery returns to the backup point;
changes made afterward are not restored.

For the installation guide's original container name and port, stop recovery,
preserve the old stopped container under another name, and start the restored
volume with the original settings and original `SMITHERS_DOCKER_NETWORK`:

```bash
docker stop smithers-recovery
docker rename smithers smithers-failed-upgrade
docker run -d --name smithers --restart unless-stopped -p 4000:4000 \
  --network "$SMITHERS_DOCKER_NETWORK" --env-file ./recovery.env \
  -v "$SMITHERS_RECOVERY_VOLUME:/var/lib/smithers" \
  "$SMITHERS_OLD_IMAGE"
```

Retain any additional mounts, ports, or environment settings from the original
installation. Check readiness and authenticated behavior again after switching.

## Reproduce the recovery regression

The shell-boundary integration test uses two disposable PostgreSQL instances.
It backs up the old database, commits a schema/data change before a simulated
migration failure, then restores the backup into the other instance. It checks
old database state, archived file content and permissions, credentials, and the
version manifest. The simulated failing migrator is a command double; PostgreSQL,
`pg_dump`, and `pg_restore` are real. This test does not qualify a packaged image,
a parked run, or a hosted deployment.

```bash
SMITHERS_POSTGRES_TEST_BIN=/opt/homebrew/opt/postgresql@18/bin \
SMITHERS_POSTGRES_TEST_MAJOR=18 \
go test -p 1 ./distribution -run 'FailedUpgradeReportsRecovery|FailedUpgradeRecovery|IncompleteUpgrade' -count=1 -v
```
