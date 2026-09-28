import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
import { ReviewTagsMigrationsAndKeys } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  testProgram: Smithers.file("//packages/smithers/flows/database/scripts/test-matrix.mjs"),
  deps: [],
  cwd: "packages/smithers/flows/run-store"
})

/**
 * The durable-identity review: identity strings, migrations, persisted
 * schemas, and durable keys, read out of this package's own changed sources.
 *
 * @since 0.1.0
 * @category lint
 */
const reviewTagsMigrationsAndKeys = ReviewTagsMigrationsAndKeys({ cwd: "packages/smithers/flows/run-store" })

/**
 * Security review of the durable run and attempt stores: ownership fencing,
 * liveness evidence, JSON admission, and executable-state persistence.
 */
const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/run-store",
  include: ["src/**"],
  checks: [
    {
      id: "owner-fenced-writes",
      title: "Every run and attempt write is fenced on the exact running owner triple",
      threat:
        "A displaced or stale process overwrites another owner's run state, attempt outcome, or cancel acknowledgement.",
      lookFor: [
        "An UPDATE or INSERT on flows_runs or attempt rows that omits owner_host_id, owner_pid, or owner_nonce from its WHERE clause.",
        "A write whose owner values are read from the caller's object more than once instead of from the frozen snapshotOwner copy.",
        "A patch or finish path that succeeds after the run left status 'running' or its owner columns were cleared."
      ],
      paths: ["src/RunStore.ts", "src/AttemptStore.ts"]
    },
    {
      id: "steal-evidence-binding",
      title:
        "Steal, claimAndOwn, and recoverClaim require evidence bound to the snapshot owner, host relation, and nowMs",
      threat:
        "A peer process takes over a live run it does not own and runs its side effects twice or corrupts its state.",
      lookFor: [
        "evidenceMatchesOwner accepting evidence whose expectedOwner differs from the snapshot owner or whose checkedAtMs differs from nowMs.",
        "A same-host-pid-dead verdict accepted from a claimant on another host, or cross-host-unreachable-stale from the owner's own host.",
        "A steal UPDATE that drops the heartbeat_at_ms staleness predicate or the NULL claim-column predicates."
      ],
      paths: ["src/RunStore.ts", "src/Ownership.ts"]
    },
    {
      id: "lease-clock-bounds",
      title: "Caller-supplied nowMs cannot run ahead of the store clock beyond the skew allowance",
      threat:
        "A caller with a forward-dated clock declares a fresh lease expired and steals or pins another owner's run.",
      lookFor: [
        "A lease operation (claim, claimAndOwn, steal, heartbeat, recoverClaim) that uses snapshotTimestamp instead of snapshotLeaseReading for nowMs.",
        "heartbeatWriteTolerance not strictly less than heartbeatStaleAfter minus skew allowance and one interval, letting a lapsed owner keep working after a steal."
      ],
      paths: ["src/RunStore.ts", "src/Heartbeat.ts", "src/Ownership.ts"]
    },
    {
      id: "pid-probe-scope",
      title: "The pid liveness probe only issues signal-0 checks on the claimant's own host",
      threat: "A forged or cross-host owner record makes the host signal or misjudge an unrelated local process.",
      lookFor: [
        "process.kill called with a signal other than 0, or with a pid that is not a positive safe integer.",
        "sameHostPidProbe probing a pid whose owner hostId differs from the claimant's hostId.",
        "An error other than ESRCH treated as proof of death."
      ],
      paths: ["src/Ownership.ts"]
    },
    {
      id: "json-admission-bounds",
      title: "Persisted and read-back JSON passes bounded admission before use",
      threat:
        "A flow author or corrupted row stores oversized or deeply nested JSON that exhausts memory or stack of every host that resumes the run.",
      lookFor: [
        "A JSON.parse on a stored column or input that is not routed through Boundary.admitJsonText or admitJson with byte, depth, and member limits.",
        "A limits object built without maxBytes or maxDepth for state, checkpoint, outcome, or metadata columns.",
        "Identifiers accepted without Boundary.isDurableText (length, NUL, lone surrogate checks)."
      ],
      paths: ["src/internal/Boundary.ts", "src/RunStore.ts", "src/AttemptStore.ts"]
    },
    {
      id: "sql-parameterization",
      title: "All SQL is built from tagged-template parameters, never interpolated strings",
      threat:
        "A run id, lineage id, or step key supplied by a flow injects SQL that reads or rewrites other runs' rows.",
      lookFor: [
        "sql.unsafe, sql.literal, or string concatenation into a query in store code or migrations.",
        "A lineage or list query without a bound on rows returned for an attacker-chosen lineage id."
      ],
      paths: ["src/RunStore.ts", "src/AttemptStore.ts", "src/migrations/**"]
    },
    {
      id: "lineage-cancel-scope",
      title: "Lineage reads and requestCancelLineage touch only rows of the resolved lineage",
      threat:
        "A caller cancelling or listing one logical run cancels or reads unrelated runs that share a run id or join a lineage they do not belong to.",
      lookFor: [
        "A lineage read or write that builds its own membership predicate instead of using lineageMembership.",
        "lineageMembership matching rows with a NULL lineage_id other than the resolved root, or all rows when the runId does not exist.",
        "create admitting a lineageId or parentRunId whose row does not exist or whose round_ordinal collides with an existing round."
      ],
      paths: ["src/RunStore.ts"]
    },
    {
      id: "executable-state-secrets",
      title: "Executable state is persisted verbatim without leaking credentials to spans, logs, or metrics",
      threat:
        "Anyone with trace or log access reads secrets that flows placed in run state, checkpoints, or owner acknowledgements.",
      lookFor: [
        "Effect.annotateCurrentSpan, log, or metric attributes that include state_json, checkpoint, outcome, or metadata values rather than ids.",
        "Error messages or RunStoreError causes that embed the rejected JSON payload text."
      ],
      paths: ["src/RunStore.ts", "src/AttemptStore.ts", "src/RunStoreMetrics.ts", "src/internal/SpanOutcome.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, reviewTagsMigrationsAndKeys, fmt, lib, lint, test, ...securityReview }
})
