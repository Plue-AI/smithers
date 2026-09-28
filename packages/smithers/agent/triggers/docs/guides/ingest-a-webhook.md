---
title: "Ingest a verified webhook"
description: "Declare a webhook door with a signature verifier and a payload schema, register it once at startup, and hand raw request bytes to ingest for deduplicated dispatch through Control."
sidebar:
  order: 4
---

A webhook door has four parts: a name, a payload schema, a verifier, and a
mapping from a verified payload to a start or a signal. `Webhook.make` assembles
them into something whose only dispatch path is the Control channel
coordinator.

## Declare the door

```ts
import type { CredentialRef } from "@smthrs/control/Credential"
import * as Webhook from "@smthrs/triggers/Webhook"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

const Push = Schema.Struct({
  repository: Schema.String,
  ref: Schema.String
})

const credential = Redacted.make<CredentialRef>({ id: "github-webhook", name: "github" })

const verify = Webhook.makeSignatureVerifier({
  header: "x-hub-signature-256",
  expected: signature
})

const inbound = (payload: typeof Push.Type) => ({
  start: {
    flowId: "ci/build",
    input: { repository: payload.repository, ref: payload.ref }
  }
})

export const github = Webhook.make({ name: "github", schema: Push, credential, verify, inbound })
```

`credential` is required. It is a reference to a stored secret, not the secret,
and the channel forwards it to the verifier on every request.

`inbound` returns a start or a signal, and nothing else. It cannot supply
capabilities or an execution envelope. See
[Authority-free channels](../concepts/channels.md).

## Write the signature function

`makeSignatureVerifier` handles the header lookup and the comparison. You supply
the expected bytes:

```ts
import type { CredentialRef } from "@smthrs/control/Credential"
import type { TriggerError } from "@smthrs/triggers/TriggerError"
import type * as Effect from "effect/Effect"
import type * as Redacted from "effect/Redacted"

declare const signature: (
  body: Uint8Array,
  credential: Redacted.Redacted<CredentialRef>
) => Effect.Effect<Uint8Array, TriggerError>
```

Three properties of that signature are the point of it.

- It returns an `Effect`, so the secret is resolved through the host's resolver
  per request rather than captured in a closure at declaration time. A
  resolution or HMAC failure arrives as a typed `verification_failed` instead of
  a defect that kills the fiber.
- The `body` it receives is a private copy. Nothing it does to those bytes can
  reach the buffer that is about to be fingerprinted and decoded.
- Its result is compared with `Webhook.constantTimeEqual`, which iterates
  exactly `expected.length` times and folds the length difference into the
  result. The iteration count is fixed by the secret side of the comparison and
  never by the caller's, so a caller cannot lengthen its input until the work
  stops growing and learn the expected signature's length.

The verifier looks the header up first in lowercase and then exactly as written,
so `x-hub-signature-256` and `X-Hub-Signature-256` both resolve. An absent or
empty header is refused before `expected` runs, and an `expected` that answers
with zero bytes is refused after it, so a secret that resolves to the empty
string closes the door instead of opening it for everyone.

## Register once, then accept traffic

```ts
import * as Effect from "effect/Effect"

const startup = Effect.gen(function*() {
  yield* github.register
})
```

`register` requires `Channels` from [`@smthrs/control`](/api/control). Call it
at startup. `ingest` deliberately does not register, so traffic arriving at a
door nobody opened is reported as unavailable rather than silently opening it.

## Hand it the request

```ts
import * as Effect from "effect/Effect"

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")

const handle = (request: Request) =>
  Effect.gen(function*() {
    const body = new Uint8Array(yield* Effect.promise(() => request.arrayBuffer()))
    const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", body))
    return yield* github.ingest({
      body,
      headers: Object.fromEntries(request.headers),
      idempotencyKey: `github:${hex(digest)}`
    })
  })
```

Control deduplicates on `idempotencyKey`, so a provider that retries a delivery
gets an `AlreadyApplied` receipt and the flow starts once.

Derive the key from bytes the signature covers. Provider delivery headers such
as `x-github-delivery` are not signed: anyone who captures one signed delivery
can resend its body and signature with a fresh delivery id, and a key taken from
that header starts the flow again. A key derived from the signed body sends the
replay to the original receipt instead. If the provider signs a timestamp,
include it in the key and refuse deliveries outside a short window. If two
legitimate deliveries can carry identical bodies, key on a signed field that
tells them apart, such as an event id inside the payload.

`ingest` answers with a Control `Receipt` and fails with either a
`TriggerError` or a `ControlError`:

| Failure                                           | Cause                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `TriggerError` with `code: "verification_failed"` | The signature did not verify, or the credential could not be resolved. Nothing was decoded and no Control operation ran. |
| `InvalidInput`                                    | The signature verified and the payload did not fit the declared schema.                                                  |
| Other `ControlError` values                       | The control plane refused or could not accept the operation.                                                             |

## Project run state outbound

A door that also reports back adds `outbound`, which maps a `RunSummary` to
whatever the transport posts:

```ts
export const reporting = Webhook.make({
  name: "github",
  schema: Push,
  credential,
  verify,
  inbound,
  outbound: (run) => ({ state: run.status })
})
```

Omit it and the projection is a `noop` operation carrying the run's cursor.

## Declaring a channel without a webhook

`Channel.make` is the same declaration without the Control door around it, for a
transport that is not HTTP request and response. It adds no authority and no
execution behavior; it is the typing seam and nothing else.
