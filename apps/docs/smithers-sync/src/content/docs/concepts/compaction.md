---
title: "Compaction and resync"
description: "What a compacted refusal means, how the client resumes from the checkpoint the server names, and why the entries below that checkpoint are a real hole the consumer must fill."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sync/docs/concepts/compaction.md"
---

Compaction deletes a run's journal entries below a checkpoint. A cursor under
that floor names history that no longer exists, so the read cannot be served
and cannot be served later either.

`@smthrs/journal` owns the mechanism, including when a checkpoint is written
and what it may summarize; see
[Checkpoints and compaction](https://journal.smithers.sh/concepts/compaction/). This page is
about what the sync boundary does with it.

## The refusal names where to resume

The server maps the journal's compacted failure onto its own `compacted` code
and attaches a `Resync` of `{ runId, checkpointSeq, generation }`. `checkpointSeq`
is the compaction floor: the checkpoint's state subsumes every entry at or below
it, so a follower must restore a snapshot covering that sequence before
resuming. Its cursor then names the snapshot actually applied, which may be
newer. `generation` is the run's history after any rewinds; a restored cursor
that omits its own generation is bound to this one.

`compacted` is its own code rather than an `unknown` because it is the one
recoverable failure here. Folding it into `unknown` cost the checkpoint, and
with it every path back: the client retries only `transport_failed`, so the
subscription died and every resubscribe from the same cursors died identically.
A whole-workspace subscription then died over a single compacted run.

The run id comes from the call site rather than from the journal error. The
journal error carries only a sequence, and a workspace read fans out over many
runs, so without the id a follower could not tell which cursor to move.

`Resync` rides on `SyncError` as one optional field rather than as a new frame
variant or a new procedure. A follower that never meets a compacted run sees no
change at all. `Sync.Snapshot` separately fetches an explicitly public,
versioned and lineage-bound projection when the host provides one.

## Recovery requires an explicit handler

`SyncClient.subscribe` fails closed by default. An `onResync` handler must
restore the missing prefix and return `{ runId, afterSeq }` for the snapshot
actually applied. Only then does the client advance and read the suffix.
The receipt must name the requested run and cover the reported floor.

These cases stay failures on purpose:

- A `compacted` error carrying no `Resync` has no resume point to apply.
- A target outside the subscription's run scope is refused before the hook runs.
- A missing handler, failed application, or invalid receipt cannot acknowledge history.
- A checkpoint at or below what the subscription already covers cannot move the
  cursor forward, so retrying would re-read the same refusal forever. That is
  the same non-convergence rule that refuses an incomplete catch-up page which
  makes no progress.

## The hole is real

:::warning
The resync moves a cursor, not state. The entries below `checkpointSeq` are
gone from the journal. A consumer must fetch and apply a public snapshot or
restore an authorized local checkpoint before claiming to have rebuilt that prefix.
:::

`SubscribeOptions.onResync` is the seam a consumer fills the hole through. It
runs **before** the cursor moves and must return a valid restored cursor. A failure leaves the cursor
where it was and fails the subscription, so nothing is skipped behind the
consumer's back.

What a consumer does there depends on what it is holding:

- A remote follower fetches a configured public projection with `sync.snapshot`,
  validates its application schema, applies it, and returns its exact cursor.
- A trusted Node follower can also read the prefix out of band with
  `journal.latestCheckpoint(runId)` and applies `checkpoint.state`, then
  continues from the sync stream.
- A follower that cannot restore the prefix fails
  the hook, and the subscription fails with the cursor unmoved.

Durable consumers own the transaction that commits snapshot state and their
durable cursor together. This client's in-memory cursor is not a cross-store
transaction. A moving compaction floor may require another idempotent restore.
Raw journal checkpoints are unredacted execution state. `SnapshotSource` is
an explicit public-projection boundary, not a passthrough for those checkpoints.
Provider failures and defects are logged at warning level with their original
cause. The caller receives `not_found` without provider details. Interruption
remains interruption.

## Retention and rebuilding

The protocol transfers a complete snapshot value. It does not hand out a
checkpoint reference that might expire between lookup and fetch. A provider
must capture its selected public state before yielding it, then let the server
detach and validate the response. Collecting a provider cache after capture
cannot invalidate those transferred bytes. A newer compaction can still
invalidate the suffix cursor; the next read returns `compacted` and recovery
fetches and applies a newer snapshot.

Before compacting, durably checkpoint every projection whose history the host
claims is recoverable. Keep that authoritative checkpoint until a newer complete
checkpoint covers it. The journal's fenced compaction transaction retains its
floor checkpoint and allocation entry while collecting older checkpoints and
events. A disposable public-snapshot cache can then be dropped and rebuilt from
that checkpoint plus retained history. Deleting both the checkpoint and the
compacted prefix destroys authority and cannot be repaired by sync.

`ProjectionRebuild.integration.test.ts` exercises 17-, 33-, and 257-entry
histories with independent full-history expectations. It drops the consumer's
branch and workspace projection tables and the public snapshot cache, kills
each rebuilding consumer with SIGKILL inside its transaction, then reopens
SQLite and reconstructs identical state. The 17-entry case ends exactly at its
compaction floor. A second case collects snapshots during transfer and advances
the floor before suffix replay. The workspace projection is an application
example authorized with production `WorkspaceShare` middleware.

`WorkspaceShare` itself is an HMAC capability authority, not a journal
projection. Its signing keys, credential lifetime, and access grants are not
rebuildable from public history. Branch presence is likewise an ephemeral lease.
These must not be included in claims about disposable history projections.

An older client without a recovery handler receives the typed
`compacted` result with its `resync` target and unchanged progress. A missing
public provider returns `not_found`; incompatible identities or versions are
refused. Neither response authorizes skipping the missing prefix.

[Handle a compacted run](/guides/handle-a-compacted-run/) is the
task-shaped version, with the hook written out.

## Compaction is opt-in

Without a compaction policy on the journal layer, no entry is ever deleted and
no follower ever meets this code. That is the default. The code path matters
anyway, because the day a workspace enables compaction is the day the
difference between a follower that catches up and one that never can becomes
visible, and by then the follower is already deployed.

## Related pages

- [Checkpoints and compaction](https://journal.smithers.sh/concepts/compaction/) in
  `@smthrs/journal`: what a checkpoint is and how a floor advances.
- [Scopes and cursors](/concepts/scopes-and-cursors/): what the cursor being moved
  means.
- [Troubleshooting](/troubleshooting/): the `compacted` symptom and what to
  change.
