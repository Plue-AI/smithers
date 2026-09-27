---
title: "Troubleshooting"
description: "Every failure code this tool reports, the exit status it maps onto, what causes it, and what to change. Plus the scan warnings that appear in the report rather than on stderr."
---

Every failure this package reports is one type, `MigrateError`, carrying a code
the CLI maps onto an exit status. Find the code in the message and read the
matching section.

```text
smthrs migrate: <message>
<details>
```

| Code                  | Exit | One line                                                               |
| --------------------- | ---- | ---------------------------------------------------------------------- |
| `run-state-blocked`   | 3    | The project still holds 0.x run state.                                 |
| `unsafe-blocked`      | 3    | A construct has no safe translation.                                   |
| `apply-in-progress`   | 3    | Another apply run holds this project's lock.                           |
| `no-vcs`              | 1    | The project is under no version control.                               |
| `invalid-layout`      | 1    | The root, report directory, or flows directory is not usable.          |
| `unsupported-project` | 1    | The plan does not describe this project.                               |
| `stale-plan`          | 1    | The project changed after it was planned.                              |
| `checkpoint-failed`   | 1    | A unit could not be checkpointed or restored.                          |
| `io`                  | 1    | A file, a directory, or the runtime itself could not be read or built. |
| `verify-failed`       | 1    | Reserved. No code path raises it.                                      |
| `agent-failed`        | 1    | Reserved. No code path raises it.                                      |

Exit 3 is parked, not failed. The project is intact and a person has a
decision to make.

## run-state-blocked

**What happened.** `apply` found 0.x run state and you have not acknowledged
it. Both the `blocked` and the `history-only` verdict refuse, because a 1.0
runtime can neither read nor resume a 0.x database whatever its runs are doing.

**What to change.** Act on the instructions the report prints, in the order it
prints them, then rerun. To migrate the source and leave the state where it is,
pass `--acknowledge-run-state`. See
[Clear 0.x run state before you apply](./guides/clear-run-state.md).

## unsafe-blocked

**What happened.** The scan found constructs with no safe translation, and you
have not named them. The message lists each one and spells the exact flag that
accepts them.

**What to change.** Pass `--allow-unsafe <name,...>` with the names you have
read and accepted, or `--allow-unsafe all`. Either way the rewrite leaves a
`TODO(migrate-smithers-v1)` marker and an `unsupported` report entry rather
than an imitation. See
[Accept constructs with no safe translation](./guides/allow-unsafe-constructs.md).

## apply-in-progress

**What happened.** Another `apply` holds this project's lock. The canonical
project root has one lock even when callers use different `--report-dir`
values or reach the project through a symlink. Each apply holds a SQLite
transaction on `.smithers-migrate/apply.lock.sqlite` for its whole run. The
adjacent `apply.lock` JSON file records its pid, start time, and report
directory for diagnostics. A missing or incomplete JSON record still refuses
a contender while the transaction is held.

**What to change.** Wait for the other run to finish. Process exit releases
the operating-system lock, including a crash before the JSON record was
written. A later apply can acquire it and records any abandoned owner's
report directory in its takeover note. If the earlier run stopped mid-unit,
recover from that directory's `pending-unit.json` before applying again.

An unresolved `pending-unit.json` refuses a retry with `checkpoint-failed`
before replacing the owner record or any backup. This also applies when a
retry chooses a different report directory. The original owner record stays
in place until its checkpoint has been recovered and its pending marker
removed.

The SQLite guard file remains after release so every process locks the same
file. Leave it in place; deleting or replacing it while an apply is running
would split ownership across two files. Normal release removes only the JSON
owner record, provided that run has no unresolved checkpoint.

## no-vcs

**What happened.** The project is under neither jj nor git, so a migration
would have no way back. This refuses the whole run before anything is written,
unlike every other unit failure.

**What to change.** Initialize jj or git and commit once. To accept a file copy
under the report directory as the only checkpoint, pass `--allow-no-vcs`.

A git project with no commit at all raises `checkpoint-failed` instead, with
the same two options: commit once, or rerun with `--allow-no-vcs`.

## invalid-layout

**What happened.** The root, the report directory, or the flows directory is
not a path the tool may write to. It is checked before a byte is read. The
message names which one and why:

- The root is not absolute, not normalized, or not a directory.
- A layout path is empty, absolute, ends with a slash, has an empty segment,
  contains `.` or `..`, contains a backslash or a NUL byte, or is `.flows`,
  `.git`, `.jj`, or `node_modules`, or lives under one of them.
- The report directory and the flows directory overlap. A report written under
  the flows directory is discovered as a flow, and a flows directory under the
  report directory is archived with the backups.
- The flows directory is `.smithers-migrate` or inside it. This fixed directory
  holds the project lock even with a custom report directory. The lock directory
  itself must not be a symlink.
- A symlink on either path leads out of the project root.
- The report directory already holds files that are not the tool's. It may be
  empty, new, or hold only `report.json`, `report.md`, `units/`, `backup/`,
  `archive/`, `pending-unit.json`, and the tool's `apply.lock`,
  `apply.lock.sqlite`, and `apply.lock.sqlite-journal` files. The scan skips the report directory
  wholesale, so a project directory named as the report directory would vanish
  from the plan and then receive the archive.

**What to change.** Pick another `--report-dir` or `--flows-dir`, or resolve
the root to an absolute normalized path before you pass it.

## unsupported-project

**What happened.** One of four things:

- The scan could not read part of the project, and `apply` will not migrate an
  incomplete plan. The message counts the skipped paths.
- Two units would share one id, so one would overwrite the other. The message
  names the id and the files that produced it.
- `--unit` named an id no unit is planned for. The message lists the ids that
  are planned.
- The unit ids the flow was handed no longer match the units the project plans.

**What to change.** For a skipped path, make it readable or move it: a
directory the walk cannot list, one deeper than twelve levels, and a file over
8 MB all raise `incomplete-scan`. For the others, plan again and apply that
plan.

## stale-plan

**What happened.** Before the first unit runs, the flow reads the project again
and compares it against the plan it was given: every unit outline, the
run-state roots, the layout, and a digest of every source and target. Something
the plan covers changed. Nothing was written.

**What to change.** Plan again, then apply:

```bash
smithers-migrate
smithers-migrate --apply --seat anthropic:<model>
```

## checkpoint-failed

**What happened.** A unit could not be checkpointed, or a restore refused. The
causes are all deliberate refusals rather than crashes:

- jj could not read the working-copy change, or `jj new` failed.
- git has no commit to check point against, or `git update-ref` failed.
- A backup, or a restored file, no longer digests to what the manifest
  recorded. The restore fails rather than overwriting your tree.
- A path the manifest never named was asked for. It is refused rather than
  guessed at.
- A permission error, a disk error, or a directory where a file was declared.
  Only the platform's typed `NotFound` counts as absent.

**What to change.** Read the detail. A dirty version-control state is usually
the cause; commit or clean, then rerun the unit with `--unit <id>`.

## verify-failed and agent-failed

**What happened.** Nothing. Both codes are declared in `MigrateErrorCode` and
neither is raised anywhere in the package. A verification that fails and a
rewrite that fails are unit outcomes, not run failures: the round is handed
back for repair, and a unit that still fails is restored from its checkpoint
and recorded as `failed` in the report, with the next unit still running. The
run then exits 1 through the report's own exit code rather than through an
error.

**What to change.** Read the unit's entry in the report, and
[Recover from a failed unit](./guides/recover-a-failed-unit.md).

## The rewrite has no seat

**What happened.** The migration declares one seat, `migrate`, and the resolver
could not turn it into a model. The unit fails with the refusal in its report
entry, and the message says which half is missing. With no seat and no key it
names the three variables:

```text
Set ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY or pass --seat <provider:model> to run the migration
```

With a key but no `--seat`, it names the provider it found a key for and asks
you to name the model instead.

**What to change.** Pass `--seat provider:model` and put that provider's key in
the environment. No model id is hard coded anywhere in this package, so a key
alone does not say which model to spend it on.

## io

**What happened.** A file or directory could not be read or written, or the
composition itself could not be built. `Command.runNode` reports the second
case as "the migration could not build its runtime", because the layer derives
its grant rules from a read-only scan that can itself fail.

**What to change.** Read the cause in the details. It is a real filesystem or
composition error, not a migration decision.

## Warnings that do not stop the run

These appear in the report's project detection rather than on stderr. Most are
worth reading before you apply.

| Warning                 | What it means                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `incomplete-scan`       | A path could not be read. `plan` reports it; `apply` refuses the plan.                                                     |
| `effect-pin-conflict`   | An `effect` declaration, or a lockfile resolution, is not the version this release was built against.                      |
| `uncatalogued-import`   | A name imported from the 0.x facade that no catalog row covers. It is reported rather than dropped.                        |
| `unknown-authoring-api` | A workflow file built on a foreign or unrecognized API. It contributes no constructs, because guessing corrupts a project. |
| `mixed-authoring-api`   | One file imports both Smithers 0.x and a foreign API. The 0.x half is inventoried and the other half is named.             |
| `already-migrated`      | A file already on Smithers 1.0. It gets no unit, so running the tool twice is safe.                                        |
| `unresolved-ui-entry`   | A `<UI entry>` target that does not resolve to a file.                                                                     |
| `unparsable-manifest`   | A `package.json` that could not be parsed.                                                                                 |
| `unparsable-tsconfig`   | A `tsconfig*.json` that could not be parsed.                                                                               |

## The report says a unit failed

Read [Recover from a failed unit](./guides/recover-a-failed-unit.md). The
unit's files are already restored; the report says why it failed and how to
rerun it.

## Nothing failed, but a migrated flow does not appear

Run `smthrs ls`. A flow that discovery will not list is a flow nobody can run.
The report's Verification section names the discovery warning: usually a
default export that is not a `Flow.make` call, or a declaration
with no `description` string literal. `Checks.discovery` runs the registry's
own scan and fails on any warning, so a unit recorded as `migrated` passed it
at the time; a later hand edit is the usual cause.
