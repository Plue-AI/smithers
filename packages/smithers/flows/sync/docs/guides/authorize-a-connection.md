---
title: "Authorize a connection"
description: "Provision a workspace share authority, mint a capability, present it from a client, rotate signing keys without invalidating outstanding links, and reach a shared branch instead."
sidebar:
  order: 3
---

A sync connection reads a workspace's non-branch runs only when it presents a
verified `WorkspaceShare` capability. This guide provisions the authority,
mints a capability, and gets it onto the wire.

## Provision the authority from configuration

`WorkspaceShare.layerConfig` reads one secret and one key name from the
environment:

```ts
import * as WorkspaceShare from "@smthrs/sync/WorkspaceShare"

const shareLayer = WorkspaceShare.layerConfig
```

| Variable               | Meaning                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `SMITHERS_SYNC_SECRET` | The HMAC signing secret, read as `Redacted` so it is never logged. Required; at least 32 bytes of UTF-8. |
| `SMITHERS_SYNC_KEY_ID` | The key name recorded in every capability's claims. Defaults to `primary`.                               |

There is deliberately no default secret. A deployment that configures neither
name fails to construct the authority, and the read path stays closed.

## Mint a capability

`mint` takes the id you will audit by, the access level, and a lifetime in
milliseconds:

```ts
import * as Effect from "effect/Effect"

const mint = Effect.gen(function*() {
  const share = yield* WorkspaceShare.WorkspaceShare
  return yield* share.mint({
    capabilityId: "dashboard-session-7",
    access: "read",
    ttlMs: 60 * 60 * 1000
  })
})
```

The result carries its claims and their signature. `capabilityId` is what
identifies the credential in a span or an audit trail; it is not a secret and
it is not the signature.

`verify` is the other half, and it is the single place a refusal happens. It
checks the signature in constant time, then that the key name is known, then
the expiry, then that the access asked for is covered. Every refusal is
`unauthorized` with a distinct message.

## Present it from a client

`SyncAuth.layerClient` stamps every outgoing request from a generated RPC
client with the capability:

```ts
import * as SyncAuth from "@smthrs/sync/SyncAuth"
import * as SyncClient from "@smthrs/sync/SyncClient"
import * as Layer from "effect/Layer"

const authorized = (capability: WorkspaceShare.WorkspaceCapability) =>
  SyncClient.layer.pipe(Layer.provide(SyncAuth.layerClient(capability)))
```

A client written against the wire rather than against `SyncClient` sets the
header itself. The name is `SyncAuth.capabilityHeader`, which is
`flows-sync-workspace`, and the value is the unpadded base64url of the
schema-encoded capability JSON:

```ts
const header = Effect.gen(function*() {
  const share = yield* WorkspaceShare.WorkspaceShare
  const capability = yield* share.mint({ capabilityId: "cli", access: "read", ttlMs: 60_000 })
  return yield* SyncAuth.encodeCapability(capability)
})
```

`SyncAuth.decodeCapability` is the inverse. Every malformation folds to the
same `unauthorized` refusal, so the header cannot be used as a parsing oracle.

## Rotate a signing key

A capability's claims carry the `kid` of the key that signed them, and the
`kid` is itself signed. Build the authority over a keyring to add a new active
key while capabilities minted under the retired one are still outstanding:

```ts
import * as Config from "effect/Config"
import * as Layer from "effect/Layer"

const rotated = Layer.unwrap(
  Effect.gen(function*() {
    const keyring: WorkspaceShare.Keyring = {
      activeKid: "2026-q1",
      keys: [
        { kid: "2026-q1", secret: yield* Config.Redacted("SYNC_SECRET_CURRENT") },
        { kid: "2025-q4", secret: yield* Config.Redacted("SYNC_SECRET_RETIRED") }
      ]
    }
    return WorkspaceShare.layerHmac(keyring)
  })
)
```

`Config.Redacted` reads each secret without ever rendering it. An unset
variable fails the layer with a `ConfigError` naming it, so the read path
stays closed.

New capabilities are signed with `activeKid`. Capabilities naming any key in
`keys` still verify. Drop the retired key once its longest outstanding
lifetime has passed.

Every key is imported when the authority is constructed, so a misconfigured
keyring fails there rather than at the first request. A malformed keyring
fails with `invalid_request`:

- an `activeKid` that names no key in the ring;
- a `kid` listed twice;
- a secret holding an unpaired surrogate, which UTF-8 would fold into the
  same key bytes as a different secret;
- a secret shorter than 32 bytes of UTF-8. Every capability carries its
  claims and signature in the clear, so one observed capability lets an
  attacker search a short secret offline and then forge capabilities.
  Generate one with `openssl rand -base64 32`.

A secret Web Crypto refuses to import fails with `unknown` instead, because
the refusal is the platform's rather than the request's. The error's `cause`
carries the rejection text.

## Close the door entirely

`WorkspaceShare.layerNoop` mints nothing and verifies nothing. Both operations
**fail** with `unauthorized` rather than dying, so a consumer handling
`SyncError` gets a refusal where the type promised one. Wire it when a
deployment deliberately offers no workspace sharing, such as a local CLI whose
only reader is in process.

## Reach a shared branch instead

A branch capability is a different credential with a different authority. It
travels in the request payload rather than in a header, because it names one
branch rather than one connection:

```ts
import type { JournalEvent } from "@smthrs/journal"
import type * as BranchProtocol from "@smthrs/sync/BranchProtocol"

const followBranch = (capability: BranchProtocol.ShareCapability, runId: JournalEvent.RunId) =>
  Effect.gen(function*() {
    const sync = yield* SyncClient.SyncClient
    return sync.subscribe({ scope: { _tag: "Run", runId }, cursors: [], capability })
  })
```

Mint one through `BranchShare`, whose `mint` takes a `branchId` alongside the
same `capabilityId`, `access`, and `ttlMs`. A connection holding only a branch
link still reads no engine run: that is the other boundary, and the link does
not answer it.

## Related pages

- [Authorization](../concepts/authorization.md): why there are two boundaries
  and what a signed expiry does to an open subscription.
- [Serve the read path](./serve-the-read-path.md): where the middleware is
  installed.
- [Troubleshooting](../troubleshooting.md): each `unauthorized` symptom and its
  cause.
