# Changelog

## [Unreleased]

### Fixed

- Durable engine-state JSON codec and missing first-writer row defects now
  expose `EngineStateFault` with typed reasons, optional field, and cause.

- Cache replay and workspace copy-back confine to a Windows drive root instead
  of failing with `host_unavailable`. Breaking: `StepBoundary.makeFileSystem`
  and `WorkspaceSandbox.makeFileSystem` take the host `Path` after `fs`, and
  `StepBoundary.layer`, `WorkspaceSandbox.layerFileSystem`, and
  `StepSandbox.layer` require `Path.Path` (`NodePath.layer` on Node). The Node
  and Bun runtimes already provide it (#2302).

### Security

- Workspace copy-back can no longer be redirected outside the workspace by a
  symlink swapped in between its confinement check and its write. Every
  copy-back host call (lock, preflight, apply, rollback) now goes through
  `@smthrs/kernel/FileSystem`'s `confined` view: one descriptor-relative,
  no-follow request against the root pinned for that commit. The path-based
  `realPath`/`readLink` confinement pre-check is gone. Breaking: a copy-back
  through a symlink that stays inside the root is refused with
  `path_escapes_workspace` instead of followed, and
  `WorkspaceSandbox.layerFileSystem` and `StepSandbox.layer` fail to build with
  `host_unavailable` over a plain path-based `FileSystem`. Compose them over
  `@smthrs/platform-node`'s `AtomicFileSystem.layer` (which `NodeHost` and
  `BunHost` already provide), the kernel-guarded `FileSystem.layer`, or an
  in-memory volume wrapped in `withIsolatedFileSystem`.

### Added

- `EngineStore.Options.requestResume` reports every wake this engine itself
  initiates against a parked execution: a durable deferred completing, a
  durable clock firing, and a child settling under a parent that parked on it.
  An operator's own resume is not reported, because the host that asked for it
  has already claimed the run. A host that refuses to re-enter a parked run
  nobody asked for had no way to tell an engine wake from its own heartbeat
  sweep, so a run that slept, or whose child parked, never settled. Optional: a
  composition without such a host leaves it undefined and every wake is exactly
  what it was.

### Changed

- Breaking: `DurableEngineState.staleRunningRuns` returns
  `ReadonlyArray<StaleRunningRow>` (`{ runId, heartbeatAtMs }`) instead of run
  ids, so a sweep can scope a steal refusal to the lease it was refused
  against. Custom `DurableEngineState` implementations must return the frozen
  heartbeat with each run id; callers read `row.runId`.

### Fixed

- Compiled `stop-merge` recovery retains the stopped attempt's `skipped`
  outcome. `PlanMergeStore` persists eligible peers and atomically commits
  merge completion with its plan, source observations, and append event.
  Reopening can recover recorded merge-only extensions from the original base;
  intervening manual generations still require their approved plan. Generated
  IDs avoid ordinary user IDs without treating names or bodies as authority.
  Compose the new layer on the scheduler's database. Migration `3005` refuses
  old observation heads whose merge state is unknown; finish on the prior
  runtime or reconcile unfinished effects before starting a new run.

- Compiled recovery binds the normalized runtime environment before dispatch
  for all effect tiers. Changing `Options.environment` no longer repeats a
  completed action under a fresh key. Nested environment options are copied at
  construction. `PlanInputStore.Address` now requires `environmentDigest`,
  derived by `StepKey.environmentIdentity`; migration `3004` refuses older
  observation heads whose original environment is unknown instead of guessing.
  Existing action keys are unchanged. Recover with the original environment,
  or reconcile unfinished effects before intentionally starting new work.

- `PlanInputStore` persists source digests and glob membership before compiled
  dispatch. Reopening a self-updating run replays its original key instead of
  observing its own output as a new input. Appended generations retain earlier
  pins; corrupt, missing, incompatible or unfenced observations are refused.
  The new layer is required on the scheduler's database and is included in
  `TestStores`. Migration `3003` refuses compiled recovery for older runs that
  already had attempts but no input observations; finish them before upgrading
  or explicitly reconcile their effects. Changed approved graphs require a
  new run, not replacement within an observed run.

- File inputs are classified relative to each reader's predecessors. Explicit
  read-before-write sequences pin initial sources, and intermediate reads see
  preceding outputs. Future writers/removers no longer cause late source
  remeasurement or expand source-glob membership. Durable input snapshots now
  preserve that selection across reopening as well.

- Ready-work admission uses `@smthrs/plan/Scheduling` for priority, aging, plan-
  order ties and step/agent caps. Priority plus waiting age is compared exactly
  even outside the safe-number range. This does not change the interpreter's
  separate execution path or claim conditional scheduling parity.

- Plan scheduling preserves declared effect tiers. Compensable and irreversible
  work uses run-local, structurally scoped execution keys and never publishes a
  shared-cache result. Durable replay survives reopening the database;
  compensable retries restore their pre-image and keyless irreversible retries
  remain refused. An irreversible conflict fails without automatic rebase or
  merge execution. Compensable merge elaboration preserves the stopped node's
  tier instead of turning it into shared-cache work.

- Cancellation through any trampoline round now reaches live successors and
  linked child lineages, including children created by earlier rounds. Requests
  and handoffs serialize in the owning write transaction; local interruption
  is sent only after commit and does not wait on user cleanup. Normal parent
  exit resolves child policy from the round that created the edge and preserves
  it across handoffs. Fork ancestry alone does not propagate cancellation.

- Fixed the CommonJS build of the migration set. esbuild compiles a default
  import of a sibling module under `"type": "module"` to Node-style interop,
  where `import_x.default` is the sibling's whole exports object rather than
  the Effect it exported, so `set.migrations["0001_initial"]` and
  `set.migrations["0002_selection_store"]` had no `pipe` in `dist/cjs` and
  every `require` consumer failed at schema time. `migrations/0001_initial`
  now exports the named `initial` binding, `migrations/0002_selection_store`
  exports the named `selectionStore` binding, neither has a default export,
  and `Migrations` imports both by name.

## [1.0.0-rc.0] - 2026-09-01

### Release notes

> **Issue links.** This package was imported from the `smithersai/flows`
> repository, so the issue numbers cited below resolve there. Issues opened
> since the import resolve in `smithersai/smithers`, which `package.json`
> names as this package's repository.

> **Databases.** Smithers 1.0.0-rc.0 stores run state in local SQLite only (`@effect/sql-sqlite-node` over Node.js `node:sqlite`). PostgreSQL and PGlite are not supported: no client layer or migration ladder ships, `SMITHERS_BACKEND=pglite|postgres` and `--backend pglite|postgres` exit with `unsupported_database`, and the 0.x `smithers migrate --to` database move is removed. Projects that ran 0.x on PGlite or PostgreSQL must finish or discard their runs on 0.x; there is no import path.

### Added

- Added persisted plan scheduling and reconciliation, workspace and step
  sandboxes, selection and training, local/remote artifact and cache sync,
  metrics, in-process wakes, bounded retention, run-catalog reads, artifact
  garbage collection, and hot backup/verify/restore/fence operations.
- Added cross-process artifact backup leases and frozen-root verification so a
  backup cannot race artifact sweep or publish an incomplete manifest.

### Changed

- Required an owner-liveness probe when constructing the durable engine.
- `DurableEngineState` now requires Effect's `SqlClient` service plus
  `DurableWriter` (the renamed `Database` service).
- Made durable state, journal records, plan mutations, and multi-row selection
  updates transactional, with strict numeric bounds and host-independent
  UTF-16 ordering.
- Snapshot caller-owned descriptors and bytes before asynchronous work, and
  bind checkpoint operations to the configured repository workspace.
- Derived workspace-revision and bundle-identity strings from domain-tagged
  canonical JSON. Their persisted values now change.
- Removed the internal `@slop` review markers from every published JSDoc block.
  They shipped in `src/**/*.ts` and the generated declarations, so a consumer's
  editor hover showed a repository to-do instead of the contract.
- Repointed every JSDoc design reference, every reference in the package's own
  `docs/` prose, and the remaining references in test headers at their published
  `docs/pages` successors. The imported `docs/specs` tree and the
  `.smithers/tickets` notes do not exist in this repository, so each pointer
  named a file no reader could open.
- Renamed the durable `flows.engine.cache-conflict` payload field `key` to
  `cacheKey`. `@smthrs/journal` reads a field named `key` as a credential and
  replaces its value with `[REDACTED]`, which erased the very content address
  the conflict record exists to preserve.
- Renamed the dispatch observability field `key` to `stepKey` on every log
  annotation and span attribute this package writes. The same journal rule that
  redacts a durable `key` also redacts a log annotation named `key`, and
  `RedactedLogger` is installed by `@smthrs/flows`' `NodeRuntime` and by the
  `smithers` binary, so every dispatch line an operator read said
  `key=[REDACTED]` and no longer named which step it described. Span attributes
  take the new name too, so a trace and a log line agree.
- Validated `DisasterRecovery` `maxFileSizeBytes` at option admission. A
  fractional, NaN, infinite, negative, or unsafe value now fails with the new
  `invalid_options` code instead of dying inside `BigInt`.

### Fixed

- Prevented torn scheduler/journal settlements, retention partial deletes,
  mutable boundary evidence, forged materialization conflicts, ambiguous
  deviation identities, and failure-Exit corruption after in-memory restart.
- Made artifact GC and disaster recovery fail closed on corrupt durable roots,
  and made the local CAS coordinate writers and sweepers across processes.
- Required explicit whole-tree write verification before admitting a sealed
  result to the cross-run cache.
- Quarantined corrupt boundary evidence off succeeded attempt rows after
  journalling the inconsistency, so a later resume returns the durable outcome
  without re-executing the action
  ([#171](https://github.com/smithersai/flows/issues/171)).
- Included recorded-row provenance in corruption journal identities so an
  identically re-corrupted row records a new incident after healing
  ([#172](https://github.com/smithersai/flows/issues/172)).
- Reduced a live failure value to inert JSON before it reaches the attempt row,
  so a boundary refusal, a sandbox refusal, or any `Data.TaggedError` settles
  the attempt instead of being refused by the store as a non-plain object. A
  value JSON cannot express at all now records as `null` rather than as a
  dropped key the replay decoder could not read. The reduction reads own data
  properties only, so persisting a failure no longer runs the failing value's
  getters, `toJSON`, or proxy traps, and it is bounded by the depth, node, and
  character allowances the attempt store admits, so an outsized failure records
  as `null` instead of being refused and leaving the row `running`.
- Enumerated a declared tree artifact in full. `.git`, `.jj`, and `node_modules`
  are pruned from glob expansion only; pruning them from `filesUnder` and
  `entriesUnder` left files out of a tree's captured identity and left stale
  copies of them behind on replay.
- Derived glob-pruning exemptions from every full include that shares a walk
  prefix. An ignored-directory segment after a wildcard now remains in a
  declared read set instead of disappearing from boundary measurement, while a
  root glob still skips undeclared repository metadata and dependency trees.
- Charged the persisted cause envelope and interrupt reasons against one node
  budget, with a replayable one-reason fallback when it is exhausted. A large
  interrupted fan-out can no longer make `AttemptStore.finish` reject the
  terminal update and leave the attempt `running`.
- Reduced array-buffer views to a bounded marker before own-key enumeration and
  charged every other enumerated key against a shared walk allowance. A large
  typed-array defect can no longer materialize one property name per byte on
  the terminal failure path.
- Measured the encoded backup manifest against `maxFileSizeBytes` before its
  final write. Backup can no longer report success for a manifest that verify
  and restore reject under the same file-size option.
- Dropped quarantined boundary evidence by omitting the key rather than writing
  `undefined` over it, which the attempt store refuses.

## [0.1.0] - 2026-08-05

### Fixed

- Removed composition-time throws and structural boundary sniffing by using
  Deferred service wiring and Schema-backed boundary descriptors.
- Supervised ownership heartbeats through structured interruption races.

### Added

- Added the journal-backed engine composition, claim-gated run
  driver, durable deferred and absolute-clock state, action persistence
  wiring, and deterministic test layers.
- Added SQL-backed deferred completions and clock deadlines with owner-fenced
  scheduling, first-writer completion, and restart recovery.
