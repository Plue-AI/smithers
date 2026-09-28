---
title: "Hand work to a durable worker"
description: "Declare a durable queue, suspend a flow until a worker records its result, and run the worker as a layer with bounded concurrency."
sidebar:
  order: 10
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/guides/queue-work-to-a-worker.md"
---

A `DurableQueue` moves work out of the flow that asked for it. The flow offers a
payload, parks, and resumes when a worker persists a result. Requests and recorded
results survive the process that made them.

## Declare the queue

```ts
import { DurableQueue } from "@smthrs/flow"
import * as Schema from "effect/Schema"

export const Renders = DurableQueue.make({
  name: "Renders",
  payload: Schema.Struct({ page: Schema.String }),
  success: Schema.String,
  idempotencyKey: ({ page }) => page
})
```

`idempotencyKey` is required. The payload key scopes an occurrence counter;
the execution ID and occurrence ordinal also contribute to the queue item ID.
Distinct offers of the same page create distinct items, including within one
execution. Replaying the same occurrence derives the same ID for queue deduplication.
Business-level deduplication across distinct offers or runs is the caller's job.
`success` defaults to `Schema.Void` and `error` to `Schema.Never`.

## Offer work from a flow

```ts
const rendered = DurableQueue.process(Renders, { page: "home" })
```

`process` offers the payload under the name `DurableQueue/<name>`, attaches a
completion token, and suspends the execution until a worker records the handler's
exit against it. The success and error channels are the queue's declared schemas,
so the caller sees the worker's own outcome. While suspended, the execution's
waiting annotation has reason `event` and the item's completion token.

Invalid payloads and offer encoding failures die with `SchemaError` without
retrying. The final offer failure of an exhausted retry schedule also becomes a
defect. The typed error channel is reserved for the worker's declared error.

`retrySchedule` bounds how a failing offer is retried. The default retries with
exponential delays capped at one minute and never gives up, so a caller that
wants a bound supplies its own:

```ts
import * as Schedule from "effect/Schedule"

const bounded = DurableQueue.process(Renders, { page: "home" }, {
  retrySchedule: Schedule.recurs(5)
})
```

## Run the worker

`DurableQueue.worker` is the layer form: it forks the worker into the layer's
scope, so it starts with the composition and stops with it.

```ts
import * as Effect from "effect/Effect"

export const RendersWorker = DurableQueue.worker(
  Renders,
  ({ page }) => Effect.succeed(`<html>${page}</html>`),
  { concurrency: 4, maxAttempts: 10 }
)
```

`concurrency` defaults to `1` and must be a positive safe integer;
`DurableQueue.makeWorker` and `DurableQueue.worker` throw a `RangeError`
otherwise. `makeWorker` is the underlying effect, for a host that wants to fork
it itself.

The handler's exit is what the waiting flow receives. A handler that fails with
the queue's declared error type resumes the caller with that typed failure; a
handler that dies resumes it with a defect. An interrupt-only handler exit records
nothing and requeues the item without consuming an attempt. Mixed failures are
recorded with interrupt reasons removed.

Handler execution is at least once: if recording its result fails, a subsequent
take runs the handler again. Make side effects idempotent using a business key in
the payload. `maxAttempts` is passed to the persisted queue and defaults to `10`
on both worker constructors. Failed takes consume attempts; interrupt-only exits
do not. A declared handler failure that is successfully recorded completes the
item instead of retrying it.

A worker completes only the wait its own `process` call created: an item stored
under ID `key` must carry a token for `DurableQueue/<name>/<key>`. An item whose
token is malformed or names any other wait point is logged at error level and
acknowledged without running the handler. The worker links its span to the
offering span only when the stored trace and span ids are 32 and 16 lowercase hex
characters.

A take failure after the handler produces a recordable exit is logged at error
level with the queue name, item ID, completion token, attempt, attempt limit, and
whether that limit was reached. At exhaustion the store drops or quarantines the
item according to its policy. If completion writes exhaust the attempts without
recording a result, the caller remains suspended and requires recovery by the
host. Raising `maxAttempts` allows more retries but does not guarantee completion.

## When to reach for it

A durable queue is the right shape when the work has a different lifetime or a
different scaling story from the flow that asked for it: a render farm, a batch
of uploads, anything where the caller should park rather than hold a slot. When
the work belongs to the same run, an action is simpler and keeps the step in the
plan. When it is its own unit of work with its own journal,
[a child execution](/guides/run-a-child-flow/) is the closer fit.

## Related pages

- [Wait for an external signal](/guides/wait-for-an-external-signal/): the deferred
  and token machinery the queue's reply channel is built on.
- [Suspension and replay](/concepts/suspension-and-replay/): what the caller
  is doing while the worker works.
