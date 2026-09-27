# Changelog

`@smthrs/scorers` is public at `1.0.0-rc.0` and versioned with the rest of the
`1.0.0-rc.0` train; `publishConfig` publishes it under the `next` tag. Every
`@since` tag in `src/` still reads `0.1.0`, the version the package carried
while it was workspace-private. Those tags date a member's first appearance and
are history, not the release that carries it.

## [Unreleased]

### Added

- `Checks`: pure text and action checks (length, wording, openers,
  truncation, links, linked references, bare paths, tool-call counts, and
  leakage) and `Checks.scorer`, which declares a scorer over them.

- `Rubric`: a rubric judge declared as a scorer over a caller-supplied model
  call, with `render`, `parse`, `decide`, and `agreement` for calibration.

- `ScoreStore.Service.prune({ olderThan })` deletes observations and job
  claims older than a cutoff and answers `ScoreStore.Pruned`. Neither table
  was pruned before, so a host scoring live runs grew both forever.

### Fixed

- `Checks.includes` matches whole words and phrases, the way `Checks.excludes`
  does, and accepts `/source/flags` entries. It matched substrings, so a
  required "No" was satisfied by "not" or "know". Both checks read a trailing
  `*` as a stem (`renew*` finds "renewal") for the cases that want a prefix.

- `RunnerLive.layer` logs a warning with the count of queued jobs a closing
  scope discards; they used to vanish with no trace.

## [1.0.0-rc.1] - 2026-09-22

### Changed

- Release candidate 1 with the workspace package train.

### Removed

- Removed `Runner.make` and `ScoreStore.make`. Both forwarded their only
  argument to the exported context service class and validated nothing, so the
  package documented two constructors for one service. Construct through
  `Runner.Runner.of` and `ScoreStore.ScoreStore.of`. `makeNoop` stays on both
  namespaces because it supplies an implementation rather than forwarding one.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added flow-native scorers, ground-truth and deterministic sampling bindings,
  durable repeated and inconclusive observations, and scoped queue/batch
  runners.
- Added `Runner.jobIdentity`, a length-prefixed constructor for the durable
  idempotency key, so two different tuples cannot produce one identity.
- Added `Runner.runBatchCorrelated`, which tags every observation with its job
  identity and reports whether the durable write was persisted, duplicated, or
  failed. `runBatch` keeps its existing observation-only contract.
- Added `ScoreStore.Observation` as a runtime schema plus `ScoreStore.validate`,
  and the documented bounds `maxReasonBytes`, `maxMetadataBytes`,
  `maxIdentityBytes`, and `maxObservations`.
- Added a page bound to `ScoreStore.observations` (`limit`, `offset`, `before`),
  an `inconclusive` count to `Aggregate`, and an optional `code` to an
  inconclusive observation, persisted in a new `failure_code` column by
  migration `0003_score_failure_codes`. `offset` is the cursor; `before` is a
  time filter, and on its own it could never walk past a page of rows sharing
  one timestamp.
- Inconclusive observations now require a structured failure code. Migration
  `0004_require_failure_codes` backfills legacy rows as `inconclusive` and
  enforces the invariant in SQLite.
- `recordOnce` now accepts only the two possible affected-row counts, zero or
  one, and rolls back on any contradictory driver result.
- Added package-owned generated documentation: `docs/Manifest.ts`, `PACKAGE.ts`, and
  `scripts/docs.mjs` project categorized source exports into `docs/exports.md`,
  while `test/docs.test.ts` keeps the curated API table synchronized.

### Changed

- **Sampling decisions move.** `Sampling.decide` now hashes UTF-8 bytes rather
  than UTF-16 code units and builds its material from length-prefixed
  components. The old hash collapsed every astral code point in a
  1024-code-point block onto one value and gave `("a:b", "c", "d")` and
  `("a", "b:c", "d")` the same decision. Every ratio decision taken before this
  change differs from the one taken after it; golden vectors in
  `test/Sampling.test.ts` freeze the new hash.
- `Sampling` now rejects a ratio outside the open interval `(0, 1)` and an
  empty seed at decode time rather than deep inside a run, and
  `Scorer.Result.score` carries the inclusive `[0, 1]` bound so the declared
  flow output and `Scorer.validate` enforce one contract.
- `Scorer.MakeOptions` no longer accepts `body`; `score` is the only
  implementation.
- `Scorer.make` throws a `ScorerError` with code `invalid_declaration` instead
  of a bare `TypeError` or a raw `SchemaError`, names which of `id` and
  `version` was blank, and refuses a configuration carrying a member canonical
  JSON would drop, which would otherwise give two different scorers one durable
  key.
- `Scorer.make` and observation metadata now refuse values nested more than
  1,000 levels, non-enumerable own properties, and `toJSON` members by path.
  These values either overflowed the lossless walk or disappeared from the
  durable identity after canonical JSON transformed them.
- `Aggregate.mean` and `Aggregate.min` are `undefined` when no score succeeded.
- `SqlScoreStore` encodes `meta` through canonical JSON before the transaction
  opens rather than with a bare `JSON.stringify` inside it, reads its
  affected-row count with `DurableWriter.affectedRows`, and classifies write
  failures: a constraint violation now has its own `constraint` code and every
  other database failure names its code in the message.
- `RunnerLive` logs a warning when the score store rejects an observation
  instead of discarding the failure silently, truncates a scorer's reason to
  the durable bound, and copies a submitted job's scalar fields so a later
  mutation cannot change what is recorded.
- `Runner.inconclusive` carries a `code`, coerces the cause safely, and
  truncates the reason to `maxReasonBytes` on a code-point boundary.
- Raised the coverage thresholds from 65/76/87/85 to 100 in every category
  except `branches`, which stays at 99 only while
  `packages/flows/test/vitestCoverageIsolation.test.ts` lists `scorers` in its
  `coverageFloorDeferred` set.

### Fixed

- `SqlScoreStore` now scrubs `reason` and `meta` with the journal's redaction
  rules before the `INSERT`. `flows_scores` is never pruned and is read back
  into eval reports and CI gate summaries, so a judge failure quoting its own
  request, or a reason quoting the agent output it graded, wrote a bearer token
  or a URL password into the database in clear and kept it there. A reason the
  scrub lengthens past `maxReasonBytes` is truncated again rather than refused;
  metadata the scrub grows past `maxMetadataBytes` is refused, because JSON has
  no truncation that leaves JSON.
- The four migration modules export their effect as the named binding
  `migration` and `Migrations` imports each one by name; the default exports
  are gone. The CommonJS build (`scripts/build.mjs`, esbuild under
  `"type": "module"`) emitted Node-style interop for a default import of a
  sibling module, so `Migrations.run` in `dist/cjs` received the whole
  `{ __esModule, default }` wrapper instead of the migration effect and no
  migration could apply through the `require` entry.
- `Scorer.make` now rejects a non-string `id` or `version` with
  `invalid_declaration` and maps an unexpected configuration-walk failure to
  the same typed error instead of leaking a host `TypeError` or `RangeError`.

- `recordOnce` no longer loses an observation forever under
  `SqlClient.SafeIntegers`: the bigint affected-row count was read as "already
  claimed", so the claim committed without the observation and every retry
  returned `false`.
- `recordOnce` rejects a blank or oversized job identity instead of letting one
  empty identity silently drop every observation after the first.
- The store no longer persists an inconclusive observation with no reason, a
  score outside `[0, 1]`, or a non-integral `at`. A single such row used to make
  every later `observations()` call for that target fail, and the read path now
  names the offending row.
- `record` and `recordOnce` no longer wrap their own errors twice, so the
  underlying failure reaches the caller instead of an identical copy of the
  outer sentence.
- Removed six `@see docs/specs/Concepts/Scoring.md` pointers at a path that
  does not exist.
