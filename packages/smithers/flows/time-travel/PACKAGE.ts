import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
import { ReviewTagsMigrationsAndKeys } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  testProgram: Smithers.file("//packages/smithers/flows/database/scripts/test-matrix.mjs"),
  deps: [],
  cwd: "packages/smithers/flows/time-travel"
})

/**
 * The durable-identity review: identity strings, migrations, persisted
 * schemas, and durable keys, read out of this package's own changed sources.
 *
 * @since 0.1.0
 * @category lint
 */
const reviewTagsMigrationsAndKeys = ReviewTagsMigrationsAndKeys({ cwd: "packages/smithers/flows/time-travel" })

/**
 * Security review: `security` reviews the diff against origin/main and
 * `securityAudit` audits every source file this package owns.
 *
 * @since 0.1.0
 * @category lint
 */
const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/time-travel",
  include: ["src/**"],
  checks: [
    {
      id: "sql-identifier-literals",
      title: "Every SQL statement binds journal and caller values as parameters, never as literals",
      threat:
        "A run id, lineage id, or journal payload value written by a flow injects SQL that reads or deletes other runs' journal, audit, and receipt rows.",
      lookFor: [
        "A `sql.literal(...)` or `sql.unsafe(...)` call whose argument is built from anything other than a module constant such as `EffectBoundary.eventType`.",
        "A `Dialect.jsonText` JSON path or a `json_extract` path built from a runtime value instead of a fixed string.",
        "A DELETE or UPDATE on flows_journal_events, flows_attempts, flows_time_travel_* without a `run_id =` or `child_run_id =` bound predicate."
      ],
      paths: ["src/SqlTimeTravelStore.ts", "src/migrations/**", "src/Migrations.ts"]
    },
    {
      id: "truncate-owner-fence",
      title: "Rewind truncation and child cleanup commit only while this owner still holds the run",
      threat:
        "A second engine or a stale rewind deletes a live run's journal suffix or a child run's rows while another owner is executing it.",
      lookFor: [
        "The archive-and-truncate transaction in SqlTimeTravelStore missing the owner_host_id/owner_pid/owner_nonce predicate or not failing when zero rows match.",
        "A child run deleted (flows_attempts, flows_journal_events, snapshots, edges) without first re-reading and matching its owner triple inside the same transaction.",
        "A Lease.withHeldLease body that keeps mutating after the heartbeat fiber reports `fence_lost`."
      ],
      paths: [
        "src/SqlTimeTravelStore.ts",
        "src/MemoryTimeTravelStore.ts",
        "src/internal/Lease.ts",
        "src/internal/Rewind.ts"
      ]
    },
    {
      id: "recovery-claim-before-restore",
      title: "Recovery claims the run before it restores a workspace or replays rollback receipts",
      threat:
        "A crashed rewind's recovery pass rolls back compensations or restores jj state underneath a run another engine is actively executing.",
      lookFor: [
        "A path in Recovery.ts that calls a handler rollback or Compensation.restorePreparedWorkspace before `acquire` returned a claimed or self-owned row.",
        "A steal from a `running` row without liveness evidence that the recorded owner is dead.",
        "An exit path after the claim that leaves the row `running` under the recovery owner with no heartbeat."
      ],
      paths: ["src/internal/Recovery.ts", "src/internal/Lease.ts", "src/internal/RunRow.ts"]
    },
    {
      id: "compensation-fail-closed",
      title: "An unresolvable or malformed compensation verdict blocks the rewind",
      threat:
        "A flow author's buggy or swapped-in handler lets a rewind cross an irreversible effect (a charge, a message send) without reverting it.",
      lookFor: [
        "EffectHandlerRegistry resolving a handler whose `tier` or recorded `compensation` descriptor differs from the effect's and not assessing it as blocking.",
        "A custom `assess` result used without decoding it against `Assessment`, or a decode failure mapped to anything but `blocking`.",
        "An effect with `requiresIdempotencyKey` and no recorded key that is still reverted.",
        "A rewind option such as `detachedChildren: \"cancel\"` or `wholeRepo` reachable from an unvalidated string rather than the decoded literal union."
      ],
      paths: [
        "src/CompensationHandlers.ts",
        "src/internal/EffectHandlerRegistry.ts",
        "src/internal/Compensation.ts",
        "src/internal/Rewind.ts",
        "src/TimeTravel.ts"
      ]
    },
    {
      id: "effect-io-leak",
      title: "Effect inputs and outputs never reach errors, logs, or span attributes",
      threat:
        "Credentials an adapter was called with, captured in a boundary record, leak to anyone reading logs, traces, or a serialized TimeTravelError.",
      lookFor: [
        "A `TimeTravelError` cause built from a raw EffectRecord, journal entry, or audit detail rather than `Compensation.blockingSummary`-style identity fields.",
        "`Effect.annotateLogs`, `Effect.annotateCurrentSpan`, or `Effect.log*` passed an effect's `input`, `output`, a receipt, or `detail_json`.",
        "Audit detail or receipt JSON returned from a public read verb (`replay`, `inspect`) to a caller that only needs the frame."
      ],
      paths: ["src/TimeTravelError.ts", "src/EffectBoundary.ts", "src/internal/**", "src/TimeTravel.ts"]
    },
    {
      id: "fork-workspace-path",
      title: "A fork's jj workspace name and directory stay inside the configured workspace root",
      threat:
        "A run id containing `/`, `..`, or a leading `-` makes `jj workspace add` write outside the lane root or parse the name as a flag.",
      lookFor: [
        "`workspaceNameFor` output that can contain a path separator, `..`, or begin with `-` for some child run id.",
        "The directory passed to `jj.workspaceAdd` built from anything other than `options.workspaceRoot` and the sanitized name.",
        "A jj change id or operation id read from the journal or audit detail passed to `jj.restore`/`jj.opRestore` without shape validation that rules out a leading `-`."
      ],
      paths: ["src/internal/Fork.ts", "src/internal/Compensation.ts", "src/internal/Recovery.ts", "src/TimeTravel.ts"]
    },
    {
      id: "lineage-edge-provenance",
      title: "Rewind archives and deletes only runs this run actually spawned or handed off to",
      threat:
        "Flow code that records a boundary with the engine's child-spawn kind and a forged `output.childRunId` makes a later rewind of its own run archive and delete an unrelated run's journal, attempts, and snapshots.",
      lookFor: [
        "`EffectBoundary.guard` accepting a `kind` equal to `EventTypes.childSpawnKind` from any caller, with `output.childRunId` taken from the action result unchecked.",
        "The `edgesUnder` recursive query or LineageTree.descendants trusting `$.effect.output.childRunId` / `$.nextExecutionId` without joining to a row proving that child's parent is this run.",
        "The child loop in the truncate transaction deleting `flows_journal_events`/`flows_attempts` for a child run id without confirming the child row names this run as its parent."
      ],
      paths: [
        "src/EffectBoundary.ts",
        "src/SqlTimeTravelStore.ts",
        "src/MemoryTimeTravelStore.ts",
        "src/internal/LineageTree.ts",
        "src/internal/Rewind.ts"
      ]
    },
    {
      id: "history-bounds",
      title: "Replay, rewind, and projection read bounded history",
      threat:
        "A caller or a runaway flow with a huge journal makes replay, inspect, or rewind load the whole history into memory and stall the host.",
      lookFor: [
        "A journal read in Replay, Rewind, SnapshotProjector, or JournalPages without a page size or `maxHistoryEntries` cap.",
        "A caller-supplied `maxHistoryEntries` or frame `seq` accepted without the positive-integer decode in `Position`/`Frame`."
      ],
      paths: [
        "src/internal/Replay.ts",
        "src/internal/JournalPages.ts",
        "src/internal/HistoryLimit.ts",
        "src/internal/SnapshotProjector.ts",
        "src/internal/Rewind.ts",
        "src/Frame.ts",
        "src/TimeTravel.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: {
    check,
    circular,
    docs,
    docsFiles,
    reviewTagsMigrationsAndKeys,
    fmt,
    lib,
    lint,
    test,
    ...securityReview
  }
})
