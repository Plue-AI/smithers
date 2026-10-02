# T-INS-07 `smthrs host upgrade`, `backup`, `restore` (M-26)

Stage R · Size M · Depends on T-INS-05 · Unblocks — · Issue: [#3444](https://github.com/smithersai/smithers/issues/3444)
Spec: spec.md §6.3 (quiesce), §8.4.3, §16.4, §16.5, §19.1 · Delta: delta.md §1 (Add `smthrs host upgrade`; write `version.env` at first boot) · Product: mvp.md M-26, §12.6, §6.1 Restart

## Goal
One owner command upgrades an install in place after a verified backup, and a failed upgrade prints the exact command that restores the previous version and its data.

## Scope
In:
- `smthrs host backup` (§16.5): `pg_dump` with the bundled tools, plus an APFS clone (`cp -c`) of `$STATE` into `$STATE/backups/<version>-<UTC ts>/`. The clone excludes `$STATE/backups/` and the live PostgreSQL data directory (the dump is the database copy). A `MANIFEST` records version, schema version, PostgreSQL major, dump sha256 and file counts.
- `smthrs host upgrade`, §16.4 steps 1 to 7: refuse while a burst is open or a merge is in flight, naming each; capture and sleep every awake machine; back up; save the current bundle (the Cellar version) into the backup directory, then `brew upgrade smithers`; start and migrate forward (the database refuses an older binary, `packages/backend/db/product/migrate.go:25`); health check (every process ready, migrations at head, one machine wakes); on failure print `smthrs host restore <dir>`.
- `smthrs host restore <dir>`: refuses a running install; verifies the `MANIFEST`; restores the dump into an empty data directory and the files from the clone; reinstalls the saved bundle when the backup came from an upgrade (§16.5).
- `$STATE/version.env` written at first boot and checked at every start, porting `distribution/lib.sh:72-99` (version, schema and PostgreSQL major match; `.upgrade-incomplete` marker refuses a start).
- Free-space check before a backup derives from the detected volume and `$STATE` size, not a fixed number.

Out:
- PostgreSQL major upgrades (refused as today, `packages/backend/postgres/postgres.go:183-200`); downgrades; automatic upgrades.
- The Docker scripts `distribution/{backup,restore,upgrade}.sh` (deleted with the Docker image by T-INS-05).

## Changes
- `packages/smithers/src/commands/Server.ts` (T-INS-05) → `upgrade`, `backup`, `restore` in the `server` group.
- Host quiesce: `POST /api/install/quiesce` (owner, §6.3, §16.5) returns the refusals (open burst, merge in flight) or the list of captured, sleeping machines. It uses the §8.4.3 final capture (T-MCH-07, stage 2); before that exists it only stops machines. Row in `docs/api/openapi/install.yaml`.
- `packages/backend/native/native.go:23-41` → write or verify `$STATE/version.env` before `app.Migrate`; refuse on `.upgrade-incomplete`.
- `apps/backend/main.go:43` `migrate` subcommand → `migrate status` used by the health check.
- Port the `distribution/lib.sh` checks to Go or TypeScript; do not call the shell scripts (they need `flock`, which macOS lacks, and a Docker data root). Then delete `distribution/lib.sh`, `distribution/version.env` and their Go tests in this change.
- `packages/backend/docs/upgrade-recovery.md` → a Mac install section; CLI reference; docs gates (`pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/smithers:docs`).

## Tests
- unit: quiesce refusal reasons; `MANIFEST` verification failures (wrong version, missing dump, sha mismatch, schema newer than binary).
- integration (real PostgreSQL 18 from the bundle): backup, mutate, restore → row digests equal the backup's; restore into a running install refused; an upgrade whose migration fails leaves `.upgrade-incomplete`, exits non-zero, and the printed command restores a working install on the old binary.
- fault: kill `smthrs host upgrade` after `brew upgrade` and before migration → the next `smthrs host start` refuses and prints the restore command.
- journey: C-REL-03.

## Acceptance
- [C-REL-03](../checks/C-REL-03.md): a launch-day install upgrades to the next release with data intact, refuses during a merge or burst, and a failed upgrade restores from the printed command.

## Risks and notes
- An APFS clone of live PostgreSQL files is inconsistent. Observation that confirms it: a restore from the cloned data directory fails crash recovery. The design restores the database only from the dump.
- `brew cleanup` deletes old kegs, so the previous binary may be gone when a restore is needed. Observation: `brew list --versions smithers` shows one version after an upgrade. The bundle clone in the backup covers it.
- `brew upgrade` replaces `smthrs` while the command runs. Observation: the health step fails with a missing module. Run steps 5 to 7 by exec'ing the new `smthrs`.
- On a non-APFS volume `cp -c` copies instead of cloning. Observation: free space drops by `$STATE`'s size. Refuse with a typed error.
