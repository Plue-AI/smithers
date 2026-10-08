---
title: "Upgrade recovery guards"
description: "Owner maintenance and recovery guards for a Mac install."
---

T-INS-07 owns Mac upgrade recovery. The backend holds every guard; the shell scripts that used to carry them are deleted. Preserve failed state and verified backups. Never clear an incomplete-upgrade marker to bypass a guard.

The Mac CLI recognizes `smthrs host backup`, `smthrs host upgrade` and
`smthrs host restore <directory>`. These commands execute the verified installed
backend as the installing user. Backup and upgrade currently refuse with
`host_maintenance_unavailable`: admission and runtime drain, persistence flush
and external-write recovery are not composed. Machine capture is composed:
quiesce sends every awake machine down the sleep path (verified capture, then
a confirmed stop that keeps its disk) and names the branch of one that fails.
The CLI authenticates preflight through the installing user’s private socket.
Backup preflight also requires authoritative captured-head, disk and finished-step
readers, a binary matching `version.env`, and an APFS state volume. Missing
providers or a non-APFS volume refuse before freezing. Database size and
custom-format dump exports use the supervised PostgreSQL through the private
socket; a dump requires the owner's ready lease throughout its stream.

Restore refuses a running launchd install. Its offline backend validates
`MANIFEST.json`, relative paths and every file hash before refusing unavailable
recovery providers. Versioned release binaries also enforce release, schema and
PostgreSQL-major compatibility. A development binary cannot restore an install.
These validations do not move live data or start PostgreSQL.

## Mac install

A backup is one directory under `backups/` in the install state:

| Entry | Holds |
| --- | --- |
| `postgres.dump` | A custom-format `pg_dump` taken through the supervised database. |
| `state/` | A clone of every state tree except `backups/`, `logs/` and `postgres/`. |
| `bundle/` | The running bundle. Upgrade backups only. |
| `MANIFEST.json` | Version, schema, PostgreSQL major, quiesce time and every entry. Written last. |

`MANIFEST.json` records a file as `{path, size, sha256}` and a symbolic link as
`{path, link}`. A link must resolve inside its own tree: `state/` links inside
`state/`, `bundle/` links inside `bundle/`. Backup, verification and restore
refuse an absolute target, a climb above the tree and a loop with
`unsafe_path`, before anything is published or moved. A bundle's tool links
(`libexec/git-core/<tool>` to `../../bin/git`) are captured and restored.

Restore proves the install is stopped three ways before it moves a tree: the
owner socket does not answer, no backend holds the PostgreSQL ownership lock,
and no postmaster the owner record identifies is alive. It then creates a
database in a staging directory with the bundled `initdb`, loads the dump with
the bundled `pg_restore` and stops it. The live data directory is never opened.
Live trees and the live database move to `backups/pre-restore-<time>/`; restore
deletes nothing. The database password reaches `pg_dump` and `pg_restore`
through their environment, never a command line.

`smthrs host restore <directory>` runs from the installed bundle and executes
only that bundle's own programs, each checked against the bundle manifest
first, as the installing user with `HOME` and `PATH` alone:

1. It verifies the backup, then refuses a running install.
2. It runs the bundle's `microvm doctor`. A Mac that cannot isolate machines
   never receives restored machine disks.
3. It stages the trees and loads the database, then writes
   `.upgrade-incomplete` and moves the live trees aside.
4. It starts the install with the bundle's `smthrs host start --bundle`, on the
   backup's bundle when it holds one, and waits until it answers ready.
5. It removes `.upgrade-incomplete` and prints the backup's time.

While `.upgrade-incomplete` exists every start refuses and prints the restore
command, except the one start in step 4. Restore grants that start in
`backups/.recovery-start`, which names the backup and the restore command's
own process (PID and start time). The backend accepts the grant only while
that process is alive and the marker records the same backup, so a restore or
upgrade that was killed leaves no start the marker does not refuse. Restore
removes the grant when step 4 returns. Writes stay refused until step 5.

The start time is the one the kernel recorded when the process was created:
`kinfo_proc.kp_proc.p_starttime`, read with `sysctl kern.proc.pid.<pid>`, to
the microsecond. The system can give a PID to a later process, but that
process has its own start time, so it does not satisfy the grant. A zombie
(killed, not yet reaped) still holds its PID and start time and is refused.

A development binary, and a backend that is not its bundle's
`bin/smithers-backend`, cannot restore.

## Upgrade

`smthrs host upgrade` is composed from the installed bundle and refuses today,
before it asks the install anything, with `host_maintenance_unavailable:
upgrade health wake requires machine admission (T-MCH-06)`. The health check
wakes one machine as the freeze's only grant, and machine admission has not
composed that grant. When it does, the command runs in this order:

1. It refuses unless the install runs the bundle Homebrew links at
   `/opt/homebrew/opt/smithers/libexec` and `/opt/homebrew/bin/brew` exists.
2. It quiesces and backs up, with the running bundle in `bundle/`.
3. It writes `.upgrade-incomplete`, then runs `brew upgrade smithers` with
   `HOME` and `PATH` alone.
4. It becomes the upgraded bundle's backend (`execve`), after checking that
   backend against the upgraded bundle's manifest. It refuses if Homebrew's
   link did not move.
5. The upgraded backend starts the install on its bundle under the restore
   grant, which applies the forward migrations, and requires `version.env` to
   show the new release.
6. It wakes one machine, removes `.upgrade-incomplete` and reopens.

A failure after step 3 keeps `.upgrade-incomplete`, removes the grant and
prints `smthrs host restore <directory>`. That restore starts the previous
release from the backup's `bundle/`, so it works after `brew cleanup` removed
the previous keg.

The install enforces persisted freezes even when maintenance execution is
disabled. Reads stay available. Reopen and lease recovery preserve the freeze
when complete resume providers are unavailable.

Backup, upgrade and restore coordinators are implemented against provider
contracts. Upgrade retains the bundle backup and recovery marker through
Homebrew and the new binary’s migration, readiness and isolated health-wake.
Restore retains its guard through startup and stages a verified saved bundle
inside install state. The native dispatcher now calls these coordinators. Backup uses the owner
bridge; restore is composed from the installed bundle; upgrade refuses its
missing lifecycle and health-wake providers before it freezes.
The SQL summary records every TODO; capture and finished-step readers still
need production providers. Contract tests do not qualify a release upgrade or
restore.

## Compatibility

Rulings by smithers-8a, 2026-10-07:

- Before launch, a backup taken by a release without the
  `backups/.recovery-start` grant cannot start its own bundle under the
  marker. This is accepted: no released backup exists.
- From the first public release on, restore reads every earlier released
  backup format, and a refusal shows as a named state.

The published `MANIFEST.json` format is pinned as literal bytes by
`TestManifestPublishedContractUsesIndependentLiteralDigests` and
`TestManifestPublishedContractRecordsALinkAsPathAndTarget`. A format change
after the first public release adds a reader for the old bytes; it never
edits those two tests.

Named states a backup, upgrade or restore refuses with today:

| State | Meaning |
| --- | --- |
| `wrong_version`, `older_version`, `newer_schema` | The backup does not fit this release, schema or PostgreSQL major. |
| `partial`, `missing_file`, `missing_dump`, `extra_file`, `hash_mismatch` | The backup is incomplete or its bytes changed. |
| `unsafe_path` | A path or link leaves its tree, or an entry is not a file or a link. |
| `insufficient_space`, `clone_unavailable` | The state volume lacks space or is not APFS. |
| `install_running` | Restore needs a stopped install. |
| `host_owner_required` | The command must run as the installing user, not root. |
| `host_maintenance_unavailable` | A provider, bundle member or isolation is missing. |
| `host_start_failed` | The install did not start on the restored or upgraded bundle. |
| `invalid_backup`, `invalid_command` | The command line is wrong. |

Not yet named, and shown by the CLI as `host_maintenance_failed`: a dump
`pg_restore` rejects, a staged database that cannot be created, and the
`upgrade incomplete: ...; restore with smthrs host restore <directory>`
failure of a started upgrade. They need names before the first public release.

Keep the original install stopped when restoring a backup on another Mac.
Restoring returns to the backup time; subsequent changes are lost. A restore
on the reference Mac with launchd and real microVMs, and the C-REL-03/06
release evidence, remain outstanding.
