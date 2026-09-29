---
title: "Troubleshooting"
description: "The typed failures @smthrs/engine-store reports, what causes each one, and what to change: admission, boundaries, workspaces, caches, artifacts, retention, and recovery."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine-store/docs/troubleshooting.md"
---

Every failure this package reports is typed, and every `code` literal exported
through `Errors` is part of the public API: switch on `code` or on `_tag`, and
the strings will not change without a major version. Find the tag below and
read the matching section. The full schemas are in the
[API reference](/reference/api/).

## AttemptAdmissionRejected

**What happened.** The attempt was not admitted, so its body never ran. The
`outcome` field names which check refused it: a superseded fence, a live
same-key attempt, or an already-settled row.

**What to change.** Usually nothing. Because the body did not execute, this
failure is always safe to surface without compensation, and it marks only
genuinely mid-flight rows: a persisted `failed` row rethrows its domain failure
rather than being re-admitted. If you see it under a single engine with no
concurrency, look for two fibers reaching the same step key at once. See
[Attempts and replay](/concepts/attempts-and-replay/).

## AttemptSuspended

**What happened.** The attempt stopped without settling. It is durably parked,
not failed.

**What to change.** Nothing at the call site. The distinction matters to the
driver: a suspended attempt keeps its row and its attempt number, so resuming
continues the same attempt rather than burning a new one against the retry
budget. If the run never resumes, check that the process registers the flow;
a wake for an unregistered flow logs a once-per-run warning and leaves the row
parked for a process that does register it.

## AttemptEvidenceQuarantined

**What happened.** A succeeded attempt row's recorded boundary evidence no
longer hashes to its recorded digest, under the strict `Inconsistency` verdict.
The failure carries `keyDigest`, `attempt`, `path`, `recordedDigest`, and
`measuredDigest`. The driver handles this failure by parking the run in the `quarantine` waiting
state. Execution callers keep waiting under their `suspendedRetryPolicy` and
report `SuspendedResumeGaveUp` if that budget expires; polling and fresh
execution calls cannot authorize recovery.

**What to change.** Investigate the disk. A succeeded attempt row records that
this run's side effects already ran, so the evidence cannot simply be evicted
and re-executed without breaking exactly-once for an irreversible action. The
next explicit resume returns the durable outcome without re-materializing the
poisoned evidence and without re-executing.

## CacheCorruptionDetected

**What happened.** A shared cache row's bytes no longer hash to their recorded
digest. Unlike a succeeded attempt row, a cache row is evictable.

**What to change.** Nothing for correctness: the entry is dropped and the next
dispatch re-executes and re-captures cleanly. It is reported rather than
swallowed so a failing disk stays visible, so treat repeated occurrences as a
hardware signal.

## CacheConflictDetected

**What happened.** Two different runs recorded results under the same step key.
The key is a digest of the declaration, so a conflict means the declaration does
not fully describe what the step depends on: same key, different answer.
`recordedRunId` names the run that got there first.

**What to change.** Find the undeclared input. It is usually a file outside the
declared read set, an environment variable, a clock, or a network call. Widen
the declaration, or make the step honest about its nondeterminism by declaring
it. `Inconsistency.layerTolerant(owner)` preserves the first-recorded row and
continues, if you need to keep running while you investigate.

## UndeclaredWrite

**What happened.** A hard-mode step wrote outside its declared write set. The
error carries the `paths` and the `diffIdentity`. Hard mode treats the
declaration as a contract, so the step's evidence is never journaled and never
becomes a cache entry.

**What to change.** Add the paths to `writeSet`, or switch the declaration to
`boundaryMode: "expected"`, where the same observation is recorded as a
deviation and routed to `Reconciliation`.

## MissingDeclaredOutput

**What happened.** A step finished without producing a path its `writeSet`
declared, and did not declare that path in `removes`.

**What to change.** Either produce the file or declare the deletion. The absence
itself is the defect: recording it as valid evidence caches the claim "this file
should not exist", which `replayOutputs` then acts on by deleting the path on a
workspace that never ran the step. Declaring the path in `removes` is the only
thing that makes an absence legitimate.

## SurvivingDeclaredRemoval

**What happened.** A hard-mode step left a declared removal in place. `removes`
promises a path is absent afterwards, and a path that survived, possibly
rewritten, is a post-state the declaration disclaimed.

**What to change.** Remove the file, or drop it from `removes`. Settling it as
evidence would cache the surviving bytes under a removal and hand them to every
replay.

## UnsupportedBoundary

**What happened.** The host could not honour the boundary at all: a filesystem
that cannot be measured, a path that cannot be read, or a transient I/O failure.
It is the catch-all host refusal, and it carries the original failure whole in
`cause`.

**What to change.** Read `cause`. If you see it from `StepSandbox.open`, the
composition provided `StepSandbox.layerNoop`, which fails closed on purpose for
a host that cannot sandbox, such as a browser.

If the message reads `cache replay needs a confined host filesystem`, the
boundary's `FileSystem` carries neither `@smthrs/platform-node`'s
`AtomicFileSystem` executor nor an isolation attestation, so cache replay
refuses and the step re-executes. Provide `AtomicFileSystem.layer` instead of
a bare `NodeFileSystem.layer`. A replay refused with a `PlatformError` cause
naming a symlink loop means a replayed path runs through a symlink; replay
never follows one, so remove the link or accept the re-execution.

## BoundaryCorruption

**What happened.** Recorded boundary evidence's bytes no longer match their
recorded digest. This is an integrity violation of the store's strongest
invariant, deliberately distinct from a transient host failure so that a failing
disk corrupting many blobs does not journal identically to a one-off EIO.

**What to change.** Investigate the disk, and consider restoring from a verified
backup. See [Back up and restore the store](/guides/back-up-and-restore/).

## MissingArtifact

**What happened.** Recorded evidence references an artifact this host's store
does not hold. It carries the `path` and the `digest`.

**What to change.** Usually nothing: this is the normal first answer for a row
recorded on a machine whose artifacts this one has never seen. The dispatch
hydrates from the shared tier and retries the replay exactly once before falling
through to a real execution. If you see it under a purely local composition and
the step then re-executes every time, either the artifact store was cleared or
`ArtifactGc` collected a blob a live root still referenced; check the grace
bound.

## MaterializationConflict

**What happened.** Copy-back would overwrite host state that changed since the
transaction's base snapshot was taken. Every `FileChange.beforeDigest` is
compared against the live host before a byte lands, so the whole bundle is
refused rather than half applied.

**What to change.** Usually nothing: the engine retries the attempt from a fresh
base a bounded number of times. If it persists, two lanes are writing the same
paths concurrently; narrow the declarations, or use the plan scheduler's
`delay-rebase` or `stop-merge` strategy. Use
`WorkspaceSandbox.isMaterializationConflict(error)` to classify one, because a
persisted failure retains the schema tag but not the class prototype.

## WorkspaceError

**What happened.** A body could not execute inside an isolated workspace, or its
result could not be moved through one. The `code` says which:

| Code                     | Meaning                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `invalid_path`           | A path was absolute, outside the workspace, or contained `..`.                                          |
| `not_found`              | A path the transaction needed was absent.                                                               |
| `host_unavailable`       | The host filesystem or artifact store refused, or the host cannot make descriptor-relative requests.    |
| `path_escapes_workspace` | A change's path crosses a symlink or a hard-linked file, or the workspace root was replaced mid-commit. |
| `commit_lock_timeout`    | Another writer held `.smithers-workspace-lock` for the whole 2-minute acquisition deadline.             |

**What to change.** For `path_escapes_workspace`, replace the symlink with the
real file or directory, or have the body write the referent path: copy-back
never follows a link, even one that stays inside the root. For
`host_unavailable`, read `cause`, which carries the refusing failure whole. A
cause saying the host "does not provide descriptor-relative, no-follow
filesystem isolation" means the sandbox was composed over a path-based
filesystem such as `NodeFileSystem.layer`; compose it over
`@smthrs/platform-node`'s `AtomicFileSystem.layer` instead.

For `commit_lock_timeout`, another commit on the same root is still running
and heartbeating its lock. Retry once it finishes; do not delete the lock by
hand. A lock whose owner was killed, and a lock directory left by an rc.1
build, is reclaimed on its own once its mtime is 60 seconds old.

## UndeclaredRead

**What happened.** A hermetic body attempted to read a path outside its declared
read set. It carries the `paths` and the `diffIdentity`.

**What to change.** Add the paths to `readSet`. The filesystem sandbox seeds the
transaction with exactly the declared read set, so an undeclared file is not
there at all.

## ArtifactPublicationFailed

**What happened.** A referenced artifact could not be made durable in the shared
tier, so the cache entry that references it was not published. It carries the
`digests` and the refusing `cause`.

**What to change.** Fix the shared tier. Failing here is the point: publishing
the entry anyway is exactly the state the REAPI ordering constraint exists to
prevent. The local row is unaffected, and the refusal is journaled as
`cache-provenance` with `action: "unpublished"`.

## RunParentCycleError and FlowCycleDetected

**What happened.** Recording a parent edge would close a cycle in the run DAG.
`path` lists execution ids from the child back to itself. The transaction that
inserted the edge is rolled back, so a rejected edge leaves no durable trace.
The driver maps this to `FlowCycleDetected`.

**What to change.** Break the spawn cycle in the flow. Of two concurrent writers
whose edges jointly close a cycle, exactly one fails, so seeing it under
concurrency does not mean both spawns were wrong.

## IrreversibleRetryRequiresIdempotencyKey

**What happened.** An irreversible action was retried without an idempotency
key. Retrying an effect that already reached the world needs a key that lets
the world deduplicate it.

**What to change.** Declare `idempotencyKey` on the action.

## SchedulerError

**What happened.** The plan scheduler itself refused. A node's own failure is
not one of these: the run continues and the report says `failed`.

| Code                   | Meaning                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| `invalid_plan`         | Plan content, graph annotations, or approval digests failed verification. |
| `boundary_unavailable` | The boundary could not be measured for a dispatch.                        |
| `key_uncomputable`     | The dispatch key could not be derived.                                    |
| `elaboration_failed`   | Appending an elaborated subgraph refused.                                 |
| `store_failed`         | The plan store or journal refused.                                        |

**What to change.** For `boundary_unavailable`, check the `StepBoundary` layer
and the host filesystem. For `store_failed`, check that the plan store's
migrations ran: the plan set is last in `Migrations.sets`, so a composition that
installed only part of the ladder is missing exactly that table.

## RetentionError

**What happened.** A retention pass could not complete.

- `scan_failed`: the candidate set could not be computed. Nothing was deleted.
- `delete_failed`: the candidate set held but a delete refused. The transaction
  rolled back, so nothing was deleted then either.

**What to change.** Re-run once the cause is fixed. Retention is idempotent and
converges. Run with `dryRun: true` first to see the candidate set.

## RunCatalogError

**What happened.** The workspace's run set could not be read.

- `invalid_options`: the limit was not a non-negative safe integer.
- `list_failed`: the read refused.

**What to change.** For `list_failed`, the caller keeps whatever view it had and
the next read converges, so no state is lost. Check the database connection.

## SelectionStoreError

**What happened.** The suspected-edge store refused.

- `invalid_input`: an edge or observation did not decode.
- `decode_failed`: a stored row is corrupt.
- `persistence_failed`: the write refused.

**What to change.** For `decode_failed`, delete and re-record the affected
edges: beliefs are advisory, so losing one costs a guess and nothing else.

## ArtifactGcError

**What happened.** A collection could not complete.

- `invalid_options`: an option was outside its admissible range.
- `mark_failed`: a root could not be scanned, or its boundary evidence could not
  be decoded by this build. Nothing was deleted.
- `sweep_failed`: the inventory or a deletion refused.

**What to change.** `mark_failed` on undecodable evidence is deliberate: reading
such a row as "references no artifacts" is how a live blob gets collected.
Upgrade to a build that understands the evidence rather than forcing the sweep.

## DisasterRecoveryError

**What happened.** A backup, verification, restore, or fence refused. The error
carries the `method` and one of ten codes; the table is in
[Back up and restore the store](/guides/back-up-and-restore/).

**What to change.** Two are worth calling out. `snapshot_incomplete` means the
snapshot references artifact digests the capture could not take, which almost
always means `objectsDirectory` was omitted for a composition that has a
filesystem artifact tier. `schema_mismatch` means the restored file's applied
migrations omit or rename a historical entry recorded in the manifest. Forward
additions within installed lower blocks are compatible; check historical IDs
and names before fencing again.

## The composition does not compile

**What happened.** A required service is missing. A composition failure is an
unmet `Requirements` type, by design, so there is no run-time composition error
to handle.

**What to change.** Read the unmet requirement in the type error and provide it.
The full list is in
[Compose a durable engine](/guides/compose-a-durable-engine/).

## A cache hit never happens

**What happened.** Steps re-execute even though the key is stable.

**What to change.** Work down the admission list. A record is admitted only when
the action is `sealed`, the boundary is `hard`, no deviation occurred, and the
evidence carries `wholeTreeWritesVerified: true`. Under the production
composition that last flag comes from `WorkspaceSandbox.layerFileSystem()`, so a
composition with `StepBoundary.layer` and no sandbox produces run-local results
however everything else is wired. If admission is fine, read the
`flows_engine_step_cache_decisions` counter: `StaleReadSet` means a declared
read moved, `UnverifiableEvidence` means the recorded evidence cannot justify
reuse. See [Cache admission](/concepts/cache-admission/).

## A run stays parked forever

**What happened.** The run has a waiting row and nothing wakes it.

**What to change.** Confirm the process registers the flow: a wake for an
unregistered flow logs a once-per-run structured warning naming the run id and
the flow, and leaves the row parked deliberately, so a process that does
register the flow can still reclaim it. Then check the waiting reason with
`DurableEngineState.waiting(runId)`: `timer` with a past `wakeAt` points at
clock redispatch, `quarantine` points at corrupt evidence, and `released` means
a shutdown interrupted it and the sweep will re-drive it.

A SchedulerError may carry `cleanupErrors` if sibling attempt settlement failed
after the primary scheduler failure. Preserve and investigate both: a failed
cleanup transaction leaves its attempt for recovery and never publishes a
successful cache entry. The original `code`, `message`, and `cause` remain the
primary diagnostic.
