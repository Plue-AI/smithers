---
title: "Handle failures"
description: "Branch on ModelError codes: what the executor already retried, when to park, and when to give up."
sidebar:
  order: 3
---

Every provider failure reaches you as a `ModelError` whose `code` is the
contract. Provider message text is not a contract and changes without
notice, so branch on `code`, never on message wording. Kernel permission
failures arrive as their own classes (`PermissionRequired`,
`PermissionDenied`, `GrantStoreError` from `@smthrs/capability`), never as
`ModelError` codes.

## What already happened before you see the error

The `RequestExecutor` retried the request inside the call: at most two
retries after the first attempt, starting at 500 ms, doubling, jittered,
capped at 10 s per computed wait and 60 s in total, and only for a retryable
code. A provider `Retry-After` within the budget is slept in full; one that
exceeds the 60 s budget is not slept at all. After three
consecutive `transport` failures, the next attempt invokes the transport's
`rebuild` effect. `RequestExecutor.make` and `RequestExecutor.layer` use
`fixed(http)`, which returns the same client. Replacing a connection pool
requires `RequestExecutor.makeWith(transport)` with a host-supplied rebuilding
transport. An `authentication` failure is never retried, except once when
the route's `Auth` declares a `refresh`.

So the error in your hands has already had its transient chances. Your
decision is what to do next.

## Branch on the code

```ts
import { Model } from "@smthrs/model"
import { ModelError } from "@smthrs/model/ModelError"
import { Effect, Stream } from "effect"

const program = Effect.gen(function*() {
  const model = yield* Model.Model
  return yield* Stream.runCollect(model.stream(request))
}).pipe(
  Effect.catchIf(
    (error): error is ModelError => error instanceof ModelError,
    (error) => {
      switch (error.code) {
        case "quota_exceeded":
          return Effect.fail(error) // park until the account is funded
        case "context_overflow":
          return Effect.fail(error) // compact the transcript, then retry
        case "call_timeout":
          return Effect.fail(error) // re-issue with a tighter request
        default:
          return Effect.fail(error)
      }
    }
  )
)
```

The twelve codes and their retryability are tabulated in the
[API reference](../api.md#modelerror). The decision per code:

- `rate_limited`: transient. The executor already waited; a durable caller
  can park on `error.resetAtEpochMillis` instead of burning attempts.
  ChatGPT `usage_limit_reached` responses and streamed failures use this code.
  `resets_in_seconds` and `resets_at` become an absolute reset instant; a
  subscription reset beyond the transport retry window is returned immediately.
- `quota_exceeded`: never retryable, because waiting does not add credit.
  Park until the account is funded; `retryAfterMillis`,
  `resetAtEpochMillis`, and `resetSource` carry the wake instant when the
  provider stated one. A bare HTTP 402 on Anthropic, Responses, or Chat
  Completions routes arrives here, even without a recognized error body.
  Quota codes and Anthropic's "credit balance is too low" also arrive here.
- `context_overflow`: the request did not fit the window. Compact or
  truncate the transcript, then issue a new request.
- `call_timeout`: your own wall-clock budget expired and the caller
  interrupted the request, so nothing about its settlement is known.
  Re-issue with the model told to be shorter.
- `authentication`: the credential was rejected. Rotating it outside the
  route is the only repair; on a route whose `Auth` has a `refresh`, the one
  automatic retry already happened.
- `invalid_request`: the request is malformed for this provider. When the
  package refused to send it, `error.path` names the offending member, such
  as `params.maxTokens`, and never its value.
- `content_policy`: the provider refused on safety grounds. Retrying the
  same content reaches the same refusal.
- `provider_internal`, `transport`: the provider or the connection failed.
  The executor's ladder already applied; an outer, longer-horizon retry is
  the caller's policy.
- `invalid_provider_output`: the provider sent bytes the protocol cannot
  read. Report it; the request was fine.
- `no_route`: no model is configured in this environment. This is the noop
  layer answering; provide a route.
- `unknown`: unclassified. Inspect `httpStatus`, `providerCode`, and
  `requestId` when reporting it.

## Supply a rebuilding transport

The host supplies the initial client and a repeatable effect that creates a
client backed by a fresh pool. The host owns pool allocation and cleanup,
including the replaced pool and the final pool when its scope closes. Both
clients must preserve the host's permission middleware.

Node hosts use the shared scoped transport. Provide the same `GrantStore`
used by the rest of the host; every replacement retains its permission checks
and the supplied environment's proxy policy.

```ts
import { RequestExecutor } from "@smthrs/model"
import * as EgressHttpClient from "@smthrs/platform-node/EgressHttpClient"
import { Effect, Layer } from "effect"

const executor = Layer.effect(
  RequestExecutor.RequestExecutor,
  Effect.flatMap(
    EgressHttpClient.guardedTransport(process.env),
    RequestExecutor.makeWith
  )
)
```

Build this layer in the host's scope and retain it across model calls.
Suggestion, migration model seats, and character evaluation use this composition; a new
conversation does not need a new executor to recover from session loss.
Browser and Fetch hosts keep `RequestExecutor.layer` over their HTTP client.

The counter belongs to this executor and spans calls. Reaching three
failures does not immediately rebuild or grant another retry. Before the
next attempt, the executor runs the transport's `rebuild` effect, uses its returned client,
and resets the counter. With the default two retries, that next attempt
can be in a later call. Any HTTP response clears the transport-failure
counter. Calls that reach the bound together share one rebuild: the first
runs `rebuild` and the rest wait for its client. A failure reported by a
client the executor has already replaced does not count against the
replacement.

## Read the detail fields

Beyond `code`, a `ModelError` carries `message`, `path`, `retryAfterMillis`,
`resetAtEpochMillis`, `resetSource`, `providerCode`, `requestId`, and
`httpStatus`, all scrubbed of credentials. The failed provider response body
is available for diagnostics as `error.body`, redacted and capped at 16 KiB,
with `error.bodyTruncated` set when a cap bit. Both fields are
non-enumerable: they survive for logging, but serializing the error never
copies a provider body into run state.

## Structured output with tools

Chat Completions routes preserve tools alongside `response_format`. Cerebras
accepts schema-valid completions and tool calls with this combination. Use
`toolChoice: "none"` to omit tools.
