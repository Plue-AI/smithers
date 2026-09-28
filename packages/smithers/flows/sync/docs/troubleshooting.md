---
title: "Troubleshooting"
description: "Every SyncError code @smthrs/sync raises, the symptom each one produces, and the change that fixes it, plus the silent failures that are not errors at all."
---

A sync operation fails with one of two errors. `SyncError` carries a stable
`code`, a `message`, an optional bounded `cause` string, a `resync` that is set
only on `compacted`, and a `rewind` that is set only on `lineage_changed`. `SyncGapError` reports that a server frame started
beyond the cursor the client covered, and it is terminal.

Match on the code, not on the message. Messages name run ids and byte counts
and are not a contract; codes are.

```ts
import { SyncError } from "@smthrs/sync/SyncError"

const isExpired = (failure: unknown) => SyncError.is(failure) && failure.code === "unauthorized"
```

`SyncError.is` is a structural guard, not a class check, because every value
that reaches it has crossed a boundary that rebuilds it: the RPC client's
schema-decoded error channel, or a browser `postMessage` that keeps the fields
and drops the prototype. It is also total, so a throwing getter on the value
answers `false` rather than raising.

## Error codes

| Code                 | Where it comes from                                                                                                                                                                                                      | What to do                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `unauthorized`       | No workspace principal, a refused workspace capability, a missing or foreign branch capability, or a credential that expired while a subscription was open.                                                              | Present a credential, or mint a new one and resubscribe.                                                                                |
| `invalid_request`    | A cursor set naming one run twice, a numeric option that is not a positive safe integer, an option above the ceiling the wire allows, a keyring with a duplicate or dangling `kid`, or claims that do not survive UTF-8. | Fix the request or the option. The message names the field.                                                                             |
| `compacted`          | The request's cursor for one run sits below that run's compaction floor. `resync` names the run and the checkpoint sequence.                                                                                             | Restore through an explicit `onResync` handler or retain the refusal. See [Handle a compacted run](./guides/handle-a-compacted-run.md). |
| `not_found`          | `Sync.Snapshot` ran against a server that provides no `SyncServer.SnapshotSource`, a provider that failed, or `SyncServer.makeNoop`.                                                                                     | Provide a `SnapshotSource`, or omit `onResync` so the client never asks for a snapshot.                                                 |
| `lineage_changed`    | A read or subscription named a generation the run has moved past, because the run was rewound. `rewind` names the current generation and the archive boundary.                                                           | Rebuild the projection from retained history and create a fresh client. The client never retries this refusal.                          |
| `frame_too_large`    | A single entry whose own encoded size exceeds the frame ceiling, or a page or frame whose entries sum past the ceiling the client enforces.                                                                              | Raise `maxFrameBytes` on both sides, or stop writing entries that large.                                                                |
| `protocol_violation` | A server page or frame that contradicted itself: another run's entry, a repeated or reordered sequence, an entry at or below the requested cursor, or an incomplete page with no entries.                                | Report it. No cursor moved, so nothing was skipped. A rewriting proxy is the usual cause.                                               |
| `transport_failed`   | The RPC transport failed.                                                                                                                                                                                                | The client retries this under backoff. It reaches you only if the stream ends for another reason.                                       |
| `closed`             | The server sent a `Closed` frame, the journal reported `journal_closed`, or the operation ran against `SyncClient.makeNoop`, `SyncServer.layerNoop`, or `BranchCommands.layerNoop`.                                      | Check that the composition provides real services, then resubscribe.                                                                    |
| `backpressure`       | The journal's admission queue overflowed, or a branch already holds `maxParticipants` participants.                                                                                                                      | Retry. Raise the bound only after confirming the producer is not the problem.                                                           |
| `decode_failed`      | The journal could not decode a stored payload.                                                                                                                                                                           | Inspect the run's storage. The sync boundary is reporting, not causing, this.                                                           |
| `unknown`            | A journal failure this boundary has no counterpart for, or Web Crypto refusing to import or use the signing key.                                                                                                         | Read `cause`, which carries the underlying error's name and its own enumerated code.                                                    |

The `cause` field is a bounded string and never the host object that failed.
`SyncError` is the declared error schema of every procedure in both RPC groups,
so whatever it carries reaches a follower that may hold nothing but a share
link. A journal failure crosses as its stable journal code, never as the
driver's own sentence.

## Every read fails with unauthorized

**Symptom.** A follower gets `unauthorized` on `Sync.Read` and
`Sync.Subscribe` for every non-branch run, with the message "Reading workspace
runs requires an authenticated workspace principal".

**Cause.** The request ran as the anonymous principal. Either the connection
sent no `flows-sync-workspace` header, or the serving composition never
provided `SyncAuth.layer` and nothing else established a principal.

**Fix.** On the client, provide `SyncAuth.layerClient(capability)` so every
outgoing request carries the header. On the server, provide `SyncAuth.layer`
over a `WorkspaceShare` authority. An in-process caller that owns the workspace
provides `SyncPrincipal.layerWorkspace(id)` instead and presents no credential
at all. See [Authorize a connection](./guides/authorize-a-connection.md).

There is no trusted pass-through middleware. A transport cannot be told to skip
the check; only an in-process caller providing `SyncPrincipal` bypasses it.

## A working subscription ends with unauthorized

**Symptom.** A subscription delivers entries for a while, then fails with
"The capability authorizing this subscription has expired".

**Cause.** A subscription is authorized once, when it opens, so the signed
expiry travels with the identity. When that moment arrives the stream ends,
because a stream authorized only at open is otherwise the one thing a signed
expiry cannot revoke.

**Fix.** Mint a fresh capability and resubscribe from your persisted cursors.
Treat this as routine rather than as an error path: choose a `ttlMs` longer
than the reconnect you are willing to pay for. An in-process owner that
provides `SyncPrincipal` itself has no deadline.

## A branch read is refused with a capability in hand

**Symptom.** `unauthorized` with "Reading a shared branch requires a valid
share capability", even though the request carried one.

**Cause.** One of three things: the capability is for a different branch, it
has expired, or the serving composition provides no `BranchShare` authority.
Without an authority in scope, every branch run is closed.

**Fix.** Check that the capability's branch id matches the branch behind the
run id, and that the server provides `BranchShare.layerHmac` or
`BranchShare.layerConfig`. A workspace
listing does not fail here: it silently excludes the branch runs the caller's
capability does not cover, so a run missing from a listing is the same problem
seen from the other side.

## invalid_request naming a cursor or an option

**Symptom.** "Cursors name run `X` more than once", or a message of the form
"`SyncClient.SubscribeOptions.credit` must be a positive safe integer, not
NaN".

**Cause.** A cursor set that names one run twice has no correct reading: the
read position would come from the first occurrence and the echoed response
state from the last, so a follower persisting the returned cursors would skip
entries the page never carried. A numeric option that is `NaN`, zero, or
negative satisfies the TypeScript type `number` and disables the comparison it
configures rather than tightening it, so each one is checked where it enters.

**Fix.** Deduplicate the cursor set, or pass a positive safe integer.
`boundedInt` also refuses a value above the wire's ceiling, so
`credit` above `SyncProtocol.maxSubscribeCredit` and `bootstrapLimit` above
`SyncProtocol.maxReadLimit` are refused before a request is built rather than
retried as a transport failure.

## invalid_request from the keyring

**Symptom.** `WorkspaceShare.makeHmac` or `BranchShare.makeHmac` fails with
"The workspace keyring names kid `K` twice", "The branch keyring's active kid
names no key in the ring", or "The HMAC signing secret must be at least 32 bytes
of UTF-8".

**Cause.** The keyring is malformed. A duplicate `kid` makes verification
ambiguous, an `activeKid` with no matching key leaves nothing to mint with, and
a short secret can be searched offline from one observed capability.

**Fix.** Correct the keyring before the layer is built. Generate each secret
with `openssl rand -base64 32`. Rotation adds the new
key to `keys` and points `activeKid` at it, keeping the retired key in the ring
so capabilities minted under it still verify.

## SyncGapError

**Symptom.** The stream fails with `SyncGapError`, naming a run, the sequence
the client expected to start from, and the sequence the server's frame started
at.

**Cause.** The server's declared covered interval began beyond the cursor the
client had. History between the two was never delivered.

**Fix.** Rebuild, do not retry. Resubscribing from the same cursors reproduces
it. This is not the same as a hole in the sequence: a journal sequence is
legitimately non-contiguous because dropped admissions leave gaps, and the
client compares `fromSeq` against the cursor for exactly that reason. A gap
error means the interval itself skipped forward, which a correct server does
not do.

## A compacted failure that is not recovered

**Symptom.** `compacted` reaches your consumer instead of being absorbed.

**Cause.** No recovery handler was supplied, application failed, the error
carries no `resync`, or the checkpoint it names is
at or below what the subscription already covers. A resync to a position the
client has passed cannot move it forward, so retrying would re-read the same
refusal forever.

**Fix.** Supply `onResync` only when you can restore the missing state. Return
the exact `{ runId, afterSeq }` actually applied, covering the reported floor.
If you supplied a handler, check whether it failed: it runs before the cursor moves and
must return a valid receipt, so a failure deliberately leaves the cursor where it was rather
than skipping the range silently. See
[Handle a compacted run](./guides/handle-a-compacted-run.md).

## A workspace subscription delivers nothing

**Symptom.** `{ _tag: "Workspace" }` produces an empty stream that never fails.

**Cause.** The run catalog lists no runs. `RunCatalog.layerNoop` is
`layerStatic([])`, and `RunCatalog.makeMemory` starts empty, so a composition
that never registers a run has nothing to cover.

**Fix.** Provide a catalog that sees the runs. `RunCatalog.layerPolling` over
`RunCatalogRead` from [`@smthrs/engine-store`](/api/engine-store) is the
durable form, and it is what lets a follower learn of runs another engine
created. See [List a workspace's runs](./guides/list-workspace-runs.md).

A subscription with no covered runs is also what a credential that covers
nothing looks like, so confirm the principal before changing the catalog.

## A subscription skips history you asked for

**Symptom.** You pass an older cursor, and the subscription starts later than
that cursor.

**Cause.** The effective start position is the later of your cursor and the
matching shared progress map: applied for a subscription with `apply`, delivered
otherwise. One client belongs to one materialization. A delivered bookmark is
not proof that a projection applied the corresponding history.

**Fix.** Build a fresh client. Its progress maps are empty, so your cursor is
the only one there is. Rebuilding a projection from an earlier position is a
different job from following, and it gets its own client.

## Every operation fails with closed

**Symptom.** Every subscription fails immediately with "Sync client is closed",
"Branch commands are unavailable", or "Branch presence is unavailable".

**Cause.** The composition provided a noop stub. `SyncClient.layerNoop`,
`SyncServer.layerNoop`, `BranchCommands.layerNoop`, and
`TestSync.layerNoop` exist so a consumer that only needs the ports to resolve
can compile, and every operation on them refuses.

**Fix.** Provide the real layers. In a test, `TestSync.layerTest` is the
fixture that binds a real server over a real journal. See
[Test a follower](./guides/test-a-follower.md).

## An import fails to resolve

**Symptom.** A bundler or Node reports that `@smthrs/sync/internal/thing` has
no export, or a browser build fails on `@smthrs/sync/test/TestSync`.

**Cause.** `./internal/*` is mapped to `null` in the package's exports, so
nothing under it resolves. `@smthrs/sync/test/TestSync` binds the Node SQLite
test journal and is Node only.

**Fix.** Import from the root or from a public module path. In a browser test,
`@smthrs/sync/test/TestSocket` is the half that runs anywhere.

## Branch procedures have no server

**Symptom.** A branch client finds no endpoint to talk to.

**Cause.** Nothing outside this package's tests mounts `BranchRpcs`.
[`@smthrs/gateway`](/api/gateway) mounts `SyncRpcs` on `POST /sync` and
`/sync/ws` and stops there.

**Fix.** Mount `BranchServer.layerHandlers` on a transport of your own, and
treat the branch modules as a library surface pending a host. See
[Branch collaboration](./concepts/branches.md).
