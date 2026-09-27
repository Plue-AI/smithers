# @smthrs/control

## [Unreleased]

### Added

- `Health.makeRegistry` takes an optional third argument, `evaluator`: the
  judge the registered `jev.session` checker asks.

- `SqlControlRuntime` takes `isAlive`: with it, `resume` takes over a running
  run whose owner is gone (a host killed mid-run) once the dead owner's lease
  has expired, instead of answering `ClaimLost`; the run store verifies the
  expired lease.

- `ControlExecutor.makeObserving` wraps an executor for a host that observes
  runs and drives none: `readExecution`, `requestCancel`, `deliverSignal` and
  `settleCancelledPark` pass through, and `launch` and `resumeRun` die. A host
  with no completion judge composes one, so it can list and diagnose runs
  without being able to admit one it could never judge.

### Changed

- **Breaking:** `JevSessionChecker` asks the host's `Evaluator` instead of
  calling the Vercel AI Gateway itself. `jevEvaluationUrl`, `jevModelId` and
  the `env`, `fetch` and `url` options are removed; `evaluator` replaces them.
  Without an evaluator the probe fails with reason `unconfigured`.
  `jevRequestTimeoutMs` is now 45000 (was 1500) and `jevProbeTimeoutMs` 50000
  (was 2500).
- A journal read that fails during `watch` answers `PersistenceError` with
  operation `watch` and the journal's error as its `cause`. It used to answer
  `Unavailable`, which reads as a missing feature. A closed journal still
  answers `Unavailable`.
- `WebCryptoCipher.open` answers `PersistenceError` with operation
  `credential.open` when a record does not open, naming a malformed nonce or a
  failed authentication (a different key, changed metadata, or tampered
  ciphertext), and logs the reason. `WebCryptoCipher.make` refuses a key that
  is not 32 base64-encoded bytes with `InvalidInput`. Both used to answer
  `Unavailable`, which is now kept for a host without Web Crypto.
- Breaking: `ApprovalAuthority.local` no longer delegates the in-memory test
  identity `memory`/`test`. A caller naming kind `test` held full approval
  authority under the production default. `ControlRuntime.layerMemory`
  delegates that identity in its own default policy.
- Removed the 195 internal `@slop` review markers from `src` and the published
  declarations. `test/ReviewMarkers.test.ts` keeps them out.
- Breaking: approval decisions require an independent `ApprovalAuthority` host
  policy, checked before reads/replay and again at resolution. Custom agent,
  gateway, and operator identities need explicit delegation; attribution and
  authentication alone do not authorize approval. RPC approval errors include
  `Unauthorized`. Policy storage failure leaves the gate closed.

- Breaking: approval tokens now expose `Pending`, `Approved`, or `Denied`
  instead of `resolved`. Terminal decisions retain their principal and time;
  approvals also retain scope. `requireApproved` fails closed on pending or
  denied requests. The documented gate no longer proceeds after denial or
  mistakes a storage error for approval.
- Migration 6004 stores the decision atomically with resolution. Legacy pending
  requests remain pending; old terminal requests that erased their decision are
  refused on recovery. Preserve old evidence and start a new run/request. This
  does not migrate old executable identities or cached gate results.

### Fixed

- Fixed the CommonJS build of the migration set. `migrations/0001_control_tables`
  now exports `initial` as a named binding and every importer reads it by name,
  because esbuild's Node interop for a default import of a sibling module
  resolved to the whole exports object instead of the Effect, so
  `require("@smthrs/control")` failed at load with
  `initial.pipe is not a function`.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added `ControlExecutor`, the port that hands launches, cancellations,
  signals, and resumes to a real run executor, so `ControlLive` drives an
  engine instead of describing one.
- Added `SqlControlRuntime`, the durable `ControlRuntime` over `@smthrs/journal`
  and the fenced `@smthrs/run-store`, and the credential subsystem behind it
  (`Credential`, `CredentialCipher`, `CredentialStore`, `SqlCredentialStore`,
  `WebCryptoCipher`).
- Added durable resume delegation: a decided run's restart is recorded for the
  host that owns it and taken up on that host's next poll, rather than claimed
  by a control plane with no executor (triage B-15).
- Added cancellation attribution: `control.run.cancel-requested` carries the
  authenticated principal and the operator's stated reason, and
  `Cancellation.attribute` folds a run's own evidence and its ancestors' into
  `RunSummary.cancellation`.
- Added `NoMatchingWait`, so a signal naming a wait point no run has open is
  refused where it arrives instead of being recorded as delivered.
- Added `Monitor`, which classifies run health from durable evidence and
  applies only the remedies `autoHeal` names.
- Added `Lineage` and `Steering` projections, so a client reading the journal
  directly reaches the same conclusions the server does.
- Added `ControlSchema.defaultPageSize`, `ControlSchema.maxPageSize`, and
  `ControlSchema.PageLimit`, so a listing has a documented bound the wire
  enforces.
- Added `ControlError.ControlErrorSchema` as the single membership list for the
  `ControlError` union, and added `CredentialConflict` to it.
- Added `SystemFlows.plannable` and a `plannable` marker on every catalog entry,
  so a verb the release policy removed cannot be planned as a flow.
- Added the namespaced `Migrations` module for every control and credential
  table, while standalone adapters reuse the same idempotent schema source.

### Changed

- `Control.run({_tag: "Resume"})` is the same operation as `Control.resume`.
  It used to be a second path that claimed without `scope: "launched"` (which
  overwrote an engine-created run's continuation state), replayed a recorded
  receipt for a run that had since settled, and journaled `control.run.resumed`,
  which the agent bridge reads as an approval delegation.
- `Control.resume` records the authenticated principal and the stated reason on
  `control.run.resume`, and the `Resume` RPC payload carries `reason` so a local
  and a remote resume no longer differ.
- `Control.plan` journals `control.plan.created` only when it created a plan.
  `ControlRuntime.plan` returns `{ card, created }` to say which happened.
- `Control.list` reads one run through `getRun` when `filters.runId` names one,
  instead of projecting every row in the database.
- `Control.list` refuses `filters.principalId`. It was accepted and applied
  nowhere, so a caller using it as a tenant restriction received every run.
- `Control.list` refuses a page size that cannot make progress and a cursor it
  did not issue, and applies `defaultPageSize` when the caller names none. A
  zero-sized page used to answer with a cursor a client loops on forever.
- `Control.steer` refuses a message whose `message.runId` disagrees with the
  run the call names, and records the message's stated `createdAt` on
  `control.steer.enqueued`.
- `Control.watch` refuses `afterSequence` without `runId`. Journal sequences are
  partition-local, so one scalar cursor applied to every partition skipped
  unseen entries in all of them but its own.
- Unscoped follow mode now subscribes before pinning one high-water mark per
  partition, then joins the finite snapshot to the buffered tail at those
  marks. The former 1,024-key cache could re-emit old overlap after eviction.
- A cancel that learns the engine row already settled reconciles the control row
  onto the engine's own status instead of leaving it non-terminal forever.
- Mutations now snapshot at an inert, schema-decoded 4 MiB boundary before
  their first wait. Durable identity is a fixed-size canonical SHA-256 digest
  scoped to the authenticated actor's stable id and kind; accessors and
  `toJSON` never participate, server timestamps do not split retries, and a
  nested `principal` remains caller intent.
- `ControlClient` classifies a transport failure by what actually happened. A
  request it could not encode, a response it could not decode, an unusable URL
  and an HTTP 4xx are final; a connection it could not open and an HTTP 5xx are
  retryable. Every failure used to be reported as retryable, carrying the
  transport's own message, so a keyless call was retried after a refusal that
  repeating could not fix. An interrupted call stays interrupted.
- `Monitor` records `control.monitor.healed` only for an `Accepted` or
  `AlreadyApplied` receipt, stops on a `Terminal` one, and no longer resets its
  stall evidence for a remedy that was refused.
- `SqlControlRuntime.listRuns` omits a row deleted between reading the id index
  and reading the row, instead of collapsing the whole listing to `[]`.
- Separately constructed `SqlControlRuntime` instances now mint distinct valid
  default owner identities, so one runtime cannot write through another's
  process fence when a host omits an explicit owner.
- Channel ingestion snapshots caller-owned bytes and headers before
  verification, and adapters declare the non-secret semantic headers included
  in durable idempotency fingerprints.
- `SqlControlRuntime.make` is the only exported constructor; the duplicate
  `make_` and the re-exported `FlowId` are gone.
- Approval tokens and bulk grants use the complete plan or node identity in
  memory and SQL. The SQL storage format now records target kind, run, target
  id, and the authenticated principal that resolved each token.
- Credential ciphertext authenticates a versioned canonical encoding of its
  stored id, name, and credential version, so blob moves, renames, and version
  rollbacks fail closed.
- The memory control runtime and credential store copy values at their storage
  boundaries, matching SQL serialization when callers mutate inputs or results.
- Public control JSDoc points only to documentation paths present in this
  repository.

### Removed

- Removed `Control.pause`. The frozen 1.0.0-rc.0 contract has no pause verb; an
  operator park is written through
  `ControlRuntime.writeStatus(runId, fence, "parked")`.
