---
title: "Retry a failing action"
description: "Declare a retry policy, understand where the engine makes its retry decision, keep integrity failures unretried, and read the two terminal defects."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/guides/retry-a-failing-action.md"
---

A `RetryPolicy` is plain data, not a `Schedule`. That is deliberate: the next
delay is derived from a **persisted** attempt count rather than from fiber-local
state, so a backoff ladder survives a park, a resume, and the death of the
process that started it.

## Declare a policy

```ts
import { RetryPolicy } from "@smthrs/flow"

const policy = RetryPolicy.make({
  initialMs: 200,
  factor: 2,
  maxMs: 10_000,
  maxAttempts: 5,
  expirationMs: 5 * 60_000,
  jitterRatio: 0.2,
  nonRetryable: ["payments/ChargeDeclined"]
})
```

`RetryPolicy.make` checks every bound and throws a `RangeError` naming the field
that is wrong: `initialMs` finite and greater than zero, `factor` finite and
positive, `maxMs` finite and not below `initialMs`, `maxAttempts` a safe integer
of at least one, `expirationMs` finite and positive, and `jitterRatio` finite
and within zero and one inclusive. `initialMs: 0` is refused rather than read as
"retry immediately": every computed delay would be zero, which `nextDelay`
treats as exhausted, so the policy would give up on the first failure whatever
`maxAttempts` promised. Use `initialMs: 1` for a near-immediate retry.
`jitterRatio: 0` disables jitter. The
`nonRetryable` array is copied and frozen, so mutating your array later cannot
change what a parked policy means.

`RetryPolicy.defaultRetryPolicy` is `{ initialMs: 200, factor: 1.5, maxMs: 30000 }`.
It declares neither `maxAttempts` nor `expirationMs`, so it never gives up. Bound
a long-lived retry with `expirationMs` when a wall-clock give-up is required.

## Attach it to the work

The engine reads `action.retryPolicy` at dispatch. Both forms of `Action.make`
take it; the [`Action.make` reference](/reference/flow/#actionmake) lists
every option. The inline form:

```ts
import { Action } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const settle = Action.make({
  name: "payments/Settle",
  success: Schema.String,
  error: Schema.String,
  tier: "irreversible",
  idempotencyKey: "settle:checkout-v1",
  retryPolicy: policy,
  execute: Effect.suspend(() => callProvider())
})
```

A **declared** action, the kind a body names, takes the same option:

```ts
const Settle = Action.make("payments/Settle", {
  payload: { orderId: Schema.String },
  success: Schema.String,
  error: Schema.String,
  retryPolicy: policy
})
```

Two other tools cover different needs:

- Dispatch an inline action from inside an implementation when a nested step
  needs its own record and its own attempt sequence.
- Wrap work in `Action.retry`, which is `Effect.retry` with the durable attempt
  context threaded through it, for a retry the policy does not describe.

```ts
const attempts = Action.retry(settle, { times: 3 })
```

`Action.retry` updates `Action.CurrentAttempt` on each attempt and pins ordinals
per allocation scope, so every attempt of one sequence reuses its own action's
ordinals instead of drawing new step keys. A nested block shares the enclosing
block's pinned slot, so a completed inner dispatch replays rather than
re-executing.

## What the engine decides, and when

`RetryPolicy.decide` is the engine's single retry decision point, and
non-retryable classification happens there and nowhere else. On a failing
attempt the engine asks the policy, passing the current attempt, the error, and
the elapsed time since the first attempt:

| Decision                 | What happens                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RetryAfter(delayMs)`    | The engine sleeps and dispatches attempt `n + 1`. An irreversible action with no `idempotencyKey` dies with `IrreversibleRetryRequiresIdempotencyKey` instead. |
| `GiveUp("nonRetryable")` | The original typed failure propagates unchanged.                                                                                                               |
| `GiveUp("exhausted")`    | The final declared failure propagates unchanged.                                                                                                               |
| `GiveUp("expired")`      | The final declared failure propagates unchanged.                                                                                                               |

A spent retry policy preserves the action's error channel. `Node.catch` and
ordinary typed Effect recovery can handle the final failure. The execution span
records `retry.stopReason` and `retry.attempt`; adding retries does not turn a
business failure into a defect. Previously persisted exhaustion defects remain
historical outcomes and are not rewritten.

A durable engine persists the first attempt's start time and the attempt
sequence, so `expirationMs` is measured from the true first attempt and a
resumed run does not re-sleep the ladder from attempt one.

## Failures that are never retried

`RetryPolicy.defaultNonRetryable` lists error tags that are non-retryable under
**every** policy, with no per-callsite opt-out. They are integrity verdicts from
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/), and they must reach the driver
without an action-level retry hiding the first detection.

Your own tags go in `nonRetryable`. `RetryPolicy.errorTag` is how a tag is read
off an error: an own string `_tag` when present, otherwise the first own `name`
descriptor found while walking a bounded prototype chain.

## Bound a hung attempt

A retry policy only sees attempts that end. Declare `attemptTimeoutMs` to end
one that hangs, or `heartbeatTimeoutMs` to end one that stops reporting
progress through `Action.heartbeat`. Both forms of `Action.make` take them, as
positive integers:

```ts
const Fetch = Action.make("sandbox/Fetch", {
  payload: { url: Schema.String },
  success: Schema.String,
  retryPolicy: policy,
  attemptTimeoutMs: 30_000,
  heartbeatTimeoutMs: 5_000
})

const layer = Fetch.toLayer(({ url }) =>
  Effect.gen(function*() {
    const stream = yield* openStream(url)
    // Each heartbeat restarts the 5 second gap.
    return yield* readChunks(stream, { onChunk: () => Action.heartbeat })
  })
)
```

An expired bound interrupts the body and dies with `Action.AttemptTimedOut`,
naming the action, the attempt, the `bound` that expired (`"attempt"` or
`"heartbeat"`), and its `timeoutMs`. The engine counts that defect as a failed
attempt: `retryPolicy` decides on it like a typed failure, a durable engine
records it as a failed attempt row, and listing `"@smthrs/flow/AttemptTimedOut"`
in `nonRetryable` stops the retries. Without a retry policy, or once the policy
gives up, the defect is the action's outcome. Every other defect stays
unretried.

## Infrastructure interrupts

An action implementation or transport adapter may fail with
`Action.InfraInterrupt` when it can identify a retryable infrastructure event.
It is not an ordinary domain failure and `retryPolicy` does not see it. Only an
inline action's `interruptRetryPolicy`, an Effect `Schedule`, retries the
explicit marker. The shipped engines do not convert owner loss, host shutdown,
or ordinary fiber interruption into it:

```ts
import * as Schedule from "effect/Schedule"

const resilient = Action.make({
  name: "payments/Settle",
  success: Schema.String,
  error: Schema.String,
  interruptRetryPolicy: Schedule.recurs(3),
  execute: callProvider().pipe(
    Effect.catchTag(
      "TransportUnavailable",
      (error) => Effect.fail(new Action.InfraInterrupt({ reason: error.message }))
    )
  )
})
```

Spending that schedule without reaching an ordinary success or failure dies with
`Action.InfraInterruptRetriesExhausted`, carrying the action name, the attempt
count, and the final interrupt.

## Deciding without an engine

The policy functions are pure and exported, so a host can ask the same questions
the engine asks:

```ts
RetryPolicy.nextDelay(policy, 2) // Option<number>; None means give up
RetryPolicy.isNonRetryable(policy, error)
RetryPolicy.decide(policy, { attempt: 2, error })
```

`nextDelay` is total even for a policy decoded from a persisted row: a
non-finite attempt, elapsed time, bound, or computed delay answers `None` rather
than handing a caller a negative or `NaN` duration. `RetryPolicy.nextDelayEffect`
and `RetryPolicy.decideEffect` are the variants that sample the `Random` service
for jitter.

## Related pages

- [Attach an implementation to an action](/guides/implement-an-action/): the tiers a
  retry has to respect.
- [Suspension and replay](/concepts/suspension-and-replay/): why
  `suspendedRetryPolicy` on a flow is a different thing entirely.
