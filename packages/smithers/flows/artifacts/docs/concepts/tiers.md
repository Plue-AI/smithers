---
title: "The three tiers"
description: "One store contract with a filesystem, memory, and HTTP implementation, how CombinedArtifacts composes a local and a shared tier, and what the download policy changes about a read."
sidebar:
  order: 2
---

`ArtifactStore.Service` is four operations over one address space:

| Operation              | Meaning                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `put(bytes)`           | Store the bytes under their own digest and return that address. Idempotent.              |
| `get(digest)`          | Return the bytes at the address, verified against it.                                    |
| `has(digest)`          | Whether this tier holds an artifact at the address.                                      |
| `findMissing(digests)` | Which of these addresses this tier does not hold, as a deduplicated subset of the input. |

Every implementation in this package is that same shape, which is the whole
reason a composition can swap one for another without touching a caller.

## The implementations

| Constructor                                       | Backing                                             | Notes                                                                                         |
| ------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ArtifactStore.makeFileSystem(fs, path, options)` | A directory reached through Effect's `FileSystem`   | The durable host tier. Atomic publication, digest-verified reads, cross-process coordination. |
| `ArtifactStore.makeMemory()`                      | A private `Map`                                     | Tests and browser hosts with no durable filesystem. Copies on both boundaries.                |
| `ArtifactStore.makeNoop(overrides)`               | Nothing                                             | Every operation fails as `unavailable`, with per-method overrides. The honest absence.        |
| `RemoteArtifacts.make(options)`                   | An HTTP cache reached through Effect's `HttpClient` | The shared tier. Bounded, digest-verified downloads.                                          |
| `CombinedArtifacts.make(options)`                 | Two of the above                                    | Local first, shared second, with write-back.                                                  |

`RemoteArtifacts.Service` extends the store contract with one field,
`downloadPolicy`, so a composition can read the shared tier's own preference
instead of being told it twice. `RemoteArtifacts.downloadPolicyOf` reads that
field off any store and answers `undefined` for one that declares none, which
every local store does.

## What a combined read does

`CombinedArtifacts.get` asks the local tier first and treats its three possible
answers differently:

| Local answer         | What happens                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Bytes                | Returned. The shared tier is not contacted.                                                  |
| `ArtifactMissing`    | Falls through to the shared tier.                                                            |
| `ArtifactCorruption` | Falls through to the shared tier, and the fetched bytes are written back under every policy. |
| `ArtifactStoreError` | The read fails.                                                                              |

That last row is the one worth pausing on. A host that refused the read has not
answered the question, and quietly paying for a network round trip instead
would hide a broken local tier behind a working shared one. A miss is an
answer; a refusal is not.

The write-back is opportunistic in the same way the upload is. The bytes are
already in hand, so a full disk, a read-only mount, or a refused sync costs the
next read a round trip rather than failing this one. `writeBackTimeout` bounds
the write-back, defaulting to 60 seconds. At expiry the write-back is interrupted;
the read returns the verified remote bytes after interruption cleanup finishes.

## What a combined write does

`put` publishes to the local tier first and returns the local digest. The local
tier is the one this machine's replays resolve against, so an unreachable
shared tier must not stop an artifact from being recorded.

The upload that follows is opportunistic, and its refusal is dropped rather
than propagated. Failing here would fail whatever produced the bytes because a
cache was unreachable, which is the opposite of the line above. Two properties
keep it contained:

- **Deduplicated in flight by digest.** Two callers in one process that publish
  the same artifact join one upload instead of both pushing the same bytes.
  The entry is removed before its deferred is completed, so a later put starts
  a fresh upload rather than replaying a stale outcome, and an interrupted
  upload resolves waiters with a typed failure instead of tearing them down.
- **Bounded by `uploadTimeout`,** 60 seconds by default. A shared tier that
  stalls instead of refusing must not hold the local answer hostage.

Nothing depends on that upload. What actually guarantees a shared cache entry's
blobs are durable is the publication protocol that runs before the entry is
published: `findMissing`, then upload, then confirm. A dropped upload here
costs that protocol one re-upload, never correctness.

`has` asks local, then shared. `findMissing` asks the shared tier only about
what the local tier could not answer, which is one network round trip over the
smallest possible set, and the result stays a subset of the input because each
stage filters the previous stage's output.

## The download policy

The dial is Bazel's `--remote_download_{all,toplevel,minimal}`, and it lives on
the shared tier because the shared tier is the thing being conserved. Set it
with `RemoteArtifacts.Options.downloadPolicy`, or override it for one
composition with `CombinedArtifacts.Options.downloadPolicy`. With neither, the
policy is `all`.

| Policy     | Prefetch on replay admission | Write-back on a read                       |
| ---------- | ---------------------------- | ------------------------------------------ |
| `all`      | Every referenced blob        | Yes                                        |
| `toplevel` | Nothing                      | Yes, on the first read that needs the blob |
| `minimal`  | Nothing                      | No                                         |

Two different modules honor different halves. `CombinedArtifacts.get` honors
the write-back column. [`@smthrs/engine-store`](/api/engine-store)'s
`ArtifactSync.hydrate` honors the prefetch column.

`minimal` still writes back after local corruption. An address the local tier
already claims, one that `has` and `findMissing` both report as present, must
be one it can serve, or the publication protocol has been told a lie no later
read can correct. Replacing such an address is repair, not growth.

Choosing between them is a job, not a concept:
[Share artifacts across machines](../guides/share-artifacts-across-machines.md)
walks the composition.

## What the metrics count

`ArtifactStoreMetrics` defines two counters, `flows_artifact_puts` and
`flows_artifact_gets`. Only the filesystem and memory implementations update
them; `RemoteArtifacts` is deliberately uninstrumented, and the counters carry
no tier attribute. Read them as local artifact store traffic:

- A combined read the local tier serves counts one get.
- A combined read the shared tier serves counts no get, because no local store
  answered it.
- The write-back that materializes such a read counts a put, indistinguishable
  from a producer publishing new bytes.
- A deduplicated put still counts: the caller stored bytes and received an
  address either way.
- Missing and corrupt reads count nothing. They are error evidence, not
  throughput.

A third counter, `flows_artifact_remote_failures`, counts the shared uploads
(`operation: put`) and local write-backs (`operation: write_back`) a combined
store dropped. Neither fails the caller, so this counter and its warning are
the only evidence that the shared tier stopped filling.

No exporter ships in this package; provide one, for example
[`@smthrs/observability`](/api/observability), and the counters appear in it.

## Related

- [Content addressing](./content-addressing.md): why a read can verify rather
  than trust.
- [Coordination between processes](./coordination.md): what happens when two
  processes share one objects directory.
- [Serve the artifact protocol](../guides/serve-the-artifact-protocol.md): the
  HTTP surface a shared tier owes.
