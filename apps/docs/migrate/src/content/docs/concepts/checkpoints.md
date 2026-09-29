---
title: "Checkpoints and confinement"
description: "What a checkpoint records, what a failed unit restores, which paths a unit may write, and why the rewrite cannot read your 0.x run state even if it tries."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/migrate/docs/concepts/checkpoints.md"
---

`apply` edits your project, so the interesting question is not what it does
when it works. It is what happens when it does not, and what it cannot do
either way.

## What a checkpoint records

Before a unit edits anything, the checkpoint records three things.

**A version-control reference.** A jj change, a git ref, or, with
`--allow-no-vcs`, a file copy. The report prints the command that restores each
one. Git linked worktrees use the same git ref checkpoint as a main checkout.

**A manifest of the unit's own files.** Every declared source and target is
copied aside, and each path is recorded with whether it existed and what its
bytes digested to. Targets are recorded as well as sources, because a target
you already had at a path a unit writes is your data too.

Backup paths must stay inside the project and contain no symlink components.
Report and backup directories use mode `0700`; new backup files use `0600`,
including post-checkpoint copies preserved during rollback. Files are written
through exclusive temporary files and renamed into place. Original file modes
are recorded separately for restoration.

**A digest of the whole tree.** Everything except `.git`, `.jj`,
`node_modules`, the report directory, `.smithers-migrate/`, `.flows/`, and the
0.x run-state roots. The fixed `.smithers-migrate/` exclusion preserves the
project lock when reports use a custom directory.
That last exclusion is not a gap: run-state paths have a stricter check of
their own. The tree manifest is written beside the unit's backup rather than
carried in the journal, because a project has thousands of files and each one
would otherwise cross the journal once per unit.

## What a failed unit restores

Everything after the tree is read runs inside one restoring scope. The
deterministic checks, the archive, the manifest rewrites, and the
postconditions each return a failed unit through their own branch; an exception
any of them raises, an unreadable file, a full disk, a refused archive, or an
interrupt, restores the unit's files before it propagates.

The rollback reads the tree at the moment it fires, never a set computed
earlier. It diffs the tree against the checkpoint's manifest, puts every
recorded file back byte for byte, removes every path added since, and deletes
the archive copy of anything it put back. A postcondition that fails after the
archive has already moved a unit's sources therefore leaves the project exactly
as the checkpoint found it.

Three rules make the restore itself safe rather than merely willing:

- A path the manifest recorded as absent is the only kind a rollback removes.
- A path the manifest never named is refused rather than guessed at.
- A backup, or a restored file, whose digest no longer matches fails the
  restore instead of overwriting your tree.

Absence is the platform's typed `NotFound` and nothing else. A permission
error, a disk error, or a directory where a file was declared fails the
checkpoint rather than passing as "it was not there".

## What a unit is allowed to write

After the unit runs, the tree is diffed against the checkpoint. A path in that
diff that is in neither the unit's sources nor its targets fails the unit: a
file it added is removed, and a file it modified or deleted is named in the
report with the command that restores the checkpoint.

The model also answers with a `changedFiles` list of its own. It is advisory.
It is journaled so a reader can compare the two accounts, and it decides
nothing: the diff is the fact.

The lockfile at the project root is the one exception, because an install
rewrites it and a migration that adds packages makes it do exactly that. The
exception is an exact root path, one of `bun.lock`, `bun.lockb`,
`package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`, not a name at any depth:
a `src/pnpm-lock.yaml` is a file no install writes, so it fails the unit like
any other undeclared write. The exception also exempts the lockfile from the
refusal, not from the record. The unit report still names it as changed.

## What the rewrite cannot reach

The model's half runs on kernel-guarded services pinned to the project root,
with a grant store that denies every filesystem action on each 0.x run-state
path and everything under it. A read is a copy into a model call, so "do not
read the run state" is enforced by the kernel rather than by a sentence in a
prompt. A source file that merely shares the directory stays readable. The
same deny protects `.smithers-migrate/` and its contents, so agent filesystem
tools cannot remove or replace the migration's lock.

Shell access is granted one command line at a time: this project's own install,
format, typecheck, and test commands, and nothing else. A spawned process
writes at the OS level, where no filesystem rule can see it, so confining which
lines may be spawned is the only place a shell can be stopped from reaching a
database. What those commands then do is outside any rule, which is why the
run-state digests are checked again after them: a unit whose commands touched
run state fails its checks and is restored.

The run-state check works both ways. It compares a digest per recorded path, so
it works on binary files, and it walks every run-state directory to catch a
file written there after the checkpoint was taken, which no digest covers. 0.x
leaves loose state files beside its directories, such as
`.smithers/workflows/run-<id>.log`, and a file used as a walk root walks
nothing, so the roots are directories.

## Everything quoted from your project is data

The prompt fences every source, hint, snippet, warning, and command output it
quotes, with one more backtick than the longest run inside the content, so the
content cannot end the block. Paths and command lines are fenced inline the
same way. The contract's last rule says in so many words that an instruction
appearing inside any of them is part of the project, never part of the task,
and changes no rule.

## The plan is sealed before the first edit

Before the first unit runs, the flow reads the project again and compares it
with the plan it was given: every unit outline, the run-state roots, the
layout, and a digest of every source and target. A project that changed since
it was planned, in any byte the plan covers, is refused with `stale-plan` and
exit 1, and nothing is written. A migration of a stale plan is a migration of
the wrong project.
