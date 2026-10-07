---
title: "Upgrade recovery guards"
description: "Owner maintenance and recovery guards for a Mac install."
---

T-INS-07 owns Mac upgrade recovery. Scripts and regression tests in `distribution/` remain port sources only. Preserve failed state and verified backups. Never clear an incomplete-upgrade marker to bypass a guard.

The Mac CLI recognizes `smthrs host backup`, `smthrs host upgrade` and
`smthrs host restore <directory>`. These commands execute the verified installed
backend as the installing user. They currently refuse with
`host_maintenance_unavailable`: coordinated machine capture, admission/runtime
drain, persistence flush and external-write recovery are not composed.
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
