---
title: "Troubleshooting"
description: "Every typed failure and refused outcome these stores report, what causes each one, and what to change: invalid input, corrupt rows, lost fences, refused guards, unconfirmed evidence, and clock mistakes."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/run-store/docs/troubleshooting.md"
---

The stores answer on two channels, and which one you are on decides what to do
next.

- A **refused outcome** is a success value. `FenceLost`, `AlreadyClaimed`,
  `GuardFailed`, and the rest mean the store worked correctly and your write did
  not win. Handle it; do not retry it blindly.
- A **typed error**, `RunStoreError` or `AttemptStoreError`, means a defect:
  invalid input, a corrupt durable row, or a database that failed.

Both carry a `method` naming the operation and a `message` prefixed with the
code, so `invalid_run: RunStore.claim: run input is invalid` says where to look
before you read the cause. Causes carry field names, lengths, and validity flags,
never the value that failed. Every code and outcome is listed in the
[API reference](/reference/api/).

## invalid_run and invalid_attempt

**What happened.** An input did not meet the durable contract, and nothing was
written. The cause names the field and what was wrong with it. The common ones:

- **An invalid snapshot.** `RunSnapshot` requires own enumerable data fields
  `status`, `owner`, and `heartbeatAtMs`. A `RunRow` returned by `get` is valid
  as `expected`; extra own data fields are ignored. Missing or inherited
  required fields, enumerable accessors on any key, and non-plain prototypes
  are refused. So is a partial ownership pair: `running` requires both an
  owner and a heartbeat, and every other status requires neither.
- **A timestamp that is not a non-negative safe integer.** Every `nowMs`,
  `claimedAtMs`, `startedAtMs`, and `finishedAtMs` is checked on its own.
- **A lease reading ahead of the store's clock.** `claim`, `claimAndOwn`,
  `steal`, `heartbeat`, and `recoverClaim` refuse a `nowMs` more than
  `heartbeatSkewAllowance` ahead of the injected `Clock`, with the detail "runs
  ahead of the store clock by more than the heartbeat skew allowance".
- **An identifier that is not durable text.** Run ids, step key digests, lineage
  ids, owner host ids and nonces, and attempt state names must be non-empty, at
  most 1,024 UTF-16 units, free of NUL, and free of lone surrogates.
- **`toStatus: "pending"`.** A run does not go back to unstarted.
- **A malformed `TransitionGuard`.** `cancelRequested` accepts only `"absent"`
  or `"present"`, and the guard object takes no other key.
- **A value the JSON boundary refused.** The complaint names the rule: "contains
  an accessor", "contains a cycle", "contains a non-plain object", "contains a
  sparse or accessor array member", "contains an enumerable symbol", "contains a
  non-finite number", "contains unbounded or ill-formed text", "exceeds the
  maximum JSON depth of 128", or "contains more than 100000 JSON values".
- **A checkpoint over the byte ceiling**, "exceeds the JSON byte limit". Only
  checkpoints have one.
- **An invalid store policy**, reported by `AttemptStore.makeWith` and
  `layerWith`: `inProgressStates` must be a non-empty array of unique durable
  names, `maxCheckpointBytes` must be between 1 and
  `AttemptStore.maximumCheckpointBytes`, and `putMode` must be `"insert"` or
  `"upsert"`.

**What to change.** Fix the input. For run state and attempt values that means
building plain data: no class instances, no `toJSON`, no getters. For a policy it
means fixing the layer, because the failure arrives when the store is built, not
when the first bad value does. See [Durable values](/concepts/durable-values/).

## decode_failed

**What happened.** A row came back that these stores could not have written. The
cause distinguishes two cases: "could not decode flows_runs row" is a schema
mismatch, and "flows_runs row violates durable invariants" is a row whose
ownership, claim, or state columns disagree with each other, for example an owner
without a heartbeat or a `running` row with no owner.

**What to change.** Find the other writer. The invariants are also SQL `CHECK`
constraints, so a row that breaks them was written by raw SQL, a foreign tool, or
a partially applied migration. Re-run the migration set, or repair the row. Do
not widen the schema: the check exists so a half-owned row is never handed back
as executable state.

## constraint

**What happened.** The database refused the write. The usual cause is
`create` with a `parentRunId` or a foreign key that names a run that does not
exist, since `flows_runs.parent_run_id` and `flows_attempts.run_id` are both
foreign keys.

**What to change.** Create the parent run first, or drop the `parentRunId`
option. A lineage is ordinary metadata; the ancestry edge is not.

## not_found_row

**What happened.** `RunStore.get` was called for a run id with no row. It is the
one read that fails rather than reporting absence, because callers use it to
follow a fence they already believe in.

**What to change.** Treat it as "this run was never created", not as a race.
Every compare-and-swap reports `NotFound` as a value instead, and
`AttemptStore.get` returns `Option.none()`.

## persistence_failed

**What happened.** Either the database operation failed, or the composition is
running `RunStore.layerNoop()`, whose `create` and `get` fail with the message
"no run store in this environment".

**What to change.** If `get` fails immediately on a fresh database, the
migrations did not run: `Migrations.layer` has to be provided beneath both
stores, and `Layer.provideMerge` is what keeps the client and the writer in
context. See
[Compose the stores into a host](/guides/compose-the-stores/). If it is the
stub, provide a real store, or override the one operation the test needs.

## unknown

**What happened.** `AttemptStore.layerNoop()` is in the composition. Every
operation fails with "the store is unavailable in this environment".

**What to change.** Provide `AttemptStore.layer` or `layerWith`, or pass the
override that supplies the outcome your test wants.

## Every attempt write reports FenceLost after the run settles

**What happened.** `AttemptStore` carries no ownership of its own. `put`,
`heartbeat`, `finish`, and `patch` each require that the run is `running` and
owned by the caller. A terminal transition clears the owner columns, so from that
moment every attempt write on that run reports `FenceLost`.

**What to change.** Record what you know about an attempt before you settle the
run. This is deliberate: it is what stops a displaced owner's late write from
rewriting the winning row. See
[Record a step attempt](/guides/record-step-attempts/).

## GuardFailed instead of Transitioned

**What happened.** You still own the run, and the guard predicate refused the
write. `{ cancelRequested: "absent" }` means a cancellation was requested;
`{ cancelRequested: "present" }` means none was.

**What to change.** Take the branch the guard is pointing at. A `GuardFailed`
completion means the run should settle as `cancelled` instead. Ownership is
checked first, so this is never a fence problem: `FenceLost` would have been
reported for that. See [Cancel a run](/guides/cancel-a-run/).

## FenceLost while you believe you own the run

**What happened.** Another owner holds the row, or the run is no longer
`running`. The fence is the complete `(hostId, pid, nonce)` triple, so an
identity that differs only by `nonce` is a different owner: a restarted process
does not inherit its predecessor's runs.

**What to change.** Stop working on the run. `Ownership.heartbeatLoop` exists to
make that automatic: race it against the owned work with `Effect.raceFirst` and a
lost fence interrupts the work. See [The heartbeat lease](/concepts/leases/).

## EvidenceRequired from claimAndOwn

**What happened.** Your snapshot is still current, the row's different owner has
a stale heartbeat, and you supplied no matching `LivenessEvidence`. No
compare-and-swap ran.

**What to change.** Re-reading and retrying cannot make progress. Supply evidence
built at the same `nowMs`, or use `steal` followed by `activate`. A row whose
heartbeat is still fresh reports `HeartbeatFresh` instead, and evidence cannot
satisfy that predicate. See
[Take over a stalled run](/guides/recover-a-stalled-run/).

## LivenessUnconfirmed rather than SnapshotChanged

**What happened.** The evidence did not match the recorded owner, the host
relation its `kind` requires, or the call's `nowMs`, so the store refused before
any comparison ran. `SnapshotChanged` is reserved for matching evidence whose
comparison lost to a row that moved.

**What to change.** Check three things, in this order: `expectedOwner` must equal
the owner on the snapshot; `checkedAtMs` must equal the call's `nowMs` exactly,
so evidence probed at T is refused at T plus one millisecond; and `kind` must fit
the hosts, since `same-host-pid-dead` is accepted only on the owner's own host
and `cross-host-unreachable-stale` only from a different one. See
[Liveness evidence](/concepts/liveness-evidence/).

## HeartbeatFresh for an owner you know is dead

**What happened.** The persisted heartbeat is still inside
`heartbeatStaleAfter`. The store judges the row, not the process, and no evidence
overrides that cutoff.

**What to change.** Wait for the lease to expire. If the delay is the problem,
the answer is a liveness check that can say more than the lease, not a shorter
window: `Ownership.sameHostPidProbe` asks the operating system. One trap comes
with it: an owner recorded under the claimant's own pid always probes as alive,
so an embedded host that re-creates its engine in the same process should keep
`Ownership.leaseLiveness`, whose timeout does expire.

## AlreadyClaimed that never clears

**What happened.** A claimant wrote the claim columns and never activated. The
row is not owned and not claimable, and `claim` reports `AlreadyClaimed` for
everyone.

**What to change.** The owner of a failed activation should call `abandonClaim`,
which is why the two-phase path releases its claim when activation loses. For a
claimant that will not come back, `recoverClaim` clears the claim once it is
older than `heartbeatStaleAfter` and evidence confirms the claimant is gone. A
claim still inside the window reports `ClaimFresh`.

## Conflict from a replayed put

**What happened.** An attempt row already exists at `(runId, stepKeyDigest,
attempt)` with different content, and the store is first-writer-wins.

**What to change.** A byte-equivalent replay reports `ExistingSame` instead and
is safe, so a `Conflict` means two writers disagree about what this attempt is.
Object key order is ignored in that comparison; array order is not. Fix the
caller, or set `putMode: "upsert"` if overwriting an in-progress row is genuinely
what you want. A terminal attempt stays immutable in both modes.

## StateChanged from heartbeat or finish

**What happened.** You still own the run, and the attempt's `state` is no longer
one of the store's `inProgressStates`. Something already finished it, and a
second `finish` reports the same thing rather than overwriting the winning row.

**What to change.** Treat the attempt as settled. If your executor uses more than
one running state, declare them all in `inProgressStates` when you build the
store.

## requestCancel reports Terminal or AlreadyRequested

**What happened.** `Terminal` means the run settled before the request could be
recorded, and its `status` says which ending it lost to. `AlreadyRequested` means
a request was already on the row, and `requestedAtMs` is the original time rather
than the one you passed.

**What to change.** Neither is an error. A repeat request is harmless by design:
the column is first-writer-wins so a retry cannot move the recorded intent. A
terminal run records nothing, because it has no owner left to observe the intent.

## heartbeat reports Updated but the stamp did not move

**What happened.** Heartbeats are monotonic. The write is
`MAX(heartbeat_at_ms, :nowMs)`, so a pulse delayed past a newer one from the same
owner still reports `Updated`: the fence held and the write proved liveness, but
the stamp is not moved backwards where it would make a live run look stale to a
peer.

**What to change.** Nothing, unless your `nowMs` readings are genuinely going
backwards. That is the sign of a caller mixing clock sources.

## Two clocks in one row

**What happened.** Lifecycle stamps come from the injected Effect `Clock`, and
`nowMs` comes from the caller. A composition that reads `Date.now()` for `nowMs`
while the store runs on a `TestClock` produces a row with readings from two
unrelated timelines, and the lease operations then refuse the reading as ahead of
the store's clock.

**What to change.** Take `nowMs` from `Clock.currentTimeMillis`. That is also
what makes the whole store driveable under `TestClock`. See
[Test against the real stores](/guides/testing/).
