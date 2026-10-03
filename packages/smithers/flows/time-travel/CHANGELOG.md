# Changelog

## [Unreleased]

### Fixed

- Failed rewind/recovery audit updates and unknown effect-boundary appends now
  warn with their cause and identifiers while preserving the primary outcome.

## [1.0.0-rc.0]

### Added

- One flat `TimeTravel` service key with `replay`, `inspect`, `fork`, and
  `rewind`, plus `layer`, `layerWith`, `make`, and `makeWith`. Building the
  layer runs startup recovery, so an interrupted rewind is finished or rolled
  back before the service accepts work. `replay` is the fold verb the release
  contract names, with `ReplayOptions` (`pageSize`, `maxHistoryEntries`);
  `inspect` is the same fold under the service defaults.
- `maxHistoryEntries`, on `TimeTravel.Options` and on every verb's options: the
  cap on journal entries one replay folds or one fork or rewind assesses,
  defaulting to `TimeTravel.defaultMaxHistoryEntries` (100,000). An operation
  past it fails with the new `limit_exceeded` code, a rewind before it claims
  the run. A replay now streams its fold and stops reading at the frame, and a
  fork or rewind retains only the boundary records of the suffix it assesses,
  instead of materializing whole histories.
- `TimeTravelStore.ForkIntent` and `Service.abandonForkIntents`. `nextForkId`
  durably reserves the id it mints, `createFork` consumes the reservation, and
  building `TimeTravel.layer` hands back reservations older than five minutes
  whose fork never committed and forgets the jj lane each one named. A process
  that died between provisioning a lane and committing its fork used to remint
  the same id on retry, and jj refused the lane name the leftover held.
- `CompensationHandlers.Handler.compensation`, the descriptor an effect
  records on its boundary. A handler owns only the evidence recorded under the
  descriptor it declares; the `Classification` and `Assessment` schemas moved
  beside the handler shape, and a custom `assess` is decoded against them.
- `CompensationHandlers`, the optional door a composition contributes its
  adapters' compensations through. With none provided a crossed record that is
  not sealed classifies `blocking` and the rewind fails `irreversible`.
- `Migrations`, the same DDL as a rung on the shared migration ladder at id
  block `5000`, for a composition that owns migration itself.
- A fork-created marker record on every forked run, naming the parent and the
  journal offset it was cut at, so a forensic walk can start from any child.
- `fence_lost`, the refusal `archiveAndTruncate` raises when the caller's
  ownership of the run was superseded before the mutation committed.
- `already_crossed`, the refusal `EffectBoundary.guard` raises when an effect
  already recorded a durable `intended` boundary. It used to report `busy`,
  which is the code a contended run raises.
- Startup recovery reports a `Busy` outcome for an audit whose run another live
  process holds, and writes nothing, so the audit stays recoverable instead of
  being closed on the strength of a race.
- Colocated `docs/` is synced to `apps/docs/time-travel` by the shared
  `contentSync` target and to the main site API reference by
  `apps/site/scripts/sync-api-docs.mjs`.

### Changed

- **Breaking.** A frame's `lineageId` is minted by `FlowEngine.Lineage`, never
  spelled. The encoding is versioned, so a hand-written `<runId>/root` address
  names no record and every operation refuses it as `not_found`.
- `SqlTimeTravelStore` requires Effect's `SqlClient` service plus
  `DurableWriter` (the renamed `Database` service).
- `SqlTimeTravelStore.createFork` derives the child's state AT the frame by
  folding the run-decision records, and copies only the attempts the copied
  prefix can explain, instead of copying the parent's current row and every
  attempt it ever wrote.
- A rewind holds its ownership lease with a supervised heartbeat for the whole protocol.
  It previously activated the run once and never pulsed again, so any
  compensation, workspace restore, or archive slower than the staleness window
  was stolen by a co-located engine mid-flight. Losing that heartbeat now stops
  the owned work with `fence_lost` instead of letting it continue unfenced.
- A rewind resolves attached descendants as well as detached ones. A live
  attached child now refuses the rewind under the default `block` policy
  instead of having its journal archived out from under it.
- Compensation receipts are persisted after each successful handler and before
  the next handler starts, so a crash mid-compensation still leaves recovery
  every landed receipt to roll back.
- The planned child cancellations are written with the `compensated` audit
  phase before the archive. Each child is then claimed before the commit and
  fenced inside the archive transaction; cancellation remains post-commit, so
  a crash is finished by recovery without truncating a foreign-owned child.
- A rewind writes the run's state AT the frame when it suspends, instead of
  leaving `state_json` from the truncated future, and truncation prunes the
  `flows_attempts` rows the truncated journal no longer explains.
- `TimeTravelStore.updateAudit` takes a named `AuditPatch` restricted to
  `status`, `rateLimit`, and `detail`. `Partial<Audit>` let a caller patch
  identity keys that one store applied and the other silently ignored.
- `MemoryTimeTravelStore` is held to the SQL store's answers: it enforces the
  ownership fence through the new `Options.runOwners`, writes the fork-created
  marker, keeps records that carry no lineage, refuses a fork whose frame
  addresses no record, and copies the opaque audit and receipt payloads on every
  read and write. `SqlTimeTravelStore` deduplicates detached edges to match it.
- Error causes carry an effect's identity and classification, never its `input`
  or `output`. `TimeTravelError` encodes its cause, so a raw payload on one was
  a size and secret hazard.
- Time travel is a library API, also exposed as
  `smthrs runs inspect|replay|fork|rewind`; see the
  [CLI reference](https://smithers.sh/docs/reference/cli/). MCP exposes these
  verbs only through the unified command tools.

### Fixed

- A fork refuses while ANY ancestor is live. The SQL store's liveness walk
  followed this package's fork edges alone, so an inactive child a running
  engine parent had spawned or handed off to, recorded only through
  `flows_runs.parent_run_id` or `flows_run_parents`, forked as if its history
  were settled. The walk now covers all three relations, breadth first, and
  terminates on a cycle; the memory store walks every parent edge of a child
  rather than the first.
- The registry enforces the handler safety contract before a rewind acts on a
  verdict: a custom `assess` result that does not decode assesses `blocking`,
  an effect that recorded no idempotency key is blocked and never reverted by
  a handler that requires one, a handler declaring another compensation
  descriptor, or none, neither assesses, reverts, nor rolls back evidence
  recorded under a descriptor, a rollback verifies the receipt's tier, and a
  malformed declaration is refused `invalid` at registration.
- `EffectBoundary.fromEntries` refuses conflicting boundary evidence instead of
  keeping whichever record the caller listed last: records fold in `seq`
  order, identity fields must agree, and only `intended` followed by one
  terminal record is legal. An `unknown` outcome can no longer be turned into
  a `succeeded` one by a reordered journal. `fromRecords` exposes the fold.
- The snapshot projector keeps the jj pointer and the plan digest per lineage,
  so a `carried` anchor on one lineage never inherits another lineage's
  pointer when a run's journal interleaves them, and a plan record with no
  lineage metadata is refused `invalid` like a snapshot record.
- `SqlTimeTravelStore` scopes its lineage-edge read to the runs reachable from
  the run in question instead of decoding every edge in the database.
- A rewind no longer rolls a handler receipt back twice when the workspace
  restore fails: `restoreWorkspace` owns the receipts it is handed and reverses
  them itself, and nothing requires a handler's `rollback` to be idempotent.
- A cancelled rewind reports as cancelled. An interrupt-only cause is re-raised
  verbatim instead of being squashed into `TimeTravelError{code: "unknown"}`.
- `SqlTimeTravelStore.make` reports a migration failure with its driver cause
  instead of dying with the value `undefined`.
- Startup recovery restores the ownership it acquired on every failure path,
  and claims a suspended run before rolling its compensation back, instead of
  restoring a workspace under a run another process may claim mid-rollback.
- Startup recovery suspends an archive-committed rewind with the state derived
  at its surviving frame, not the post-frame state from the run row.
- Successful compensation rollback is removed from an open audit before run
  restoration, so a later recovery pass cannot repeat a non-idempotent handler.
- Recovery leaves an audit pending when it cannot return acquired ownership,
  instead of closing the audit under a recovery owner whose lease will expire.
- The rewind failure branch no longer closes an audit as `rolled_back` when the
  run-state restoration itself failed.
- A `RunStore` failure while reading a child is propagated instead of being
  downgraded to "evidence is missing" and letting the rewind proceed.
- The destructive read paths refuse an empty journal page that claims
  `hasMore`, instead of treating it as the end of history.
- `RewindOptions.detachedChildren` is decoded, so a misspelled policy is
  refused `invalid` rather than silently selecting the destructive one.
- Audit patch values are runtime-decoded in both stores, so an invalid status is
  refused consistently instead of reaching SQLite's constraint alone.
- Empty-journal validation now carries an explicit empty-tail expectation into
  the owned rewind, so a newly appended first record is refused as a moved tail.
- A migration failure names the object whose statement raised it, so a driver
  error like "views may not be indexed" is actionable.

## [0.1.0] - 2026-08-05

### Added

- Initial durable replay, fork, and time-travel store contracts.

### Fixed

- Made SQL forks executable by cloning restartable engine state and durable attempts.
