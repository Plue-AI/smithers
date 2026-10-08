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

The restore command still refuses: its start on the restored bundle, and the
microVM isolation check it runs first, are not composed yet.

The install enforces persisted freezes even when maintenance execution is
disabled. Reads stay available. Reopen and lease recovery preserve the freeze
when complete resume providers are unavailable.

Backup, upgrade and restore coordinators are implemented against provider
contracts. Upgrade retains the bundle backup and recovery marker through
Homebrew and the new binary’s migration, readiness and isolated health-wake.
Restore retains its guard through startup and stages a verified saved bundle
inside install state. The native dispatcher now calls these coordinators. Backup uses the owner
bridge; upgrade and restore refuse missing lifecycle and isolation providers.
The SQL summary records every TODO; capture and finished-step readers still
need production providers. Contract tests do not qualify a release upgrade or
restore.

Keep the original install stopped when restoring a backup on another Mac.
Restoring returns to the backup time; subsequent changes are lost. Successful
restore execution and the C-REL-03/06 release evidence remain outstanding.
