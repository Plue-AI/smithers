---
title: "Process containment"
description: "How the kernel makes a cancelled run leave no process behind: the SIGTERM-then-SIGKILL deadline, the durable process ledger, and the orphan records a dead host hands its successor."
sidebar:
  order: 4
---

A contained run owns its process lifetime independently of the target's exit
status. The kernel supplies the ledger and composition contract; a platform
lifecycle supplies launch and verified cleanup.

## A cancellation that never finishes

Effect's spawner already signals a child's process group when the spawn scope
closes, and then waits for the exit. With no `forceKillAfter` configured, it
waits forever. A child that traps `SIGTERM`, or a child whose own children trap
it, turns a cancellation into a hung host: the releasing fiber never finishes,
the run never reaches `cancelled`, and the process stays on the machine.

`ContainedSpawner.layer` rewrites every command it spawns to carry an
escalation deadline: `SIGTERM`, then `SIGKILL` after `graceMs`, which defaults
to `ContainedSpawner.defaultGraceMs` (2,000 ms). Both legs of a pipeline get
the policy. A command that already names its own `killSignal` or
`forceKillAfter` keeps the policy its caller chose.

A deadline alone is insufficient. A target can exit naturally while a child
keeps running or holds stdout open. `Lifecycle` prepares a live owner before
execution, lets the kernel record it, then activates the target. Each pipeline
leg has its own owner and record. Node and Bun use
`ProcessReaper.layerSpawner`, which combines a prepared native adapter with
`ProcessReaper.processLifecycle`; `NodeHost.layerContained` and
`BunHost.layerContained` already install it. A smaller Node/Bun composition
can use that factory directly. `ContainedSpawner.isContained` rejects a
deadline-only wrapper.

The platform owns signals and verifies cleanup. Its handle may identify a
supervisor rather than the target, so callers use `handle.kill` and never
signal the recorded numeric pid as a substitute. A target's exit alone does
not authorize ledger retirement.

## A host that dies before its finalizers run

A killed host runs no finalizers. The supplied POSIX supervisor observes its
private parent connection closing and requests cleanup independently. A
durable ledger still lets a later host reconcile any retained records when
cleanup could not be confirmed.

`ProcessLedger` is the durable memory that fixes it. Every successful spawn is
recorded before target activation, and the record is released only after the
lifecycle confirms cleanup when the spawn's scope closes. Records
are ownerless journal entries on the run `flows.host:<hostId>` under the
source id `@smthrs/kernel/ProcessLedger`, with four event types:

| Event type                           | Meaning                                                   |
| ------------------------------------ | --------------------------------------------------------- |
| `flows.host.process-spawned.v1`      | This host started the process.                            |
| `flows.host.process-exited.v1`       | The process ended and its scope released it.              |
| `flows.host.process-reaped.v1`       | An abandoned process group was signalled by a later host. |
| `flows.host.process-reap-skipped.v1` | A later host refused to signal it, and why.               |

The next incarnation of the same host replays that history, folds the exit,
reap, and skip events onto the spawn events, and reads `orphans`: the records
whose owner pid is not this incarnation's. `ProcessLedger.layerMemory` keeps
only the current incarnation's bookkeeping, with no journal and nothing
inherited.

Live tracking and replay identify each process by `(pid, startedAtMs)`.
`startedAtMs` comes from the Effect clock when the spawn is recorded. A delayed
exit, reap, or skip retires only that identity, preserving a newer record for
the same pid. Callers pass the original record to retirement operations.

## A failed write is reported, never swallowed

`record`, `release`, `reaped`, and `skipped` all carry the journal's failure to
their caller. A swallowed write would leave a child no incarnation of the host
can discover, which is the exact outcome containment exists to prevent.

A failed durable record prevents activation and closes the prepared owner.
Failed startup in any pipeline leg immediately closes all legs already
prepared for that logical command, even if the caller catches the failure.

The release finalizer runs after platform cleanup. If cleanup fails or its
`settled` result is false, release fails and the record is retained. If cleanup
is verified but the journal release write fails after its retries, the record
also stays for the next reaper instead of inventing a successful retirement.

## Reaping is deliberately conservative

Signalling a process group you did not start is dangerous: a pid can be
recycled. [`@smthrs/platform-node`](/api/platform-node)'s `ProcessReaper`
therefore signals an orphan only after every one of these holds:

- The record names a **separate** process group, not the reaping host's own
  group, and the group is a plausible one the child leads.
- The owner is genuinely gone.
- The record belongs to the current boot. A record written before this machine
  booted names a pid from a pid space that no longer exists.
- Where the platform can read it, the pid's start time still matches.

A successful reap and a safety refusal retire the record through **different**
event types, so an operator reading the journal can tell "we killed it" from
"we declined to". A failed signal or a still-live owner leaves the record for a
later attempt.

`ContainedSpawner.groupOf(command, pid, platform)` decides what group to
record, and it takes the platform because Effect detaches a child that names
no `detached` option everywhere except win32. A win32 record claiming
`pgid === pid` would name a group the child does not lead, so it records no
group at all instead.

## The grant identity is the command line and its environment names

Compose the permission decorator above containment to check the caller's
whole command before pipeline expansion and platform preparation.
Containment and authorization are separate concerns over the same tag, but
they share one fact worth stating here. Every stage of a spawn is checked as
its own `proc:spawn` with `CommandLine.resource(stage, context)` as its
resource, and no stage starts until every stage passes. That resource is the
rendered line with three markings:

- a `shell: true` line holding shell control syntax becomes `sh -c '<line>'`;
- an environment variable the child would not otherwise inherit is named in an
  `env <NAME>… --` prefix: any name outside the bootstrap set (`PATH`, `HOME`,
  `USER`, `LANG`, `TERM`, `TMPDIR`, `SHELL`, `LC_*`), and a bootstrap name
  whose value differs from this process's own;
- a working directory outside `Workspace.root` is named in a `cwd <path> --`
  prefix. The directory is judged by real path, so a symlink inside the
  workspace that leads to another repository is named as that repository.

A grant for `git status *` therefore covers none of `git status; curl x | sh`,
`git status` with `GIT_SSH_COMMAND` set, `git status` with `PATH` pointing
into the workspace, or `git status` run in `/tmp/other`. `git status | sh`
needs a grant for `sh` too.

A pipeline's `from` and `to` routing is **not** part of what the grant
authorizes. Nor is the content of files inside the workspace: `git status` in
the workspace reads `.git/config`, and `npm test` runs whatever `package.json`
says. A flow that holds `fs:write` on those files decides what the granted
program does, so grant `proc:spawn` for a config-reading program together with
the `fs:write` scope you intend it to follow. The working directory and the
_names_ of overridden environment variables also reach an attended surface as
display metadata; the values do not.

A custom shell path is explicit in the rendered line, and a pipeline renders
with `|` between its stages, so neither can hide behind a grant for something
else. The derived helpers (`exitCode`, `string`, `lines`, and both `stream`
forms) are all rebuilt from the guarded `spawn`, so none of them can bypass the
check.

## Related

- [Contain spawned processes](../guides/contain-spawned-processes.md): the
  composition, with and without a journal.
- [How a grant decision is made](./grant-decisions.md): the check that runs
  before any of this.
