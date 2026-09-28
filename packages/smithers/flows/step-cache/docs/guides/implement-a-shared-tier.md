---
title: "Implement a shared cache server"
description: "The HTTP surface a shared step-result tier owes RemoteCacheStore: three requests, the two-stage rule that decides 201 from 409, the provenance query parameters, and the validators to reuse so your service refuses exactly what the client refuses."
sidebar:
  order: 6
---

`RemoteCacheStore` speaks the action-cache half of Bazel's dumb-HTTP remote
cache protocol, with two additions. If you are writing the service on the other
end, this page is the contract.

The blob on the wire is the JSON encoding of a `CacheStore.CacheEntry`, not a
REAPI `ActionResult` proto: the recorded result and its journal provenance are
the thing being shared.

## Authenticate and authorize every request

The tier is a trust boundary. Every host that reads from it writes a hit back
into its local store and replays it as the step's own output, so any caller
that can `PUT` can inject results into other machines' runs, and any caller
that can `DELETE` can wipe entries they replay from. The protocol carries no
authentication of its own, and nothing below replaces yours:

- Authenticate every `GET`, `PUT`, and `DELETE` on `/ac/{keyDigest}` before
  touching storage, with the credential clients send in `headers`. Answer
  `401` or `403`; the client reports either as `persistence_failed`.
- Authorize `PUT` and `DELETE` per caller. Grant them only to trusted writers,
  such as your CI or build hosts, and give read-only machines `GET` alone.
- Scope keys per tenant or project, so one tenant's writer can neither read
  nor overwrite another's entries under the same `keyDigest`.

The client-side checks in [what the client already does](#what-the-client-already-does)
reject malformed and misrouted entries. They do not stop a well-formed entry
that a writer publishes under the correct address.

## The three requests

Every path resolves beneath the configured endpoint, and a trailing slash on
the endpoint is ignored.

| Request                  | Conforming answer                                               | Client reads it as                        |
| ------------------------ | --------------------------------------------------------------- | ----------------------------------------- |
| `GET /ac/{keyDigest}`    | `200` with the entry JSON, or `404` for a miss                  | The entry, or `Option.none()`             |
| `PUT /ac/{keyDigest}`    | `201` created, any other 2xx for no disagreement, `409` for one | `Inserted`, `ExistingSame`, or `Conflict` |
| `DELETE /ac/{keyDigest}` | Any 2xx once the entry is gone, `404` when nothing matched      | `true` or `false`                         |

`404` is the only status that means "miss" or "nothing matched". Every other
non-2xx fails the operation with `persistence_failed` naming the status, which
is the only classification a dumb-HTTP cache can support: there is no richer
error envelope on the wire.

Do not answer `409` from a `DELETE`, and do not answer `404` from a `PUT`. Each
would be read as a transport failure rather than as the outcome you meant.

## Decide 201 from 409 in two stages

This is the rule that makes first-writer-wins decidable over dumb HTTP. Your
tier holds the same two things the SQL tier holds: an immutable record per
`(keyDigest, recordedRunId, recordedEventSeq)`, and a mutable head per
`keyDigest`.

1. **The provenance stage.** If you already recorded that exact triple, its
   complete bytes decide the answer. Identical `result`, `meta`, and
   `createdAtMs` mean this is a retry. Anything else is `409`. That record is
   immutable: never rewrite it.
2. **The head stage.** Otherwise arbitrate on the canonical `result` alone. A
   second run recording the same result under its own provenance carries a
   different `meta`, `createdAtMs`, and run identity without being a conflict,
   so answer a non-`201` 2xx. Answer `201` only when you created the head.

`409` therefore means one thing: your tier refuses to overwrite bytes it
already holds, under one provenance or under the head. Answering it anywhere
else reports a divergence that has not happened, and the composition counts
every one of them as an operator alarm.

Compare canonical text, not parsed objects. The client encodes the body as
RFC 8785 canonical JSON, so two structurally equal results built in different
key orders arrive as identical bytes on every host.

## Answer the provenance query parameters

Both extensions are query parameters, `recordedRunId` and `recordedEventSeq`,
and plain Bazel HTTP defines neither.

- On `GET`, answer the entry that provenance recorded if you still hold it, and
  your head otherwise. That is exactly the SQL tier's ledger-then-head rule.
- On `DELETE`, make the delete a compare-and-swap: remove the entry only while
  it still carries that provenance, and answer `404` on a mismatch.

:::danger
A tier that ignores these parameters degrades both extensions silently. A
fenced eviction becomes an unconditional `DELETE`, and a fenced lookup becomes
a head read. The client cannot detect either, because a conforming tier answers
a fenced lookup with its head whenever it holds no row for that provenance, so
an entry recorded under different provenance is the documented fallback.
:::

## Refuse exactly what the client refuses

The boundary checks are exported, so your service can run the same ones rather
than reimplementing them. Run them after the caller is authenticated and
authorized:

```ts
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"

const admit = (keyDigest: string, body: unknown) =>
  Effect.gen(function*() {
    yield* CacheStore.validateKey(keyDigest)
    const entry = yield* CacheStore.snapshotEntry(body as CacheStore.CacheEntry)
    if (entry.keyDigest !== keyDigest) {
      return yield* Effect.fail(
        new CacheStore.CacheStoreError({
          code: "invalid_cache",
          message: "the entry does not match the path segment"
        })
      )
    }
    const result = yield* CacheStore.encodeCanonical(entry.result, "result")
    const meta = yield* CacheStore.encodeCanonical(entry.meta, "meta")
    return { entry, result, meta }
  })
```

`snapshotEntry` copies the six fields through their own descriptors and freezes
the result, without invoking a getter or a `toJSON` hook, and `encodeCanonical`
produces the text you store and compare.
Together they enforce the key grammar, the 4 MiB byte budget, the depth, node,
and member limits, and the provenance contract. The full list is
[what the cache admits](../concepts/admission.md).

Only an absent pair means an unconditional delete. Require exactly one value
for each parameter when either is present. The sequence must be nonempty ASCII
decimal digits with no leading zeros except `0`; validate its safe-integer
range after conversion. Map `invalid_cache` to HTTP `400` before deleting:

```ts
const fenceOf = (params: URLSearchParams) => {
  const runId = params.get("recordedRunId")
  const eventSeq = params.get("recordedEventSeq")
  if (runId === null && eventSeq === null) return Effect.succeed(undefined)
  if (
    runId === null || eventSeq === null ||
    params.getAll("recordedRunId").length !== 1 ||
    params.getAll("recordedEventSeq").length !== 1 ||
    eventSeq === "" || /[^0-9]/.test(eventSeq) ||
    (eventSeq.length > 1 && eventSeq.startsWith("0"))
  ) {
    return Effect.fail(
      new CacheStore.CacheStoreError({
        code: "invalid_cache",
        message: "eviction fence requires one run ID and one canonical decimal sequence"
      })
    )
  }
  return CacheStore.validateRecordedBy({ runId, eventSeq: Number(eventSeq) }, "eviction fence")
}
```

Validate the server with these `DELETE` cases:

- Neither parameter: allow an unconditional delete to an authorized writer.
- Only `recordedRunId` or only `recordedEventSeq`: `400`, with no deletion.
- An empty value for either parameter, or duplicate values for either (even
  identical values): `400`, with no deletion.
- A sequence with whitespace, a sign, leading zeros, a fraction, exponent or
  hexadecimal notation, or a value above `Number.MAX_SAFE_INTEGER`: `400`, with
  no deletion.
- A valid pair, including sequence `0`: delete only matching provenance and
  answer `404` on a mismatch.

`CacheStore.validateKey`, `validateRecordedBy`, `validateFence`, `validateAge`,
`snapshotEntry`, and `encodeCanonical` are all exported, alongside the
`KeyDigest`, `RecordedRunId`, `RecordedBy`, and `CacheEntry` schemas. Their
signatures are on the [API reference](../api.md).

## What the client already does

Knowing this saves you from defending against problems the client handles, and
from assuming defenses it does not have.

- **The key is validated before a request leaves.** It matches
  `[A-Za-z0-9_-]{1,256}`, so `.`, `..`, path separators, control characters,
  and ill-formed Unicode never reach your routing. An empty key never reaches
  the `/ac/` collection root as a `DELETE`.
- **Responses are bounded.** A `Content-Length` that is not plain decimal
  digits naming a safe integer fails the read. A declared length past
  `maxResponseBytes`, 4 MiB by default, is refused before a body byte is read,
  and a chunked body is cut off the moment it crosses.
- **Bodies are decoded strictly.** Reading the byte stream, decoding it as
  UTF-8, and parsing it as JSON fail with `persistence_failed`. A body that
  parses and is not a bounded `CacheEntry` fails with `decode_failed`.
- **A misrouted entry is caught.** An answer whose `keyDigest` is not the one
  requested fails with `decode_failed` rather than being returned. Your service
  cannot substitute content under the wrong address.
- **Age bounds are applied client side.** The client compares `createdAtMs`
  against its own clock, so you do not interpret `maxAgeMs`.
- **One deadline covers a whole operation**, its request and its response body
  together, so a tier that answers headers promptly and then stalls the body
  cannot spend the budget twice.

## Retention is yours

`RemoteCacheStore.sweepExpired` validates its argument, issues no request, and
answers `0`. A client that swept your tier would delete rows other machines are
still replaying from. Collect on your own schedule, and remember that a
provenance record is the evidence a replay reads: reclaim it with the run it
belongs to, not by age alone.

## Where to go next

- [Share results across machines](./share-results-across-machines.md): the
  client side of this contract.
- [The head and the ledger](../concepts/head-and-ledger.md): the two-stage rule
  as the SQL tier implements it.
