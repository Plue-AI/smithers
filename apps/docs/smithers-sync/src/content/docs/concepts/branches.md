---
title: "Branch collaboration"
description: "A branch is one shared live document whose durable state is exactly one journal run: how commands are admitted exactly once, why presence is never journalled, and what the projection guarantees."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sync/docs/concepts/branches.md"
---

:::warning
Branch collaboration ships unserved at 1.0.0-rc.0.
[`@smthrs/gateway`](https://gateway.smithers.sh/reference/api/) mounts `SyncRpcs` on `POST /sync` and
`/sync/ws`; nothing outside this package's own tests mounts `BranchRpcs`, so
the seven branch procedures have no integration against a real host yet. Treat
these modules as a library surface pending a host, not as a served endpoint.
:::

A branch is one shared live document that several people edit at once. It has
no store of its own. Its durable state is exactly one journal run, and
`BranchProtocol.branchRunId` is the only mapping:

```ts
import * as BranchProtocol from "@smthrs/sync/BranchProtocol"

const branchId = "design-review" as BranchProtocol.BranchId
const runId = BranchProtocol.branchRunId(branchId)
```

That single decision is what the rest of the design rests on. Every replication
guarantee the read path already provides carries over unchanged: the canonical
per-run `seq`, exclusive cursors, gap detection, resumable follow. Multiplayer
introduces no second source of truth, and a branch is followed with the same
`SyncClient.subscribe` call any other run is followed with.

`BranchProtocol.branchOfRunId` reverses the mapping, and returns `null` for a
run that is not a branch. The bare prefix with nothing after it is a non-branch
run rather than a branch with an empty id, because `BranchId` is a branded
non-empty string and branding `""` would hand a value the brand forbids to
`share.verify`.

## Commands are admitted exactly once

Three things look identical from the server's side: an optimistic client
re-sending after a timeout, a reconnecting client flushing its outbox, and two
people pressing the same button at once. All three must produce exactly one
durable command.

The client mints a `CommandId` once per user intent and reuses it across
optimistic application, retransmission, and concurrent submission. That is what
makes it an idempotency key rather than a correlation id.

The constraint is durable, not process-local. Every append carries the journal
producer identity `(branch run, commandSourceId(commandId), commandSourceSeq)`,
which the journal enforces inside its own write transaction. Two independently
constructed servers racing the same command therefore collide in the journal:
one appends, and the other receives a duplicate receipt or an idempotency
conflict and resolves the canonical sequence by replaying the branch.

`commandSourceSeq` is fixed at 0 and supplied explicitly. Letting the journal
allocate a sequence would hand a resubmission after a lost response a fresh
identity, and therefore a second durable append.

A `CommandReceipt` reports `admitted` or `duplicate`, and both are successes.
`duplicate` names the canonical sequence the original submission already
occupies, so a retransmitting client settles its optimistic row instead of
executing the command twice.

`BranchCommands` keeps an in-memory receipt ledger, a per-branch admission
permit, and a replay cursor. All three are a fast path: they answer known
duplicates without a journal write and keep a restarted server from
re-executing history. Correctness never depends on them, which is what makes it
safe to bound them. See the ledger, hydration, and command size bounds in the
[API reference](/reference/api/).

## One event type, one decoder

A branch journal has exactly one durable event shape,
`BranchProtocol.CommandEvent`. Chat messages, edits, and flow launches are all
commands, so the projection has exactly one decoder. `branch.say` is the
command that appends a chat message; a command's `target` names the shared
field it durably edits and is `""` for one that only appends.

A command's `participantId` is whatever the submitting client claimed.
`BranchCommands.submit` stamps the verified `capabilityId` of the share
capability that sent it onto the durable payload, and the projection carries it
on every message, applied command, and field. Attribute a command by its
`capabilityId`; a row admitted before the field existed decodes it as `""`.

Sync admission and command hydration validate known command records before
advancing progress. Malformed commands and foreign run/branch identities fail
typed; they cannot become a partial hydration or a new durable write. Hydration
stages a bounded receipt map and commits it with the replay cursor only after
all pages in that replay succeed. Existing decoding defaults for absent `args`
and `target` remain in force. Malformed retained records require explicit
repair by their authority; this package never rewrites them or silently treats
them as successful commands.

`BranchProjection.apply` and `project` are pure folds over admitted canonical
records, not admission APIs. Their convergence rules permit redelivery and
reordering of that canonical set. Use the validated sync read path before
folding transport or host input. The read path rejects malformed known records
before those pure folds can ignore them.

## Presence is a lease, and is never journalled

A roster is a lease table. Every announcement extends a lease, and a
participant that stops announcing, because the tab closed or the process died,
ages out without anyone reporting the disconnect. An announcement is idempotent
and the same shape serves join, heartbeat, and cursor movement, so a client that
reconnects simply announces again.

Writing presence to the journal would make "who was looking at this" part of the
durable, replayable history of a run. That is both unbounded and wrong:
replaying a branch must not resurrect a stranger's caret.

Announcing requires write access, so a read-only share link may watch the roster
but never appears on it, and a shared read link cannot be used to impersonate a
collaborator. A live participant is bound to the verified `capabilityId` that
first announced it: an announce or leave for that `participantId` under any
other capability is refused with `unauthorized` until the lease lapses, so one
write link cannot rename, move, or evict another link's participant. Holders of
the same link share its `capabilityId` and are not told apart. A branch holds at most
`BranchPresence.defaultMaxParticipants` participants at once; a further announce
is refused with `backpressure`.

`BranchPresence.list` is authoritative and `changes` is only a low-latency wake.
Each announcement or list drops that branch's expired leases and sweeps up to
16 branch rosters for expired participants, deleting empty maps. The sweep
resumes where the previous call stopped, so activity on other branches reclaims
abandoned rosters. An idle registry retains expired storage until activity
resumes; no timer fiber is needed. Both operations return detached participant
and cursor values, so callers cannot mutate the stored roster through a result.

A watcher re-lists once per lease as well as on every change, because a lapsed
lease publishes nothing: a watch driven by change events alone would never
observe the last participant leaving.

## The projection converges

`BranchProjection` folds journal entries into what two people looking at the
same branch must agree on: the message timeline, the applied commands, and the
current value of each durably edited field.

The fold is order-independent over the canonical entry set, which makes
convergence a property rather than a hope. Any two clients that have applied the
same set of entries hold the same state, whatever order their transports
delivered frames in and however many times a frame arrived. Three guards do the
work:

- an entry from another branch's run is ignored, so a mis-routed frame cannot
  leak into a projection;
- an entry already folded, whether the cursor tip redelivered or a command id
  already applied, is ignored, so an at-least-once transport cannot double-apply
  a user action;
- an entry below the cursor whose command was never applied is folded into its
  canonical `seq` position, so out-of-order delivery converges instead of
  permanently dropping the late entry.

Two durable edits of the same field are resolved by highest canonical sequence,
with a lexicographic `participantId` tie-break. The rule is deliberately not
wall-clock based: client clocks disagree, and a merge rule that depends on them
is not deterministic.

## The wire group

`BranchRpcs` carries seven procedures: `Branch.CreateBranch`,
`Branch.MintShare`, `Branch.Submit`, `Branch.Announce`, `Branch.Leave`,
`Branch.Roster`, and `Branch.WatchRoster`. `BranchServer.layerHandlers` projects
the branch services onto them. Five procedures forward to the service that owns
their boundary and add nothing: `Branch.Submit` to `BranchCommands`,
`Branch.Announce`, `Branch.Leave`, `Branch.Roster`, and `Branch.WatchRoster`
to `BranchPresence`. For those, an in-process caller and a remote caller face
the same rules.

Two procedures enforce policy in the adapter itself, on top of what
`BranchShare` checks:

- `Branch.CreateBranch` refuses any principal that is not an authenticated
  workspace with `unauthorized` before it mints the first capability;
- `Branch.MintShare` verifies the presented capability for write access to the
  branch, refuses an expired parent with `unauthorized`, and passes the parent's
  expiry as `maxExpiresAtMs` so the child never outlives it.

`BranchShare.mint` performs none of those checks. It decodes its request, so a
malformed id or ttl is refused with `invalid_request`, but an in-process host
that mints through the service directly must gate the principal and the parent
capability itself or it hands out branches and links the wire would refuse.

The payload schemas **are** the service schemas rather than copies of them, so
the wire and the services cannot drift about what a legal message is.

For the two-stage authorization the group uses, see
[Authorization](/concepts/authorization/).

## Related pages

- [Authorization](/concepts/authorization/): what a branch capability grants and how
  it is checked.
- [API reference](/reference/api/): every branch export, with its bounds and defaults.
