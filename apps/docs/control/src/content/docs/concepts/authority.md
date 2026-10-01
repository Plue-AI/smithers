---
title: "Authority, not execution"
description: "Why the control plane records decisions instead of running work, the three ports that keep that split honest, and what a composition looks like with each of them present or absent."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/concepts/authority.md"
---

`Control` decides. It does not run anything.

Every operation the service exposes either records an intent or reads back
evidence. `plan` writes a reviewable card. `approve` resolves a durable token
and installs a grant. `cancel` writes a request and an attribution. `watch`
replays a journal it did not write. Nothing in this package executes a flow,
opens a step, or interprets a graph.

That is not a limitation to work around. It is what lets one control plane
answer for runs that several processes own, on machines it cannot reach, in a
database it shares with an engine it never imports.

## The three ports

A host chooses an implementation of each seam, and the seams are what make the
plane portable.

| Port              | Question it answers                                                     | Implementations here                                    |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `ControlRuntime`  | Where do plans, tokens, grants, idempotency records, and run rows live? | `ControlRuntime.layerMemory`, `SqlControlRuntime.layer` |
| `ControlExecutor` | Who actually runs the work, and what did they do with my request?       | `ControlExecutor.makeNoop`, your own                    |
| `Journal`         | Where is the evidence of what was decided?                              | [`@smthrs/journal`](https://journal.smithers.sh/reference/api/)                       |

`ControlLive.layer` is the implementation over those three plus the
[notification queue](https://notifications.smithers.sh/reference/api/) a steer travels through and the
[registry](https://registry.smithers.sh/reference/api/) a flow listing reads.

Both runtimes are held to one
[shared contract suite](https://github.com/smithersai/smithers/blob/main/packages/smithers/control/test/ControlContract.ts),
so a behavior you observe against the memory runtime is a behavior the durable
one owes you.

## The executor is optional, and the absence is a real composition

`ControlLive` reads `ControlExecutor` through `Effect.serviceOption`. A
composition with no executor is not broken; it is a plane that starts nothing:

- `run` on an approved plan still mints the run row, still journals
  `control.run.accepted`, and then releases the row as `control.run.pending`,
  because nothing here took the launch.
- `cancel` still writes its attribution and still interrupts a fiber this
  process is driving, but nothing reaches an engine row in another database.
- `signal` still records the fact, and no wait point is completed by this call.
- `resume` and `run` with a Resume input join or claim control-launched runs
  and journal `control.run.resume`. A caller or journal subscriber must drive
  the execution. Explicit resume does not offer work through
  `ControlExecutor.resumeRun`. A run a live host parked is handed to that
  host as a `requestResume` delegation that carries the operator's consent.
- A node-approval decision records a durable `requestResume` delegation.
  Without an executor, it remains available for the owning host's next poll.

That is the shape a monitor, a dashboard, or a read-only operator tool has, and
it is what [`examples/src/38-monitor-and-alert.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/38-monitor-and-alert.ts)
builds on purpose.

## Two run tables, one journal

A control run row and an engine run row are different documents about the same
work, and they do not collide by accident: the plane keeps its own
`flows_runs`, and the engine keeps its own. The [`smthrs` CLI](https://cli.smithers.sh/reference/api/) runs
them as two files, `.flows/control.db` and `.flows/engine.db`.

They share the journal, and that is what makes `watch` worth having: one stream
carries `control.run.accepted` and `flows.engine.attempt-started` in the order
they happened.

Sharing one database instead is a deployment choice with consequences, because
`SqlControlRuntime` reads the engine's own columns for several projections:

| Projection                                        | Column or entry it reads                              |
| ------------------------------------------------- | ----------------------------------------------------- |
| `RunSummary.waitingReason`                        | `flows_runs.waiting_reason`                           |
| Engine-created children and forks in `list`       | `flows_run_parents`, `flows.time-travel.fork-created` |
| `RunSummary.cancellation` with `source: "engine"` | `cancel_requested_at_ms`, `flows.engine.interrupted`  |

Give the control runtime and the engine one `SqlClient` and those projections
fill in. Keep them apart and the projections are empty, while cancellation
still converges, because the request travels through the `ControlExecutor` port
and the owning driver settles from it.

## What the plane owes a caller

Three properties hold across every implementation of every port, and the rest
of this package exists to keep them:

1. **Every mutation is idempotent under its key.** A retry answers the first
   call's receipt rather than doing the work twice. See
   [Receipts and idempotency](/concepts/receipts/).
2. **Every mutation is attributed.** The runtime stamps a principal, and a
   server stamps the one it authenticated rather than the one a client claimed.
3. **Every mutation leaves evidence beside the state it changed.** The journal
   entry and the state write commit together, so a reader cannot see one
   without the other.

## Where to go next

- [Receipts and idempotency](/concepts/receipts/): what a receipt means, and what a
  second ask is worth.
- [Ownership, fences, and claims](/concepts/ownership/): why a mutation can answer
  `ClaimLost`, and what a park releases.
- [Journal projections](/concepts/projections/): how `watch` turns entries into
  `ControlEvent` values.
