/**
 * Versioned engine history contracts over the open journal. These schemas do
 * not change journal admission or make history the engine's recovery store.
 *
 * @since 1.0.0
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Event from "./JournalEvent.ts"

/**
 * Required lineage coordinates for a root or derived run.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Lineage = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("root"),
    runId: Event.RunId,
    lineageId: Event.LineageId,
    rootRunId: Event.RunId,
    round: Schema.Literal(0),
    parentRunId: Schema.Null
  }).check(Schema.makeFilter((value) => value.runId === value.rootRunId)),
  Schema.Struct({
    kind: Schema.Literals(["child", "fork", "continuation"]),
    runId: Event.RunId,
    lineageId: Event.LineageId,
    rootRunId: Event.RunId,
    round: Event.NonNegativeQuantity,
    parentRunId: Event.RunId
  }).check(Schema.makeFilter((value) =>
    value.runId !== value.parentRunId && value.runId !== value.rootRunId &&
    (value.kind !== "continuation" || value.round > 0)
  ))
])

/**
 * Required lineage coordinates for a root or derived run.
 *
 * @category models
 * @since 1.0.0
 */
export type Lineage = typeof Lineage.Type

/**
 * Encoded values only: class instances must first pass their own codec.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Success = Schema.TaggedStruct("Success", { value: Schema.Json })

/**
 * Failure channels stay distinct, including interruption and encoding failure.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Failure = Schema.TaggedStruct("Failure", {
  reason: Schema.Literals(["error", "defect", "interrupted", "encoding"]),
  detail: Schema.Json
})

/**
 * Encoded success or a classified failure.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ResultEnvelope = Schema.Union([Success, Failure])
/**
 * Encoded success or a classified failure.
 *
 * @category models
 * @since 1.0.0
 */
export type ResultEnvelope = typeof ResultEnvelope.Type

const timing = { startedAtMs: Event.TimestampMs }
const live = {
  ...timing,
  heartbeatAtMs: Schema.optionalKey(Event.TimestampMs),
  checkpoint: Schema.optionalKey(Schema.Json),
  finishedAtMs: Schema.optionalKey(Schema.Never),
  result: Schema.optionalKey(Schema.Never)
}

/**
 * Completion and its outcome are inseparable; live states cannot carry either.
 *
 * @category schemas
 * @since 1.0.0
 */
export const AttemptLifecycle = Schema.Union([
  Schema.Struct({ state: Schema.Literal("running"), ...live }),
  Schema.Struct({ state: Schema.Literal("suspended"), ...live }),
  Schema.Struct({
    state: Schema.Literal("succeeded"),
    ...timing,
    finishedAtMs: Event.TimestampMs,
    result: Success
  }),
  Schema.Struct({
    state: Schema.Literal("failed"),
    ...timing,
    finishedAtMs: Event.TimestampMs,
    result: Failure
  })
])

/**
 * Wall clocks can move backwards; completion need not be after start.
 *
 * @category models
 * @since 1.0.0
 */
export type AttemptLifecycle = typeof AttemptLifecycle.Type

/**
 * Complete identity and state of one versioned attempt event.
 *
 * @category schemas
 * @since 1.0.0
 */
export const AttemptPayload = Schema.Struct({
  version: Schema.Literal(2),
  lineage: Lineage,
  executionId: Event.RunId,
  stepKeyDigest: Event.DispatchId,
  attempt: Event.NonNegativeQuantity,
  lifecycle: AttemptLifecycle
}).check(Schema.makeFilter((value) => value.executionId === value.lineage.runId))

/**
 * Complete identity and state of one versioned attempt event.
 *
 * @category models
 * @since 1.0.0
 */
export type AttemptPayload = typeof AttemptPayload.Type

/**
 * Durable wait identities; ownership and cancellation remain independent facts.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Wait = Schema.Union([
  Schema.TaggedStruct("Deferred", { waitId: Event.WaitId }),
  Schema.TaggedStruct("Clock", { waitId: Event.WaitId, dueAtMs: Event.TimestampMs })
])

/**
 * A complete execution observation, without operational ownership leases.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ExecutionLifecycle = Schema.Union([
  Schema.Struct({ state: Schema.Literal("running"), waits: Schema.Array(Wait) }),
  Schema.Struct({ state: Schema.Literal("suspended"), waits: Schema.NonEmptyArray(Wait) }),
  Schema.Struct({ state: Schema.Literal("completed"), result: ResultEnvelope })
])

/**
 * Versioned execution, deferred and clock observations. Every variant records
 * its semantic identity and encoded value independently of diagnostics.
 *
 * @category schemas
 * @since 1.0.0
 */
export const StatePayload = Schema.Struct({
  version: Schema.Literal(2),
  lineage: Lineage,
  executionId: Event.RunId,
  event: Schema.Union([
    Schema.TaggedStruct("Execution", { lifecycle: ExecutionLifecycle }),
    Schema.TaggedStruct("DeferredCompleted", { waitId: Event.WaitId, result: ResultEnvelope }),
    Schema.TaggedStruct("ClockScheduled", {
      clockId: Event.CommandId,
      waitId: Event.WaitId,
      dueAtMs: Event.TimestampMs
    })
  ])
}).check(Schema.makeFilter((value) => value.executionId === value.lineage.runId))

/**
 * Versioned execution, deferred and clock observations.
 *
 * @category models
 * @since 1.0.0
 */
export type StatePayload = typeof StatePayload.Type

/**
 * Event family for complete execution, deferred and clock observations.
 *
 * @category constants
 * @since 1.0.0
 */
export const stateEventType = "flows.engine.v2.state-event"

/**
 * New identity prevents old readers mistaking complete state for historical markers.
 *
 * @category constants
 * @since 1.0.0
 */
export const attemptEventType = "flows.engine.v2.attempt-lifecycle"

/**
 * Malformed, foreign, unsupported or inconsistent event evidence.
 *
 * @category errors
 * @since 1.0.0
 */
export class EventError extends Schema.TaggedError<EventError>()("@smthrs/journal/EngineEventError", {
  code: Schema.Literals(["malformed", "unsupported", "foreign", "transition"]),
  message: Schema.String,
  cause: Schema.Unknown
}) {}

/**
 * Every consumer chooses its source allowlist and unknown-namespace policy.
 *
 * @category models
 * @since 1.0.0
 */
export interface Consumer {
  readonly runId: Event.RunId
  readonly lineageId: Event.LineageId
  readonly rootRunId: Event.RunId
  readonly round: number
  readonly parentRunId: Event.RunId | null
  readonly sources: ReadonlyArray<Event.SourceId>
  readonly unknown: "ignore" | "surface"
}

/**
 * A known event or the explicitly selected extension outcome.
 *
 * @category models
 * @since 1.0.0
 */
export type Decoded =
  | { readonly _tag: "Attempt"; readonly entry: Event.Entry; readonly payload: AttemptPayload }
  | { readonly _tag: "State"; readonly entry: Event.Entry; readonly payload: StatePayload }
  | { readonly _tag: "Ignored" }
  | { readonly _tag: "Unknown"; readonly entry: Event.Entry }

const strict = { onExcessProperty: "error" } as const
const decodeRow = (input: unknown) =>
  Effect.gen(function*() {
    const raw = yield* Schema.decodeUnknownEffect(Schema.toEncoded(Event.Entry))(input)
    return yield* Schema.decodeUnknownEffect(Event.Entry)(raw)
  })
const decodePayload = Schema.decodeUnknownSync(AttemptPayload, strict)
const decodeJson = Schema.decodeUnknownSync(Schema.Json)

/**
 * Decode untrusted committed input. Unknown events in the known engine namespace
 * are unsupported errors, never ignored. Original schema/accessor errors stay
 * in cause; foreign identity includes the conflicting evidence in cause.
 *
 * @category decoders
 * @since 1.0.0
 */
export const decodeEntry = (input: unknown, consumer: Consumer): Effect.Effect<Decoded, EventError> =>
  Effect.gen(function*(): Effect.fn.Return<Decoded, unknown> {
    const entry = yield* decodeRow(input)
    if (entry.runId !== consumer.runId || !consumer.sources.includes(entry.sourceId)) {
      throw new EventError({
        code: "foreign",
        message: "event run or source is outside the consumer scope",
        cause: entry
      })
    }
    if (entry.eventType !== attemptEventType && entry.eventType !== stateEventType) {
      if (entry.eventType.startsWith("flows.engine.")) {
        throw new EventError({
          code: "unsupported",
          message: "unsupported engine event family or version",
          cause: entry
        })
      }
      return consumer.unknown === "ignore" ? { _tag: "Ignored" } : { _tag: "Unknown", entry }
    }
    const decoded = entry.eventType === attemptEventType
      ? { _tag: "Attempt" as const, payload: yield* Schema.decodeUnknownEffect(AttemptPayload, strict)(entry.payload) }
      : { _tag: "State" as const, payload: yield* Schema.decodeUnknownEffect(StatePayload, strict)(entry.payload) }
    const { payload } = decoded
    if (
      payload.lineage.runId !== entry.runId || payload.lineage.lineageId !== consumer.lineageId ||
      payload.lineage.rootRunId !== consumer.rootRunId || payload.lineage.round !== consumer.round ||
      payload.lineage.parentRunId !== consumer.parentRunId
    ) {
      throw new EventError({
        code: "foreign",
        message: "event lineage disagrees with its journal or consumer",
        cause: payload.lineage
      })
    }
    // The optional journal side channel is disclosure only. Semantic lineage
    // lives in payload and cannot be replaced by diagnostic metadata.
    yield* Schema.decodeUnknownEffect(Schema.Json)(entry.meta)
    return { ...decoded, entry }
  }).pipe(Effect.catchCause((failure) => {
    const cause = Cause.squash(failure)
    return Effect.fail(
      cause instanceof EventError
        ? cause
        : new EventError({ code: "malformed", message: "invalid engine event", cause })
    )
  }))

/**
 * Construct a versioned submission, validating before journal redaction.
 *
 * @category constructors
 * @since 1.0.0
 */
export const attempt = (
  payload: AttemptPayload,
  sourceId: Event.SourceId,
  sourceSeq: Event.SourceSeq,
  diagnostics: Schema.Json = null
): Event.Input => {
  const validated = decodePayload(payload)
  return new Event.Input({
    runId: validated.lineage.runId,
    sourceId,
    sourceSeq,
    eventType: attemptEventType,
    payload: validated,
    meta: decodeJson(diagnostics)
  })
}

/**
 * Construct a versioned execution, deferred or clock submission. Existing
 * unversioned writers are unchanged and cannot manufacture missing lineage.
 *
 * @category constructors
 * @since 1.0.0
 */
export const stateEvent = (
  payload: StatePayload,
  sourceId: Event.SourceId,
  sourceSeq: Event.SourceSeq,
  diagnostics: Schema.Json = null
): Event.Input => {
  const validated = Schema.decodeUnknownSync(StatePayload, strict)(payload)
  return new Event.Input({
    runId: validated.lineage.runId,
    sourceId,
    sourceSeq,
    eventType: stateEventType,
    payload: validated,
    meta: decodeJson(diagnostics)
  })
}

/**
 * Historical attempt markers deliberately remain incomplete evidence. No
 * result, timestamp, round or lineage root is invented for old rows.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CurrentAttempt = Schema.Union([
  Schema.Struct({
    eventType: Schema.Literal("flows.engine.attempt-started"),
    payload: Schema.Struct({
      version: Schema.optionalKey(Schema.Never),
      runId: Event.RunId,
      stepKeyDigest: Event.DispatchId,
      attempt: Event.NonNegativeQuantity,
      tier: Schema.Literals(["sealed", "compensable", "irreversible"])
    })
  }),
  Schema.Struct({
    eventType: Schema.Literal("flows.engine.attempt-finished"),
    payload: Schema.Struct({
      version: Schema.optionalKey(Schema.Never),
      runId: Event.RunId,
      stepKeyDigest: Event.DispatchId,
      attempt: Event.NonNegativeQuantity,
      state: Schema.Literals(["succeeded", "failed"])
    })
  })
])

/**
 * Decode current markers using their recorded lineage, without upgrading bytes.
 *
 * @category decoders
 * @since 1.0.0
 */
export const decodeCurrentAttempt = (input: unknown, consumer: Consumer) =>
  Effect.gen(function*() {
    const entry = yield* decodeRow(input)
    const marker = yield* Schema.decodeUnknownEffect(CurrentAttempt)(entry)
    const meta = yield* Schema.decodeUnknownEffect(Schema.Struct({ lineageId: Event.LineageId }))(entry.meta)
    if (
      entry.runId !== consumer.runId || marker.payload.runId !== entry.runId ||
      meta.lineageId !== consumer.lineageId || !consumer.sources.includes(entry.sourceId)
    ) {
      throw new EventError({
        code: "foreign",
        message: "current attempt marker is outside the consumer scope",
        cause: entry
      })
    }
    return { entry, marker, lineageId: meta.lineageId }
  }).pipe(Effect.catchCause((failure) => {
    const cause = Cause.squash(failure)
    return Effect.fail(
      cause instanceof EventError
        ? cause
        : new EventError({ code: "malformed", message: "invalid current attempt marker", cause })
    )
  }))

/**
 * Where a declaration was written, as a durable record may carry it.
 *
 * Repo-relative by contract: a journal is read on machines that are not the
 * one that wrote it, so an absolute path is at best noise and at worst an
 * operator's home directory published into a run's history. A writer that
 * cannot make a path relative omits the field.
 *
 * @category schemas
 * @since 1.0.0
 */
export const DeclaredAt = Schema.Struct({
  path: Schema.NonEmptyString.check(Schema.makeFilter((value) => !value.startsWith("/"))),
  line: Event.NonNegativeQuantity
})

/**
 * A root that names the whole filesystem, which is no root at all.
 *
 * `process.cwd()` is `"/"` for a host a launcher started outside any
 * directory, and relativizing against it would make every absolute path
 * "relative": an operator's home directory, minus one leading slash, written
 * into a run's permanent history. The empty string is the same statement, and
 * a Windows drive root (`C:` or `C:\`) is the same statement again. @private
 */
const isFilesystemRoot = (root: string): boolean => root === "" || root === "/" || /^[A-Za-z]:[\\/]?$/.test(root)

/**
 * A declaration path as {@link DeclaredAt} may carry it: relative to the
 * root, or nothing.
 *
 * It lives beside the schema that refuses an absolute path, because obeying
 * that refusal is the writer's one job and every writer obeys it the same
 * way. A path outside the root is omitted rather than recorded with `..`
 * segments, because a reader resolving those would have to know the root,
 * which is exactly the machine-specific fact this strips. A root that is the
 * filesystem itself strips nothing, so it is read as no root.
 *
 * @category accessors
 * @since 1.0.0
 */
export const relativePath = (root: string | undefined, path: string): string | undefined => {
  if (root === undefined || isFilesystemRoot(root) || path === "") return undefined
  const base = root.endsWith("/") ? root : `${root}/`
  if (!path.startsWith(base)) return undefined
  const relative = path.slice(base.length)
  return relative === "" ? undefined : relative
}

/**
 * One node of the graph a run was driven from.
 *
 * `kind` is open text because the two executors name kinds differently and
 * both are true: the plan scheduler's node is a `step`, an `agent` or a
 * `merge`, while the interpreter's is the authoring variant it was observed
 * at. A closed union here would force one of them to lie.
 *
 * @category schemas
 * @since 1.0.0
 */
export const NodeSummary = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.String,
  dependsOn: Schema.Array(Schema.NonEmptyString),
  tier: Schema.Literals(["sealed", "compensable", "irreversible"]),
  key: Schema.optionalKey(Schema.String),
  generation: Schema.optionalKey(Event.NonNegativeQuantity),
  action: Schema.optionalKey(Schema.String),
  effects: Schema.optionalKey(Schema.Json),
  declaredAt: Schema.optionalKey(DeclaredAt)
})

/**
 * One edge of that graph, with the reason the builder drew it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const EdgeSummary = Schema.Struct({
  from: Schema.NonEmptyString,
  to: Schema.NonEmptyString,
  reason: Schema.Literals(["value", "continuation", "failure"])
})

/**
 * The immutable name of a tree a host read declaration sites out of.
 *
 * Exactly the forty lowercase hex digits the only producer emits: a jj
 * working-copy commit id, or a git commit for a tree that still matches one
 * (`SourceRevision.objectId`). It is narrowed here rather than left as text
 * because a reader puts it straight into a contents route's `?ref=`, and
 * `DeclaredAt` beside it refuses an absolute path for the same class of
 * reason: a field that only ever holds one shape should refuse the others at
 * the boundary rather than at whatever spawns a process downstream.
 *
 * @category schemas
 * @since 1.0.0
 */
export const SourceRevision = Schema.NonEmptyString.check(Schema.makeFilter((value) => /^[0-9a-f]{40}$/.test(value)))

/**
 * The graph, or one page of it, carried beside a plan record.
 *
 * `edges` is optional because only one writer can answer it honestly. A plan
 * names its edges through each node's `dependsOn` and knows no reason for
 * them; an interpreter knows the reason it drew each one. A writer without
 * reasons omits the field rather than labelling every edge `value`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const NodeGraph = Schema.Struct({
  nodes: Schema.Array(NodeSummary),
  edges: Schema.optionalKey(Schema.Array(EdgeSummary)),
  /**
   * The revision of the tree the nodes on this page were read out of.
   *
   * A `declaredAt` is a path and a line, and neither says which bytes were
   * at that line: a working tree moves, so the same path after an edit or a
   * branch switch is a different file. Only the writer can answer this —
   * like the root a path is made relative to — so it travels with the page
   * the sites travel on, and a reader can ask for the file AT this revision
   * instead of whatever is on disk when they look.
   *
   * Optional because only a writer served out of a version-controlled tree
   * can name one. A writer that cannot says nothing, and a reader that has
   * nothing shows no code rather than code it cannot bind (D-068).
   */
  sourceRevision: Schema.optionalKey(SourceRevision)
})

/**
 * A plan was recorded and a run is about to be driven under it.
 *
 * `nodes` is the node COUNT the record has always carried. The node list
 * arrives beside it as `graph`, optional and paged, because a journal entry
 * has a byte bound: what does not fit follows as {@link SubgraphAppended}
 * pages rather than being clipped.
 *
 * Everything an executor cannot honestly answer is optional rather than
 * invented. The interpreter drives a graph with no plan id, no plan digest
 * and no store to record an outcome with, and saying so is the point of this
 * schema.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PlanRecordedPayload = Schema.Struct({
  planId: Schema.optionalKey(Schema.NonEmptyString),
  flow: Schema.NonEmptyString,
  digest: Schema.optionalKey(Schema.String),
  baseDigest: Schema.optionalKey(Schema.String),
  generation: Event.NonNegativeQuantity,
  nodes: Event.NonNegativeQuantity,
  outcome: Schema.optionalKey(Schema.String),
  page: Schema.optionalKey(Event.NonNegativeQuantity),
  pages: Schema.optionalKey(Event.NonNegativeQuantity),
  graph: Schema.optionalKey(NodeGraph)
})

/**
 * An elaboration appended a pre-keyed subgraph to the same plan, or the next
 * page of a graph too large for one record.
 *
 * @category schemas
 * @since 1.0.0
 */
export const SubgraphAppendedPayload = Schema.Struct({
  planId: Schema.optionalKey(Schema.NonEmptyString),
  flow: Schema.optionalKey(Schema.NonEmptyString),
  digest: Schema.optionalKey(Schema.String),
  baseDigest: Schema.optionalKey(Schema.String),
  generation: Event.NonNegativeQuantity,
  nodeIds: Schema.Array(Schema.NonEmptyString),
  page: Schema.optionalKey(Event.NonNegativeQuantity),
  pages: Schema.optionalKey(Event.NonNegativeQuantity),
  graph: Schema.optionalKey(NodeGraph)
})

/**
 * A plan node was admitted and its work is about to start.
 *
 * @category schemas
 * @since 1.0.0
 */
export const NodeScheduledPayload = Schema.Struct({
  planId: Schema.optionalKey(Schema.NonEmptyString),
  nodeId: Schema.NonEmptyString,
  kind: Schema.String,
  planKey: Schema.optionalKey(Schema.String),
  dispatchKey: Schema.optionalKey(Schema.String),
  attempt: Event.PositiveQuantity,
  priority: Schema.optionalKey(Schema.Int),
  waited: Schema.optionalKey(Event.NonNegativeQuantity),
  action: Schema.optionalKey(Schema.String)
})

/**
 * A bounded look at what a node settled with.
 *
 * `preview` is JSON text, redacted before it was encoded and cut to a fixed
 * ceiling afterwards, so a long value costs a durable row a known number of
 * bytes rather than however many it happens to hold. `truncated` says the cut
 * happened, which is also the warning that the text is a PREFIX of JSON and
 * no longer parses. `bytes` is the size of the encoding the preview was cut
 * from, so a reader can say how much was left out without being shown it; a
 * value too large for a writer to redact at all is named by the size of its
 * own encoding, with an empty preview and the flag set.
 *
 * Redaction comes first and truncation second on purpose: cutting the text
 * first can split a credential across the boundary, and a textual redactor
 * scanning the remains would no longer recognise it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const NodeResultSummary = Schema.Struct({
  preview: Schema.String,
  bytes: Event.NonNegativeQuantity,
  truncated: Schema.Boolean
})

/**
 * A plan node reached an outcome.
 *
 * The outcomes are Skyframe's evaluation states: `built` ran,
 * `clean` was served from records, `failed` raised, `skipped` was never
 * reached, and `deferred` is a scheduling debt the plan scheduler alone
 * records.
 *
 * `attempts` is the executor's own count. For the plan scheduler it is the
 * node's; for the interpreter it is the highest durable attempt any of this
 * node's dispatches ran as, because the interpreter settles each node once
 * and a retry happens underneath it inside one dispatch.
 *
 * `stepKeyDigests` names the dispatches the node drove, and it is the join
 * `flows.engine.attempt-started` could not make on its own: an attempt record
 * carries a step key digest and no node id, so an attempt belongs to the node
 * whose settlement claims its digest. A retried dispatch keeps ONE digest —
 * the attempt is folded into no key — so the list is distinct dispatches, not
 * attempts. A writer that derives no digests omits the field; a node that
 * dispatched nothing records an empty list, which is a different statement.
 *
 * `result` is what the node settled with: the success value for `built` and
 * `clean`, the typed failure for `failed`, bounded and redacted by the writer.
 * Absent when the writer kept none.
 *
 * @category schemas
 * @since 1.0.0
 */
export const NodeSettledPayload = Schema.Struct({
  planId: Schema.optionalKey(Schema.NonEmptyString),
  nodeId: Schema.NonEmptyString,
  planKey: Schema.optionalKey(Schema.String),
  dispatchKey: Schema.optionalKey(Schema.String),
  stepKeyDigests: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  outcome: Schema.Literals(["built", "clean", "failed", "skipped", "deferred"]),
  attempts: Event.NonNegativeQuantity,
  rebases: Schema.optionalKey(Event.NonNegativeQuantity),
  action: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(NodeResultSummary)
})

/**
 * A scheduled node's dispatch identity was invalidated and re-keyed.
 *
 * @category schemas
 * @since 1.0.0
 */
export const NodeInvalidatedPayload = Schema.Struct({
  planId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  planKey: Schema.String,
  from: Schema.String,
  to: Schema.String,
  reason: Schema.Literal("measured-inputs-changed")
})

/**
 * The reconciliation seam returned a verdict for a deviation.
 *
 * @category schemas
 * @since 1.0.0
 */
export const NodeReconciledPayload = Schema.Struct({
  planId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  trigger: Schema.String,
  verdict: Schema.Json
})

/**
 * Where a declaration was written, as a durable record carries it.
 *
 * @category models
 * @since 1.0.0
 */
export type DeclaredAt = typeof DeclaredAt.Type

/**
 * One node of the graph a run was driven from.
 *
 * @category models
 * @since 1.0.0
 */
export type NodeSummary = typeof NodeSummary.Type

/**
 * One edge of the graph a run was driven from.
 *
 * @category models
 * @since 1.0.0
 */
export type EdgeSummary = typeof EdgeSummary.Type

/**
 * The graph, or one page of it, carried beside a plan record.
 *
 * @category models
 * @since 1.0.0
 */
export type NodeGraph = typeof NodeGraph.Type

/**
 * A plan was recorded and a run is about to be driven under it.
 *
 * @category models
 * @since 1.0.0
 */
export type PlanRecordedPayload = typeof PlanRecordedPayload.Type

/**
 * An elaboration appended a subgraph, or the next page of a large graph.
 *
 * @category models
 * @since 1.0.0
 */
export type SubgraphAppendedPayload = typeof SubgraphAppendedPayload.Type

/**
 * A plan node was admitted and its work is about to start.
 *
 * @category models
 * @since 1.0.0
 */
export type NodeScheduledPayload = typeof NodeScheduledPayload.Type

/**
 * A bounded look at what a node settled with.
 *
 * @category models
 * @since 1.0.0
 */
export type NodeResultSummary = typeof NodeResultSummary.Type

/**
 * A plan node reached an outcome.
 *
 * @category models
 * @since 1.0.0
 */
export type NodeSettledPayload = typeof NodeSettledPayload.Type

/**
 * A scheduled node's dispatch identity was invalidated and re-keyed.
 *
 * @category models
 * @since 1.0.0
 */
export type NodeInvalidatedPayload = typeof NodeInvalidatedPayload.Type

/**
 * The reconciliation seam's verdict for one deviation.
 *
 * @category models
 * @since 1.0.0
 */
export type NodeReconciledPayload = typeof NodeReconciledPayload.Type

/**
 * The event type each node and plan payload is recorded under.
 *
 * Readers and writers share these identities, so a value here is stored
 * history and changing one requires migrating it.
 *
 * @category constants
 * @since 1.0.0
 */
export const nodeEventTypes = {
  planRecorded: "flows.engine.plan-recorded",
  subgraphAppended: "flows.engine.subgraph-appended",
  nodeScheduled: "flows.engine.node-scheduled",
  nodeSettled: "flows.engine.node-settled",
  nodeInvalidated: "flows.engine.node-invalidated",
  nodeReconciled: "flows.engine.node-reconciled"
} as const
