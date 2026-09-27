---
title: "Ownership, fences, and claims"
description: "How a fence makes every owner-sensitive write a compare-and-swap, what a park releases, why a resume can be scoped to runs this plane launched, and how a resume delegation reaches the process that can act on it."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/concepts/ownership.md"
---

Several processes share one control database, and only one of them may be
driving a given run. Ownership is how the plane decides which, and a **fence**
is the token that decides it.

A fence is a serialized owner identity: a host id, a process id, and a nonce
that is regenerated on every claim. Every owner-sensitive write presents its
fence, and the runtime turns that into a single SQL compare-and-swap, so a
stale writer loses the `UPDATE` rather than racing a read-then-write. A fence
taken before a park is not the fence held after the resume that follows it, and
the stale one is refused.

When a write presents a fence the row has moved past, the plane answers
[`ClaimLost`](/troubleshooting/).

## Status is ownership, spelled for an operator

`SqlControlRuntime` maps the control plane's vocabulary onto the run store's:

| Control status                        | Run store status | Ownership            |
| ------------------------------------- | ---------------- | -------------------- |
| `accepted`, `running`                 | `running`        | Held by this process |
| `accepted` after an executor declines | `suspended`      | Released             |
| `parked`, `waiting-approval`          | `suspended`      | Released             |
| `cancelled`, `completed`, `failed`    | same             | Released, terminal   |

A claim writes `accepted`. `Control.run` promotes it to `running` when its
executor takes the launch; an explicit resume leaves it `accepted` until the
driver writes another status. An `ownerId` distinguishes an owned `accepted`
run from a released pending launch. Losing a claim to an owned `accepted` or
`running` row means a live peer holds it.

The authoritative `RunSummary` is written into the row's `state_json` by the
same fenced `UPDATE` that moves the status, so a projection can never be read
out of step with the lifecycle.

## A park releases the row, and records who parked it

A parked execution releases its owner columns. That is what makes it resumable
at all, and it is also why every process sharing the database can see the park.

The fence the park was written under is kept in `RunSummary.parkedBy`, and only
on a park. It is the one thing left on the row that says which host parked the
run, so that host recognizes its own park and a short-lived process that would
drive the run and then exit can tell the execution is not its to take up.

`RunSummary.waitingReason` is the other half of the picture, and the control
plane only ever reads it. The engine writes it when it parks a run and clears
it on the wake, so an operator park written through
`ControlRuntime.writeStatus(runId, fence, "parked")` leaves the column empty.
An empty column is exactly how an operator park is told apart from an engine
park, and several behaviors turn on that:

| `waitingReason`  | A steer arriving | A monitor's reading |
| ---------------- | ---------------- | ------------------- |
| `event`          | Resumes the run  | Ordinary park       |
| `released`       | Resumes the run  | Ordinary park       |
| `approval`       | Leaves it parked | `awaiting-human`    |
| `timer`, `quota` | Leaves it parked | Ordinary park       |
| absent           | Leaves it parked | `awaiting-human`    |

## Claim scope: launched, or any

`ControlRuntime.resume` joins a non-terminal run whose fence this process
still holds, including an `accepted` run. A join preserves the original fence.
An `accepted` run released by `releasePending` is claimable under a new fence.

`scope: "launched"` restricts claims to runs recorded in `control_runs`, the
shared index of control-launched runs. Both `Control.resume` and `Control.run`
with a Resume input, plus every steer wake, pass this scope. An engine-created
child, fork, or later trampoline round keeps its own continuation and driver.

`scope: "any"`, also the runtime default, is a trusted low-level runtime
capability for hosts that can drive the claimed execution. It is not the
public Control resume contract.

## Explicit resume records a journal intent

Both public resume spellings journal `control.run.resume`. A suspended run
outside the launch index remains unclaimed; the receipt is `Accepted` after
the journal intent is recorded. A live peer's owned run fails with `ClaimLost`.
A caller or journal subscriber must drive the execution, including after a
successful claim. An `Accepted` receipt does not establish that work started.

Explicit resume does not call `requestResume` or `ControlExecutor.resumeRun`.
It creates no `pendingResumes` entry for host polling.

## Node approval records a durable resume delegation

A decision on an in-run approval restarts the run server-side, and the process
that decides is usually not the process hosting the execution: an operator's
`smthrs approvals approve`, a gateway, a second CLI.

So the intent is recorded durably rather than published in process:

1. `requestResume(runId)` writes the delegation and returns its sequence.
   `RunSummary.pendingResume` reports that sequence while it is outstanding.
2. The plane offers it to its own executor through `ControlExecutor.resumeRun`.
   An executor that answers `resuming` has claimed the row and is driving, so
   the delegation is cleared with `clearResume(runId, sequence)`.
3. An executor that answers `unknown` leaves the delegation standing.
   `pendingResumes` is what every host polls, and a run parked by a process
   that has since exited is taken up by whichever host can drive it once the
   delegation has gone unanswered for the run store's heartbeat staleness
   window.

The sequence check is what makes the clear safe. A resume requested between the
read and the clear has a higher sequence and survives, so the host takes it up
on its next tick instead of losing it.

A settled run's delegation is never reported: no host will ever take it up, and
reporting it forever would turn a finished run into an unbounded backlog.

## Where to go next

- [Cancel a run, and restart one](/guides/cancel-and-resume/): the verbs
  that meet these rules head on.
- [Connect an execution engine](/guides/implement-an-executor/): the port
  that turns a delegation into a running fiber.
- [Ownership on smithers.sh](https://smithers.sh/docs/concepts/ownership/): the same fence, from
  the engine's side.
