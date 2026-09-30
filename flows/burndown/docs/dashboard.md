---
title: Burndown dashboard
description: Read-only observation of one selected host and run.
---

## Select a run

Set `BURNDOWN_RUN_ID` explicitly. `BURNDOWN_HOST` defaults to the current
checkout. `BURNDOWN_REPORT_DIR` defaults to
`<host>/.flows/burndown/<runId>`; select the monitor's actual `reportRoot`
when it differs. No private operational directory is a public default.

```sh
BURNDOWN_RUN_ID=run-42 BURNDOWN_HOST=/path/to/host \
  BURNDOWN_REPORT_DIR=/path/to/reports \
  node --experimental-strip-types flows/burndown/dashboard.ts
```

The selected report directory must contain `scope.json` with
`{"hostDir":"/canonical/path/to/host","runId":"run-42"}`. The operator
supplies this receipt after verifying the directory belongs to that host/run;
the dashboard never creates it or changes the watched stores. Missing, corrupt
or foreign scope prevents report and worker-log reuse.

The dashboard reads `<host>/.flows/engine.db` through read-only SQLite transactions.
Each snapshot uses one short transaction and closes the connection afterward,
including WAL-mode databases, so committed WAL state is visible. Read-only means
no logical engine/control data writes: normal SQLite shared-memory sidecars and
read-lock coordination are allowed. The dashboard never checkpoints or changes
journal mode and never uses immutable reads or unlocked database/WAL copies.
Busy, corrupt, missing or inaccessible databases show unknown with a diagnostic.
It never invokes `runs show`, reconciles history, or selects the newest run.
Rounds require the selected entry's ancestry and lineage. Workers require its
ancestry and may have their own lineages.
A completed entry can hand off to a running round; only a successful current-round
`Complete` confirms completion. Missing or corrupt evidence displays unknown.
Worker commit receipts supply landing links; unrelated repository history does not.

Monitor lines use `timestamp runId HEALTHY|UNHEALTHY text`. Only matching,
non-future evidence no older than two minutes can show health; failed or cancelled
runs cannot show healthy. Unknown selected engine evidence cannot show healthy.
Untagged `status.txt`, `rounds.log`, `NEEDS-YOU.md` and landing scripts are not
execution evidence and do not override the panels.

The page polls every five seconds. Port 4777 is the default; override with
`BURNDOWN_DASHBOARD_PORT`. A collision fails visibly and never opens the existing
server. `BURNDOWN_DASHBOARD_NO_OPEN=1` suppresses browser launch.

## Regression checks

```sh
node --experimental-strip-types --test flows/burndown/test/dashboard.test.ts
```

The tests use isolated two-host SQLite stores, actual HTTP responses and the
returned page renderer. They check selection, report freshness, terminal and
missing evidence, log isolation and port collisions. Open-writer WAL fixtures
check current and subsequent commits, selected lineage isolation, unchanged
database/WAL bytes while the writer pauses, rejected read-only updates and writer
progress after each snapshot. Shared-memory coordination is permitted.
They do not establish deployment or live fleet health.
