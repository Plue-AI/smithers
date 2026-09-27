---
title: "Recover from a failed unit"
description: "What exit 1 means, what the tool already restored for you, how to find why a unit failed, and how to rerun just that unit."
sidebar:
  order: 5
---

A failed unit is not a failed migration. The tool restores the unit's files
from its checkpoint, records the failure, and runs the next unit. The run exits
1 at the end.

## Find out what failed

Open `.smithers-migrate/report.md` and read two sections.

The **Units** section carries one entry per unit with its status. A `failed`
entry names the reason: the check that refused, the verification command that
did not pass, or the error the step raised.

The **Manual follow-ups** section lists `unit <id> failed verification and was
restored` as a `must` item for each one, so the checklist alone tells you how
many there were.

## What was already put back

Everything after the tree was read runs inside one restoring scope, so the
unit's files are already back as the checkpoint found them: every recorded file
restored byte for byte, every path added since removed, and the archive copies
of restored files deleted.

The `Appendix: restoring a checkpoint` section still prints the version-control
command for each unit, because the working copy around the unit is yours:

| VCS  | Command                      |
| ---- | ---------------------------- |
| jj   | `jj restore --from <change>` |
| git  | `git checkout <ref> -- .`    |
| none | `cp -R <directory>/. .`      |

Run one only when you want to discard more than the unit's own files.

## Why a unit fails

| Cause                         | What it means                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Verification did not pass     | Install, format, a typecheck, the tests, or registry discovery failed after every repair round.                   |
| A deterministic check refused | An old import survived, a JSX pragma survived, an escape hatch was added, a flow has no readable description.     |
| A write left the unit         | A path in the tree diff that is in neither the unit's sources nor its targets.                                    |
| Run state changed             | A digest under a run-state root differs, or a file appeared under one.                                            |
| A postcondition failed        | The tree after the archive is not the state this kind of unit exists to produce.                                  |
| A step could not run          | A checkpoint that could not be taken, an archive that could not move a file, a verification that could not spawn. |

The one failure that stops the whole run rather than one unit is `no-vcs`,
which refuses before anything is written so you see `--allow-no-vcs`.

## Give a unit more repair rounds

A failing verification is handed back to the model with the failing output.
Three rounds is the default:

```bash
smithers-migrate --apply --seat anthropic:<model> --max-repair-rounds 5
```

More rounds cost more model calls, so raise it when the failures look like
things a rewrite can fix, not when they look like a wrong command. If the
failure is the command itself, see
[Set the commands that verify each unit](./set-verification-commands.md).

## Rerun one unit

If a process died before the unit settled, a retry refuses with
`checkpoint-failed` and names the original `pending-unit.json`. This refusal
happens before any backup is replaced, including when you choose a different
`--report-dir`. A handled failure that could not settle its recovery record
uses the same protection.

Open that file and inspect its checkpoint and restore instruction. Restore
the checkpoint and verify the project, then remove only that resolved
`pending-unit.json` before retrying. Keep the checkpoint backups until
recovery is complete. Leave `.smithers-migrate/apply.lock.sqlite` in place;
the next apply uses it to serialize ownership and clears the old diagnostic
owner record after a successful release.

```bash
smithers-migrate --apply --seat anthropic:<model> --unit workflow:pipelines/ci-fast
```

`--unit` takes a comma-separated list of unit ids. An id that no unit is
planned for fails the run and lists the ids that are, rather than filtering
every unit away and reporting a migration that did nothing.

Rerunning is safe by design. A file already written against Smithers 1.0 raises
`already-migrated`, gets no unit, and is never handed back to the model.

## When the rerun refuses with a stale plan

```text
smthrs migrate: <what changed since the plan>
```

Before the first unit runs, the flow reads the project again and compares it
with the plan it was given: every unit outline, the run-state roots, the
layout, and a digest of every source and target. Any byte the plan covers that
changed since planning refuses the run with `stale-plan` and exit 1, and
nothing is written.

That is what you get after fixing something by hand between two applies. Plan
again, then apply:

```bash
smithers-migrate
smithers-migrate --apply --seat anthropic:<model>
```

## Related

- [Checkpoints and confinement](../concepts/checkpoints.md): exactly what is
  recorded and exactly what is restored.
- [Troubleshooting](../troubleshooting.md): every failure code and its fix.
