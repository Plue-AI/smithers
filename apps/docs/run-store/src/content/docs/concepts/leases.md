---
title: "The heartbeat lease"
description: "The four heartbeat durations and how they relate, the two clock sources that stamp one run row, the skew allowance the store enforces, and what a wall-clock lease can and cannot promise."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/run-store/docs/concepts/leases.md"
---

An owner proves it is still working by writing `heartbeat_at_ms`. A peer that
wants the run reads that stamp and decides whether the owner is gone. Every
number in that exchange is a constant this package defines, and they are
related rather than independently chosen.

## The four durations

They live in `@smthrs/run-store/Heartbeat` and are re-exported from
`Ownership`. All four are `Duration` values:

| Constant                  | Value      | What it governs                                                                           |
| ------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `heartbeatInterval`       | 1 second   | How often the supervision loop pulses.                                                    |
| `heartbeatStaleAfter`     | 30 seconds | How old a persisted heartbeat must be before a peer may steal the run.                    |
| `heartbeatSkewAllowance`  | 10 seconds | How far the owner's wall clock may lag a peer's before the lease reasoning stops holding. |
| `heartbeatWriteTolerance` | 19 seconds | How long an owner may keep working through failing or stalled heartbeat writes.           |

The last one is derived, not chosen:
`heartbeatStaleAfter - heartbeatSkewAllowance - heartbeatInterval`. A peer may
steal the run the instant the persisted heartbeat is `heartbeatStaleAfter` old.
The peer's clock may already read `heartbeatSkewAllowance` later than the
owner's, so an owner that tolerated write failures for the full staleness
window would still be running side effects when the steal was admitted.
Subtracting the skew allowance and an extra pulse interval reserves one
interval to reconfirm ownership before interrupting.

They live in a leaf module because `Ownership` imports `RunStore` and
`RunStore` needs the staleness cutoff for its own predicates. Neither could own
the constants without the other restating them, and a restated constant is a
constant that drifts.

## The supervision loop

`Ownership.heartbeatLoop` is the owner's half of the exchange. It pulses
forever and interrupts itself when the fence is gone, so race it against the
owned work with `Effect.raceFirst`, which settles on the first outcome of
either side, interruption included:

```ts
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"

const owned = <A, E>(
  runId: string,
  owner: Ownership.OwnerId,
  work: Effect.Effect<A, E, RunStore.RunStore>
): Effect.Effect<A, E, RunStore.RunStore> => Effect.raceFirst(work, Ownership.heartbeatLoop(runId, owner))
```

The loop pulses every `heartbeatInterval`, reading the injected Effect `Clock`,
so a test drives it with `TestClock` and never waits in wall time. It
distinguishes two failures on purpose:

- **A lost fence** is any heartbeat outcome other than `Updated`. That is
  durable evidence that another owner holds the run, so the loop interrupts
  immediately and takes the raced work with it.
- **A failed write** is not evidence of anything. The persisted heartbeat is
  still on the row and no peer may steal the run until it is
  `heartbeatStaleAfter` old, so transient database errors are tolerated for
  `heartbeatWriteTolerance`.

When that budget expires, an independent deadline calls `RunStore.reconfirm`,
bounded by one `heartbeatInterval`. It delegates to the same `Consensus`
strategy as ordinary heartbeats and mirrors the renewed stamp in the same
transaction. Reconfirm succeeds only when the owner still matches and there
is no pending claim. A peer that reserved the stale lease therefore wins
even before it activates.

Reconfirmation keeps its one-heartbeat-interval deadline. When it succeeds,
supervision resets the confirmed-pulse time from the timestamp sent to the
store. `onReconfirm(unconfirmedMs)` must finish within the remaining renewed
`heartbeatWriteTolerance` budget; reconfirmation time is subtracted, and receipt
completion does not extend the persisted lease. A blocked or failed receipt
lapses the lease. The engine journals
`run-decision` with decision `lease-reconfirmed` and detail `{ unconfirmedMs }`;
`runs show` reports a warning. Owner identity and journal generation do not
change. A lost lease, write error, or timeout calls `onLapse` and interrupts
the pulse loop and its pending write, including when that write never returns. A successful pulse
re-arms the deadline from the timestamp supplied to the store, not the time the
write completes. The deadline reads the current clock after each wait; delayed
successes and failures cannot extend the lease beyond that persisted timestamp's
budget. Until the first successful pulse, the budget starts when supervision
begins.

## Heartbeats only move forward

`heartbeat` writes `MAX(heartbeat_at_ms, :nowMs)`. A pulse that arrives after a
newer one from the same owner still reports `Updated`, because the fence held
and the write proved liveness, but it does not move the stamp backwards and
make a live run look stale to a peer's cutoff. The same rule applies to attempt
heartbeats.

## Two clocks stamp one row

A run row carries readings from two different sources, and the split is
deliberate.

**The caller's `nowMs`** is used by the operations that judge or record a
lease: `claim`, `claimAndOwn`, `steal`, `heartbeat`, `reconfirm`, `requestCancel`, and
`recoverClaim`. It is the cutoff their predicates compare against and the value
they persist, and it is taken literally.

**The Effect `Clock`** stamps the lifecycle. `create` writes `created_at_ms`,
`activate` writes `started_at_ms` and `heartbeat_at_ms`, and `transitionOwned`
writes `finished_at_ms`.

One row can therefore hold readings from both, so a composition must give both
sources the same reading. In practice that means taking `nowMs` from
`Clock.currentTimeMillis` rather than from `Date.now()`, which is also what
makes the whole store driveable under `TestClock`.

## The skew allowance is enforced

Every `nowMs` is validated as a non-negative safe integer. The lease operations
(`claim`, `claimAndOwn`, `steal`, `heartbeat`, `reconfirm`, and `recoverClaim`) then bound it
from above: a reading more than `heartbeatSkewAllowance` ahead of the store's
own `Clock` fails with `invalid_run` before any predicate runs.

No composition produces such a reading honestly, because the caller and the
store share a process, and it is the one lever that steals a fresh owner or
pins a lease past the cutoff. A reading behind the clock is admitted: it makes
every staleness judgment more conservative, and the monotonic heartbeat absorbs
it.

Two operations sit outside that bound on purpose. `requestCancel` keeps its
literal reading because its timestamp is request data rather than a lease
predicate. The `claimedAtMs` fence tokens passed to `activate`, `abandonClaim`,
and `recoverClaim` are compared against the row rather than bounded, because
they are tokens the store itself issued.

Inside the allowance the reading is trusted completely: the store cannot tell a
slow clock from a lie. That is the right contract for an in-process library over
a local SQLite file whose caller can issue raw SQL anyway, and it must not
cross a trust boundary.

## What the lease does not promise

Beyond `heartbeatSkewAllowance` of clock offset between two hosts, a peer can
be admitted while the previous owner is still running. Durable writes stay safe
regardless, because they are fenced by the consensus strategy's commit-time
guard and the displaced owner's writes fail rather than corrupt. Non-durable external side
effects, such as an HTTP call or a spawned process, can genuinely overlap.

That is inherent to any wall-clock lease. A caller that cannot tolerate any
overlap needs a fencing token at the side effect itself, not a larger timeout.
The next lever after the lease is evidence: see
[Liveness evidence](/concepts/liveness-evidence/).
