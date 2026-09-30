---
title: "Process containment"
description: "How a crashed host's abandoned processes get killed: incarnations, the process ledger, and every guard ProcessReaper checks before it signals a durable record."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-node/docs/concepts/process-containment.md"
---

A target's exit does not mean its children exited. A host killed outright
runs no finalizers either. The contained Node host uses a live POSIX supervisor
to own each process group independently of the target and to observe host loss
through a private connection. A process ledger lets a later host reconcile
records whose cleanup was not confirmed.

## Incarnations

A **host** has a durable `hostId`. Each time a process starts under that id, it
is a new **incarnation**, identified by its pid. The ledger records which
incarnation started each process, so a later incarnation can tell its own live
children from an abandoned one's.

That is the whole shape of the problem: the input to reaping is a durable
record that outlived the process that wrote it, on a machine where the
operating system reuses pid numbers.

## The live half: the contained spawner

`NodeHost.layerContained` uses `ProcessReaper.layerSpawner` to compose
[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/)'s `ContainedSpawner` with a native process
adapter and `ProcessReaper.processLifecycle`:

- Preparation creates an owner without executing the target. The kernel
  records its identity and the original command digest before activation.
- Every pipeline leg has a separate owner and ledger record. On POSIX the
  handle's `pid` is that supervisor's; `exitCode` and `isRunning` describe the
  target. Signals go through `handle.kill`.
- Cleanup keeps its deadline after the target exits, so a same-group child
  cannot keep inherited output open indefinitely. Only verified cleanup retires
  the record; failed cleanup fails scope close and retains it.
- The grace period is an upper bound. Once the target has exited and the group
  holds no other live member and no captured escaped descendant, cleanup
  finishes at once.

Default commands lead their own group. `detached: false` opts out of group
cleanup and signals only the native target. Explicit stopping of a still-live
grouped target additionally attempts a revalidated positive-PID sweep of
escaped descendants, with ordinary POSIX PID races remaining. Natural exit
does not promise cleanup of deliberately escaped sessions.

An explicit stop owns its deadline until cleanup is acknowledged. A target exit
received during that stop does not send another request. The helper preserves
the accepted signal and grace period across target exit and either socket's
closure, even when its configured default is `SIGKILL`. A still-live target
receives that policy even after calling `setsid()` to leave the supervisor's
group. Group membership selects the descendant sweep, not the target's signal
or grace period. Only an unactivated owner or verified natural completion can
use the host's immediate cleanup shortcut. After the target exits, the helper
reads the process table once: an empty group with no captured escaped
descendant ends the stop at once, since waiting cannot clean anything more.
A live group member, a captured escaped descendant or an unreadable table keeps
the full deadline. Requests and lifetime
status use separate private sockets, so an EPIPE on a late request cannot discard
a buffered target exit or cleanup receipt. The host drains that receipt and
verifies the process group before retiring the ledger record.

Delivery deadlines and verification retries use the platform clock. Freezing
the caller's Effect clock does not freeze native process cleanup or turn an
unverifiable group into an unbounded scope finalizer.

`jj` goes through that same spawner rather than around it. `NodeJj.layer`
spawns its own children, which is right for a host that has no spawner to
offer; under containment it would mean a `jj` invocation that leads no recorded
process group, appears in no ledger, and survives the incarnation that started
it.

## The durable half: the sweep

`ProcessReaper.reap` runs once while the contained layer is built. It reads the
records a previous incarnation of the same `hostId` left behind and kills the
process groups they name. Standing a host up is therefore also what cleans up
after the incarnation that crashed.

The rules are narrow on purpose. A record is signalled only when every one of
these holds:

1. It belongs to a different incarnation of the same `hostId`. The ledger
   filters that before the reaper sees it.
2. Its owner is gone. A pid that exists but belongs to another user counts as
   alive, so only `ESRCH` reads as dead and every other answer keeps the
   record.
3. Its numbers name something this platform can signal. On POSIX that is a
   process group the child leads itself, so `pgid` has to be a safe integer
   above 1 and equal to `pid`. On Windows it is a pid, so `pgid` has to be
   absent. The check is made against the durable record rather than trusted
   from it, because `process.kill(-0, "SIGKILL")` would signal this host's own
   process group.
4. That group is not this process's group, and its pid is not this process's
   pid. The host's real process group is read from the operating system,
   because a stored number can claim anything and the shell that started this
   host shares its group.
5. The number still names the process the record describes. A record written
   before this machine booted names a pid from a pid space that no longer
   exists; within one boot, the recorded start time has to match the start time
   the operating system reports for that pid.

## No evidence never authorizes a kill

Two of those guards are questions put to `ps`: this process's own group, and
when the recorded pid started. Either can go unanswered on a host with no
usable `ps`.

An unanswered guard refuses. A guard that did not run is not a guard that
passed, so a record whose identity could not be verified is kept rather than
signalled.

The probe is deliberately unhelpful to anyone trying to fool it. It runs
`/bin/ps` by absolute path, never a `PATH` lookup, under `LC_ALL=C` and `TZ=UTC`
in a minimal environment, with a five-second `SIGKILL` deadline. Start times
are parsed explicitly as UTC, independent of the host runtime's timezone.
Live cleanup on Linux instead reads group membership, start times, and zombie
state directly from `/proc`, so it works without `procps`. Missing processes
are skipped; unreadable or malformed data leaves cleanup unverified. Other
POSIX hosts use `/bin/ps` for live cleanup with the same timezone and parsing.
The crash-recovery sweep still uses the `ps` probes described here.
The probe reads the
`pgid` column as one run of decimal digits and nothing else: `Number.parseInt`
reads a prefix, so `"12 34"`, `"12abc"`, and `"0x10"` would each become a
number that is not this host's group, silently pass the own-group comparison,
and suppress the refusal that exists to say the comparison could not be made.

## Refusals, and which ones are final

Every refusal also decides whether the record is retired. Retiring says in the
journal that nothing was signalled, which stops every later incarnation
re-examining a number the operating system has moved on from. Only a refusal a
later incarnation cannot answer differently is final.

| Refusal               | What it means                                               | Retired |
| --------------------- | ----------------------------------------------------------- | ------- |
| `owner-alive`         | the incarnation that started it is still running            | no      |
| `identity-unverified` | this host could not read the pid's start time               | no      |
| `own-group-unknown`   | this host could not read its own process group              | no      |
| `kill-failed`         | the signal was refused, so it is tried again                | no      |
| `no-group`            | it shared its owner's group, so there is no group to signal | yes     |
| `own-group`           | it named this host's own group or pid                       | yes     |
| `invalid-record`      | its numbers name nothing this platform may signal           | yes     |
| `pre-boot`            | it was written before this machine booted                   | yes     |
| `process-gone`        | the pid it names does not exist                             | yes     |
| `identity-mismatch`   | the pid exists but did not start when the record says       | yes     |

A retirement that fails to commit is logged rather than propagated. The process
is already dead and the record stays inherited, so the next incarnation reads
it, finds the pid gone, and retires it then; failing the whole sweep would take
the host down for a bookkeeping write.

## The one deliberate leak

`identityToleranceMs` is 2000. It covers two gaps at once: `ps` reports
`lstart` with one-second granularity, and `uptime` places the boot instant to
the nearest second.

The boot tolerance points backwards, so a record written moments after boot is
read as predating it and refused. That refusal is `pre-boot`, which retires the
record, so a group spawned inside that two-second window is never reaped by any
later incarnation either. It is a leak rather than a retry, and it is the
deliberate price of refusing to kill on an instant the host can only place to
the nearest second.

## Windows

Windows has no `lstart` and no process groups, so two guards cannot be answered
there: the identity check falls back to the boot-time comparison alone, and
there is no own-group refusal to make. `taskkill /T /F` walks the tree down
from the recorded pid instead. This is a documented weaker guarantee on an
unsupported platform, not an oversight.

## Next

[Contain child processes](/guides/contain-child-processes/) is the
task-shaped version of this page: the layers to compose, the ledger to choose,
and how to read what the sweep decided.
