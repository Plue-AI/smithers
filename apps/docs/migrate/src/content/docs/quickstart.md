---
title: "Quickstart"
description: "Migrate one Smithers 0.x project end to end: scan it, read the report, clear the gates, apply the rewrite, and verify the result."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/migrate/docs/quickstart.md"
---

This walkthrough takes one 0.x project from a first read to a migrated tree.
Nothing before the apply step changes a byte, so you can stop after any of
them.

## Before you start

- Node.js 26.4.0 or later.
- A Smithers 0.x project: JSX workflows under `.smithers/workflows/`, an
  `examples/` tree, or a `.smithers` pack.
- A clean working copy in jj or git. Each unit is checkpointed before it edits
  anything, and a project under no version control refuses the run until you
  pass `--allow-no-vcs`.
- For the apply step only: a provider key in the environment and a model to
  spend it on.

## Read the project

Run the scan from the project root. It writes nothing at all:

```bash
smithers-migrate --scan
```

The summary names what the scan found:

```text
smthrs migrate scan: /Users/you/project

Units: 3 planned, 0 migrated, 0 failed, 0 blocked.
Constructs: 14 rows across 6 mapping decisions.
Run state: clean.

0 unresolved items, 0 unsupported constructs.
Exit 0.
```

`Run state: clean` means no 0.x database, no live run, and no Postgres setting
stands in the way. A `blocked` or `history-only` verdict prints the
instructions you have to act on first, in the order you have to act on them.

## Plan the migration

Drop `--scan` to plan. This is the default mode, and it writes only the report:

```bash
smithers-migrate
```

The report lands at `.smithers-migrate/report.json` and
`.smithers-migrate/report.md`. Read the Markdown. Its sections come in a fixed
order and every list inside them is sorted, so two runs of the same project
diff cleanly:

1. Summary.
2. Run state and the instructions it needs.
3. Project detection.
4. Construct inventory.
5. Mapping decisions.
6. Units.
7. Verification.
8. Manual follow-ups.
9. The commands that restore each checkpoint.

Section 5 is where the decisions are. Each construct the project uses is
classed `automatic`, `guided`, or `unsafe`, and an `unsafe` row is one the
apply will refuse until you name it. See
[The mapping table](/concepts/mapping/).

Section 6 lists the units. A small project plans three:

```text
dependencies
workflow:simple-workflow
project
```

That order is fixed, and it is the order the rewrite runs in. See
[Migration units](/concepts/units/).

## Rewrite the project

Pass `--apply` and name the seat the rewrite runs on:

```bash
ANTHROPIC_API_KEY=... smithers-migrate --apply --seat anthropic:<model>
```

Each unit runs the same steps in the same order: checkpoint the files it
declared, capture their source, rewrite them, verify, and settle. Settling is
where the deterministic checks, the archive, the postconditions, and a final
verification of the whole tree run. A failing verification is handed back to
the model with the failing output, three times by default and
`--max-repair-rounds` times if you say otherwise. A unit that still fails is
restored from its checkpoint, recorded as `failed`, and the next unit runs. The
run exits 1 when any unit failed.

Three refusals exit 3 with the project untouched, and each is a decision you
have to make rather than a bug to work around:

- `run-state-blocked`: the project still holds 0.x run state. See
  [Clear 0.x run state before you apply](/guides/clear-run-state/).
- `unsafe-blocked`: the project uses a construct with no safe translation. See
  [Accept constructs with no safe translation](/guides/allow-unsafe-constructs/).
- `apply-in-progress`: another apply run still holds this project's lock. Wait
  for it; a lock whose process died is taken over by the next run, which says
  so in its report.

## Read the result

When the run finishes, the tree has changed in four ways:

- `flows/<name>/flow.ts` holds each migrated workflow, at the position its old
  file had: `.smithers/workflows/pipelines/ci-fast.tsx` becomes
  `flows/pipelines/ci-fast/flow.ts`.
- `.smithers-migrate/archive/<original path>` holds every source the migration
  replaced. `--keep-old-sources` leaves them in place instead.
- `package.json`, `tsconfig*.json`, and `.gitignore` are rewritten where they
  are: the 0.x packages removed, `effect` pinned, `smithers up <file>` scripts
  rewritten to `smthrs flow start <flow>` with input/detach flags translated,
  the JSX compiler options and the old path
  mappings dropped, and `.flows/` ignored.
- `.smithers-migrate/report.md` records all of it.

Read the report's Verification section before you commit it. Each command's
last 12 KB of output is captured verbatim and nothing redacts it: a failing
install or test suite in a 0.x project prints whatever it prints, a registry
token or a value read from `.env` included, and the tool cannot tell a secret
from a stack frame.

## Verify the tree yourself

The migration already ran your project's install, format, typecheck, tests, and
registry discovery over the final tree. Run them again yourself, then check
that the flows are discoverable:

```bash
smthrs ls
smthrs doctor
```

`smthrs ls` lists the flows discovered under the project. A migrated workflow
that does not appear is a flow nobody can run; the report's Verification
section names the discovery warning that explains why.

Commit `report.md`. It is the record of what the tool changed, what it could
not translate, and what is still yours to decide.

## Next steps

- [Migration units](/concepts/units/): why the work is cut this way, and
  what one unit is allowed to touch.
- [Checkpoints and confinement](/concepts/checkpoints/): what is restored
  when a unit fails, and what the rewrite is prevented from reaching.
- [Recover a failed unit](/guides/recover-a-failed-unit/): what to do with
  an exit 1.
- [Set the commands that verify each unit](/guides/set-verification-commands/):
  for a project whose typecheck lives somewhere the detection ladder cannot
  see.
