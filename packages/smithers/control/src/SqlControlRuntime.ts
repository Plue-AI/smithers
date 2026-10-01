/**
 * Durable `ControlRuntime` over `@smthrs/journal`'s fenced `RunStore` and a
 * SQL database.
 *
 * `layerMemory` models the production seams but keeps everything in a `Map`, so
 * nothing it decides survives the process. This adapter supplies the durable
 * boundary the header of `ControlRuntime` describes.
 *
 * ## Where ownership lives
 *
 * The run lifecycle is not re-implemented here. `RunStore` already owns it, and
 * it is the piece that is hard to get right: every ownership move is a single
 * SQL compare-and-swap, so a stale writer loses the `UPDATE` rather than
 * racing a read-then-write. This module maps the control plane's vocabulary
 * onto it:
 *
 * | control status | `RunStore` status | ownership |
 * | --- | --- | --- |
 * | `accepted`, `running` | `running` | held by this process |
 * | `accepted` after an executor declines | `suspended` | released |
 * | `parked`, `waiting-approval` | `suspended` | released |
 * | `cancelled` / `completed` / `failed` | same | released, terminal |
 *
 * The authoritative `RunSummary` is written into the row's `state_json` by the
 * same fenced `UPDATE` that moves the status, so a projection can never be read
 * out of step with the lifecycle. `RunStore` has no list operation, so
 * `control_runs` is kept as a plain id index and each summary is read back
 * through the store rather than duplicated.
 *
 * ## Fences
 *
 * A fence is a serialized `OwnerId`. `hostId` and `pid` identify the process;
 * the `nonce` is regenerated on **every** claim, so a fence taken before a
 * park is not the fence held after the resume that follows it, and the stale
 * one is refused by the CAS. This is the `rangeID`-style monotonic fence from
 * `reference/temporal`'s history service, narrowed to a per-run token.
 *
 * ## Browser safety
 *
 * Nothing here imports `node:*`. Identity comes from `globalThis.crypto`, and
 * persistence is the driver-neutral SQL contract, so this module runs anywhere
 * `@smthrs/database` has a driver. Fibers are the exception and are
 * deliberately process-local: a fiber is a live continuation, not a row, and
 * cancellation is interruption of the fiber that this process owns.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as DurableWrites from "@smthrs/database/DurableWriter"
import { Ownership, RunStore } from "@smthrs/run-store"
import { Clock, Crypto, Effect, Fiber, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlError from "effect/unstable/sql/SqlError"
import * as ApprovalAuthority from "./ApprovalAuthority.ts"
import * as Attribution from "./Cancellation.ts"
import type { PlanInput } from "./Control.ts"
import {
  AlreadyResolved,
  ClaimLost,
  type CodeDrift,
  EnvelopeMismatch,
  FlowNotFound,
  InvalidInput,
  PersistenceError,
  PlanDenied,
  PlanDigestMismatch,
  PlanNotFound,
  RunNotFound,
  Unauthorized
} from "./ControlError.ts"
import * as ControlExecutor from "./ControlExecutor.ts"
import type {
  ApprovalToken,
  BulkGrant,
  IdPage,
  IdPageRequest,
  LaunchResult,
  MemoryFlow,
  PlanPage,
  PlanQuery,
  RunCursor,
  RunQuery,
  Service,
  StoredPlan
} from "./ControlRuntime.ts"
import { ApprovalDecision, ControlRuntime, idPageLimit, make } from "./ControlRuntime.ts"
import {
  ApprovalTarget,
  type Cancellation,
  Envelope,
  GrantScope,
  type IdempotencyKey,
  type PendingWait,
  PlanCard,
  PlanDecision,
  Principal,
  Receipt,
  type RunId,
  type RunStatus,
  RunSummary,
  SignalPayload
} from "./ControlSchema.ts"
import * as ActiveFibers from "./internal/activeFibers.ts"
import { canonicalIssue, cappedIssue, schemaIssuePath } from "./internal/issues.ts"
import {
  accepted,
  adoptedCode,
  alreadyApplied,
  budgeted,
  canonical,
  codeDriftOf,
  emptyEnvelope,
  planCard,
  planFingerprint,
  sameEnvelope
} from "./internal/planning.ts"
import { causeMessages, missingTable } from "./internal/sqlSchemaErrors.ts"
import * as Lineage from "./Lineage.ts"
import * as Migrations from "./Migrations.ts"
import { plannable } from "./SystemFlows.ts"

/**
 * A flow the durable runtime can plan.
 *
 * The same shape the memory runtime takes, so a composition can hand the same
 * catalog to either.
 *
 * @category models
 * @since 0.1.0
 */
export type DurableFlow = MemoryFlow

/**
 * Durable runtime configuration.
 *
 * `owner` is the process identity every claim is stamped with. When omitted,
 * one valid synthetic identity is minted for this runtime only, so separately
 * constructed runtimes cannot cross each other's fences. Hosts that can
 * report their real process identity should still supply it so liveness probes
 * can reason about the operating-system process.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly flows?: ReadonlyArray<DurableFlow> | undefined
  /**
   * Reads the current flow catalog for each plan and listing. When supplied,
   * this replaces `flows`, including the default system catalog. A host with
   * a refreshable registry should return one complete snapshot per call.
   * Existing plans retain the definition they were approved against.
   */
  readonly loadFlows?: (() => Effect.Effect<ReadonlyArray<DurableFlow>, PersistenceError>) | undefined
  /**
   * Reads each flow's code as it is on disk now, for the drift check that runs
   * before a run is re-driven and for the code an allowed drift adopts. A host
   * whose `loadFlows` answers from a cached snapshot supplies this, so a flow
   * edited or deleted after the run parked is refused before the claim rather
   * than found by the executor after it. Defaults to `loadFlows`.
   */
  readonly currentFlows?: (() => Effect.Effect<ReadonlyArray<DurableFlow>, PersistenceError>) | undefined
  /** Verifies a durable pinned source closure before consenting to resume it. */
  readonly pinnedFlow?:
    | ((flowId: string, digest: string) => Effect.Effect<boolean | undefined, PersistenceError>)
    | undefined
  /**
   * Makes one flow's code on disk now the code this host executes, for a
   * resume the operator allowed to drift, and answers the identity the host
   * can now run, or `undefined` when it can run none. A host whose executor
   * serves a loaded snapshot supplies this: recording a digest its executor
   * does not hold accepted the resume and then failed the run (#2740).
   * Defaults to the flow's entry in `currentFlows`.
   */
  readonly adoptFlow?:
    | ((flowId: string, runId: string) => Effect.Effect<DurableFlow | undefined, PersistenceError>)
    | undefined
  readonly owner?: Ownership.OwnerId | undefined
  /**
   * Whether the process a running run's owner names is still working. With
   * it, `resume` takes over a running run whose owner is gone (a host killed
   * mid-run) once that owner's lease has expired, instead of answering
   * `ClaimLost`; the run store verifies the expired lease. Without it a
   * running run belongs to its recorded owner for good.
   */
  readonly isAlive?: Ownership.LivenessCheck | undefined
  readonly principal?: Omit<Principal, "stampedAt"> | undefined
  readonly approvalAuthority?: ApprovalAuthority.Service | undefined
  /** The engine version stamped on every run this runtime starts. */
  readonly engineVersion?: string | undefined
}

const persistence = (operation: string) => (cause: unknown): PersistenceError =>
  new PersistenceError({
    operation,
    message: `Control runtime failed to ${operation}`,
    cause
  })

const storedFailure = (location: string, path: string, reason: string): PersistenceError =>
  new PersistenceError({
    operation: `decode ${location}`,
    message: `Control runtime could not decode ${location}: ${cappedIssue(path, reason)}`
  })

const decodeStoredValue = <S extends Schema.Top>(
  location: string,
  schema: S,
  value: unknown
): Effect.Effect<S["Type"], PersistenceError, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((error) =>
      storedFailure(location, schemaIssuePath(error), "stored value does not match its schema")
    )
  )

const decodeStoredJson = <S extends Schema.Top>(
  location: string,
  schema: S,
  json: string
): Effect.Effect<S["Type"], PersistenceError, S["DecodingServices"]> =>
  Effect.try({
    try: () => JSON.parse(json) as unknown,
    catch: () => storedFailure(location, "$", "stored value is not valid JSON")
  }).pipe(Effect.flatMap((value) => decodeStoredValue(location, schema, value)))

/** The admitting principal a signal command recorded, spread onto the command. */
/** `summary` with the launcher its run's launch index recorded, if any. */
const withLauncher = (
  summary: RunSummary,
  launcher: { readonly id: string; readonly kind: string } | undefined
): RunSummary => launcher === undefined ? summary : { ...summary, launchedBy: { id: launcher.id, kind: launcher.kind } }

const signalPrincipal = (
  json: string | null
): Effect.Effect<{ readonly principal?: Principal }, PersistenceError> =>
  json === null ? Effect.succeed({}) : Effect.map(
    decodeStoredJson("control_signal_commands.principal_json", Principal, json),
    (principal) => ({ principal })
  )

/** A random identifier that does not depend on any Node API. */
const randomId = (): string => globalThis.crypto.randomUUID()

const terminal = (status: RunStatus): boolean => status === "cancelled" || status === "completed" || status === "failed"

/**
 * The deepest nesting the wait walk climbs.
 *
 * It matches `@smthrs/engine-store` `waitingTreeMaxDepth` and exists for the
 * same reason: authored nesting is a handful of executions deep, and the cap
 * bounds the read of a tree whose edges were corrupted outside the engine.
 */
const maxWaitTreeDepth = 64

/**
 * Whether this database lacks the engine's wait-tree schema.
 *
 * Run-store installs the wait and trampoline columns before the engine
 * installs spawn edges and `execution_flow`. A control-only database can
 * lack the latter without making its ordinary run listings unreadable.
 */
const missingWaitTreeSchema = (cause: unknown): boolean =>
  missingTable("flows_runs")(cause) || missingTable("flows_run_parents")(cause) ||
  causeMessages(cause).some((message) => message.includes("execution_flow"))

/**
 * The question a park declared, as JSON, or nothing.
 *
 * The column is the wait's own text under a `json_valid` check, so text that
 * does not parse is text nothing wrote: it reads as a park that declared no
 * question rather than failing the listing it appears in.
 */
const declaredRequest = (value: string | null): { readonly request?: typeof Schema.Json.Type } => {
  if (value === null) return {}
  try {
    return { request: JSON.parse(value) as typeof Schema.Json.Type }
  } catch {
    return {}
  }
}

/** The `RunStore` status the control plane's status projects onto. */
const storeStatus = (status: RunStatus): RunStore.RunStatus => {
  switch (status) {
    case "accepted":
    case "running":
      return "running"
    case "parked":
    case "waiting-approval":
      return "suspended"
    default:
      return status
  }
}

/**
 * Whether two identities are the same *process*.
 *
 * The nonce is deliberately excluded: it is the per-claim fence, so a process
 * that re-claims a run has a new nonce but is still the same owner.
 */
const sameProcess = (left: Ownership.OwnerId, right: Ownership.OwnerId): boolean =>
  left.hostId === right.hostId && left.pid === right.pid

interface PlanRow {
  readonly planId: string
  readonly cardJson: string
  readonly decodedInputJson: string
  readonly decision: string
}

interface TokenRow {
  readonly tokenId: string
  readonly targetJson: string
  readonly resolved: number
  readonly decisionPrincipalJson: string | null
  readonly decisionJson: string | null
}

interface ApprovalIdentity {
  readonly targetTag: ApprovalTarget["_tag"]
  readonly runId: string
  readonly targetId: string
}

const approvalIdentity = (target: ApprovalTarget): ApprovalIdentity =>
  target._tag === "Plan"
    ? { targetTag: target._tag, runId: "", targetId: target.planId }
    : { targetTag: target._tag, runId: target.runId, targetId: target.requestId }

const sameApprovalIdentity = (left: ApprovalTarget, right: ApprovalTarget): boolean =>
  left._tag === "Plan"
    ? right._tag === "Plan" && left.planId === right.planId
    : right._tag === "Node" && left.runId === right.runId && left.requestId === right.requestId

const tokenFromRow = (
  row: TokenRow,
  target: ApprovalTarget
): Effect.Effect<ApprovalToken, PersistenceError> =>
  Effect.gen(function*() {
    const decision = row.decisionJson === null
      ? { _tag: "Pending" as const }
      : yield* decodeStoredJson("control_tokens.decision_json", ApprovalDecision, row.decisionJson)
    if (row.decisionJson === null && row.resolved === 1) {
      return yield* new PersistenceError({
        operation: "recover an approval decision",
        message:
          "This legacy approval erased its decision. Preserve the database for review; create a new run and request a new approval. It cannot safely resume through this gate."
      })
    }
    const expectedPrincipal = decision._tag === "Pending" ? undefined : decision.decisionPrincipal
    const storedPrincipal = row.decisionPrincipalJson === null
      ? undefined
      : yield* decodeStoredJson("control_tokens.decision_principal_json", Principal, row.decisionPrincipalJson)
    if (
      row.resolved !== (decision._tag === "Pending" ? 0 : 1) ||
      JSON.stringify(storedPrincipal) !== JSON.stringify(expectedPrincipal)
    ) {
      return yield* storedFailure(
        "control_tokens.decision_json",
        "$",
        "approval decision disagrees with its resolution"
      )
    }
    return {
      tokenId: row.tokenId,
      target,
      ...decision
    }
  })

/** Plans read per statement while a filtered plan page fills. */
const planScanBatch = 200

const CancelRequestPayload = Schema.Struct({
  principal: Schema.optional(Principal),
  reason: Schema.optional(Schema.String)
})

const EngineInterruptionPayload = Schema.Struct({
  outcome: Schema.optional(Schema.String),
  interruptedAtMs: Schema.optional(Schema.Number)
})

// Control only projects an engine-owned row's flow name. Importing the full
// engine state schema would add an engine-store runtime dependency, so this
// validates exactly the field this package reads and permits the remaining
// engine-owned fields to pass through the struct decoder unused.
const EngineStateProjection = Schema.Struct({ flowName: Schema.NonEmptyString })

/**
 * Creates every control-plane table.
 *
 * `RunStore`'s own migrations are the journal package's business and are
 * applied by its layer. A read-only client installs nothing.
 *
 * @category migrations
 * @since 0.1.0
 */
export const migrate: Effect.Effect<void, PersistenceError, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  // A read-only observer reads the schema it finds and installs nothing.
  if (Dialect.isReadOnly(sql)) return
  // A standalone runtime cannot record control's high-offset migration first:
  // that high-water mark would make later journal and run-store sets look
  // skipped. The idempotent bootstrap keeps standalone construction safe. The
  // cross-package follow-up is for the host to compose `Migrations.set` beside
  // the journal and run-store sets before it constructs any adapter.
  // Reuse the canonical migration set and the shared transaction/retry policy,
  // without advancing the shared migration ledger during standalone bootstrap.
  yield* DurableWrites.make(sql).write(
    Effect.forEach(Object.values(Migrations.set.migrations), (migration) => migration, { discard: true })
  )
}).pipe(Effect.mapError(persistence("migrate")))

/**
 * Constructs a durable runtime over the ambient database and run store.
 *
 * Not exported under this name: `make` below is the single public constructor.
 * Exporting both put two names for one function on the package's public
 * surface, and only one of them was documented.
 */
const makeRuntime = (
  options: Options = {}
): Effect.Effect<
  Service,
  PersistenceError,
  Crypto.Crypto | DurableWriter | SqlClient.SqlClient | RunStore.RunStore
> => {
  // Snapshot before the Effect starts: construction options are caller-owned
  // and may be mutated while migrations or service acquisition are suspended.
  const owner: Ownership.OwnerId = options.owner === undefined
    ? Object.freeze({
      hostId: `control-runtime-${randomId()}`,
      pid: 1,
      nonce: randomId()
    })
    : Object.freeze({ ...options.owner })
  const isAlive = options.isAlive
  const approvalAuthority = options.approvalAuthority ?? ApprovalAuthority.local
  const authorizeApproval = approvalAuthority.authorize.bind(approvalAuthority)

  return Effect.gen(function*() {
    const crypto = yield* Crypto.Crypto
    const writer = yield* DurableWriter
    const runStore = yield* RunStore.RunStore
    yield* migrate
    const sql = yield* Effect.service(SqlClient.SqlClient)

    const configuredFlows = options.flows ?? plannable.map((entry): DurableFlow => ({
      flowId: entry.flowId,
      description: `Reserved ${entry.verb} system flow`,
      deployClass: entry.deployClass,
      envelope: emptyEnvelope
    }))
    const readFlows = (options.loadFlows === undefined
      ? Effect.succeed(configuredFlows)
      : Effect.suspend(options.loadFlows)).pipe(
        Effect.map((entries) => new Map(entries.map((flow) => [flow.flowId, flow] as const)))
      )
    const readCurrentFlows = options.currentFlows === undefined
      ? readFlows
      : Effect.suspend(options.currentFlows).pipe(
        Effect.map((entries) => new Map(entries.map((flow) => [flow.flowId, flow] as const)))
      )
    const readAdoptedFlow = (flowId: string, runId: string) =>
      options.adoptFlow === undefined
        ? readCurrentFlows.pipe(Effect.map((flows) => flows.get(flowId)))
        : Effect.suspend(() => options.adoptFlow!(flowId, runId))

    // Fibers are live continuations, not rows. A restarted process legitimately
    // has none, and interrupting a run it does not own is the other process's
    // job — so this map is process-local by design, not by omission.
    const fibers = new Map<RunId, Fiber.Fiber<unknown, unknown>>()
    let pendingSignalCursor = 0

    const now = Clock.currentTimeMillis

    const query = <A>(operation: string) => (effect: Effect.Effect<ReadonlyArray<A>, unknown>) =>
      effect.pipe(Effect.mapError(persistence(operation)))

    /**
     * Runs a read that may fail on a missing table or column, and is caught.
     *
     * Inside an enclosing transaction the read takes a savepoint, because a
     * failed statement aborts a PostgreSQL transaction and the catch could not
     * recover it. Outside one it runs bare: on SQLite a top-level transaction
     * is `BEGIN IMMEDIATE`, which takes the write lock for a read and fails a
     * contender with `SQLITE_BUSY` while another plane holds the claim.
     */
    const probe = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError.SqlError, R> =>
      Effect.flatMap(
        Effect.serviceOption(sql.transactionService),
        (enclosing): Effect.Effect<A, E | SqlError.SqlError, R> =>
          Option.isSome(enclosing) ? sql.withTransaction(effect) : effect
      )

    /** Allocates the next value of a durable counter inside one transaction. */
    const nextSequence = (name: string): Effect.Effect<number, PersistenceError> =>
      writer.write(Effect.gen(function*() {
        yield* sql`INSERT INTO control_sequences (name, value) VALUES (${name}, 0) ON CONFLICT (name) DO NOTHING`
        const rows = yield* sql<{ readonly value: number }>`
          UPDATE control_sequences SET value = value + 1
          WHERE name = ${name} AND value < ${Number.MAX_SAFE_INTEGER} RETURNING value
        `
        const value = Number(rows[0]?.value)
        if (!Number.isSafeInteger(value) || value < 1) {
          return yield* Effect.fail(new Error(`Sequence ${name} did not return a positive safe integer`))
        }
        return value
      })).pipe(Effect.mapError(persistence("allocate a sequence")))

    const readPlan = (planId: string): Effect.Effect<Option.Option<PlanRow>, PersistenceError> =>
      sql<PlanRow>`
        SELECT plan_id AS "planId", card_json AS "cardJson",
               decoded_input_json AS "decodedInputJson", decision
        FROM control_plans WHERE plan_id = ${planId}
      `.pipe(query("read a plan"), Effect.map((rows) => Option.fromNullishOr(rows[0])))

    const storedPlan = (row: PlanRow): Effect.Effect<StoredPlan, PersistenceError> =>
      Effect.all({
        card: decodeStoredJson("control_plans.card_json", PlanCard, row.cardJson),
        decodedInput: decodeStoredJson("control_plans.decoded_input_json", Schema.Json, row.decodedInputJson),
        decision: decodeStoredValue("control_plans.decision", PlanDecision, row.decision)
      })

    const requirePlan = (planId: string): Effect.Effect<PlanRow, PlanNotFound | PersistenceError> =>
      Effect.flatMap(
        readPlan(planId),
        Option.match({
          onNone: () => Effect.fail(new PlanNotFound({ planId })),
          onSome: Effect.succeed
        })
      )

    /**
     * Reads a run row, translating a missing row into `RunNotFound` and every
     * other store failure into `PersistenceError` — never a defect.
     */
    const requireRow = (runId: RunId): Effect.Effect<RunStore.RunRow, RunNotFound | PersistenceError> =>
      runStore.get(runId).pipe(
        Effect.mapError((error) =>
          error.code === "not_found_row"
            ? new RunNotFound({ runId })
            : persistence("read a run")(error)
        )
      )

    /**
     * The control status a store status projects back onto.
     *
     * The forward map is lossy — `accepted` and `running` both store as
     * `running` — so a run this plane did not launch is reported under the
     * status the store can actually prove.
     */
    const controlStatus = (status: RunStore.RunStatus): RunStatus => {
      switch (status) {
        case "pending":
          return "accepted"
        case "running":
          return "running"
        case "suspended":
          return "parked"
        default:
          return status
      }
    }

    type DecodedRunState =
      | { readonly _tag: "Control"; readonly summary: RunSummary }
      | { readonly _tag: "Engine"; readonly flowName: string }

    /**
     * Decodes one state row once, then validates the projection its keys name.
     * A control summary and an engine state share the column but not a schema.
     */
    const decodeRunState = (stateJson: string): Effect.Effect<DecodedRunState, PersistenceError> =>
      Effect.gen(function*() {
        const parsed = yield* decodeStoredJson("flows_runs.state_json", Schema.Json, stateJson)
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const candidate = parsed as Readonly<Record<string, unknown>>
          if ("runId" in candidate || "flowId" in candidate || "status" in candidate) {
            return {
              _tag: "Control",
              summary: yield* decodeStoredValue("flows_runs.state_json as RunSummary", RunSummary, parsed)
            }
          }
        }
        const engine = yield* decodeStoredValue(
          "flows_runs.state_json as engine state",
          EngineStateProjection,
          parsed
        )
        return { _tag: "Engine", flowName: engine.flowName }
      })

    const optional = <A>(value: A | null | undefined): { readonly value?: A } =>
      value === null || value === undefined ? {} : { value }

    /**
     * How much of the database one projection needs to read.
     *
     * A page needs only its selected runs and their ancestor chains. Cascade
     * attribution walks ancestors and stops, so a page or a single-run
     * mutation does not project unrelated runs, and no read projects them all.
     */
    type IndexScope = ReadonlyArray<string>

    /** `WHERE` material narrowing a column to a scope. */
    const within = (column: string, scope: IndexScope) => sql.in(column, scope as Array<string>)

    /**
     * The two facts a run row cannot tell about itself.
     */
    interface AncestryIndex {
      /** Run ids a `fork-created` marker names. */
      readonly forked: ReadonlySet<string>
      /** The run that spawned each child, by child id. */
      readonly spawnedBy: ReadonlyMap<string, string>
      /** What each parked run is waiting for, by run id. */
      readonly waitingFor: ReadonlyMap<string, string>
      /** Open human waits in each run's tree, by the run that contains them. */
      readonly humanWaits: ReadonlyMap<string, ReadonlyArray<PendingWait>>
      /** Who cancelled each cancelled run, by run id. */
      readonly cancellations: ReadonlyMap<string, Cancellation>
      /** The outstanding resume delegation of each run that has one. */
      readonly pendingResumes: ReadonlyMap<string, number>
    }

    /**
     * Projects a run row onto a control summary, ancestry included.
     *
     * Ancestry reaches the row from two different places, because the engine
     * records two different relationships. `parent_run_id` is the trampoline
     * chain — the round before this one — and it is the only ancestry a run
     * row carries. A run another run SPAWNED records nothing in its own row:
     * the edge lives in `flows_run_parents`, which is the subflow DAG cycle
     * detection walks (`packages/smithers/flows/run-store/src/migrations/0002_lineage.ts`).
     * A projection that read the column alone would report every child of
     * every run as an orphan.
     *
     * The column wins when both exist, which is the case for round 1 of a run
     * that was itself spawned: the round's nearest ancestor is the round
     * before it, not the run that spawned round 0.
     *
     * @param row the run row
     * @param ancestry the fork markers and spawn edges of the whole database
     */
    const baseSummary = (row: RunStore.RunRow, state: DecodedRunState): RunSummary =>
      state._tag === "Control"
        ? state.summary
        : {
          runId: row.runId,
          flowId: state.flowName,
          status: controlStatus(row.status),
          createdAt: row.createdAtMs,
          updatedAt: row.finishedAtMs ?? row.startedAtMs ?? row.createdAtMs
        }

    const summaryFrom = (
      row: RunStore.RunRow,
      ancestry: AncestryIndex
    ): Effect.Effect<RunSummary, PersistenceError> =>
      Effect.gen(function*() {
        const base = withLauncher(baseSummary(row, yield* decodeRunState(row.stateJson)), yield* launcherOf(row.runId))
        const parentRunId = optional(row.parentRunId).value ?? ancestry.spawnedBy.get(row.runId)
        const lineageId = optional(row.lineageId).value
        const roundOrdinal = optional(row.roundOrdinal).value
        const origin = Lineage.originOf({
          ...(parentRunId === undefined ? {} : { parentRunId }),
          ...(roundOrdinal === undefined ? {} : { roundOrdinal }),
          forked: ancestry.forked.has(row.runId)
        })
        const waitingReason = ancestry.waitingFor.get(row.runId)
        const cancellation = ancestry.cancellations.get(row.runId)
        const pendingResume = ancestry.pendingResumes.get(row.runId)
        const pendingWaits = ancestry.humanWaits.get(row.runId)
        return {
          ...base,
          // A run whose tree holds an open human wait is waiting on a human,
          // however nested the row that holds it and whether or not its own row
          // has flipped to parked yet: a parent awaiting a `.child()` is
          // blocked on that child's question either way. Rolling the status up
          // is what lets every existing `status: "waiting-approval"` filter —
          // the gateway inbox, `smithers approvals list`, the diagnosis card —
          // find a `HumanTask` parked on a descendant.
          //
          // Only ATTACHED waits reach here. A `detach` spawn outlives the run
          // that started it (`@smthrs/engine-store` `RunState.onParentExit`),
          // so the walk stops at one rather than telling a reader that a run
          // which can proceed cannot.
          ...(pendingWaits === undefined ? {} : { pendingWaits }),
          ...(pendingWaits === undefined || terminal(base.status)
            ? {}
            : { status: "waiting-approval" as const }),
          ...(pendingResume === undefined ? {} : { pendingResume }),
          ...(parentRunId === undefined ? {} : { parentRunId }),
          ...(lineageId === undefined ? {} : { lineageId }),
          ...(roundOrdinal === undefined ? {} : { roundOrdinal }),
          ...(origin === undefined ? {} : { origin }),
          ...(waitingReason === undefined ? {} : { waitingReason }),
          ...(cancellation === undefined ? {} : { cancellation })
        }
      })

    /**
     * The runs a `fork-created` marker names.
     *
     * Time travel writes the marker on the forked child's own journal, which
     * is the only evidence separating a fork from an ordinary child: both
     * record `parent_run_id`. A composition whose journal is not this database
     * has no journal table here at all, and the honest answer there is "no
     * fork evidence" — not a failed projection — so exactly that one failure
     * is folded into the empty set.
     *
     * Every other failure is reported. A locked database, a corrupt page, or
     * a table that exists but no longer answers this question would otherwise
     * report every fork in the deployment as an ordinary child, silently and
     * for as long as the condition lasted.
     */
    const forkedRunIds = (scope: IndexScope): Effect.Effect<ReadonlySet<string>, PersistenceError> =>
      sql<{ readonly runId: string }>`
      SELECT DISTINCT run_id AS "runId" FROM flows_journal_events
      WHERE event_type = ${Lineage.forkCreatedEventType} AND ${within("run_id", scope)}
    `.pipe(
        Effect.map((rows) => new Set(rows.map((row) => row.runId)) as ReadonlySet<string>),
        Effect.catchIf(
          missingTable("flows_journal_events"),
          () => Effect.succeed(new Set<string>() as ReadonlySet<string>)
        ),
        Effect.mapError(persistence("read fork markers"))
      )

    /**
     * The run that spawned each child, by child id.
     *
     * `seq` is the engine's store-global insertion order, so the FIRST edge is
     * the creating parent. A diamond's later parents are edges too, and a
     * summary names one ancestor, so the creating one is the one it names.
     *
     * Missing table, missing evidence, exactly as with the fork markers: a
     * control plane over a database with no engine state in it observes runs
     * that spawned nothing.
     */
    const spawnedBy = (scope: IndexScope): Effect.Effect<ReadonlyMap<string, string>, PersistenceError> =>
      sql<{
        readonly childId: string
        readonly parentId: string
      }>`
      SELECT child_id AS "childId", parent_id AS "parentId"
      FROM flows_run_parents WHERE ${within("child_id", scope)} ORDER BY seq DESC
    `.pipe(
        probe,
        // Descending, so the lowest `seq` is written last and wins the key.
        Effect.map((rows) => new Map(rows.map((row) => [row.childId, row.parentId])) as ReadonlyMap<string, string>),
        Effect.catchIf(
          missingTable("flows_run_parents"),
          () => Effect.succeed(new Map<string, string>() as ReadonlyMap<string, string>)
        ),
        Effect.mapError(persistence("read spawn edges"))
      )

    /**
     * What each parked run is waiting for, by run id.
     *
     * The engine writes `waiting_reason` on the run row when it parks a run
     * (`packages/smithers/flows/engine-store/src/DurableEngineState.ts` `park`), and clears
     * it on the wake. The control plane reads it and never writes it: a park
     * belongs to whoever is holding the run, and the projection reports the
     * hold rather than deciding it.
     *
     * The reason separates the parks a steer can end from the parks it
     * cannot, so `Control.steer` needs it on the summary and not only in the
     * engine's own store.
     */
    const waitingFor = (scope: IndexScope): Effect.Effect<ReadonlyMap<string, string>, PersistenceError> =>
      sql<{
        readonly runId: string
        readonly waitingReason: string
      }>`
      SELECT run_id AS "runId", waiting_reason AS "waitingReason"
      FROM flows_runs WHERE waiting_reason IS NOT NULL AND ${within("run_id", scope)}
    `.pipe(
        Effect.map((rows) => new Map(rows.map((row) => [row.runId, row.waitingReason])) as ReadonlyMap<string, string>),
        Effect.mapError(persistence("read waiting reasons"))
      )

    /**
     * Open human waits in each run's tree, by every run that contains one.
     *
     * The walk goes UP, not down. Approval parks are rare and run trees are
     * shallow, so start from the parked rows and climb every spawn and
     * trampoline edge; starting from every run in scope and descending would
     * re-walk the whole forest to find the same few rows. A wait therefore
     * appears under its own execution AND under every ancestor of it, which
     * is exactly what "does this run tree owe anybody an answer" asks.
     *
     * The scope filters the ANCESTOR, not the parked row: a listing wants the
     * waits of the runs it is about to return, wherever those waits are held.
     *
     * Collapse paths to each wait/ancestor pair at their shortest depth so
     * shared descendants and cycles cannot duplicate or reorder a wait.
     * A database without the engine's wait-tree schema observes no nested
     * waits rather than failing every listing.
     */
    const humanWaits = (scope: IndexScope): Effect.Effect<
      ReadonlyMap<string, ReadonlyArray<PendingWait>>,
      PersistenceError
    > =>
      sql<{
        readonly ancestorId: string
        readonly runId: string
        readonly flowId: string | null
        readonly waitingReason: string
        readonly waitingToken: string | null
        readonly waitingRequest: string | null
        readonly createdAtMs: number
        readonly depth: number
      }>`
      WITH RECURSIVE human_waits(wait_run_id, ancestor_id, depth) AS (
        SELECT run_id, run_id, 0 FROM flows_runs
        WHERE waiting_reason = ${ControlExecutor.humanWaitReason}
          AND status NOT IN ('completed', 'failed', 'cancelled')
        UNION
        SELECT human_waits.wait_run_id, parent.run_id, human_waits.depth + 1
        FROM flows_runs step JOIN human_waits ON step.run_id = human_waits.ancestor_id
        JOIN flows_runs parent ON parent.run_id IN (
          SELECT parent_id FROM flows_run_parents WHERE child_id = step.run_id
          UNION ALL
          SELECT step.parent_run_id WHERE step.parent_run_id IS NOT NULL
        )
        WHERE human_waits.depth < ${maxWaitTreeDepth}
          AND (parent.run_id = step.parent_run_id
            OR COALESCE(${Dialect.jsonText(sql, sql`step.state_json`, "$.onParentExit")}, 'cancel') <> 'detach')
      ), reachable(wait_run_id, ancestor_id, depth) AS (
        SELECT wait_run_id, ancestor_id, MIN(depth) FROM human_waits GROUP BY wait_run_id, ancestor_id
      )
      SELECT
        reachable.ancestor_id AS "ancestorId",
        reachable.depth AS "depth",
        parked.run_id AS "runId",
        parked.execution_flow AS "flowId",
        parked.waiting_reason AS "waitingReason",
        parked.waiting_token AS "waitingToken",
        parked.waiting_request AS "waitingRequest",
        parked.created_at_ms AS "createdAtMs"
      FROM reachable JOIN flows_runs parked ON parked.run_id = reachable.wait_run_id
      WHERE ${within("reachable.ancestor_id", scope)}
      ORDER BY reachable.ancestor_id, reachable.depth, parked.created_at_ms, parked.run_id
    `.pipe(
        probe,
        Effect.map((rows) => {
          const index = new Map<string, Array<PendingWait>>()
          for (const row of rows) {
            const built = ControlExecutor.pendingWaitOf({
              runId: row.runId,
              reason: row.waitingReason,
              token: row.waitingToken,
              createdAt: row.createdAtMs,
              ...(row.flowId === null ? {} : { flowId: row.flowId }),
              ...declaredRequest(row.waitingRequest)
            })
            if (built === undefined) continue
            const waits = index.get(row.ancestorId) ?? []
            waits.push(built)
            index.set(row.ancestorId, waits)
          }
          return index
        }),
        Effect.catchIf(
          missingWaitTreeSchema,
          () => Effect.succeed(new Map<string, ReadonlyArray<PendingWait>>())
        ),
        Effect.mapError(persistence("read nested human waits"))
      )

    /**
     * The attributed cancel requests this plane journaled, by run id.
     *
     * The FIRST entry for a run wins. A cancel is idempotent, so a repeat asks
     * for something that already happened; the request that caused the
     * cancellation is the one that gets to name the principal and the reason.
     */
    const cancelRequests = (
      scope: IndexScope
    ): Effect.Effect<ReadonlyMap<string, Attribution.Request>, PersistenceError> =>
      sql<{
        readonly runId: string
        readonly emittedAtMs: number
        readonly payloadJson: string
      }>`
      SELECT run_id AS "runId", emitted_at_ms AS "emittedAtMs", payload_json AS "payloadJson"
      FROM flows_journal_events
      WHERE event_type = ${Attribution.requestedEventType} AND ${within("run_id", scope)}
      ORDER BY run_id, seq
    `.pipe(
        Effect.catchIf(
          missingTable("flows_journal_events"),
          () =>
            Effect.succeed(
              new Array<{ readonly runId: string; readonly emittedAtMs: number; readonly payloadJson: string }>()
            )
        ),
        Effect.mapError(persistence("read cancel requests")),
        Effect.flatMap((rows) =>
          Effect.gen(function*() {
            const requests = new Map<string, Attribution.Request>()
            for (const row of rows) {
              if (requests.has(row.runId)) continue
              const payload = yield* decodeStoredJson(
                "flows_journal_events.payload_json for control.run.cancel-requested",
                CancelRequestPayload,
                row.payloadJson
              )
              requests.set(row.runId, {
                requestedAt: Number(row.emittedAtMs),
                ...(payload.principal === undefined ? {} : { principal: payload.principal }),
                ...(payload.reason === undefined ? {} : { reason: payload.reason })
              })
            }
            return requests
          })
        )
      )

    /**
     * When the engine journaled each run's interruption.
     *
     * The engine writes this record in the same transaction as the `cancelled`
     * transition (`packages/smithers/flows/engine-store/src/internal/RunDriver.ts`), so it is
     * the moment a cancellation actually took, as opposed to the moment
     * somebody asked. A run cancelled by a peer process that never wrote a
     * request column still has this.
     */
    const engineInterruptions = (scope: IndexScope): Effect.Effect<ReadonlyMap<string, number>, PersistenceError> =>
      sql<{
        readonly runId: string
        readonly payloadJson: string
      }>`
      SELECT run_id AS "runId", payload_json AS "payloadJson"
      FROM flows_journal_events
      WHERE event_type = ${Attribution.interruptedEventType} AND ${within("run_id", scope)}
    `.pipe(
        Effect.catchIf(
          missingTable("flows_journal_events"),
          () => Effect.succeed(new Array<{ readonly runId: string; readonly payloadJson: string }>())
        ),
        Effect.mapError(persistence("read engine interruptions")),
        Effect.flatMap((rows) =>
          Effect.gen(function*() {
            const cancelled = new Map<string, number>()
            for (const row of rows) {
              const payload = yield* decodeStoredJson(
                "flows_journal_events.payload_json for flows.engine.interrupted",
                EngineInterruptionPayload,
                row.payloadJson
              )
              if (payload.outcome !== "cancelled") continue
              cancelled.set(row.runId, Number(payload.interruptedAtMs ?? 0))
            }
            return cancelled
          })
        )
      )

    /**
     * The ancestry and cancel columns of every run row.
     *
     * Cascade is a fact about a run's ancestors, so the attribution cannot be
     * decided a row at a time: the request that cancelled a child may be three
     * rounds up the chain.
     */
    const cancelEvidence = (scope: IndexScope): Effect.Effect<
      ReadonlyArray<{
        readonly runId: string
        readonly parentRunId: string | null
        readonly cancelRequestedAtMs: number | null
      }>,
      PersistenceError
    > =>
      sql<{
        readonly runId: string
        readonly parentRunId: string | null
        readonly cancelRequestedAtMs: number | null
      }>`
      SELECT run_id AS "runId", parent_run_id AS "parentRunId",
             cancel_requested_at_ms AS "cancelRequestedAtMs"
      FROM flows_runs WHERE ${within("run_id", scope)}
    `.pipe(Effect.mapError(persistence("read cancel evidence")))

    /** Every cancelled run's attribution in the scope, folded in one pass. */
    const cancellations = (scope: IndexScope): Effect.Effect<ReadonlyMap<string, Cancellation>, PersistenceError> =>
      Effect.map(
        Effect.all({
          rows: cancelEvidence(scope),
          requests: cancelRequests(scope),
          interrupted: engineInterruptions(scope),
          spawnedBy: spawnedBy(scope)
        }),
        ({ interrupted, requests, rows, spawnedBy }) =>
          Attribution.attribute({
            runs: rows.map((row) => {
              const parentRunId = row.parentRunId ?? spawnedBy.get(row.runId)
              const cancelledAt = interrupted.get(row.runId)
              return {
                runId: row.runId,
                ...(parentRunId === undefined || parentRunId === null ? {} : { parentRunId }),
                ...(row.cancelRequestedAtMs === null ? {} : { cancelRequestedAt: Number(row.cancelRequestedAtMs) }),
                ...(cancelledAt === undefined ? {} : { cancelledAt })
              }
            }),
            requests
          })
      )

    /**
     * The outstanding resume delegation of each run in the scope.
     *
     * Read from `control_run_resumes` rather than from the journal because the
     * question is "what has not been taken up yet", which a log of what was
     * asked cannot answer without a per-run cursor.
     */
    const pendingResumeIndex = (scope: IndexScope): Effect.Effect<ReadonlyMap<string, number>, PersistenceError> =>
      sql<{ readonly runId: string; readonly requestedSeq: number }>`
      SELECT run_id AS "runId", requested_seq AS "requestedSeq"
      FROM control_run_resumes WHERE ${within("run_id", scope)}
    `.pipe(
        Effect.map((rows) =>
          new Map(rows.map((row) => [row.runId, Number(row.requestedSeq)] as const)) as ReadonlyMap<string, number>
        ),
        Effect.mapError(persistence("read pending resumes"))
      )

    /** Every index a projection needs over one scope, read together. */
    const ancestryIndex = (scope: IndexScope): Effect.Effect<AncestryIndex, PersistenceError> =>
      Effect.map(
        Effect.all({
          forked: forkedRunIds(scope),
          spawnedBy: spawnedBy(scope),
          waitingFor: waitingFor(scope),
          humanWaits: humanWaits(scope),
          cancellations: cancellations(scope),
          pendingResumes: pendingResumeIndex(scope)
        }),
        (index): AncestryIndex => index
      )

    /**
     * One run and every ancestor above it, nearest first.
     *
     * The trampoline chain is one recursive read over `parent_run_id`. A
     * SPAWNED run records nothing in its own row, so when a chain runs out the
     * spawn edge is looked up and the walk continues from there — one extra
     * read per nesting level, and subflow nesting is shallow where a
     * trampoline is long. The visited set makes corrupt ancestry terminate
     * instead of taking the control plane down with it.
     */
    const ancestorChain = (runId: RunId): Effect.Effect<ReadonlyArray<string>, PersistenceError> =>
      Effect.gen(function*() {
        const chain: Array<string> = []
        const visited = new Set<string>()
        let start: string | undefined = runId
        while (start !== undefined && !visited.has(start)) {
          const rows = yield* sql<{ readonly runId: string; readonly parentRunId: string | null }>`
            WITH RECURSIVE ancestry(run_id, parent_run_id) AS (
              SELECT run_id, parent_run_id FROM flows_runs WHERE run_id = ${start}
              UNION
              SELECT runs.run_id, runs.parent_run_id
              FROM flows_runs runs JOIN ancestry ON runs.run_id = ancestry.parent_run_id
            )
            SELECT run_id AS "runId", parent_run_id AS "parentRunId" FROM ancestry
          `.pipe(Effect.mapError(persistence("walk a run's ancestry")))
          if (rows.length === 0) {
            // No row at all: the caller's own `requireRow` reports that.
            chain.push(start)
            break
          }
          let last: string | undefined
          for (const row of rows) {
            if (visited.has(row.runId)) continue
            visited.add(row.runId)
            chain.push(row.runId)
            if (row.parentRunId === null) last = row.runId
          }
          // The chain ended at a row naming no parent. A run somebody SPAWNED
          // records its parent in the edge table instead, so the walk
          // continues from there.
          const spawn = last === undefined ? undefined : (yield* spawnedBy([last])).get(last)
          start = spawn
        }
        return chain
      })

    /**
     * One run row as a control summary, whoever wrote the row.
     *
     * `flows_runs.state_json` is `@smthrs/run-store`'s column and it has two
     * writers: this plane stores a `RunSummary` there, and the engine stores
     * its own `RunState` (`version`, `flowName`, `payload`). Decoding the
     * column as a `RunSummary` outright therefore failed
     * `PersistenceError` for every engine-created run before the caller could
     * reach the answer it was owed: `interrupt` reads the summary before it
     * asks who owns the row, so cancelling a run the ENGINE owns reported a
     * corrupt database instead of the `ClaimLost` that lets `Control.cancel`
     * fall back to the durable request, and `resume` failed the same way
     * before it could delegate to the owning driver.
     *
     * `baseSummary` already projects both shapes for listings. Sharing it here
     * keeps one answer for one row: a control row decodes to the summary it
     * stored, and an engine row is projected from the columns the run store
     * owns. Nothing writes back through this path except a transition this
     * plane's own fence authorized, which is a control row by construction.
     */
    const summaryOf = (row: RunStore.RunRow): Effect.Effect<RunSummary, PersistenceError> =>
      Effect.zipWith(
        decodeRunState(row.stateJson),
        launcherOf(row.runId),
        (state, launcher) => withLauncher(baseSummary(row, state), launcher)
      )

    const snapshotOf = (row: RunStore.RunRow): RunStore.RunSnapshot => ({
      status: row.status,
      owner: row.owner,
      heartbeatAtMs: row.heartbeatAtMs
    })

    // A type predicate, not a plain boolean: a row this process owns has a
    // non-null owner by construction, and the callers hand `row.owner` straight
    // to the fenced transitions.
    const ownedByUs = (
      row: RunStore.RunRow
    ): row is RunStore.RunRow & { readonly owner: Ownership.OwnerId } =>
      row.status === "running" && row.owner !== null && sameProcess(row.owner, owner)

    /**
     * Moves a run this process owns to a new control status, writing the
     * projection in the same compare-and-swap. A lost fence is `ClaimLost`.
     */
    const transition = (
      runId: RunId,
      claim: Ownership.OwnerId,
      summary: RunSummary,
      status: RunStatus
    ): Effect.Effect<RunSummary, RunNotFound | ClaimLost | PersistenceError> =>
      Effect.gen(function*() {
        const timestamp = yield* now
        const next: RunSummary = {
          ...summary,
          status,
          updatedAt: timestamp,
          ...(storeStatus(status) === "running" ? {} : { ownerId: undefined }),
          // A park releases the owner columns, so the row itself stops saying
          // which process is hosting the execution. The fence it was parked
          // under is kept instead: it is what lets the host recognize its own
          // park, and every other process tell that the execution belongs to
          // one it cannot see (triage B-15). Any other status ends the park,
          // so it ends the record with it.
          parkedBy: storeStatus(status) === "suspended" ? JSON.stringify(claim) : undefined
        }
        const outcome = yield* runStore.transitionOwned(
          runId,
          claim,
          storeStatus(status),
          JSON.stringify(next)
        ).pipe(Effect.mapError(persistence("transition a run")))
        if (outcome._tag === "NotFound") return yield* Effect.fail(new RunNotFound({ runId }))
        if (outcome._tag !== "Transitioned") return yield* Effect.fail(new ClaimLost({ runId }))
        return next
      })

    /**
     * Evidence that a running row's owner is gone, from the configured
     * liveness check, or `undefined` when there is no check or the owner is
     * alive. A pid is evidence only on its own host; elsewhere the claim
     * rests on the expired lease the run store verifies.
     */
    const deadOwner = (
      row: RunStore.RunRow
    ): Effect.Effect<Ownership.LivenessEvidence | undefined> =>
      Effect.gen(function*() {
        if (isAlive === undefined || row.owner === null) return undefined
        const nowMs = yield* now
        const alive = yield* isAlive(row.owner, { claimant: owner, heartbeatAtMs: row.heartbeatAtMs, nowMs })
        if (alive) return undefined
        return {
          expectedOwner: row.owner,
          checkedAtMs: nowMs,
          kind: Ownership.sameHostIncarnation(row.owner, owner)
            ? "same-host-pid-dead" as const
            : "lease-expired" as const
        }
      })

    /**
     * Takes ownership of a suspended or pending run under a fresh nonce, or
     * of a running one whose owner `evidence` says is gone.
     */
    const claim = (
      runId: RunId,
      row: RunStore.RunRow,
      evidence?: Ownership.LivenessEvidence | undefined,
      adopted?: Pick<RunSummary, "executionDigest" | "engineVersion"> | undefined
    ): Effect.Effect<RunSummary, RunNotFound | ClaimLost | PersistenceError> =>
      Effect.gen(function*() {
        const timestamp = evidence?.checkedAtMs ?? (yield* now)
        const claimant: Ownership.OwnerId = { ...owner, nonce: randomId() }
        const outcome = yield* runStore.claimAndOwn(runId, snapshotOf(row), claimant, timestamp, evidence).pipe(
          Effect.mapError(persistence("claim a run"))
        )
        if (outcome._tag === "NotFound") return yield* Effect.fail(new RunNotFound({ runId }))
        if (outcome._tag !== "Activated") return yield* Effect.fail(new ClaimLost({ runId }))
        const summary = yield* summaryOf(row)
        return yield* transition(runId, claimant, {
          ...summary,
          ...adopted,
          ownerId: JSON.stringify(claimant)
        }, "accepted")
      })

    /**
     * The run's summary with the code identity it started on.
     *
     * A row with no control summary of its own (a trampoline round, or a fork
     * or child the engine wrote) records no identity, and checking it against
     * nothing let it resume on any code. It inherits the identity of its
     * nearest ancestor of the same flow that recorded one.
     */
    const recordedCode = (row: RunStore.RunRow): Effect.Effect<RunSummary, PersistenceError> =>
      Effect.gen(function*() {
        const summary = yield* summaryOf(row)
        const seen = new Set<string>([row.runId])
        let parentId = optional(row.parentRunId).value ?? summary.parentRunId
        while (
          summary.executionDigest === undefined && summary.engineVersion === undefined &&
          parentId !== undefined && !seen.has(parentId)
        ) {
          seen.add(parentId)
          const parentRow = yield* requireRow(parentId).pipe(
            Effect.catchTag("/control/RunNotFound", () => Effect.succeed(undefined))
          )
          if (parentRow === undefined) break
          const parent = yield* summaryOf(parentRow)
          if (parent.flowId !== summary.flowId) break
          if (parent.executionDigest !== undefined || parent.engineVersion !== undefined) {
            return { ...summary, executionDigest: parent.executionDigest, engineVersion: parent.engineVersion }
          }
          parentId = optional(parentRow.parentRunId).value ?? parent.parentRunId
        }
        return summary
      })

    /**
     * The code identity an allowed drift records, read before the claim: a
     * flow this host cannot run leaves the run where it was rather than
     * accepted and then failed (#2740).
     */
    const adoptable = (
      row: RunStore.RunRow
    ): Effect.Effect<Pick<RunSummary, "executionDigest" | "engineVersion">, CodeDrift | PersistenceError> =>
      Effect.gen(function*() {
        const summary = yield* summaryOf(row)
        const flow = yield* readAdoptedFlow(summary.flowId, summary.runId)
        const gone = flow === undefined
          ? codeDriftOf(yield* recordedCode(row), undefined, options.engineVersion)
          : undefined
        if (gone !== undefined) return yield* gone
        return adoptedCode(summary, flow, options.engineVersion)
      })

    /** `resume`, recording the identity `adopt` answers on the claimed run when given. */
    const resumeRun = <E = never>(
      runId: RunId,
      scope: "launched" | "any" | undefined,
      adopt?:
        | ((row: RunStore.RunRow) => Effect.Effect<Pick<RunSummary, "executionDigest" | "engineVersion">, E>)
        | undefined
    ): Effect.Effect<RunSummary, RunNotFound | ClaimLost | PersistenceError | E> =>
      Effect.gen(function*() {
        const row = yield* requireRow(runId)
        const summary = yield* summaryOf(row)
        if (terminal(summary.status)) return summary
        // Start-or-join: owning the run already means resume is a no-op.
        if (ownedByUs(row)) return summary
        // Parking clears ownership, but the detached host can still be alive.
        // Public resume may take its park only after a same-host dead-pid
        // probe; otherwise the caller would steal and interrupt its execution.
        // The refusal names that host, so `Control.resume` hands the resume
        // to it instead (#3342). Trusted host claims remain able to reclaim
        // their engine's execution.
        if (scope === "launched" && row.status === "suspended" && summary.parkedBy !== undefined) {
          const parkedOwner = yield* decodeStoredJson("parked host", Ownership.OwnerId, summary.parkedBy)
          if (!sameProcess(parkedOwner, owner)) {
            const alive = isAlive === undefined || !Ownership.sameHostIncarnation(parkedOwner, owner)
              ? true
              : yield* isAlive(parkedOwner, { claimant: owner, heartbeatAtMs: row.heartbeatAtMs, nowMs: yield* now })
            if (alive) {
              return yield* new ClaimLost({
                runId,
                reason: "The host that parked this run is still alive or its liveness is unknown",
                parkedBy: { hostId: parkedOwner.hostId, pid: parkedOwner.pid }
              })
            }
          }
        }
        // Every public Control resume and steer wake uses launched scope.
        // Engine-created runs keep their continuation and driver. Unrestricted
        // claims are a trusted low-level capability for hosts that can drive
        // the execution; node approval delegates through requestResume instead.
        if (scope === "launched") {
          const indexed = yield* sql`SELECT run_id FROM control_runs WHERE run_id = ${runId}`.pipe(
            Effect.mapError(persistence("read the launch index"))
          )
          if (indexed.length === 0) return yield* new ClaimLost({ runId })
        }
        // A run owned by a live peer is theirs to drive. A run whose owner is
        // gone is taken over, with the evidence the run store checks.
        if (row.status === "running") {
          const evidence = yield* deadOwner(row)
          return evidence === undefined
            ? yield* new ClaimLost({ runId })
            : yield* claim(runId, row, evidence, adopt === undefined ? undefined : yield* adopt(row))
        }
        return yield* claim(runId, row, undefined, adopt === undefined ? undefined : yield* adopt(row))
      })

    // Match summaryFrom's durable fields in SQL. Only the selected ids are
    // decoded or expanded into ancestry; one extra key determines continuation.
    const runPageKeys = (
      request: RunQuery,
      includeSpawn: boolean = true,
      includeWaitRollup: boolean = true
    ): Effect.Effect<
      ReadonlyArray<RunCursor>,
      PersistenceError
    > => {
      const filters = request.filters
      const source = sql`CASE WHEN indexed.created_seq IS NULL THEN 1 ELSE 0 END`
      const sequence = sql`COALESCE(indexed.created_seq, 0)`
      const controlState = sql`(${Dialect.jsonText(sql, sql`runs.state_json`, "$.runId")} IS NOT NULL
        OR ${Dialect.jsonText(sql, sql`runs.state_json`, "$.flowId")} IS NOT NULL
        OR ${Dialect.jsonText(sql, sql`runs.state_json`, "$.status")} IS NOT NULL)`
      const flowId = sql`CASE WHEN ${controlState} THEN ${Dialect.jsonText(sql, sql`runs.state_json`, "$.flowId")}
        ELSE ${Dialect.jsonText(sql, sql`runs.state_json`, "$.flowName")} END`
      const ownStatus = sql`CASE WHEN ${controlState} THEN ${Dialect.jsonText(sql, sql`runs.state_json`, "$.status")}
        ELSE CASE runs.status WHEN 'pending' THEN 'accepted' WHEN 'suspended' THEN 'parked' ELSE runs.status END END`
      // The listing filter has to agree with the summary the listing returns.
      // `summaryFrom` rolls a run tree's open human waits up onto the root's
      // status, so the SQL that decides which runs a `status:
      // "waiting-approval"` page contains must roll them up too — otherwise
      // the inbox filter skips exactly the rows the inbox is for, which is how
      // run-3 stayed invisible while parked on `coding-clarification`.
      const status = includeWaitRollup
        ? sql`CASE
          WHEN runs.status NOT IN ('completed', 'failed', 'cancelled')
            AND runs.run_id IN (SELECT ancestorId FROM human_wait_ancestry)
          THEN 'waiting-approval' ELSE ${ownStatus} END`
        : ownStatus
      const storedParent = sql`CASE WHEN ${controlState} THEN ${
        Dialect.jsonText(sql, sql`runs.state_json`, "$.parentRunId")
      } END`
      const storedLineage = sql`CASE WHEN ${controlState} THEN ${
        Dialect.jsonText(sql, sql`runs.state_json`, "$.lineageId")
      } END`
      const parent = includeSpawn
        ? sql`COALESCE(runs.parent_run_id,
            (SELECT parent_id FROM flows_run_parents WHERE child_id = runs.run_id ORDER BY seq LIMIT 1),
            ${storedParent})`
        : sql`COALESCE(runs.parent_run_id, ${storedParent})`
      const lineage = sql`COALESCE(runs.lineage_id, ${storedLineage})`
      const after = request.cursor
      const conditions = [sql`1 = 1`]
      if (filters?.flowId !== undefined) conditions.push(sql`${flowId} = ${filters.flowId}`)
      if (filters?.status !== undefined) conditions.push(sql`${status} = ${filters.status}`)
      if (filters?.terminal !== undefined) {
        const isTerminal = sql`${status} IN ('completed', 'failed', 'cancelled')`
        conditions.push(filters.terminal ? isTerminal : sql`NOT (${isTerminal})`)
      }
      if (filters?.parentRunId !== undefined) conditions.push(sql`${parent} = ${filters.parentRunId}`)
      if (filters?.lineageId !== undefined) conditions.push(sql`${lineage} = ${filters.lineageId}`)
      if (filters?.since !== undefined) conditions.push(sql`runs.created_at_ms >= ${filters.since}`)
      if (filters?.until !== undefined) conditions.push(sql`runs.created_at_ms < ${filters.until}`)
      if (filters?.launchedBy !== undefined) {
        conditions.push(sql`indexed.principal_id = ${filters.launchedBy.id}`)
        if (filters.launchedBy.kind !== undefined) {
          conditions.push(sql`indexed.principal_kind = ${filters.launchedBy.kind}`)
        }
      }
      if (filters?.runIds !== undefined) {
        // One JSON parameter, so a trigger's whole ledger never meets the bind-variable limit.
        const ids = JSON.stringify([...new Set(filters.runIds)])
        conditions.push(
          Dialect.isPostgres(sql)
            ? sql`runs.run_id IN (SELECT jsonb_array_elements_text(${ids}::jsonb))`
            : sql`runs.run_id IN (SELECT value FROM json_each(${ids}))`
        )
      }
      if (after !== undefined) {
        conditions.push(
          request.order === "newest"
            ? sql`(runs.created_at_ms, ${source}, ${sequence}, runs.run_id) <
              (${after.createdAt}, ${after.source}, ${after.sequence}, ${after.runId})`
            : request.order === "oldest"
            ? sql`(runs.created_at_ms, ${source}, ${sequence}, runs.run_id) >
              (${after.createdAt}, ${after.source}, ${after.sequence}, ${after.runId})`
            : sql`(${source}, ${sequence}, runs.created_at_ms, runs.run_id) >
              (${after.source}, ${after.sequence}, ${after.createdAt}, ${after.runId})`
        )
      }
      // Computed once for the whole page rather than per row: the set of runs
      // with an open human wait at or below them, climbed from the few parked
      // rows instead of descended from every run.
      const waitAncestry = includeWaitRollup
        ? sql`WITH RECURSIVE human_wait_ancestry(ancestorId, depth) AS (
          SELECT run_id, 0 FROM flows_runs
          WHERE waiting_reason = ${ControlExecutor.humanWaitReason}
            AND status NOT IN ('completed', 'failed', 'cancelled')
          UNION
          SELECT parent.run_id, human_wait_ancestry.depth + 1
          FROM flows_runs step JOIN human_wait_ancestry ON step.run_id = human_wait_ancestry.ancestorId
          JOIN flows_runs parent ON parent.run_id IN (
            SELECT parent_id FROM flows_run_parents WHERE child_id = step.run_id
            UNION ALL
            SELECT step.parent_run_id WHERE step.parent_run_id IS NOT NULL
          )
          WHERE human_wait_ancestry.depth < ${maxWaitTreeDepth}
            AND (parent.run_id = step.parent_run_id
              OR COALESCE(${Dialect.jsonText(sql, sql`step.state_json`, "$.onParentExit")}, 'cancel') <> 'detach')
        )`
        : sql.literal("")
      return sql<RunCursor>`
        ${waitAncestry}
        SELECT runs.run_id AS "runId", ${source} AS source, ${sequence} AS sequence,
               runs.created_at_ms AS "createdAt"
        FROM flows_runs AS runs LEFT JOIN control_runs AS indexed ON indexed.run_id = runs.run_id
        WHERE ${sql.and(conditions)}
        ORDER BY ${
        request.order === "newest"
          ? sql`runs.created_at_ms DESC, ${source} DESC, ${sequence} DESC, runs.run_id DESC`
          : request.order === "oldest"
          ? sql`runs.created_at_ms, ${source}, ${sequence}, runs.run_id`
          : sql`${source}, ${sequence}, runs.created_at_ms, runs.run_id`
      }
        LIMIT ${request.limit + 1}
      `.pipe(
        probe,
        Effect.catchIf(
          (error) => includeSpawn && filters?.parentRunId !== undefined && missingTable("flows_run_parents")(error),
          () => runPageKeys(request, false, includeWaitRollup)
        ),
        // Without the engine's wait-tree schema, retain the ordinary page.
        Effect.catchIf(
          (error) => includeWaitRollup && missingWaitTreeSchema(error),
          () => runPageKeys(request, includeSpawn, false)
        ),
        Effect.mapError(persistence("query runs"))
      )
    }

    /**
     * One inventory page of `table` by `rowid`: the insertion-ordered row key
     * both dialects index (SQLite's b-tree key, PostgreSQL's identity column),
     * so a page is one seek and `limit + 1` rows however large the table is.
     * The first page pins `through` to the newest row, so a walk ends while
     * inserts continue.
     */
    const pageByRowId = (
      request: IdPageRequest,
      table: "flows_runs" | "control_plans",
      column: "run_id" | "plan_id",
      operation: string
    ): Effect.Effect<IdPage, InvalidInput | PersistenceError> =>
      Effect.gen(function*() {
        yield* idPageLimit(request.limit)
        const through = request.through ?? Number(
          (yield* sql<{ readonly newest: number | string | null }>`
            SELECT MAX(rowid) AS newest FROM ${sql.literal(table)}
          `.pipe(query(operation)))[0]?.newest ?? 0
        )
        const rows = yield* sql<{ readonly id: string; readonly position: number | string }>`
          SELECT ${sql.literal(column)} AS id, rowid AS position FROM ${sql.literal(table)}
          WHERE rowid > ${request.after ?? 0} AND rowid <= ${through}
          ORDER BY rowid LIMIT ${request.limit + 1}
        `.pipe(query(operation))
        const selected = rows.slice(0, request.limit)
        return rows.length > request.limit
          ? { ids: selected.map((row) => row.id), next: Number(selected.at(-1)!.position), through }
          : { ids: selected.map((row) => row.id), through }
      })

    const pagePlanIds = (request: IdPageRequest) => pageByRowId(request, "control_plans", "plan_id", "page plans")

    /**
     * One page of stored plans by `rowid`. The decision narrows in SQL; the flow
     * is read from the stored card, so a page reads batches until it fills or
     * the table ends.
     */
    const queryPlans = (request: PlanQuery): Effect.Effect<PlanPage, InvalidInput | PersistenceError> =>
      Effect.gen(function*() {
        yield* idPageLimit(request.limit)
        const plans: Array<StoredPlan> = []
        let after = request.after ?? 0
        while (true) {
          const conditions = [
            sql`rowid > ${after}`,
            ...(request.decision === undefined ? [] : [sql`decision = ${request.decision}`])
          ]
          const rows = yield* sql<PlanRow & { readonly position: number | string }>`
            SELECT plan_id AS "planId", card_json AS "cardJson",
                   decoded_input_json AS "decodedInputJson", decision, rowid AS position
            FROM control_plans WHERE ${sql.and(conditions)}
            ORDER BY rowid LIMIT ${planScanBatch}
          `.pipe(query("page plans"))
          for (const [index, row] of rows.entries()) {
            after = Number(row.position)
            const plan = yield* storedPlan(row)
            if (request.flowId !== undefined && plan.card.flowId !== request.flowId) continue
            plans.push(plan)
            if (plans.length === request.limit) {
              return index < rows.length - 1 || rows.length === planScanBatch ? { plans, next: after } : { plans }
            }
          }
          if (rows.length < planScanBatch) return { plans }
        }
      })

    /**
     * The recorded launcher of a run this plane launched. The launch index is
     * written once, so it outlives the control summary the engine replaces in
     * `flows_runs.state_json` when it takes the run over.
     */
    const launcherOf = (
      runId: RunId
    ): Effect.Effect<{ readonly id: string; readonly kind: string } | undefined, PersistenceError> =>
      Effect.map(
        sql<{ readonly id: string | null; readonly kind: string | null }>`
          SELECT principal_id AS id, principal_kind AS kind FROM control_runs WHERE run_id = ${runId}
        `.pipe(query("read a run launcher")),
        (rows) => {
          const row = rows[0]
          return row === undefined || row.id === null || row.kind === null ? undefined : { id: row.id, kind: row.kind }
        }
      )

    const messages = <S extends Schema.Top>(
      runId: RunId,
      kind: "signal",
      schema: S
    ): Effect.Effect<ReadonlyArray<S["Type"]>, PersistenceError, S["DecodingServices"]> =>
      sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson" FROM control_run_messages
        WHERE run_id = ${runId} AND kind = ${kind} ORDER BY seq
      `.pipe(
        query("read run messages"),
        Effect.flatMap((rows) =>
          Effect.forEach(
            rows,
            (row) => decodeStoredJson(`control_run_messages.payload_json as ${kind}`, schema, row.payloadJson)
          )
        )
      )

    const appendMessage = (
      runId: RunId,
      kind: "signal",
      payload: unknown
    ): Effect.Effect<void, RunNotFound | PersistenceError> =>
      Effect.gen(function*() {
        yield* requireRow(runId)
        yield* sql`
          INSERT INTO control_run_messages (run_id, kind, payload_json)
          VALUES (${runId}, ${kind}, ${JSON.stringify(payload)})
        `.pipe(Effect.mapError(persistence("append a run message")))
      })

    const service = make({
      authorizeApproval,
      plan: Effect.fn("SqlControlRuntime.plan")(function*(input: PlanInput) {
        const flow = (yield* readFlows).get(input.flowId)
        if (flow === undefined) {
          return yield* new FlowNotFound({ flowId: input.flowId })
        }
        const requestFingerprint = yield* Effect.try({
          try: () => planFingerprint(input),
          catch: (cause) => new InvalidInput({ issue: canonicalIssue(cause) })
        })
        if (input.idempotencyKey !== undefined) {
          const prior = yield* sql<{ readonly fingerprint: string; readonly planId: string }>`
            SELECT fingerprint, plan_id AS "planId" FROM control_plan_keys
            WHERE idempotency_key = ${input.idempotencyKey}
          `.pipe(query("read a plan key"))
          const found = prior[0]
          if (found !== undefined) {
            if (found.fingerprint !== requestFingerprint) {
              return yield* new InvalidInput({
                issue: `idempotency key ${input.idempotencyKey} was used for another plan`
              })
            }
            const stored = yield* readPlan(found.planId)
            if (Option.isSome(stored)) {
              const decoded = yield* storedPlan(stored.value)
              return { card: decoded.card, created: false }
            }
          }
        }
        const decoded = yield* (flow.decode?.(input.input) ?? Effect.try({
          try: () => {
            canonical(input.input)
            return input.input
          },
          catch: (cause) => new InvalidInput({ issue: canonicalIssue(cause) })
        }))
        const planId = `plan-${yield* nextSequence("plan")}`
        const handoff = flow.plan === undefined ? undefined : yield* flow.plan(decoded, planId)
        const card = yield* planCard({
          planId,
          flowId: input.flowId,
          decodedInput: decoded,
          envelope: budgeted(flow.envelope, input.budget),
          deployClass: flow.deployClass,
          executionDigest: flow.executionDigest,
          handoff,
          idempotencyKey: input.idempotencyKey
        }).pipe(Effect.provideService(Crypto.Crypto, crypto))
        const identity = approvalIdentity(card.approval.target)
        // The key row is claimed FIRST, and the claim is a conditional insert
        // followed by a read of whoever holds it. `idempotency_key` is the
        // primary key, so a bare insert made two runtimes planning under one
        // key a race the loser lost with a constraint violation surfaced as
        // `PersistenceError`, instead of the winner's card the key promises.
        // Under Control.plan this write joins the journal transaction, so the
        // card, key, token and creation entry commit or roll back together.
        const outcome = yield* writer.write(Effect.gen(function*() {
          if (input.idempotencyKey !== undefined) {
            yield* sql`
              INSERT INTO control_plan_keys (idempotency_key, fingerprint, plan_id)
              VALUES (${input.idempotencyKey}, ${requestFingerprint}, ${planId})
              ON CONFLICT (idempotency_key) DO NOTHING
            `
            const settled = yield* sql<{ readonly fingerprint: string; readonly planId: string }>`
              SELECT fingerprint, plan_id AS "planId" FROM control_plan_keys
              WHERE idempotency_key = ${input.idempotencyKey}
            `
            const holder = settled[0]
            if (holder !== undefined && holder.planId !== planId) {
              return { _tag: "raced", holder } as const
            }
          }
          // An explicit null input is stored as JSON text in the non-null column.
          const decodedJson = JSON.stringify(decoded ?? null)
          yield* sql`
            INSERT INTO control_plans (plan_id, card_json, decoded_input_json, decision)
            VALUES (${planId}, ${JSON.stringify(card)}, ${decodedJson}, 'pending')
          `
          yield* sql`
            INSERT INTO control_tokens (
              target_tag, run_id, target_id, token_id, target_json, resolved, decision_principal_json
            )
            VALUES (
              ${identity.targetTag}, ${identity.runId}, ${identity.targetId}, ${planId},
              ${JSON.stringify(card.approval.target)}, 0, NULL
            )
          `
          return { _tag: "stored" } as const
        })).pipe(Effect.mapError(persistence("store a plan")))
        if (outcome._tag === "raced") {
          if (outcome.holder.fingerprint !== requestFingerprint) {
            return yield* new InvalidInput({
              issue: `idempotency key ${String(input.idempotencyKey)} was used for another plan`
            })
          }
          const stored = yield* readPlan(outcome.holder.planId)
          if (Option.isNone(stored)) {
            return yield* new PersistenceError({
              operation: "read a plan",
              message: `plan key ${String(input.idempotencyKey)} names plan ${outcome.holder.planId}, which is absent`
            })
          }
          const decodedHolder = yield* storedPlan(stored.value)
          return { card: decodedHolder.card, created: false }
        }
        return { card, created: true }
      }),
      getPlan: Effect.fn("SqlControlRuntime.getPlan")((planId: string) =>
        Effect.flatMap(requirePlan(planId), storedPlan)
      ),
      pagePlanIds,
      queryPlans,
      lookupApproval: Effect.fn("SqlControlRuntime.lookupApproval")(function*(target: ApprovalTarget) {
        const tokenId = target._tag === "Plan" ? target.planId : target.requestId
        const identity = approvalIdentity(target)
        const rows = yield* sql<TokenRow>`
          SELECT token_id AS "tokenId", target_json AS "targetJson", resolved,
                 decision_principal_json AS "decisionPrincipalJson", decision_json AS "decisionJson"
          FROM control_tokens
          WHERE target_tag = ${identity.targetTag}
            AND run_id = ${identity.runId}
            AND target_id = ${identity.targetId}
        `.pipe(query("read an approval token"))
        const row = rows[0]
        if (row === undefined) {
          return yield* (target._tag === "Node"
            ? new RunNotFound({ runId: target.runId })
            : new PlanNotFound({ planId: target.planId }))
        }
        const stored = yield* decodeStoredJson("control_tokens.target_json", ApprovalTarget, row.targetJson)
        // The composite columns select the requested identity. The decoded copy
        // must agree too, or a rewritten JSON blob could smuggle a foreign
        // target back into the token after lookup.
        if (!sameApprovalIdentity(stored, target)) {
          return yield* new PersistenceError({
            operation: "validate an approval token",
            message: "The stored approval target does not match its identity"
          })
        }
        if (stored.digest !== target.digest) {
          return yield* new PlanDigestMismatch({
            planId: tokenId,
            expected: stored.digest,
            actual: target.digest
          })
        }
        if (!sameEnvelope(stored.envelope, target.envelope)) {
          return yield* new EnvelopeMismatch({
            planId: tokenId,
            expected: canonical(stored.envelope),
            actual: canonical(target.envelope)
          })
        }
        const token = yield* tokenFromRow(row, stored)
        if (token._tag !== "Pending") return yield* new AlreadyResolved({ requestId: tokenId })
        return token
      }),
      registerApproval: Effect.fn("SqlControlRuntime.registerApproval")(function*(
        target: Extract<ApprovalTarget, { readonly _tag: "Node" }>
      ) {
        yield* requireRow(target.runId)
        const identity = approvalIdentity(target)
        yield* sql`
          INSERT INTO control_tokens (
            target_tag, run_id, target_id, token_id, target_json, resolved, decision_principal_json
          )
          VALUES (
            ${identity.targetTag}, ${identity.runId}, ${identity.targetId}, ${target.requestId},
            ${JSON.stringify(target)}, 0, NULL
          )
          ON CONFLICT (target_tag, run_id, target_id) DO NOTHING
        `.pipe(Effect.mapError(persistence("register an approval token")))
        const rows = yield* sql<TokenRow>`
          SELECT token_id AS "tokenId", target_json AS "targetJson", resolved,
                 decision_principal_json AS "decisionPrincipalJson", decision_json AS "decisionJson"
          FROM control_tokens
          WHERE target_tag = ${identity.targetTag}
            AND run_id = ${identity.runId}
            AND target_id = ${identity.targetId}
        `.pipe(query("read an approval token"))
        const row = rows[0]
        if (row === undefined) {
          return yield* Effect.fail(
            new PersistenceError({
              operation: "register an approval token",
              message: "A registered approval token could not be read back"
            })
          )
        }
        const stored = yield* decodeStoredJson("control_tokens.target_json", ApprovalTarget, row.targetJson)
        if (!sameApprovalIdentity(stored, target)) {
          return yield* new PersistenceError({
            operation: "validate an approval token",
            message: "The stored approval target does not match its identity"
          })
        }
        if (stored.digest !== target.digest) {
          return yield* new PlanDigestMismatch({
            planId: target.requestId,
            expected: stored.digest,
            actual: target.digest
          })
        }
        if (!sameEnvelope(stored.envelope, target.envelope)) {
          return yield* new EnvelopeMismatch({
            planId: target.requestId,
            expected: canonical(stored.envelope),
            actual: canonical(target.envelope)
          })
        }
        return yield* tokenFromRow(row, stored)
      }),
      installBulkGrant: Effect.fn("SqlControlRuntime.installBulkGrant")(function*(
        token: ApprovalToken,
        envelope: Envelope,
        scope
      ) {
        const timestamp = yield* now
        const identity = approvalIdentity(token.target)
        // The envelope is installed whole. Splitting it into capabilities here
        // would let a partial grant exist, which is exactly what the bulk-grant
        // rule forbids.
        yield* sql`
          INSERT INTO control_grants (
            target_tag, run_id, target_id, token_id, envelope_json, scope, installed_at_ms
          )
          VALUES (
            ${identity.targetTag}, ${identity.runId}, ${identity.targetId}, ${token.tokenId},
            ${JSON.stringify(envelope)}, ${scope}, ${timestamp}
          )
          ON CONFLICT (target_tag, run_id, target_id) DO NOTHING
        `.pipe(Effect.mapError(persistence("install a grant")))
      }),
      resolveApproval: Effect.fn("SqlControlRuntime.resolveApproval")(function*(
        token: ApprovalToken,
        decision: "approved" | "denied",
        principal: Principal,
        scope: GrantScope = "once"
      ) {
        // Caller-owned objects can change while the clock or writer yields.
        // Bind both representations of the principal, and the plan update,
        // to the same captured request rather than reading the caller again.
        const requested = yield* Effect.try({
          try: () => structuredClone({ target: token.target, principal, tokenId: token.tokenId }),
          catch: () =>
            new PersistenceError({
              operation: "record an approval decision",
              message: "The approval request cannot be captured"
            })
        })
        const identity = approvalIdentity(requested.target)
        const requestedPrincipal = requested.principal
        const tokenId = requested.tokenId
        const decidedAt = yield* now
        const answer = yield* decodeStoredValue(
          "approval decision",
          ApprovalDecision,
          decision === "approved"
            ? { _tag: "Approved", decisionPrincipal: requestedPrincipal, decidedAt, scope }
            : { _tag: "Denied", decisionPrincipal: requestedPrincipal, decidedAt }
        )
        // Exactly once: the guard is in the UPDATE, so two concurrent decisions
        // cannot both observe an unresolved token.
        const resolved = yield* writer.write(Effect.gen(function*() {
          yield* authorizeApproval({ principal: requestedPrincipal, target: requested.target, decision, scope })
          const rows = yield* sql<{ readonly tokenId: string }>`
            UPDATE control_tokens
            SET resolved = 1, decision_principal_json = ${JSON.stringify(requestedPrincipal)},
                decision_json = ${JSON.stringify(answer)}
            WHERE target_tag = ${identity.targetTag}
              AND run_id = ${identity.runId}
              AND target_id = ${identity.targetId}
              AND resolved = 0
            RETURNING token_id AS "tokenId"
          `
          if (rows.length === 0) return false
          if (identity.targetTag === "Plan") {
            yield* sql`UPDATE control_plans SET decision = ${decision} WHERE plan_id = ${identity.targetId}`
          }
          return true
        })).pipe(Effect.mapError((error) =>
          error instanceof Unauthorized || error instanceof PersistenceError
            ? error
            : persistence("resolve an approval")(error)
        ))
        if (!resolved) return yield* new AlreadyResolved({ requestId: tokenId })
      }),
      launch: Effect.fn("SqlControlRuntime.launch")(function*(
        planId: string,
        requestedDigest: string,
        envelope: Envelope,
        principal?: Principal | undefined
      ) {
        const row = yield* requirePlan(planId)
        const plan = yield* storedPlan(row)
        if (plan.card.digest !== requestedDigest) {
          return yield* new PlanDigestMismatch({
            planId,
            expected: plan.card.digest,
            actual: requestedDigest
          })
        }
        if (!sameEnvelope(plan.card.envelope, envelope)) {
          return yield* new EnvelopeMismatch({
            planId,
            expected: canonical(plan.card.envelope),
            actual: canonical(envelope)
          })
        }
        if (plan.decision === "pending") {
          const parked: LaunchResult = {
            _tag: "Parked",
            receipt: {
              _tag: "Parked",
              receiptId: `launch:${planId}`,
              planId,
              status: "waiting-approval"
            }
          }
          return parked
        }
        if (plan.decision !== "approved") return yield* new PlanDenied({ planId })

        const sequence = yield* nextSequence("run")
        const runId = `run-${sequence}`
        const timestamp = yield* now
        const claimant: Ownership.OwnerId = { ...owner, nonce: randomId() }
        const summary: RunSummary = {
          runId,
          flowId: plan.card.flowId,
          status: "accepted",
          planId,
          planDigest: plan.card.digest,
          ...(plan.card.executionDigest === undefined ? {} : { executionDigest: plan.card.executionDigest }),
          ...(options.engineVersion === undefined ? {} : { engineVersion: options.engineVersion }),
          ownerId: JSON.stringify(claimant),
          ...(plan.card.envelope.budget.deadline === undefined
            ? {}
            : { deadlineAt: timestamp + plan.card.envelope.budget.deadline }),
          createdAt: timestamp,
          updatedAt: timestamp
        }
        yield* runStore.create(runId, JSON.stringify(summary)).pipe(
          Effect.mapError(persistence("create a run"))
        )
        yield* sql`INSERT INTO control_runs (run_id, created_seq, principal_id, principal_kind)
          VALUES (${runId}, ${sequence}, ${principal?.id ?? null}, ${principal?.kind ?? null})`.pipe(
          Effect.mapError(persistence("index a run"))
        )
        const outcome = yield* runStore.claimAndOwn(
          runId,
          { status: "pending", owner: null, heartbeatAtMs: null },
          claimant,
          timestamp
        ).pipe(Effect.mapError(persistence("claim a new run")))
        if (outcome._tag !== "Activated") return yield* new ClaimLost({ runId })
        const started: LaunchResult = {
          _tag: "Started",
          receipt: accepted(`launch:${planId}:${runId}`, runId),
          run: withLauncher(summary, principal)
        }
        return started
      }),
      getRun: Effect.fn("SqlControlRuntime.getRun")((runId: RunId) =>
        Effect.gen(function*() {
          const row = yield* requireRow(runId)
          return yield* summaryFrom(row, yield* ancestryIndex(yield* ancestorChain(runId)))
        })
      ),
      /**
       * Every durable run in `flows_runs` insertion order: `control_runs`
       * indexes only the runs this plane launched, while a child, a fork, and a
       * later trampoline round are created by the engine straight into
       * `flows_runs`. One indexed seek per page, with no row decoded, so a
       * caller that walks every run holds one page of ids at a time.
       */
      pageRunIds: (request) => pageByRowId(request, "flows_runs", "run_id", "page runs"),
      queryRuns: Effect.fn("SqlControlRuntime.queryRuns")(function*(request) {
        if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 500) {
          return yield* new InvalidInput({ issue: "limit: must be an integer between 1 and 500" })
        }
        const keys = yield* runPageKeys(request)
        const selected = keys.slice(0, request.limit)
        if (selected.length === 0) return { items: [] }
        const chains = yield* Effect.forEach(selected, (key) => ancestorChain(key.runId))
        const ancestry = yield* ancestryIndex([...new Set(chains.flat())])
        const summaries = yield* Effect.forEach(selected, (key) =>
          requireRow(key.runId).pipe(
            Effect.flatMap((row) => Effect.map(summaryFrom(row, ancestry), Option.some)),
            Effect.catchTag("/control/RunNotFound", () => Effect.succeed(Option.none<RunSummary>()))
          ))
        return {
          items: summaries.filter(Option.isSome).map((summary) => summary.value),
          ...(keys.length > request.limit ? { nextCursor: selected[selected.length - 1]! } : {})
        }
      }),
      listFlows: Effect.fn("SqlControlRuntime.listFlows")(() =>
        Effect.map(readFlows, (flows) =>
          Array.from(flows.values(), (flow) => ({
            flowId: flow.flowId,
            description: flow.description
          })))
      )(),
      deliverSignal: Effect.fn("SqlControlRuntime.deliverSignal")((runId: RunId, signal: SignalPayload) =>
        // Durable delivery, and deliberately no resumption: a signal records a
        // fact, it does not decide who runs next.
        appendMessage(runId, "signal", signal)
      ),
      admitSignal: Effect.fn("SqlControlRuntime.admitSignal")(function*(commandId, runId, signal, principal) {
        yield* requireRow(runId)
        const payloadJson = JSON.stringify(signal)
        const principalJson = principal === undefined ? null : JSON.stringify(principal)
        yield* writer.write(sql`INSERT INTO control_signal_commands (command_id, run_id, payload_json, principal_json)
          VALUES (${commandId}, ${runId}, ${payloadJson}, ${principalJson}) ON CONFLICT(command_id) DO NOTHING`).pipe(
          Effect.mapError(persistence("admit signal command"))
        )
      }),
      signalCommand: Effect.fn("SqlControlRuntime.signalCommand")(function*(commandId) {
        const rows = yield* sql<
          {
            commandId: string
            runId: string
            payloadJson: string
            token: string | null
            state: "pending" | "delivered" | "rejected" | "terminal"
            principalJson: string | null
          }
        >`
          SELECT command_id AS "commandId", run_id AS "runId", payload_json AS "payloadJson", wait_token AS token, state,
            principal_json AS "principalJson"
          FROM control_signal_commands WHERE command_id = ${commandId}`.pipe(query("read signal command"))
        const row = rows[0]
        if (row === undefined) return undefined
        return {
          commandId: row.commandId,
          runId: row.runId,
          token: row.token,
          state: row.state,
          signal: yield* decodeStoredJson("control_signal_commands.payload_json", SignalPayload, row.payloadJson),
          ...yield* signalPrincipal(row.principalJson)
        }
      }),
      pendingSignals: Effect.gen(function*() {
        const read = (after: number) =>
          sql<
            {
              seq: number
              commandId: string
              runId: string
              payloadJson: string
              token: string | null
              state: "pending"
              principalJson: string | null
            }
          >`
          SELECT seq, command_id AS "commandId", run_id AS "runId", payload_json AS "payloadJson", wait_token AS token, state,
            principal_json AS "principalJson"
          FROM control_signal_commands WHERE state = 'pending' AND seq > ${after} ORDER BY seq LIMIT 100`.pipe(
            query("read pending signals")
          )
        let rows = yield* read(pendingSignalCursor)
        if (rows.length === 0 && pendingSignalCursor !== 0) rows = yield* read(0)
        pendingSignalCursor = rows.at(-1)?.seq ?? 0
        const decoded = yield* Effect.forEach(
          rows,
          (row) =>
            Effect.all([
              decodeStoredJson("control_signal_commands.payload_json", SignalPayload, row.payloadJson),
              signalPrincipal(row.principalJson)
            ]).pipe(
              Effect.map(([signal, principal]) =>
                Option.some({
                  commandId: row.commandId,
                  runId: row.runId,
                  token: row.token,
                  state: row.state,
                  signal,
                  ...principal
                })
              ),
              Effect.catch((error) =>
                writer.write(
                  sql`UPDATE control_signal_commands SET state = 'rejected' WHERE command_id = ${row.commandId} AND state = 'pending'`
                ).pipe(
                  Effect.mapError(persistence("quarantine malformed signal")),
                  Effect.andThen(
                    Effect.logWarning("Malformed admitted signal rejected", { commandId: row.commandId, error })
                  ),
                  Effect.as(Option.none())
                )
              )
            )
        )
        return decoded.filter(Option.isSome).map((item) => item.value)
      }),
      bindSignal: Effect.fn("SqlControlRuntime.bindSignal")((commandId, token) =>
        writer.write(Effect.gen(function*() {
          yield* sql`UPDATE control_signal_commands SET wait_token = ${token} WHERE command_id = ${commandId} AND wait_token IS NULL AND state = 'pending' AND NOT EXISTS (SELECT 1 FROM control_signal_commands WHERE wait_token = ${token})`
          const rows = yield* sql<
            { token: string | null }
          >`SELECT wait_token AS token FROM control_signal_commands WHERE command_id = ${commandId}`
          if (rows[0] === undefined) {
            return yield* new PersistenceError({
              operation: "bind signal",
              message: `No pending signal command ${commandId}`
            })
          }
          return rows[0].token
        })).pipe(Effect.mapError(persistence("bind signal")))
      ),
      settleSignal: Effect.fn("SqlControlRuntime.settleSignal")((commandId, state) =>
        writer.write(
          sql`UPDATE control_signal_commands SET state = ${state} WHERE command_id = ${commandId} AND state = 'pending'`
        ).pipe(Effect.asVoid, Effect.mapError(persistence("settle signal")))
      ),
      deliveredSignals: Effect.fn("SqlControlRuntime.deliveredSignals")(function*(runId: RunId) {
        yield* requireRow(runId)
        const legacy = yield* messages(runId, "signal", SignalPayload)
        const rows = yield* sql<
          { payloadJson: string }
        >`SELECT payload_json AS "payloadJson" FROM control_signal_commands WHERE run_id = ${runId} AND state != 'rejected' ORDER BY seq`
          .pipe(query("read admitted signals"))
        return [
          ...legacy,
          ...yield* Effect.forEach(
            rows,
            (row) => decodeStoredJson("control_signal_commands.payload_json", SignalPayload, row.payloadJson)
          )
        ]
      }),
      requestResume: Effect.fn("SqlControlRuntime.requestResume")(function*(
        runId: RunId,
        options?: { readonly consent?: number | undefined } | undefined
      ) {
        const summary = yield* summaryOf(yield* requireRow(runId))
        // A settled run has no host left to take the delegation up: recording
        // one anyway leaves an orphaned row that `pendingResumes` filters out
        // of every poll but nothing ever clears.
        if (terminal(summary.status)) {
          return yield* new InvalidInput({
            issue: `run ${runId} is ${summary.status} and cannot take a resume`
          })
        }
        const sequence = yield* nextSequence("resume")
        const timestamp = yield* now
        const consent = options?.consent ?? null
        // A delegation that arrives before the host took up an operator's
        // resume keeps that consent; only a newer explicit resume replaces it.
        yield* writer.write(sql`
          INSERT INTO control_run_resumes (run_id, requested_seq, requested_at_ms, consent_seq)
          VALUES (${runId}, ${sequence}, ${timestamp}, ${consent})
          ON CONFLICT (run_id) DO UPDATE SET
            requested_seq = excluded.requested_seq,
            requested_at_ms = excluded.requested_at_ms,
            consent_seq = COALESCE(excluded.consent_seq, control_run_resumes.consent_seq)
        `).pipe(Effect.mapError(persistence("record a resume delegation")))
        return sequence
      }),
      // Terminal runs are filtered in SQL: a delegation nobody will ever take
      // up must not keep appearing in every host's poll.
      pendingResumes: sql<
        {
          readonly runId: string
          readonly requestedSeq: number
          readonly requestedAtMs: number
          readonly consentSeq: number | null
        }
      >`
        SELECT resumes.run_id AS "runId",
               resumes.requested_seq AS "requestedSeq",
               resumes.requested_at_ms AS "requestedAtMs",
               resumes.consent_seq AS "consentSeq"
        FROM control_run_resumes AS resumes
        JOIN flows_runs AS runs ON runs.run_id = resumes.run_id
        WHERE runs.status NOT IN ('completed', 'failed', 'cancelled')
        ORDER BY resumes.requested_seq
      `.pipe(
        query("read pending resumes"),
        Effect.map((rows) =>
          rows.map((row) => ({
            runId: row.runId,
            sequence: Number(row.requestedSeq),
            requestedAtMs: Number(row.requestedAtMs),
            ...(row.consentSeq === null ? {} : { consent: Number(row.consentSeq) })
          }))
        )
      ),
      clearResume: Effect.fn("SqlControlRuntime.clearResume")((runId: RunId, sequence: number) =>
        writer.write(sql`
          DELETE FROM control_run_resumes WHERE run_id = ${runId} AND requested_seq = ${sequence}
        `).pipe(Effect.mapError(persistence("clear a resume delegation")), Effect.asVoid)
      ),
      registerFiber: Effect.fn("SqlControlRuntime.registerFiber")(function*(
        runId: RunId,
        fiber: Fiber.Fiber<unknown, unknown>
      ) {
        yield* requireRow(runId)
        ActiveFibers.register(fibers, runId, fiber)
      }),
      interrupt: Effect.fn("SqlControlRuntime.interrupt")(function*(runId: RunId, settle = (effect) => effect) {
        const row = yield* requireRow(runId)
        const summary = yield* summaryOf(row)
        // Terminality is asked FIRST, as `resume` asks it. A settled run has
        // released its owner, so `ownedByUs` is false for every process
        // including the one that ran it, and asking ownership first answered
        // `ClaimLost` — "somebody else has it" — for a run that had simply
        // finished. Its caller has a `Terminal` receipt for exactly this.
        if (terminal(summary.status)) return summary
        if (!ownedByUs(row)) return yield* new ClaimLost({ runId })
        const fiber = fibers.get(runId)
        // Cancellation is fiber interruption, not a flag anyone polls.
        if (fiber !== undefined) yield* Fiber.interrupt(fiber)
        if (fibers.get(runId) === fiber) fibers.delete(runId)
        // Only reconciliation holds the writer. Re-read after finalizers and
        // retain the original fence so cleanup cannot transfer this cancel to
        // a replacement owner or overwrite a terminal outcome.
        return yield* settle(
          writer.write(Effect.gen(function*() {
            const current = yield* summaryOf(yield* requireRow(runId))
            if (terminal(current.status)) return current
            return yield* transition(runId, row.owner, current, "cancelled")
          })).pipe(
            Effect.catchTag(
              "@smthrs/database/DatabaseError",
              (error) => Effect.fail(persistence("settle an interrupted run")(error))
            )
          )
        )
      }),
      codeDrift: Effect.fn("SqlControlRuntime.codeDrift")(function*(runId: RunId) {
        const summary = yield* recordedCode(yield* requireRow(runId))
        const current = (yield* readCurrentFlows).get(summary.flowId)
        const pinned = summary.executionDigest === undefined || options.pinnedFlow === undefined
          ? undefined :
          yield* options.pinnedFlow(summary.flowId, summary.executionDigest)
        return codeDriftOf(
          summary,
          pinned === true ?
            { executionDigest: summary.executionDigest }
            : pinned === false
            ? undefined
            : current,
          options.engineVersion
        )
      }),
      recordedCode: Effect.fn("SqlControlRuntime.recordedCode")(function*(runId: RunId) {
        const { executionDigest, engineVersion } = yield* recordedCode(yield* requireRow(runId))
        return { executionDigest, engineVersion }
      }),
      resume: Effect.fn("SqlControlRuntime.resume")((
        runId: RunId,
        resumeOptions?: { readonly scope?: "launched" | "any" | undefined } | undefined
      ) => resumeRun(runId, resumeOptions?.scope)),
      resumeAdopting: Effect.fn("SqlControlRuntime.resumeAdopting")((
        runId: RunId,
        resumeOptions?: { readonly scope?: "launched" | "any" | undefined } | undefined
      ) => resumeRun(runId, resumeOptions?.scope, adoptable)),
      claimFence: Effect.fn("SqlControlRuntime.claimFence")(function*(runId: RunId) {
        const row = yield* requireRow(runId)
        if (!ownedByUs(row)) return yield* new ClaimLost({ runId })
        return JSON.stringify(row.owner)
      }),
      releasePending: Effect.fn("SqlControlRuntime.releasePending")(function*(runId: RunId, fence: string) {
        const row = yield* requireRow(runId)
        const presented = yield* decodeStoredJson("control fence", Ownership.OwnerId, fence).pipe(
          Effect.mapError(() => new ClaimLost({ runId }))
        )
        const timestamp = yield* now
        const next: RunSummary = {
          ...yield* summaryOf(row),
          status: "accepted",
          ownerId: undefined,
          parkedBy: undefined,
          updatedAt: timestamp
        }
        const outcome = yield* runStore.transitionOwned(
          runId,
          presented,
          "suspended",
          JSON.stringify(next)
        ).pipe(Effect.mapError(persistence("release a pending run")))
        if (outcome._tag === "NotFound") return yield* new RunNotFound({ runId })
        if (outcome._tag !== "Transitioned") return yield* new ClaimLost({ runId })
        return next
      }),
      writeStatus: Effect.fn("SqlControlRuntime.writeStatus")(function*(
        runId: RunId,
        fence: string,
        status: RunStatus
      ) {
        const row = yield* requireRow(runId)
        const presented = yield* decodeStoredJson("control fence", Ownership.OwnerId, fence).pipe(
          Effect.mapError(() => new ClaimLost({ runId }))
        )
        return yield* transition(runId, presented, yield* summaryOf(row), status)
      }),
      /**
       * The submitted identity wins, and only the clock is the runtime's.
       *
       * `Control.RunMutationInput` states the order: the runtime "supplies its
       * own principal when the caller names none". The submitted one is the
       * identity the server authenticated at its boundary, so a composition
       * default that overrode it would rename every remote operator to
       * whatever this process was built with.
       */
      stampPrincipal: Effect.fn("SqlControlRuntime.stampPrincipal")(function*(submitted?: Principal | undefined) {
        const timestamp = yield* now
        return {
          id: submitted?.id ?? options.principal?.id ?? "local",
          kind: submitted?.kind ?? options.principal?.kind ?? "operator",
          stampedAt: timestamp
        }
      }),
      lookupMutation: Effect.fn("SqlControlRuntime.lookupMutation")(function*(
        key: IdempotencyKey,
        fingerprint: string
      ) {
        const rows = yield* sql<{ readonly fingerprint: string; readonly receiptJson: string }>`
          SELECT fingerprint, receipt_json AS "receiptJson" FROM control_mutations WHERE mutation_key = ${key}
        `.pipe(query("read a mutation"))
        const row = rows[0]
        if (row === undefined) return undefined
        if (row.fingerprint !== fingerprint) {
          return { _tag: "Conflict" as const, message: `idempotency key ${key} was used for another mutation` }
        }
        const receipt = yield* decodeStoredJson("control_mutations.receipt_json", Receipt, row.receiptJson)
        return alreadyApplied(key, receipt)
      }),
      recordMutation: Effect.fn("SqlControlRuntime.recordMutation")((
        key: IdempotencyKey,
        fingerprint: string,
        receipt: Receipt
      ) =>
        writer.write(Effect.gen(function*() {
          yield* sql`
          INSERT INTO control_mutations (mutation_key, fingerprint, receipt_json)
          VALUES (${key}, ${fingerprint}, ${JSON.stringify(receipt)})
          ON CONFLICT (mutation_key) DO NOTHING
        `
          const rows = yield* sql<{ readonly fingerprint: string; readonly receiptJson: string }>`
          SELECT fingerprint, receipt_json AS "receiptJson"
          FROM control_mutations WHERE mutation_key = ${key}
        `
          const stored = rows[0]
          if (
            stored === undefined || stored.fingerprint !== fingerprint || stored.receiptJson !== JSON.stringify(receipt)
          ) {
            return yield* Effect.fail(
              new PersistenceError({
                operation: "record a mutation",
                message: `Idempotency key ${key} was already settled by another mutation`
              })
            )
          }
        })).pipe(
          Effect.asVoid,
          Effect.mapError((cause) =>
            cause instanceof PersistenceError ? cause : persistence("record a mutation")(cause)
          )
        )
      ),
      claimRunKey: Effect.fn("SqlControlRuntime.claimRunKey")((
        key: IdempotencyKey,
        fingerprint: string
      ) => {
        const claimant = randomId()
        return writer.write(Effect.gen(function*() {
          yield* sql`
            INSERT INTO control_run_keys (idempotency_key, fingerprint, claimant)
            VALUES (${key}, ${fingerprint}, ${claimant})
            ON CONFLICT (idempotency_key) DO NOTHING
          `
          const holders = yield* sql<{
            readonly fingerprint: string
            readonly claimant: string
          }>`
            SELECT fingerprint, claimant FROM control_run_keys
            WHERE idempotency_key = ${key}
          `
          const holder = holders[0]
          if (holder === undefined) {
            return yield* new PersistenceError({
              operation: "claim a run key",
              message: `Run key ${key} disappeared while it was being claimed`
            })
          }
          if (holder.fingerprint !== fingerprint) {
            return yield* new InvalidInput({
              issue: `idempotency key ${key} was used for another run`
            })
          }
          if (holder.claimant === claimant) return { _tag: "Claimed" as const }

          // Serialized writers make the winner's key and receipt visible in
          // one commit. Seeing its key without its receipt is therefore
          // corruption (or a claim written by an older, non-atomic build), not
          // permission to launch a second run.
          const rows = yield* sql<{ readonly fingerprint: string; readonly receiptJson: string }>`
            SELECT fingerprint, receipt_json AS "receiptJson"
            FROM control_mutations WHERE mutation_key = ${key}
          `
          const record = rows[0]
          if (record === undefined || record.fingerprint !== fingerprint) {
            return yield* new PersistenceError({
              operation: "claim a run key",
              message: `Run key ${key} has no matching settled receipt`
            })
          }
          const receipt = yield* decodeStoredJson("control_mutations.receipt_json", Receipt, record.receiptJson)
          return { _tag: "Raced" as const, receipt }
        })).pipe(
          Effect.mapError((cause) =>
            cause instanceof InvalidInput || cause instanceof PersistenceError
              ? cause
              : persistence("claim a run key")(cause)
          )
        )
      }),
      releaseRunKey: Effect.fn("SqlControlRuntime.releaseRunKey")((key: IdempotencyKey) =>
        writer.write(sql`
          DELETE FROM control_run_keys WHERE idempotency_key = ${key}
        `).pipe(
          Effect.asVoid,
          Effect.mapError(persistence("release a run key"))
        )
      ),
      grants: Effect.fn("SqlControlRuntime.grants")(() =>
        sql<{
          readonly tokenId: string
          readonly envelopeJson: string
          readonly scope: string
          readonly installedAtMs: number
        }>`
          SELECT token_id AS "tokenId", envelope_json AS "envelopeJson",
                 scope, installed_at_ms AS "installedAtMs"
          FROM control_grants ORDER BY installed_at_ms, target_tag, run_id, target_id
        `.pipe(
          query("list grants"),
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row): Effect.Effect<BulkGrant, PersistenceError> =>
              Effect.all({
                envelope: decodeStoredJson("control_grants.envelope_json", Envelope, row.envelopeJson),
                scope: decodeStoredValue("control_grants.scope", GrantScope, row.scope)
              }).pipe(
                Effect.map(({ envelope, scope }) => ({
                  tokenId: row.tokenId,
                  envelope,
                  scope,
                  installedAt: Number(row.installedAtMs)
                }))
              ))
          )
        )
      )()
    })
    return service
  })
}

/**
 * Provides a durable runtime over the ambient database and run store.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options = {}
): Layer.Layer<
  ControlRuntime,
  PersistenceError,
  Crypto.Crypto | DurableWriter | SqlClient.SqlClient | RunStore.RunStore
> => Layer.effect(ControlRuntime)(makeRuntime(options))

/**
 * Provides a durable runtime and the run store it needs over the ambient
 * database.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWithStore = (
  options: Options = {}
): Layer.Layer<
  ControlRuntime,
  PersistenceError,
  Crypto.Crypto | DurableWriter | SqlClient.SqlClient
> => layer(options).pipe(Layer.provideMerge(RunStore.layer))

/**
 * Constructs a durable runtime over the ambient database and run store.
 *
 * @category constructors
 * @since 0.1.0
 */
export { makeRuntime as make }
