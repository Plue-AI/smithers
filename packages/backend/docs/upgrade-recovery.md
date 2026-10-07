---
title: "Upgrade recovery guards"
description: "Lifecycle port sources for the Mac install."
---

T-INS-07 owns Mac upgrade recovery. Scripts and regression tests in `distribution/` remain port sources only. Preserve failed state and verified backups. Never clear an incomplete-upgrade marker to bypass a guard.

The Mac CLI recognizes `smthrs host backup`, `smthrs host upgrade` and
`smthrs host restore <directory>`. These commands execute the verified installed
backend as the installing user. They currently refuse with
`host_maintenance_unavailable`: coordinated machine capture, admission/runtime
drain, persistence flush, external-write recovery and CLI owner authorization
are not composed. No backup or upgrade is performed by this refusal.

Restore refuses a running launchd install. Its offline backend validates
`MANIFEST.json`, relative paths and every file hash before refusing unavailable
recovery providers. Versioned release binaries also enforce release, schema and
PostgreSQL-major compatibility. A development binary cannot restore an install.
These validations do not move live data or start PostgreSQL.

Keep the original install stopped when restoring a backup on another Mac.
Restoring returns to the backup time; subsequent changes are lost. Successful
restore execution and the C-REL-03/06 release evidence remain outstanding.
