---
title: "Clear 0.x run state before you apply"
description: "Why a 0.x run database blocks the migration whatever its runs are doing, how the tool finds it, and what to do about each case it reports."
sidebar:
  order: 2
---

Smithers 1.0 never loads, resumes, or migrates 0.x run state. A project that
still holds any is refused by `apply` with exit 3 and left untouched, because
what to do about a run in flight is a decision only you can make.

## Find out what you have

```bash
smithers-migrate --scan
```

The summary prints a verdict, and the report's "Run state and operator
instructions" section prints the detail:

| Verdict        | What it means                                                    |
| -------------- | ---------------------------------------------------------------- |
| `clean`        | No 0.x database, no live run, no backend setting. Nothing to do. |
| `history-only` | A database exists and every run in it has finished.              |
| `blocked`      | A run is live or parked, or a database could not be opened.      |

`history-only` blocks exactly as `blocked` does. A database whose runs have all
finished is still 0.x run state: a 1.0 runtime cannot read it, so archiving or
discarding it has to be deliberate.

## Where it looks

The scan opens each candidate SQLite file in read-only mode:
`smithers.db`, `.smithers/smithers.db`, every `dbPath:` literal in project
source, and every `SMITHERS_DB` value in a dotenv file. From each it records
the `_smithers_*` tables, the migration count and highest id, the runs grouped
by status, and every row whose status is not `finished`, `failed`, `cancelled`,
or `continued`.

A row whose heartbeat is within ten minutes of now is `live`; anything older is
`parked`. A database that will not open is recorded as unreadable and blocks
exactly as a live run does, because the tool cannot prove the project has no
work in flight.

Postgres and PGlite are recorded from settings alone, never by connecting:
`backend:` in `smithers.config.ts`, `createSmithersPostgres(`,
`SMITHERS_BACKEND`, `SMITHERS_POSTGRES_URL`, and a `PG_VERSION` marker.

## Act on the instructions, in order

The report prints these in the order you have to act on them, and the tool
prints the same texts on stderr when it refuses:

| Case               | What to do                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live runs          | Finish or cancel them with the 0.x CLI you already have (`smithers cancel <run-id>` or `smithers down`), then rerun the scan.                    |
| Parked runs        | Cancel them, or accept the loss: the 1.0 runtime cannot resume them.                                                                             |
| Finished history   | Archive the database: `mkdir -p .smithers-migrate/archive && mv .smithers/smithers.db* .smithers-migrate/archive/`. 1.0 does not import history. |
| Postgres or PGlite | The 1.0 release candidate supports SQLite only. Export what you need with the 0.x CLI, then remove the backend setting.                          |

## What the refusal looks like

```text
smthrs migrate: This project still holds Smithers 0.x run state (blocked).
Finish, archive, or discard it, then rerun with --acknowledge-run-state.
```

The instructions follow on the next lines, one per case, and the same lines are
in the report.

## Then acknowledge what is left

Once you have acted, rerun the scan. If the verdict is `clean`, nothing more is
needed. If you have decided to leave the state where it is and migrate the
source anyway, say so:

```bash
smithers-migrate --apply --seat anthropic:<model> --acknowledge-run-state
```

The flag changes what the gate does, not what the tool touches. The migration
still writes nothing under any recorded run-state path, the grant store still
denies the model every filesystem action on those paths, and a deterministic
check compares the file set both ways after every unit, so a file added under a
run-state directory fails that unit exactly as a changed one does.

## The CLI verb refuses one case no flag releases

[`smthrs migrate`](/cli/migrate) checks every `smithers.db` beside the project
before the tool runs. A database that holds runs which have not finished, or
one that cannot be opened, refuses the verb with exit 1 and lists each run with
its id, status, and workflow name. No flag releases that refusal: finish,
archive, or discard the runs with the 0.x CLI first.

`smithers-migrate` has no such pre-check. It reaches the run-state gate
instead, which exits 3 and is what `--acknowledge-run-state` answers.
