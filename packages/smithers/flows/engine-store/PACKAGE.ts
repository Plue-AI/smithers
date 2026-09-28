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
  cwd: "packages/smithers/flows/engine-store"
})

/**
 * The operator's backup, verify, and restore entry point, driven the way an
 * operator drives it: spawned `node scripts/flows-backup.mjs` invocations
 * against a real migrated store. The script wraps `DisasterRecovery`, so it
 * lives beside the module it exercises.
 *
 * @since 0.1.0
 * @category test
 */
const disasterRecovery = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//packages/smithers/flows/engine-store/scripts/flows-backup.test.mjs")]),
  srcs: [
    Smithers.glob("//packages/smithers/flows/engine-store/scripts/flows-backup*.mjs"),
    Smithers.glob("//packages/smithers/flows/engine-store/src/**/*.ts")
  ],
  deps: [],
  cwd: "packages/smithers/flows/engine-store"
})

/**
 * The durable-identity review: identity strings, migrations, persisted
 * schemas, and durable keys, read out of this package's own changed sources.
 *
 * @since 0.1.0
 * @category lint
 */
const reviewTagsMigrationsAndKeys = ReviewTagsMigrationsAndKeys({ cwd: "packages/smithers/flows/engine-store" })

/**
 * The security review: `security` reviews this package's changed files against
 * `origin/main`, and `securityAudit` audits every reviewed file.
 *
 * @since 1.0.0
 * @category lint
 */
const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/engine-store",
  include: ["src/**", "scripts/**"],
  checks: [
    {
      id: "copy-back-confinement",
      title: "Sandbox copy-back writes only inside the pinned workspace root",
      threat:
        "A step body or its agent writes or replaces host files outside the workspace, or the engine database, on the operator's machine.",
      lookFor: [
        "normalizePath accepting a path with '..', an absolute path outside root, a backslash or NUL spelling that later resolves outside root.",
        "A copy-back, preflight, apply, or rollback call that uses `fs` instead of the `confined` host and so follows a symlink or hard link.",
        "reservedAt comparing `.flows` and `.smithers-workspace-lock` case-sensitively, so `.FLOWS/...` reaches the engine state on a case-insensitive filesystem.",
        "The lease heartbeat's path-based `utimes` being reachable before the confined read proved the lock holds this call's token."
      ],
      paths: ["src/WorkspaceSandbox.ts", "src/StepSandbox.ts", "src/internal/SandboxedExecution.ts"]
    },
    {
      id: "hermetic-read-enforcement",
      title: "A hermetic step reads only its declared read set",
      threat:
        "A step body reads undeclared workspace files, secrets included, and still records a cacheable, verified result.",
      lookFor: [
        "An undeclared-read violation that yields Materialized instead of UndeclaredRead or Invalidated.",
        "A sandbox read path that serves host bytes for a path the seeded transaction did not declare.",
        "Glob coverage in the write-set matcher treating `*` as crossing `/` or `**` as matching outside its prefix."
      ],
      paths: [
        "src/WorkspaceSandbox.ts",
        "src/StepSandbox.ts",
        "src/StepBoundary.ts",
        "src/internal/SandboxedExecution.ts",
        "src/internal/FileBoundarySnapshot.ts"
      ]
    },
    {
      id: "cache-poisoning",
      title: "Cache hits replay only results whose read set and artifacts verify",
      threat:
        "A writer to the shared cache or artifact tier makes another machine's run replay forged outputs or file changes.",
      lookFor: [
        "A replayed cache entry admitted without readSetVerified or with a quarantined boundary.",
        "Artifact bytes fetched from the remote tier and materialized without re-hashing against the referenced digest.",
        "CacheSync or ArtifactSync publishing an entry before every referenced blob is durable in the shared tier."
      ],
      paths: [
        "src/internal/CacheAdmission.ts",
        "src/internal/CachePublication.ts",
        "src/internal/CacheOutputPolicy.ts",
        "src/CacheSync.ts",
        "src/ArtifactSync.ts",
        "src/internal/ActionPersistence.ts"
      ]
    },
    {
      id: "backup-restore-integrity",
      title: "Backup, verify, and restore trust only digests and fixed file names",
      threat:
        "Whoever controls a backup directory makes restore write outside the target directory or load a tampered database into production.",
      lookFor: [
        "A manifest field other than the literal database file name or a Sha256 digest reaching a filesystem path.",
        "Restore writing a blob or database file whose bytes were not re-hashed against the manifest first.",
        "`VACUUM INTO` receiving an unparameterized or operator-unchecked path.",
        "A failed backup's cleanup removing entries outside the backup directory it created."
      ],
      paths: ["src/DisasterRecovery.ts", "scripts/flows-backup.mjs"]
    },
    {
      id: "owner-fencing",
      title: "Every durable claim and settlement is fenced by the current owner",
      threat:
        "A stale or rival engine process overwrites another owner's run state, settling or cancelling runs it no longer holds.",
      lookFor: [
        "An UPDATE or DELETE on flows_attempts or flows_runs claim columns without owner_host_id and owner_nonce predicates.",
        "An OwnerId nonce drawn from a non-cryptographic or predictable source.",
        "Restore fencing that leaves any pre-backup claim or running run unsuspended."
      ],
      paths: [
        "src/DurableEngineState.ts",
        "src/OwnerIdentity.ts",
        "src/internal/RunDriver.ts",
        "src/internal/AttemptLifecycle.ts",
        "src/internal/RunCoordinator.ts",
        "src/DisasterRecovery.ts"
      ]
    },
    {
      id: "sql-construction",
      title: "Store SQL binds every value and builds identifiers only from constants",
      threat: "A flow author or caller-supplied filter injects SQL into the operator's engine database.",
      lookFor: [
        "`sql.unsafe` or `sql.literal` interpolating anything other than compile-time constants or dialect choices.",
        "A listing, selection, or retention filter that splices a caller string into ORDER BY, a column name, or a LIKE pattern without escaping."
      ],
      paths: [
        "src/migrations/**",
        "src/internal/EngineStateSchema.ts",
        "src/internal/RunListing.ts",
        "src/Selection.ts",
        "src/SelectionStore.ts",
        "src/internal/RetentionOps.ts",
        "src/PlanInputStore.ts",
        "src/PlanMergeStore.ts"
      ]
    },
    {
      id: "durable-row-decoding",
      title: "Durable rows decode fail-closed and bounded",
      threat:
        "A corrupted or attacker-written store row crashes the engine, exhausts memory, or is misread as a successful exit.",
      lookFor: [
        "A JSON column decoded without a Schema, or a decode failure mapped to a default value instead of a typed error.",
        "An unbounded recursive walk or read of a checkpoint, envelope, or output column with no size cap.",
        "ExitEncoding decoding an unknown tag as success."
      ],
      paths: [
        "src/internal/ArtifactRoots.ts",
        "src/internal/ExitEncoding.ts",
        "src/internal/ResultEnvelope.ts",
        "src/internal/JournalRecords.ts",
        "src/internal/CopiedRecord.ts",
        "src/internal/ExecutionSnapshotRead.ts"
      ]
    },
    {
      id: "gc-retention-safety",
      title: "Artifact GC and retention delete only unreferenced data",
      threat:
        "A retention or GC sweep deletes blobs or rows a live run or cache entry still references, destroying another user's results.",
      lookFor: [
        "A sweep that deletes a blob without a fence against concurrent new references.",
        "A root enumeration that skips a table or checkpoint column holding digests.",
        "Retention deleting a run that is still running, parked, or referenced by a child run."
      ],
      paths: ["src/ArtifactGc.ts", "src/Retention.ts", "src/internal/RetentionOps.ts", "src/internal/ArtifactRoots.ts"]
    },
    {
      id: "wait-token-exposure",
      title: "Waiting resume tokens and requests leave read surfaces only as digests or redacted values",
      threat:
        "A viewer of run listings, facts, snapshots, or events obtains another run's resume token and resumes or answers its approval wait.",
      lookFor: [
        "A read model, fact, snapshot, or event that returns flows_runs waiting_token verbatim instead of a Sha256 digest.",
        "A waiting request copied into an observation without Redaction.redact.",
        "A resume path that accepts a token without matching it to the run id and current wait."
      ],
      paths: [
        "src/ExecutionFacts.ts",
        "src/ExecutionSnapshot.ts",
        "src/internal/ExecutionSnapshotRead.ts",
        "src/DurableEngineState.ts",
        "src/RunCatalogRead.ts",
        "src/RunChangeFeed.ts",
        "src/internal/TypedEvents.ts",
        "src/EngineStore.ts"
      ]
    },
    {
      id: "engine-jj-authority",
      title: "Engine-private Jj authority never reaches action bodies",
      threat:
        "A flow's action body gains the engine's snapshot and restore repository authority and rewrites the user's repository.",
      lookFor: [
        "EngineJj provided into an Effect that runs user action code.",
        "HostReflection or a test store helper in src exposing host services to action context."
      ],
      paths: [
        "src/internal/EngineJj.ts",
        "src/internal/HostReflection.ts",
        "src/internal/RunDriver.ts",
        "src/test/TestStores.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: {
    check,
    circular,
    disasterRecovery,
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
