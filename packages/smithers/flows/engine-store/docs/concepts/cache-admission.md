---
title: "Cache admission"
description: "The conditions a step result must meet before another run may reuse it, how a hit is verified before it is served, and the ordering that makes a shared tier safe."
sidebar:
  order: 6
---

Serving a recorded result instead of executing a step is the most valuable and
the most dangerous thing this package does. Cache admission is the set of
conditions a result must meet before it becomes reusable, and cache
verification is the check that runs before a recorded result is actually
served.

## What gets admitted

The engine admits a cache record only when all of the following hold:

- The action is `sealed`.
- The boundary is `hard`.
- All declared reads are exact inputs, not unresolved globs.
- No deviation occurred.
- The evidence explicitly carries `wholeTreeWritesVerified: true`.
- The evidence explicitly carries `hermeticReadsVerified: true`.
- The completed attempt carries `readSetVerified: true`: its measured inputs
  matched the declaration when the body executed.

Fresh results and recovered durable completions use the same internal
publication decision. Refusal keeps a completed action's run-local outcome;
it does not require the body to execute again. Known-corrupt evidence cannot
be published merely because the inconsistency policy tolerates that outcome.

Older evidence, and boundaries that observe declared paths only, are
conservatively refused. Under the production composition the proof comes from
[`WorkspaceSandbox`](./workspace-transactions.md): the body ran in an isolated
workspace, so a write outside the declared set is a map comparison rather than
an inference, and the engine sets the flag itself. When the whole-tree
diff shows a deviation the declared-read scan would have missed, it records that
deviation and withholds the entry instead.

One more distinction decides reach rather than admission. Only a content-key
record has an address another run can reproduce; an ordinal-key record stays
run-local.

## A hit is verified before it is served

A matching key is not sufficient. Before serving, the store calls
`StepBoundary.prepare` and compares the descriptor's declared `readSet` against
the `readSnapshot` the host measured:

- Every declared read still matching permits output replay verification.
- A declared path that is missing, or whose digest differs, refuses the hit,
  journals a `cache-provenance` record with `action: "stale_read_set"`, and
  falls through to a real execution.
- Reads the host reports but the declaration never claimed are ignored: the
  declaration is what the key was computed over.

This is Skyframe's dirty-check invariant. The key alone detects a changed
declaration, never a stale one.

A verified hit then calls `replayOutputs` before returning the stored result.
Unlike completion publication, candidate admission does not require the old
`readSetVerified` flag: current inputs are freshly measured here. Missing
whole-tree or hermetic-read evidence still refuses the candidate. An unavailable
measurement does not prove staleness and does not justify evicting the row.

When that refuses with `MissingArtifact`, the normal first answer for a row
recorded on a machine whose artifacts this one has never seen, the dispatch
hydrates from the shared tier and retries the replay exactly once before
falling through to a real execution. A second failure means the tier cannot
serve it either, and executing is strictly better than looping.

## Current output authority and legacy flags

Before measuring a candidate or replaying a durable outcome, the engine checks
the entire recorded output manifest against the current boundary descriptor.
Each write must be covered by the current write set, each deletion must be an
explicit removal, and every exact output and removal must be present. Tree
pruning requires the same declared tree root; a glob or a narrower subtree
cannot authorize pruning a broader recorded tree. A tree root must remain a
directory; a manifest cannot replay a file at that path. Duplicate and noncanonical
recorded paths are refused. The existing abstract `{ paths: [...] }` boundary
format requires an identical current write set and no removals. An unknown
output format is refused as `unsupported-output-evidence`. Malformed production
evidence cannot use the abstract path-list fallback.

A descriptor mismatch is `output-boundary-mismatch`, recorded in the existing
`cache-provenance` family with `action: "replay_failed"`. It permits no replay
call, hydration, pruning, or age-based eviction of that candidate. This is a
preflight guarantee for policy refusal, not atomic rollback of filesystem work
if an admitted replay subsequently encounters host failure or corruption.
A succeeded attempt retains its original outcome and metadata, returns that
outcome without executing its body again, and withholds cache publication when
its output evidence is refused.

Stored `boundaryQuarantined: true` always forbids shared reuse and publication.
Quarantine together with boundary evidence or `readSetVerified: true` is
`contradictory-evidence`; verified reads with no boundary evidence have the same
refusal. Neither a historical verification flag nor a tolerant inconsistency
policy overrides quarantine. These legacy rows remain unchanged and their
run-local durable outcomes remain authoritative. A candidate without the old
read-verification flag can still be admitted by fresh current-read measurement.
Proof flags retain their existing true-or-omitted schema. Stored false values
or strings fail metadata decoding as `invalid-meta` for shared reuse, while
the run-local durable outcome remains authoritative.

## Empty output sets

An action with no declared writes or removals can publish and converge a cache
entry. For replay and convergence, its evidence must explicitly encode the empty
set as `{ outputs: [] }` (with no tree roots) or the abstract `{ paths: [] }`
format. All ordinary boundary, whole-tree, hermetic-read and execution-time read
proofs still apply.
An empty set does not establish those proofs by itself. A durable completion
without a finish timestamp uses the current clock when it converges the entry.

Empty outputs do not bypass replay verification. If the boundary reports
`BoundaryCorruption` in admitted evidence, the succeeded attempt's evidence is
quarantined, its boundary and read-verification proof are cleared, and strict
policy parks the run until an explicit resume; polling and repeated execution
cannot clear quarantine. That explicit resume returns the durable
outcome without rechecking that evidence, repeating the body, or publishing it.

An opaque `{}` is unsupported evidence, not an encoded empty set. An empty
manifest that omits a declared exact output, removal, or tree root is a boundary
mismatch. These preflight refusals preserve the succeeded outcome and original
metadata, withhold convergence, and never call the boundary, so they do not
trigger corruption quarantine. Undecodable metadata likewise supplies no
reusable proof; it does not manufacture a corruption verdict.

## Age decisions, policy removal, and forked history

The first age verdict for a cache provenance is durable: age equal to `ttlMs`
is admitted, and age one millisecond greater is expired. Replaying that verdict
uses its original answer when the clock moves in either direction. An exact
duplicate of the opposite measured verdict proves a clock change; an arbitrary
journal conflict never does.

Removing `ttlMs` after any recorded age verdict for this cache address within
the run is refused with `JournalError.code: "idempotency_conflict"`. This holds
even if the head has since been evicted or replaced. Restore the original
policy or use a new action identity. Before a verdict exists, the policy can
still change. Scope continues to narrow the cache address without changing the
durable attempt identity.

The no-TTL guard indexes verdicts per executor and reads only journal entries
after its last validated sequence on subsequent dispatches. It checks new
entries before answering absence. Resume, a different journal service, or a
changed rewind generation rebuilds the index from retained history once.
EngineStore shares it across a run's action instances; PlanScheduler shares it
across its node dispatches.

A fork may reuse a copied parent's age verdict only after a paged history
lookup validates the complete producer identity, event type, payload including
TTL and recorded provenance, sequence, timestamp, and lineage metadata against
the retained ancestor record. Each ancestry edge also requires the recorded
fork marker, its producer, exact cutoff, and cutoff lineage. Forks of forks
must validate every intervening copied prefix. Missing ancestry, contradictory
fields, and unrelated foreign lineage retain the typed `idempotency_conflict`
with its cause. A journal read failure, including a compacted cursor, preserves
the journal's original typed error. An identity refusal also records
`action: "replay_failed", reason: "incompatible-age-history"` in the existing
cache provenance family. No new event family, persisted schema, key, or producer
identity is introduced; transparent reuse of unvalidated foreign history is
unsupported.

## Publication order across two tiers

A shared tier turns one machine's result into every machine's result, and the
order the two writes happen in is a correctness property, not a preference.

1. `ArtifactSync.publish(digests)` runs first, immediately before the
   transaction that records the cache entry and never inside it. It probes the
   shared tier with `findMissing`, uploads what is missing, and re-probes to
   confirm. A publication that cannot make the artifacts durable fails with
   `ArtifactPublicationFailed`, and the shared entry is withheld.
2. The local cache row and the journal record explaining it commit in one
   `DurableWriter` transaction.
3. `CacheSync.publishEntry(entry)` runs after that transaction, publishing the
   already-durable local entry to the shared step-result tier.

Step 1 before step 2 is Bazel's REAPI ordering constraint: an action result is
uploaded after every blob it refers to, because a result accessed before its
blobs are present cannot be validated. Step 3 after step 2 is why `CacheSync`
is a separate seam from the `CacheStore` tag at all: a `CacheStore` whose `put`
also wrote a shared HTTP tier would put a network round trip inside a write
transaction, blocking every other writer for its duration and rolling the local
row back whenever a shared cache was unreachable.

The ordering makes a shared tier consistent, not trustworthy. A hit replays the
entry's evidence into the workspace, writing its outputs and deleting its
`digest: null` paths, and every check that runs is against digests the same
entry recorded. Only producers you trust as much as your own machines may write
to the shared tier. See
[Trust every writer of the shared tier](../guides/share-a-cache-across-machines.md#trust-every-writer-of-the-shared-tier).

## Neither publication step can fail a run

Both run after `attempts.finish`, so the result is already durably recorded on
this host. Failing a completed run because an optional accelerator is
unreachable trades a real result for an unavailable one.

A refusal withholds the shared copy, never the local row, and journals a
`cache-provenance` record with `action: "unpublished"` carrying the stage
(`artifacts` or `entry`) and the reason. A missing shared entry is therefore
explainable from the journal rather than inferred from its absence.

Local cache lookup and publication failures are also accelerator failures. A
typed store refusal is journaled and a succeeded durable attempt remains
usable. A failed cache transaction leaves neither its row nor its provenance
record; reopening can publish from the terminal attempt without repeating the
body. A crash after the local cache row commits may leave the optional remote
entry absent: a subsequent local hit does not retry remote publication.

## Download policy on the read side

`ArtifactSync.hydrate` establishes that this host can resolve every referenced
artifact. How eagerly it materializes them is `DownloadPolicy`, declared on the
shared tier as `RemoteArtifacts.Options.downloadPolicy` and read from the store
`ArtifactSync.make` was handed, so one deployment setting reaches both seams. An
explicit `downloadPolicy` on `make` or `layer` overrides it.

| Policy          | Behavior on hydrate                                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `all` (default) | Downloads every referenced artifact into this host's store while admitting the replay. Every later read is local, and a shared tier that goes down afterwards costs nothing.                    |
| `toplevel`      | Downloads nothing. One batched `findMissing` establishes that the shared tier can serve what is missing, and `CombinedArtifacts.get` fetches and writes back the blobs a reader actually reads. |
| `minimal`       | The same probe and the same zero downloads; `CombinedArtifacts.get` then serves without writing back, so this host never accumulates other machines' artifacts.                                 |

The two lazy policies are sound only when the store the replay reads through
can reach the shared tier, which means `CombinedArtifacts` with the same remote
tier. Under a purely local `ArtifactStore` an admitted lazy replay would later
read an artifact this host never fetched. A tier that refuses the probe is
indistinguishable from one that holds nothing, so the replay is refused either
way and the step executes.

## When two runs disagree

Two runs that record different results under the same content key mean the
declaration does not fully describe what the step depends on. That is a
hermeticity violation, and it goes to the `Inconsistency` receiver:

- `Inconsistency.layerStrict(owner)` journals the conflict and fails the
  dispatch. This is the default for engine wiring, because a non-hermetic
  sealed hard-boundary action is a defect rather than a condition to paper
  over.
- `Inconsistency.layerTolerant(owner)` journals and continues, preserving the
  first-recorded row. That is Skyframe's tolerant production configuration.
- `Inconsistency.layerNoop()` journals nothing and tolerates everything.

The record goes through the journal's durable channel, so a `tolerate` verdict
that silently dropped its only record cannot wire the detector to nothing.

An explicitly nondeterministic declaration instead keeps the first local writer
and records `conflict_first_writer`; it never calls the deterministic
inconsistency receiver. The optional remote publisher also retains its existing
first-writer policy. Neither policy turns a local deterministic conflict into
an availability failure.

## Related

- [Step boundaries](./step-boundaries.md): where `wholeTreeWritesVerified`
  comes from.
- [Share a cache across machines](../guides/share-a-cache-across-machines.md):
  the composition that turns this on.
- [Content addressing](/docs/concepts/content-addressing/) on smithers.sh: how
  a step key is built in the first place.
