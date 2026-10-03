# T-INS-07 `smthrs host upgrade`, `backup`, `restore` with quiesce and a backup manifest (M-26)

Stage R · Size L · Depends on T-INS-05, T-INS-08, T-MCH-06, T-MCH-07 · Unblocks T-MNT-05 · Issue: [#3444](https://github.com/smithersai/smithers/issues/3444)
Spec: spec.md §6.3 (quiesce), §8.2.1, §8.3, §8.4.3, §16.4, §16.5.1–§16.5.3, §17.4, §19.1, §19.2 · Delta: delta.md §1 (Add `smthrs host upgrade`; write `version.env` at first boot) · Product: mvp.md M-26, §12.6, §6.1 Restart

## Goal
One owner command upgrades an install in place after a verified backup, and a failed upgrade prints the exact command that restores the previous version and its data. Every backup is one quiescent snapshot of every authority, and it restores on the same Mac or on another one.

## Scope
In:
- Quiesce (§16.5.1): `POST /api/install/quiesce` writes the durable freeze with a 30 s lease that the caller renews every 10 s, drains for at most 60 s, ends sessions, captures and stops every awake machine (T-MCH-07's final capture), and stops the host flow runtime. `DELETE /api/install/quiesce` reopens. A failed step or a lapsed lease reopens, except while `.upgrade-incomplete` exists.
- `smthrs host backup` (§16.5.2): refuses during a merge or an open burst, checks free space, quiesces, and writes `backups/.partial-<ts>/` with a custom-format `pg_dump`, an APFS clone of every tree under `$STATE` except `backups/`, `logs/` and the PostgreSQL data directory, and, for an upgrade, the bundle. It writes `MANIFEST.json` last (version, schema version, PostgreSQL major, quiesce op and time, every file's path, size and SHA-256, and the stack, branch-head, machine-disk and run-journal summary), syncs it, renames the directory to `<version>-<UTC ts>/` with mode 0700, reopens, and keeps the three newest backups. No path in a backup is absolute.
- `smthrs host upgrade`, §16.4 steps 1 to 7: refuse while a merge is in flight or a burst is open, naming each; quiesce; back up with the current bundle (the Cellar version); write `.upgrade-incomplete`, `brew upgrade smithers` and restart on the new bundle, keeping the freeze while the marker exists; migrate forward (the database refuses an older binary, `packages/backend/db/product/migrate.go:25`); health check (every process ready, migrations at head, one machine wakes as the freeze's only grant); delete the marker and reopen; on failure keep the marker and print `smthrs host restore <dir>`.
- `smthrs host restore <dir>` (§16.5.3), on this Mac or another: refuses a running install, a manifest whose file hashes don't verify, and an installed version older than the manifest's; moves any live trees and PostgreSQL data directory aside to `backups/pre-restore-<ts>/`; clones the backup's trees into `$STATE`; loads the dump into a data directory made by the bundled `initdb` of the manifest's major; starts the install on the backup's bundle when it holds one (`smthrs host start --bundle`, T-INS-08), otherwise on the installed bundle; prints the backup's time. Machines start asleep and are recreated from their disks at wake, so nothing outside `$STATE` is needed.
- `$STATE/version.env` written at first boot and checked at every start, porting `distribution/lib.sh:72-99` (version, schema and PostgreSQL major match; `.upgrade-incomplete` marker refuses a start).
- Free-space check before the freeze: free disk minus the 40 GiB floor (§8.2.1) must cover the database size plus, for an upgrade, the bundle.

Out:
- PostgreSQL major upgrades (refused as today, `packages/backend/postgres/postgres.go:183-200`); downgrades; automatic upgrades.
- The Docker scripts `distribution/{backup,restore,upgrade}.sh` (deleted with the Docker image by T-INS-05).

## Changes
- The `host` group in `packages/smithers/src/internal/backend/Commands.ts` (T-INS-08) → `upgrade`, `backup`, `restore`.
- `packages/backend/internal/services/install_quiesce.go` (new): the §16.5.1 freeze, lease, drain, machine capture and stop (T-MCH-07's final capture) and reopen, behind one gate that every mutating route, the admission scheduler (T-MCH-06), the host flow runtime, GitHub sync streams and periodic jobs consult. `POST` and `DELETE /api/install/quiesce` (owner), with rows in `docs/api/openapi/install.yaml`.
- `packages/backend/native/native.go:23-41` → write or verify `$STATE/version.env` before `app.Migrate`; refuse on `.upgrade-incomplete`.
- `apps/backend/main.go:43` `migrate` subcommand → `migrate status` used by the health check.
- Reuse the guards in `distribution/upgrade.sh`, `backup.sh`, `restore.sh` and `lib.sh:72-99` (manifest check, PostgreSQL-major refusal, schema-downgrade refusal, `.upgrade-incomplete` marker, `version.env`): port each check to Go, one for one, and carry the cases of `distribution/upgrade_recovery_test.go` over as the port's regression tests (minimal-code synthesis, 2026-10-03, v2 "Reuse named in tickets"). Do not re-derive the guards, and do not call the shell scripts (they need `flock`, which macOS lacks, and a Docker data root). Then delete `distribution/lib.sh`, `distribution/version.env` and their Go tests in this change.
- `packages/backend/docs/upgrade-recovery.md` → a Mac install section; CLI reference; docs gates (`pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/smithers:docs`).

## Tests
- unit: quiesce refusal reasons; the freeze gate refuses each mutating route class and lets reads through; a lapsed lease reopens unless `.upgrade-incomplete` exists; `MANIFEST.json` verification failures (wrong version, missing dump, a file whose SHA-256 differs, schema newer than binary, an installed version older than the manifest's); retention keeps three; no manifest path is absolute.
- integration (real PostgreSQL 18 from the bundle): backup, mutate, restore → row digests equal the backup's; restore into a running install refused; an upgrade whose migration fails leaves `.upgrade-incomplete`, exits non-zero, and the printed command restores a working install on the old binary.
- fault: kill `smthrs host upgrade` after `brew upgrade` and before migration → the next `smthrs host start` refuses and prints the restore command.
- e2e and fault: C-REL-06, which restores host A's backup on a fresh second Mac B and kills the backup at every step on A.
- journey: C-REL-03.

## Acceptance
- [C-REL-03](../checks/C-REL-03.md): a launch-day install upgrades to the next release with data intact, refuses during a merge or burst, keeps work in flight, and a failed upgrade restores from the printed command.
- [C-REL-06](../checks/C-REL-06.md): a backup taken under concurrent work on host A restores in a fresh macOS user account on Mac B and matches its manifest; crashes during quiesce or backup reopen admissions and leave no manifest; an incomplete backup is refused. This ticket is done only when C-REL-06's two-Mac evidence is attached to its issue.

## Risks and notes
- An APFS clone of live PostgreSQL files is inconsistent. Observation that confirms it: a restore from the cloned data directory fails crash recovery. The design restores the database only from the dump.
- Hashing every file, machine disks included, makes a backup slow. Observation: the backup step takes longer than 10 min on the reference host with 20 branch disks. Then hash each disk's data extents and hole map (`SEEK_DATA`) instead of reading its holes.
- Restoring on another Mac while the original still runs makes two installs act on one repository. `restore` can't see the other Mac, so its output and the quickstart say to stop the original first (§16.5.3). Observation: duplicate GitHub writes when C-REL-06 skips stopping A.
- `brew cleanup` deletes old kegs, so the previous binary may be gone when a restore is needed. Observation: `brew list --versions smithers` shows one version after an upgrade. The bundle clone in the backup covers it.
- `brew upgrade` replaces `smthrs` while the command runs. Observation: the health step fails with a missing module. Run steps 5 to 7 by exec'ing the new `smthrs`.
- On a non-APFS volume `cp -c` copies instead of cloning. Observation: free space drops by `$STATE`'s size. Refuse with a typed error.
