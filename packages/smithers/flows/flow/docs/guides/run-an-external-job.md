---
title: "Run an external job"
description: "Start external work once, park between probes, and reattach after a host restart."
sidebar:
  order: 8
---

`ExternalJob.make` composes recorded Start, Status, Collect and Cancel actions
with ordinary flow handoffs and durable timers. The adapter owns the external
worker; a parked Smithers execution owns no worker process scope.

```ts
import { Action, ExternalJob, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { RemoteChildProcessSpawner, Sandbox } from "@smthrs/sandbox"
import { Effect, Layer, Schema } from "effect"

const Build = ExternalJob.make("build/external", {
  payload: { source: Schema.String },
  handle: Sandbox.JobHandle,
  success: Sandbox.JobResult,
  error: Schema.Union([RemoteChildProcessSpawner.ProviderError, Sandbox.CaptureError]),
  probe: { every: "15 seconds", max: "2 minutes" },
  timeout: "2 hours",
  restarts: 1
})

// The provider adapter supplies create-or-get, observation, collection and
// cancellation. Convert cleanup transport errors to visible defects.
const adapter = Sandbox.job(provider, { command: "make" })
const buildLayer = Build.toLayer({
  ...adapter,
  cancel: (handle, key) => adapter.cancel(handle, key).pipe(Effect.orDie)
})

const Pipeline = Flow.make("build/pipeline", {
  payload: { source: Schema.String },
  success: Sandbox.JobResult,
  error: Build.errorSchema,
  body: Node.capture({ version: "build/pipeline/v1", build: Build._tag }, (payload) => Build.call(payload))
})

const implementations = Layer.mergeAll(buildLayer, Interpreter.layer(Pipeline))
  .pipe(Layer.provideMerge(Action.layerImplementations))
```

Use a retained provider. Supply the runtime and the adapter's services, including durable capture receipt
storage, to that layer. Declare the complete adapter failure union in `error`;
errors are encoded in durable action outcomes.

## Identity and replay

`Build.call` uses the existing child boundary, so each call has its own durable
execution identity. It does not inline the job into its caller. `.child` and
`.execute` also retain the ordinary flow APIs. Two calls with identical payloads
start separate jobs. `.execute` with the same execution id rejoins its lineage.

The initial action journals the enclosing job execution id and start time.
Adapters receive `<execution id>#g1`, then `#g2` for one allowed replacement.
The public payload cannot select an identity or supply a continuation handle.
`start` must atomically create-or-get by that key. Smithers replay alone cannot
make a provider's non-idempotent spawn safe.

Status actions have separate probe keys, while the provider receives the same
job key throughout one generation. Delays double from `probe.every` up to
`probe.max`, and stop at the original timeout deadline. That deadline is carried
through every generation and survives a host restart.

## Replacement and cancellation

Status returns `Running`, `Exited` with `exitCode`, or `Lost`. `Exited` calls
`collect`. A collected exit can fail with `ExternalJob.Again` to request a
replacement. Both Lost and Again complete Cancel before a durable backoff and
the next Start. A failed cancellation cannot launch another worker.

Exhaustion fails with `ExternalJobLost` (`infra`). Timeout completes Cancel and
fails with `ExternalJobTimedOut` (`dependency`). `restarts: 0`, the default,
permits only the first generation. Adapter infrastructure errors retain their
declared type and use the runtime's repeat-safe retry policy.

The actual flow scope retains `Flow.withRollback` cancellation. Timer parking,
replay and host release preserve the external worker. Explicit cancellation
cancels it, including a retained parked scope. The rollback is process-local;
providers still need their retained-machine lease or reaper after a host dies.
