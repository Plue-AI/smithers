---
title: "Troubleshooting"
description: "Every failure @smthrs/artifacts reports, plus the silent problems that produce no failure at all: what happened, why, and what to change."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/artifacts/docs/troubleshooting.md"
---

Every failure here is typed. Read the tag first, then the `code` inside
`ArtifactStoreError`, then the message. The full schemas are on the
[API reference](/reference/api/).

Three tags exist, and they mean different things on purpose:

| Tag                                    | Meaning                                                           |
| -------------------------------------- | ----------------------------------------------------------------- |
| `@smthrs/artifacts/ArtifactMissing`    | An ordinary miss. Another tier may still satisfy it.              |
| `@smthrs/artifacts/ArtifactCorruption` | An integrity violation. Bytes at an address no longer hash to it. |
| `@smthrs/artifacts/ArtifactStoreError` | The store, host, or transport refused. Carries a `code`.          |

## ArtifactMissing

**What happened.** The address is well formed, and this tier holds no bytes
under it. The error carries the validated `digest`.

**What to change.** Usually nothing: a read-through composition acts on this
rather than failing. If a blob you expect really is gone, check in this order:

- The objects directory. A store pointed at a different `directory` than the
  one that published is the most common cause, and it looks exactly like a
  cold cache.
- A sweep. `ArtifactSweep.remove` reclaimed it, which means the mark phase did
  not consider it live.
- The layout. Addresses published under the pre-1.0 flat
  `<directory>/<digest>` layout are misses that re-publish. There is no
  compatibility shim.
- The shared tier. A combined `put` uploads opportunistically, so a blob local
  to the producing machine may never have reached the cache. See
  [The three tiers](/concepts/tiers/).

## ArtifactCorruption

**What happened.** The bytes found at an address do not hash to it. The error
carries both `recordedDigest` and `measuredDigest`.

**What to change.** Publish the correct bytes again. Because every put verifies
the existing blob rather than trusting the path, the mismatch falls through to
an atomic rewrite that heals the address. A combined store does this for you:
it fetches from the shared tier and writes back under every download policy,
including `minimal`.

If it recurs on one host, suspect the disk or another process writing into the
objects directory. If it recurs from one shared tier, suspect the tier: a
mis-serving cache is exactly what this check exists to catch.

## invalid_digest

**Message.** `artifact digest must be exactly 64 lowercase hexadecimal characters`

**What happened.** A value that is not a canonical SHA-256 address reached a
store or sweep operation. The message is a constant, so it never echoes the
value.

**What to change.** Look at what produced the string. Uppercase hexadecimal, a
truncated digest, a filesystem path, and a `key1_`-prefixed step key are all
common. A step key is not an artifact address: keys come from
[`@smthrs/keys`](https://keys.smithers.sh/reference/api/) and address cache entries, while artifact addresses
come from `put`.

## invalid_configuration

**What happened.** An option was refused at construction, before any request
left the process. Every message names the violated rule and nothing else.

| Message                                                                         | Cause                                                                                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `invalid remote artifact option: endpoint`                                      | The endpoint is not a string.                                                                                      |
| `invalid remote artifact endpoint`                                              | No `URL` parser accepts it.                                                                                        |
| `remote artifact endpoint must use HTTPS`                                       | The scheme is not `https:`, and the host is not literal loopback (`localhost`, `127.0.0.1`, `[::1]`).              |
| `remote artifact endpoint must not contain credentials, a query, or a fragment` | The endpoint carries userinfo, `?`, or `#`.                                                                        |
| `invalid remote artifact option: options`                                       | A header name is not an HTTP token, or a header value is not a string, exceeds 16 KiB, or has a control character. |
| `invalid remote artifact option: <name>`                                        | A deadline, `maxDownloadBytes`, `maxFindMissingResponseBytes`, `chunkBytes`, or `downloadPolicy` is out of range.  |
| `invalid combined artifact option: uploadTimeout`                               | The combined upload deadline is not a positive finite duration.                                                    |
| `invalid combined artifact option: downloadPolicy`                              | The policy is not `all`, `toplevel`, or `minimal`.                                                                 |

**What to change.** Move a credential out of the URL and into
`RemoteArtifacts.Options.headers`, which is the credential seam. Note that
`maxFindMissingResponseBytes` may only lower the protocol's 256 KiB bound, so a
larger value is refused.

## unavailable

**What happened.** A host refused, or the store has no implementation.

| Message                                                  | Cause                                                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `the host filesystem refused an artifact operation: ...` | The `FileSystem` service refused a read, write, rename, sync, or lock.                                      |
| `the host filesystem refused a sweep operation: ...`     | The same, from `ArtifactSweep`.                                                                             |
| `the host could not copy the artifact bytes`             | The snapshot of the caller's buffer failed: a detached buffer, or an allocation the runtime would not give. |
| `<method> is unavailable`                                | A `makeNoop` store or sweep, with no override for that method.                                              |

**What to change.** The cause carries the underlying host error. Two cases have
non-obvious fixes:

- A `TimeoutError` in the cause of a filesystem operation means lock
  acquisition gave up after two minutes. Another process is holding the digest
  lock, or the workspace-global backup-lease gate, and is still heartbeating.
  Find it, or drop the store to `coordination: "process"` if cross-process
  exclusion is not something this host needs.
- A sync refusal can use `durability: "best-effort"` when weaker durability is
  acceptable. Both modes still require exclusive writable handles and symlink
  inspection. If the host lacks either, use a memory or remote tier until the
  host supplies them. A detected symlink or directory replacement also fails
  as `unavailable`; audit the store before retrying.

`the shared upload was interrupted before it settled` is a special case: it is
the typed answer given to callers waiting on an in-flight combined upload that
was interrupted. A combined `put` already drops it, and the next put of that
digest starts a fresh upload.

## digest_failed

**Message.** `the Crypto service failed to compute an artifact digest`

**What happened.** The injected `Crypto` service refused. Nothing about the
bytes or the store is implicated.

**What to change.** Check the `Crypto` layer the composition provides.
`NodeCrypto.layer` from `@effect/platform-node` is the Node implementation. A
composition with no `Crypto` at all does not compile, so this is a runtime
refusal, not a missing layer.

## transport_failed

**What happened.** The shared tier answered in a way the protocol cannot use.

| Message                                                                                 | Cause                                                                                                         |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `the remote artifact tier refused <operation>`                                          | The HTTP client could not complete the exchange, or the body could not be read.                               |
| `the remote artifact tier answered <operation> with HTTP <status>`                      | Any non-2xx other than the `404` that means a miss.                                                           |
| `the remote artifact tier answered <operation> with <n> bytes, past the <m>-byte bound` | A body past `maxDownloadBytes` or `maxFindMissingResponseBytes`, refused from `Content-Length` or mid-stream. |
| `the remote artifact tier did not finish <operation> within its configured deadline`    | The exchange outlived `downloadTimeout`, `uploadTimeout`, or `requestTimeout`.                                |

**What to change.** Match the operation to the request in
[Serve the artifact protocol](/guides/serve-the-artifact-protocol/). A
`403` on a `PUT` while `GET` works means a read credential where a write one is
needed. A `413` means the tier's request-body cap: the Smithers cache
services cap one body at 16 MiB, and no `chunkBytes` setting works around that,
because they refuse ranged `PUT` with `400`.

Raise a deadline only after checking that the tier is actually slow rather than
unreachable. `CombinedArtifacts.get` propagates a remote `ArtifactStoreError`,
including download timeouts. `CombinedArtifacts.put` ignores failed opportunistic
uploads. `ArtifactSync.hydrate` separately converts remote failure into replay
rejection.

## An upload succeeded here but a second machine cannot read it

**What happened.** A combined `put` returns the local digest and uploads
opportunistically. If the shared tier refused or stalled, the upload was
dropped and the operation still succeeded, by design: a cache being unreachable
must not fail the step that produced the bytes.

**What to change.** Nothing, if you are relying on the publication protocol.
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)'s `ArtifactSync` runs `findMissing`,
uploads, and confirms before a cache entry becomes observable, so a dropped
upload costs one re-upload rather than correctness. If you are calling `put`
directly and need the shared copy, probe the shared tier with `has` or
`findMissing` afterwards.

## The sweep enumerates nothing, or deletes nothing

**What happened.** `inventory` returned an empty array, or `remove` keeps
answering `false`.

**What to change.**

- **Empty inventory.** The sweep is pointed at a directory the store never
  published into. A directory that does not exist is an empty inventory, not a
  failure. Build the store and the sweep with the same `directory`.
- **`remove` answers `false`.** Three outcomes share that answer: the blob was
  already gone, it failed the `ifUnmodifiedSinceMs` fence, or a live backup
  lease fenced the deletion. The third is not progress, so do not count those
  bytes as reclaimed; the next pass after the backup finishes removes them. See
  [Reclaim disk space](/guides/reclaim-disk-space/).
- **Foreign files survive.** Only paths in the canonical `xx/<digest>` fanout
  shape are blobs. Temp files, lock files, nested paths, and anything else are
  skipped rather than deleted, and so is a blob whose modification time the
  host cannot report.

## A sweep deleted a blob a writer was publishing

**What happened.** The store and the sweep disagree about `coordination`. A
sweep on `required` beside a store on `process` takes lock files no writer ever
observes: the fence reads as armed and protects nothing.

**What to change.** Build both with the same `coordination` and the same
`directory`. Nothing checks the pairing at runtime, and no error is raised.
See [Coordination between processes](/concepts/coordination/).

## The get counter looks too low

**What happened.** `flows_artifact_gets` and `flows_artifact_puts` count local
artifact store traffic only. `RemoteArtifacts` is uninstrumented, so a combined
read the shared tier served increments no get counter, and the write-back that
materializes it increments a put indistinguishable from a producer publishing
new bytes.

**What to change.** Read the counters as local traffic rather than as artifact
operations. There is no tier attribute; adding one would change the published
counter shape. The full accounting is in
[The three tiers](/concepts/tiers/#what-the-metrics-count).

## Chunked uploads are not chunking

**What happened.** `chunkBytes` is set, and every blob still travels as one
whole-blob `PUT`.

**What to change.** Probably nothing: that is the designed degradation. A tier
that answers the empty `Content-Range: bytes */{total}` probe with `400`,
`411`, or `416`, or that answers `2xx` to a chunk that does not complete the
blob, is treated as range-unaware, and the client sends the blob whole so it
always lands. Both Smithers cache services answer `400`.

If you control the tier and want resumable transfers, implement the `308`
sequence in
[Serve the artifact protocol](/guides/serve-the-artifact-protocol/).

## Related

- [API reference](/reference/api/): the exact error schemas and codes.
- [Content addressing](/concepts/content-addressing/): why corruption is a
  refusal rather than a returned value.
- [Coordination between processes](/concepts/coordination/): the lock
  bounds behind the timeout failures.
