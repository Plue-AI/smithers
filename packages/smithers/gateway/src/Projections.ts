/**
 * The gateway read path: served projections computed from the control plane.
 *
 * Every projection here is a fold over facts `@smthrs/control` already
 * publishes: `Control.list` for run and flow listings, `Control.watch` for a
 * run's ordered events. The gateway never opens the engine database, so a
 * projection served to a browser through a relay is the same projection a
 * local reader computes, and a projection cannot drift from the control plane
 * by reading a column the control plane does not expose.
 *
 * A snapshot brackets its journal read with run-summary reads and retries
 * when the summary changes. Rows and cursor share the resulting event buffer,
 * so a completion cannot be acknowledged with the preceding run status.
 *
 * A subscription is a snapshot followed by deltas. A delta recomputes the
 * selector's rows from the accumulated events rather than patching them: a
 * projection is a reproducible fold (`@smthrs/journal` `Projection`), and
 * recomputation is the only delta that cannot disagree with a fresh snapshot.
 * `run-events` appends immutable rows. `transcript` normally appends too, but
 * sends an existing snapshot reset when a committed native call fact upgrades
 * previously delivered telemetry. Events accumulate in the stream, so each delta
 * folds without re-reading history. Resuming a historical run summary first
 * rebuilds its compacted health prefix once through durable follow replay.
 *
 * A workspace subscription follows every journal partition without a cursor.
 * The follower stores each retained run's last position and drops replay
 * through that cutoff. Sources and exclusion verdicts share the snapshot's
 * run ceiling; eviction discards a verdict together with its cursor state.
 * Events are gathered for a short window and folded into one frame, and each
 * run's rows are cached so a burst refolds only the runs whose journals grew.
 *
 * @since 1.0.0
 */

import type { Service as ControlService } from "@smthrs/control/Control"
import { Control } from "@smthrs/control/Control"
import * as ControlSchema from "@smthrs/control/ControlSchema"
import * as Health from "@smthrs/control/Health"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import * as Diagnosis from "./Diagnosis.ts"
import { GatewayError, settingRefusal } from "./GatewayError.ts"
import * as GatewayProjection from "./GatewayProjection.ts"
import * as GatewaySchema from "./GatewaySchema.ts"
import { callEventKey, nativeCallEvent, nativeStepEvent } from "./internal/callEvents.ts"
import { retainedDigestBytes } from "./internal/digestMemory.ts"

/**
 * How often an idle subscription emits a keepalive frame.
 *
 * The Smithers Cloud relay cuts an idle tunnel at 600 s (the deployed relay behavior), so a
 * quiet run must produce a frame well inside that window or the connection is
 * dropped and every follower reconnects. Thirty seconds leaves twenty
 * heartbeats of margin.
 *
 * @since 1.0.0
 * @category models
 */
export const heartbeatIntervalMillis = 30_000

/**
 * The most runs one workspace projection folds, newest first.
 *
 * A workspace projection reads one full journal per run, so the number of
 * runs it folds is bounded on purpose. This is the gateway's own ceiling, not
 * the control plane's default page size. It is 500 because that equals
 * `ControlSchema.maxPageSize`, letting the control plane satisfy the whole
 * gateway allowance in one page when it can.
 *
 * @since 1.0.0
 * @category models
 */
export const maxWorkspaceRuns = 500

/** Whether `run` was created after `other`, ties broken by run id. */
const createdAfter = (run: ControlSchema.RunSummary, other: ControlSchema.RunSummary): boolean =>
  run.createdAt !== other.createdAt ? run.createdAt > other.createdAt : run.runId > other.runId

/**
 * The most journal events one run projection retains in its window.
 *
 * This is a retention ceiling, not a refusal. A run that journals more keeps
 * its most recent {@link maxEventsPerRun} events and folds everything older
 * into the carried digest that {@link maxProjectionBytes} describes.
 *
 * @since 1.0.0
 * @category models
 */
export const maxEventsPerRun = 10_000

/**
 * The most journal events one run projection reads before it stops reading.
 *
 * The window ceiling bounds memory; this bounds work. A projection folds every
 * event it reads, so a run with a million of them would cost a million decodes
 * on every snapshot however few it kept. Ten times the window is the honest
 * compromise: every real run is far inside it, and a runaway one still answers
 * rather than running the reader out of time.
 *
 * @since 1.0.0
 * @category models
 */
export const maxEventsScanned = 100_000

/**
 * The most events one `run-events` snapshot page carries.
 *
 * `run-events` is the one selector whose rows are the journal itself, so it is
 * the one selector a client must page rather than fold. A snapshot answers at
 * most this many events and a cursor to ask for the next page from, so reading
 * a long run costs one bounded response per page instead of one response the
 * size of the whole run.
 *
 * @since 1.0.0
 * @category models
 */
export const maxEventsPerPage = 1_000

/**
 * The most terminal runs of one flow a duration fold measures.
 *
 * A prediction wants recent history, not all of it: an old run measured a
 * different declaration on a different machine. The newest finished runs are
 * the ones whose durations still describe what the flow does now, and the
 * bound is what keeps a snapshot from reading every journal a flow ever wrote.
 *
 * @since 1.0.0
 * @category models
 */
export const maxDurationRuns = 20

/**
 * The largest encoded event window or projected row set one run admits.
 *
 * The row budget is a refusal: rows go on the wire, and a frame larger than
 * this is one no client asked for. The window budget is retention: events
 * older than the newest {@link maxProjectionBytes} are folded into a carried
 * digest instead of being held. Its compact identity contributions share this
 * budget; if they cannot fit, the read refuses instead of reporting inexact
 * counters or retaining an unbounded identity set.
 *
 * @since 1.0.0
 * @category models
 */
export const maxProjectionBytes = 4 * 1024 * 1024

/**
 * The largest encoded form one retained journal event may take.
 *
 * A model request body, a response transcript, and a tool's captured output
 * are all journaled inline, and any one of them can be megabytes. Nothing a
 * projection reads out of a payload is long: a seat name, a flow name, an
 * outcome, a token count, a first line. A retained event is therefore clipped
 * to this budget rather than held whole, which is what keeps one wiki refresh
 * that retried a model call nine times from costing a run card its whole
 * history. `run-events` pages preserve native engine evidence because clients
 * decode its complete contracts to offer actions. Other large bodies remain
 * clipped; their full content belongs in run artifacts.
 *
 * @since 1.0.0
 * @category models
 */
export const maxEventBytes = 16 * 1024

/**
 * The longest string a clipped payload keeps.
 *
 * Applied only to an event already over {@link maxEventBytes}, so an ordinary
 * event reaches a projection byte for byte.
 */
const clippedTextPoints = 2_048

/**
 * How long a workspace follower gathers events before folding one delta.
 *
 * A workspace delta replaces every row, so its cost is the whole workspace,
 * not the one event that arrived. Gathering a burst into one frame bounds the
 * frame rate at twenty per second however many runs journal at once, and
 * fifty milliseconds is below what a dashboard reader can notice.
 */
const workspaceDeltaCoalesceMillis = 50

/** The most events one workspace batch gathers before folding inside the window. */
const workspaceDeltaBatchSize = 1_024

/**
 * Read-path operations served by the gateway.
 *
 * @since 1.0.0
 * @category models
 */
export interface Service {
  /**
   * Current rows, or only run-events rows after an issued cursor.
   *
   * A literal selector keeps its own row type, so an approvals reader reads
   * `requestId` and a run-tree reader reads `nodeId` without an assertion. A
   * selector chosen at runtime still answers with the snapshot union.
   */
  readonly snapshot: <S extends GatewaySchema.ProjectionSelector>(
    selector: S,
    after?: GatewaySchema.ProjectionCursor | undefined
  ) => Effect.Effect<GatewaySchema.SnapshotOf<S>, GatewayError>
  /**
   * A snapshot followed by recomputed deltas and keepalive frames, or, when
   * `after` names a cursor this selector issued, the deltas after it alone.
   *
   * The row and delta frames are the selector's own, on the same rule as
   * `snapshot`.
   */
  readonly subscribe: <S extends GatewaySchema.ProjectionSelector>(
    selector: S,
    after?: GatewaySchema.ProjectionCursor | undefined
  ) => Stream.Stream<GatewaySchema.FrameOf<S>, GatewayError>
}

/**
 * The gateway read path.
 *
 * @since 1.0.0
 * @category services
 */
export class Projections extends Context.Service<Projections, Service>()("@smthrs/gateway/Projections") {}

/**
 * The part of a control-plane failure a client is allowed to see: the failure's
 * tag and its stable code, never its message, its nested cause, or the SQL and
 * file paths a `PersistenceError` carries.
 *
 * Server logs carry only an operation identifier and an allowlisted summary.
 * `GatewayError` is the RPC error schema, so anything left on it is serialized
 * to every bearer holder and
 * forwarded to the browser by the product relay, and a cause JSON cannot encode
 * would make the error frame itself fail to encode.
 */
const summarize = (cause: unknown): { readonly _tag: string; readonly code?: string } | undefined => {
  const record = typeof cause === "object" && cause !== null ? cause as Record<string, unknown> : undefined
  if (record === undefined || typeof record._tag !== "string") return undefined
  return typeof record.code === "string" ? { _tag: record._tag, code: record.code } : { _tag: record._tag }
}

/** Log only known control-plane identifiers, never arbitrary backend text. */
const logReadFailure = (
  operation: "list-runs" | "read-events" | "follow-run" | "follow-workspace",
  cause: unknown
) => {
  const summary = summarize(cause)
  const known = summary?._tag === "/control/PersistenceError" && summary.code === "persistence_failed" ||
    summary?._tag === "/control/Unavailable" && summary.code === "unavailable"
  return Effect.logWarning({ operation, ...(known ? summary : {}) })
}

/** The read failed, with only a public error summary. */
const unavailable = (message: string, cause: unknown): GatewayError => {
  const summary = summarize(cause)
  return new GatewayError({
    code: "run_unavailable",
    message,
    ...(summary === undefined ? {} : { cause: summary })
  })
}

/** The request named something the control plane cannot serve. */
const malformed = (message: string): GatewayError => new GatewayError({ code: "malformed_request", message })

/** A projection exceeded the bounded read or wire budget. */
const resourceLimit = (message: string): GatewayError => new GatewayError({ code: "resource_limit", message })

/** The run a selector is scoped to, or undefined for a workspace selector. */
const scopeOf = (selector: GatewaySchema.ProjectionSelector): string | undefined =>
  "runId" in selector ? selector.runId : undefined

interface CursorPosition {
  readonly value: number
  readonly offset: number
}

interface EventBuffer {
  readonly compactHealth: boolean
  readonly seen: boolean
  readonly events: Array<ControlSchema.ControlEvent>
  readonly encodedBytes: number
  readonly lastPosition: CursorPosition
  /**
   * The digest of the events this buffer read and dropped to stay bounded.
   *
   * Undefined until something is dropped, so an ordinary run is folded exactly
   * as it was before the window existed. A run card combines it with the
   * digest of the retained window, so turns, calls, edits, tokens, and the run
   * span describe every event read rather than only the ones still held.
   */
  readonly carry: Diagnosis.Digest | undefined
  /** How many events the window dropped, for a reader that reports the cut. */
  readonly dropped: number
}

const emptyEventBuffer = (compactHealth = false): EventBuffer => ({
  compactHealth,
  seen: false,
  events: [],
  encodedBytes: 2,
  lastPosition: { value: 0, offset: 0 },
  carry: undefined,
  dropped: 0
})

const textEncoder = new TextEncoder()

const encodedSize = (value: unknown): number => textEncoder.encode(JSON.stringify(value)).byteLength

/**
 * One payload with every long string cut to {@link clippedTextPoints}.
 *
 * Structure is preserved so a payload stays decodable: a clipped string is
 * still a string, an object keeps its keys, and an array keeps its length.
 * Only the text shrinks, and `Diagnosis.clip` marks the cut.
 */
const clipDeep = (value: unknown): unknown => {
  if (typeof value === "string") return Diagnosis.clip(value, clippedTextPoints)
  if (Array.isArray(value)) return value.map(clipDeep)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, clipDeep(member)]))
  }
  return value
}

const isJsonObject = (json: Schema.Json): json is Schema.JsonObject =>
  typeof json === "object" && json !== null && !Array.isArray(json)

/**
 * The retained form of one event: itself when it is small, a clipped copy when
 * it is not.
 *
 * A payload that is still over the budget after clipping is replaced outright.
 * That is a payload whose size is in its shape rather than in its text — tens
 * of thousands of keys — and no projection reads such a shape. A relevance
 * reading is the exception: a large catalog makes its flow and skill verdicts
 * that wide, and the run card reads its memory verdicts
 * (`RunTrace.runMemoryOf`), so those are retained beside the marker.
 */
const retainedEvent = (event: ControlSchema.ControlEvent): ControlSchema.ControlEvent => {
  if (encodedSize(event) <= maxEventBytes) return event
  const clipped = { ...event, payload: clipDeep(event.payload) as ControlSchema.ControlEvent["payload"] }
  if (encodedSize(clipped) <= maxEventBytes) return clipped
  const marker = { truncated: true, encodedBytes: encodedSize(event.payload) }
  const payload = event.payload
  if (event.kind === "control.agent.relevance-settled" && isJsonObject(payload)) {
    const memory = (verdicts: unknown) =>
      Array.isArray(verdicts)
        ? verdicts.filter((verdict) =>
          typeof verdict === "object" && verdict !== null && (verdict as { readonly kind?: unknown }).kind === "memory"
        )
        : []
    const compact = {
      ...event,
      payload: {
        ...marker,
        kept: clipDeep(memory(payload.kept)),
        withheld: clipDeep(memory(payload.withheld))
      } as ControlSchema.ControlEvent["payload"]
    }
    if (encodedSize(compact) <= maxEventBytes) return compact
  }
  return { ...event, payload: marker }
}

const decodeEvent = Schema.decodeUnknownSync(ControlSchema.ControlEvent)
const decodeFrame = Schema.decodeUnknownSync(GatewaySchema.GatewayFrame)
const decodeSnapshot = Schema.decodeUnknownSync(GatewaySchema.ProjectionSnapshot)

const decodedEvent = (
  candidate: unknown,
  message: string
): Effect.Effect<ControlSchema.ControlEvent, GatewayError> =>
  Effect.suspend(() => {
    try {
      const event = decodeEvent(candidate)
      // Graph topology is a bounded contract. Refuse an oversized legacy page
      // intact; clipping a node id or dependency would silently change the DAG.
      const payload = event.payload
      if (
        event.kind === "control.engine.event" && typeof payload === "object" && payload !== null &&
        "eventType" in payload && (payload.eventType === "flows.engine.plan-recorded" ||
          payload.eventType === "flows.engine.subgraph-appended") &&
        encodedSize(event) > maxEventBytes
      ) {
        return Effect.fail(resourceLimit(`One graph event exceeds ${maxEventBytes} encoded bytes`))
      }
      return Number.isSafeInteger(event.sequence) && event.sequence >= 0
        ? Effect.succeed(event)
        : Effect.fail(unavailable(message, undefined))
    } catch (cause) {
      return Effect.fail(unavailable(message, cause))
    }
  })

const appendEvent = (
  state: EventBuffer,
  candidate: unknown,
  message: string,
  run: ControlSchema.RunSummary
): Effect.Effect<EventBuffer, GatewayError> =>
  Effect.flatMap(decodedEvent(candidate, message), (decoded) => {
    if (state.seen && decoded.sequence < state.lastPosition.value) {
      return Effect.fail(unavailable(message, undefined))
    }
    // A payload larger than one projection reads is clipped before it is
    // measured, so a journaled model body costs the window its own size and
    // not the body's.
    const event = retainedEvent(decoded)
    // `decodedEvent` has already rebuilt payload through `Schema.Json`, so it
    // contains neither accessors nor `toJSON` hooks and JSON encoding cannot
    // execute caller code here.
    const bytes = encodedSize(event)
    let removedBytes = 0
    let keep = true
    if (state.compactHealth && event.kind === Health.statusObservedEventType) {
      const decoded = Schema.decodeUnknownOption(Health.HealthObservation)(event.payload)
      // Match the subject before incarnation precedence or eviction, as the
      // authoritative health fold does. Foreign evidence must not displace
      // this run's reading, but its raw journal position still advances below.
      if (
        decoded._tag === "None" || decoded.value.outcome === "discarded" ||
        decoded.value.subjectId !== `run:${run.runId}`
      ) keep = false
      else {
        const same = state.events.findIndex((old) =>
          old.kind === Health.statusObservedEventType &&
          typeof old.payload === "object" && old.payload !== null && !Array.isArray(old.payload) &&
          "incarnation" in old.payload &&
          (old.payload as { readonly incarnation?: unknown }).incarnation === decoded.value.incarnation
        )
        if (same >= 0) {
          const previous = state.events[same]!
          const prior = previous.payload as { readonly evidenceSeq: number }
          if (prior.evidenceSeq > decoded.value.evidenceSeq) keep = false
          else removedBytes += textEncoder.encode(JSON.stringify(state.events.splice(same, 1)[0])).byteLength + 1
        }
        // Pin the authoritative incarnation's strongest reading. Late former
        // owners must not evict it and let weaker evidence replace it later.
        // The other slots retain recent opaque incarnations within the same cap.
        const healthEntries = state.events.filter((old) => old.kind === Health.statusObservedEventType)
        if (keep && healthEntries.length >= 16) {
          const incarnation = Health.runIncarnation(run)
          // There is at most one entry per incarnation, so an unprotected entry exists.
          const oldest = state.events.indexOf(
            healthEntries.find((old) => (old.payload as { readonly incarnation: string }).incarnation !== incarnation)!
          )
          removedBytes += textEncoder.encode(JSON.stringify(state.events.splice(oldest, 1)[0])).byteLength + 1
        }
      }
    } else if (state.compactHealth && event.kind === "control.monitor.beat") keep = false
    let encodedBytes = Math.max(2, state.encodedBytes - removedBytes) +
      (keep ? bytes + (state.events.length === 0 ? 0 : 1) : 0)
    // Unreachable today: every term is a byte length, `state.encodedBytes` is
    // bounded by `maxProjectionBytes` by the loop below, and one event is
    // bounded by the string the control plane sent, so the sum is always a
    // safe integer. The refusal stays because a later term need not be, and a
    // window that cannot count its own bytes must refuse rather than report.
    /* v8 ignore next 3 -- unreachable while every term above is a byte length. */
    if (!Number.isSafeInteger(encodedBytes)) {
      return Effect.fail(unavailable(message, undefined))
    }
    const offset = state.seen && event.sequence === state.lastPosition.value
      ? state.lastPosition.offset + 1
      : 0
    if (keep) state.events.push(event)
    // Event bodies may leave the window while compact identity contributions
    // keep the diagnosis exact. Both share the byte budget; if even the scalar
    // state cannot fit, refuse instead of silently forgetting identities.
    let carry = state.carry
    let dropped = state.dropped
    while (state.events.length > maxEventsPerRun || encodedBytes > maxProjectionBytes) {
      const evicted = state.events.shift()
      if (evicted === undefined) {
        return Effect.fail(resourceLimit(`Projection identity state exceeds ${maxProjectionBytes} encoded bytes`))
      }
      encodedBytes = Math.max(2, encodedBytes - encodedSize(evicted) - (state.events.length === 0 ? 0 : 1))
      const previousCarryBytes = retainedDigestBytes(carry)
      carry = Diagnosis.combine(carry ?? Diagnosis.emptyDigest(), Diagnosis.digest([evicted], run.runId))
      encodedBytes += retainedDigestBytes(carry) - previousCarryBytes
      dropped += 1
    }
    return Effect.succeed({
      compactHealth: state.compactHealth,
      seen: true,
      events: state.events,
      encodedBytes,
      lastPosition: { value: event.sequence, offset },
      carry,
      dropped
    })
  })

const bufferOf = (
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  message: string,
  compactHealth: boolean,
  run: ControlSchema.RunSummary
): Effect.Effect<EventBuffer, GatewayError> =>
  events.reduce(
    (state, event) => Effect.flatMap(state, (buffer) => appendEvent(buffer, event, message, run)),
    Effect.succeed(emptyEventBuffer(compactHealth)) as Effect.Effect<EventBuffer, GatewayError>
  )

const cursorOf = (
  selector: GatewaySchema.ProjectionSelector,
  position: CursorPosition
): GatewaySchema.ProjectionCursor => ({
  selector,
  projection: selector._tag,
  runId: scopeOf(selector) ?? null,
  value: position.value,
  offset: position.offset
})

const comparePosition = (left: CursorPosition, right: CursorPosition): number =>
  left.value === right.value ? left.offset - right.offset : left.value - right.value

const positionedEvents = (
  events: ReadonlyArray<ControlSchema.ControlEvent>
): ReadonlyArray<{ readonly event: ControlSchema.ControlEvent; readonly position: CursorPosition }> => {
  let sequence = -1
  let offset = 0
  return events.map((event) => {
    offset = event.sequence === sequence ? offset + 1 : 0
    sequence = event.sequence
    return { event, position: { value: sequence, offset } }
  })
}

const sameSelector = (
  left: GatewaySchema.ProjectionSelector,
  right: GatewaySchema.ProjectionSelector
): boolean => {
  if (left._tag !== right._tag) return false
  switch (left._tag) {
    case "workspace-runs":
      return left.flowId === (right as GatewaySchema.WorkspaceRunsSelector).flowId
    case "approvals":
      return left.runId === (right as GatewaySchema.ApprovalsSelector).runId
    case "node-output": {
      const candidate = right as GatewaySchema.NodeOutputSelector
      return left.runId === candidate.runId && left.nodeId === candidate.nodeId
    }
    case "flow-durations":
      return left.flowId === (right as GatewaySchema.FlowDurationsSelector).flowId
    default:
      return left.runId === (right as GatewaySchema.RunSummarySelector).runId
  }
}

/** One run and the journal it has committed, read together and read once. */
interface RunSource extends EventBuffer {
  readonly run: ControlSchema.RunSummary
}

/** Everything a selector folds, read once per snapshot. */
type Source =
  | { readonly _tag: "run"; readonly run: RunSource }
  | { readonly _tag: "workspace"; readonly runs: ReadonlyArray<RunSource> }

/**
 * The rows one run contributes to a selector.
 *
 * Pure and total over facts already read: it never reads the control plane, so
 * a delta folded from accumulated events and a fresh snapshot compute the same
 * rows from the same events. `workspace-runs` appears here because a workspace
 * listing is one summary row per run, folded by this same function.
 */
const rowsOfRun = (
  selector: GatewaySchema.ProjectionSelector,
  source: {
    readonly run: ControlSchema.RunSummary
    readonly events: ReadonlyArray<ControlSchema.ControlEvent>
    readonly carry?: Diagnosis.Digest | undefined
  },
  now: number
): ReadonlyArray<unknown> => {
  switch (selector._tag) {
    case "workspace-runs":
    case "run-summary":
      return [GatewayProjection.runSummary(source.run, source.events, now, source.carry)]
    case "run-tree":
      return GatewayProjection.runTree(source.run, source.events)
    case "run-events":
      return source.events
    case "transcript":
      return GatewayProjection.transcript(source.events)
    case "approvals":
      return GatewayProjection.approvals(source.events, source.run)
    case "node-output":
      return GatewayProjection.nodeOutput(source.events).filter((row) => row.nodeId === selector.nodeId)
    case "flow-durations":
      // One run contributes the executions it measured, never a percentile:
      // a percentile over one run is that run, and the rows this selector
      // serves are folded across every run the flow has finished. The carry
      // travels with the window because the record that names this run's
      // native root is the first one a bounded window drops.
      return GatewayProjection.nodeDurations(source.events, source.carry)
  }
}

/** Turns opened so far, for numbering appended transcript rows without a refold. */
const turnsOpened = (events: ReadonlyArray<ControlSchema.ControlEvent>): number =>
  GatewayProjection.transcript(events).at(-1)?.turn ?? 0

/**
 * The transcript rows one appended event contributes.
 *
 * A transcript row is immutable once folded and only the turn counter carries
 * across events, so folding the one event and offsetting its turn produces
 * exactly the rows a full refold would append.
 */
const transcriptAppend = (
  event: ControlSchema.ControlEvent,
  turnsBefore: number
): ReadonlyArray<GatewayProjection.TranscriptRow> =>
  GatewayProjection.transcript([event]).map((row) => ({ ...row, turn: row.turn + turnsBefore }))

/** Snapshot and follow admit exactly the same runs to the workspace inbox. */
const eligibleForWorkspace = (selector: GatewaySchema.ProjectionSelector, source: RunSource): boolean =>
  selector._tag !== "approvals" ||
  source.run.status === "waiting-approval" &&
    GatewayProjection.approvals(source.events, source.run).some((row) => row.status === "pending")

/**
 * Which open human wait a pending approval row is about, if it is about one.
 *
 * A nested wait is rolled onto the root AND onto every execution between, so
 * one question reaches a workspace listing once per ancestor. The inbox is a
 * list of questions, not of the runs that contain them, so it keeps one row
 * for each wait point: the one its outermost owner projects. See
 * {@link ownerRank}.
 */
const waitIdentity = (row: GatewayProjection.ApprovalRow): string | undefined =>
  row.waitRunId === undefined ? undefined : `${row.waitRunId}:${row.requestId}`

/**
 * How far out each listed run sits, as a comparable key: fewer listed
 * ancestors first, then the earlier created, then the run id.
 *
 * Ancestry is the explicit `parentRunId` chain among the runs listed, because
 * the listing order is the control plane's to choose (the SQL listing is
 * newest first) and two runs of one tree can share a creation millisecond.
 * Creation order breaks the ties ancestry leaves: an ancestor exists before
 * the execution it spawned.
 */
const ownerRank = (
  runs: ReadonlyArray<ControlSchema.RunSummary>
): (left: ControlSchema.RunSummary, right: ControlSchema.RunSummary) => number => {
  const listed = new Map(runs.map((run) => [run.runId, run]))
  const depths = new Map<string, number>()
  const depthOf = (run: ControlSchema.RunSummary): number => {
    const known = depths.get(run.runId)
    if (known !== undefined) return known
    // Marked before the walk so a cyclic parent chain ends instead of looping.
    depths.set(run.runId, 0)
    const parent = run.parentRunId === undefined ? undefined : listed.get(run.parentRunId)
    const depth = parent === undefined ? 0 : depthOf(parent) + 1
    depths.set(run.runId, depth)
    return depth
  }
  return (left, right) => depthOf(left) - depthOf(right) || (createdAfter(left, right) ? 1 : -1)
}

/**
 * The workspace approvals inbox over each run's own pending rows.
 *
 * Every read of the inbox, snapshot and delta alike, folds through here, so a
 * nested question is one row owned by its outermost run whichever read
 * produced it. Rows keep the order of the runs given.
 */
const approvalInbox = (
  perRun: ReadonlyArray<{ readonly run: ControlSchema.RunSummary; readonly rows: ReadonlyArray<unknown> }>
): ReadonlyArray<GatewayProjection.ApprovalRow> => {
  const owners = new Map<string, string>()
  const rank = ownerRank(perRun.map(({ run }) => run))
  for (const { run, rows } of [...perRun].sort((left, right) => rank(left.run, right.run))) {
    for (const row of rows as ReadonlyArray<GatewayProjection.ApprovalRow>) {
      const identity = waitIdentity(row)
      if (identity !== undefined && !owners.has(identity)) owners.set(identity, run.runId)
    }
  }
  const inbox: Array<GatewayProjection.ApprovalRow> = []
  for (const { run, rows } of perRun) {
    for (const row of rows as ReadonlyArray<GatewayProjection.ApprovalRow>) {
      const identity = waitIdentity(row)
      if (identity !== undefined) {
        if (owners.get(identity) !== run.runId) continue
        // Taken once: a question listed twice by its owner is still one row.
        owners.delete(identity)
      }
      inbox.push(row)
    }
  }
  return inbox
}

/** One run's rows that are still owed an answer: its share of the inbox. */
const pendingApprovals = (source: RunSource): ReadonlyArray<GatewayProjection.ApprovalRow> =>
  GatewayProjection.approvals(source.events, source.run).filter((row) => row.status === "pending")

/**
 * The rows a workspace selector projects across every run it read.
 *
 * Most of them are one run's rows, concatenated. Two are not. The approvals
 * inbox wants only what a human still owes an answer to, once per question
 * (see {@link approvalInbox}), where a run card wants that run's decided gates
 * too. And `flow-durations` is a cross-run fold: every run contributes the
 * executions it measured and the percentiles are ranked over all of them at
 * once, so a run contributes a sample rather than a row.
 */
const rowsOfWorkspace = (
  selector: GatewaySchema.ProjectionSelector,
  runs: ReadonlyArray<RunSource>,
  now: number
): ReadonlyArray<unknown> => {
  if (selector._tag === "flow-durations") {
    return GatewayProjection.flowDurations(
      selector.flowId,
      runs.flatMap((source) => rowsOfRun(selector, source, now)) as ReadonlyArray<GatewayProjection.NodeDuration>
    )
  }
  if (selector._tag !== "approvals") return runs.flatMap((source) => rowsOfRun(selector, source, now))
  return approvalInbox(runs.map((source) => ({ run: source.run, rows: pendingApprovals(source) })))
}

/** The rows a selector projects from the facts one read produced. */
const rowsOf = (
  selector: GatewaySchema.ProjectionSelector,
  source: Source,
  now: number
): ReadonlyArray<unknown> =>
  source._tag === "run" ? rowsOfRun(selector, source.run, now) : rowsOfWorkspace(selector, source.runs, now)

const boundedRows = (
  selector: GatewaySchema.ProjectionSelector,
  candidate: unknown
): Effect.Effect<ReadonlyArray<unknown>, GatewayError> =>
  Effect.suspend(() => {
    try {
      const schema = Schema.Array(GatewaySchema.rowSchemaFor(selector))
      const rows = Schema.decodeUnknownSync(schema)(candidate) as ReadonlyArray<unknown>
      const encoded = Schema.encodeUnknownSync(schema)(rows)
      const bytes = textEncoder.encode(JSON.stringify(encoded)).byteLength
      return bytes <= maxProjectionBytes
        ? Effect.succeed(rows)
        : Effect.fail(resourceLimit(`Projection rows exceed ${maxProjectionBytes} encoded bytes`))
    } catch (cause) {
      return Effect.fail(unavailable("Projection produced invalid rows", cause))
    }
  })

const frameOf = (candidate: unknown): Effect.Effect<GatewaySchema.GatewayFrame, GatewayError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(decodeFrame(candidate))
      /* v8 ignore next -- rows, selectors, cursors, and tags were admitted before this internal assembly step. */
    } catch (cause) {
      /* v8 ignore next -- the assembled frame consists only of already-admitted fields. */
      return Effect.fail(unavailable("Projection produced an invalid frame", cause))
    }
  })

const snapshotOf = (candidate: unknown): Effect.Effect<GatewaySchema.ProjectionSnapshot, GatewayError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(decodeSnapshot(candidate))
      /* v8 ignore next -- boundedRows and cursorOf admit every field before this internal assembly step. */
    } catch (cause) {
      /* v8 ignore next -- the assembled snapshot consists only of already-admitted fields. */
      return Effect.fail(unavailable("Projection produced an invalid snapshot", cause))
    }
  })

/**
 * The cursor the read reached.
 *
 * A run's cursor is the last sequence its journal committed, taken from the
 * same array the rows were folded from. A workspace cursor is `0`: control
 * journal sequences belong to per-run partitions (`@smthrs/control`
 * `ControlLive.streamForRun` and `snapshotHighWater` are keyed by `runId`), so
 * there is no workspace-wide sequence to advertise and no workspace resume.
 */
const cursorPositionOf = (source: Source): CursorPosition =>
  source._tag === "run" ? source.run.lastPosition : { value: 0, offset: 0 }

/** Implements a read path after its construction settings have been admitted. */
const makeService = (control: ControlService, heartbeatMillis: number, now: () => number): Service => {
  /** Every committed event of one run, oldest first. */
  const eventsOf = (
    run: ControlSchema.RunSummary,
    compactHealth: boolean
  ): Effect.Effect<EventBuffer, GatewayError> => {
    const runId = run.runId
    const message = `Reading the events of ${runId} failed`
    return Stream.runFoldEffect(
      control.watch({ runId, follow: false }).pipe(
        Stream.tapError((cause) => logReadFailure("read-events", cause)),
        Stream.mapError((cause) => unavailable(message, cause)),
        // The window bounds what is held; this bounds what is read.
        Stream.take(maxEventsScanned)
      ),
      () => emptyEventBuffer(compactHealth),
      (buffer, event) => appendEvent(buffer, event, `${message}: the control plane returned an invalid event`, run)
    )
  }

  /**
   * One bounded page of a run's journal, starting after `after`.
   *
   * This is the `run-events` read, and it is deliberately not the fold every
   * other selector uses. The other selectors answer rows computed from a
   * journal; `run-events` answers the journal, so its response grows with the
   * run unless the read itself is bounded. It reads from the control plane's
   * own cursor, keeps at most {@link maxEventsPerPage} events and
   * {@link maxProjectionBytes}, and reports the position it reached so the
   * caller asks for the next page from there.
   *
   * `afterSequence` replays the cursor's whole journal entry rather than
   * starting inside it, because an entry expands into several events and their
   * offsets are only countable from the entry's start. The replayed prefix is
   * dropped here.
   */
  const runEventsPage = (
    run: ControlSchema.RunSummary,
    after: CursorPosition | undefined
  ): Effect.Effect<
    { readonly events: ReadonlyArray<ControlSchema.ControlEvent>; readonly lastPosition: CursorPosition },
    GatewayError
  > => {
    const runId = run.runId
    const message = `Reading the events of ${runId} failed`
    interface Page {
      readonly events: Array<ControlSchema.ControlEvent>
      readonly bytes: number
      readonly seen: CursorPosition | undefined
      readonly last: CursorPosition | undefined
      readonly full: boolean
    }
    const empty: Page = { events: [], bytes: 2, seen: undefined, last: undefined, full: false }
    // Set when the page is full, so the next pull ends the stream instead of
    // decoding the rest of a long journal into a page that cannot grow.
    let stopped = false
    return Stream.runFoldEffect(
      control.watch({
        runId,
        ...(after === undefined || after.value === 0 ? {} : { afterSequence: after.value - 1 }),
        follow: false
      }).pipe(
        Stream.tapError((cause) => logReadFailure("read-events", cause)),
        Stream.mapError((cause) => unavailable(message, cause)),
        Stream.take(maxEventsScanned),
        Stream.takeWhile(() => !stopped)
      ),
      () => empty,
      (page, candidate): Effect.Effect<Page, GatewayError> =>
        page.full ? Effect.succeed(page) : Effect.flatMap(
          decodedEvent(candidate, `${message}: the control plane returned an invalid event`),
          (decoded) => {
            // A journal that moves backward is a broken control plane, not a
            // short page, and the fold refuses it exactly as the window does.
            if (page.seen !== undefined && decoded.sequence < page.seen.value) {
              return Effect.fail(unavailable(message, undefined))
            }
            const position: CursorPosition = {
              value: decoded.sequence,
              offset: page.seen?.value === decoded.sequence ? page.seen.offset + 1 : 0
            }
            const seen = position
            if (after !== undefined && comparePosition(position, after) <= 0) {
              return Effect.succeed({ ...page, seen })
            }
            // Native results are contracts, not display text. Clipping changes
            // their meaning and can hide validated actions such as Vibe.
            // Match live deltas, which already carry the original event.
            const event = decoded.kind === "control.engine.event" ? decoded : retainedEvent(decoded)
            if (encodedSize(event) + 2 > maxProjectionBytes) {
              return Effect.fail(resourceLimit(`One journal event exceeds ${maxProjectionBytes} encoded bytes`))
            }
            const bytes = page.bytes + encodedSize(event) + (page.events.length === 0 ? 0 : 1)
            if (page.events.length > 0 && bytes > maxProjectionBytes) {
              stopped = true
              return Effect.succeed({ ...page, seen, full: true })
            }
            page.events.push(event)
            stopped = page.events.length >= maxEventsPerPage
            return Effect.succeed({ events: page.events, bytes, seen, last: position, full: stopped })
          }
        )
    ).pipe(
      Effect.map((page) => ({
        events: page.events,
        lastPosition: page.last ?? after ?? { value: 0, offset: 0 }
      }))
    )
  }

  const runsMatching = (
    filters: {
      readonly runId?: string
      readonly flowId?: string
      readonly status?: ControlSchema.RunStatus
      readonly terminal?: boolean
    },
    newest?: number
  ): Effect.Effect<ReadonlyArray<ControlSchema.RunSummary>, GatewayError> => {
    const singleRun = filters.runId !== undefined
    // Only runOf omits the bound: it reads one identified run.
    const ceiling = newest ?? 1
    const page = (
      accumulated: ReadonlyArray<ControlSchema.RunSummary>,
      seen: Set<string>,
      cursor?: string | undefined
    ): Effect.Effect<ReadonlyArray<ControlSchema.RunSummary>, GatewayError> => {
      const remaining = ceiling - accumulated.length
      return control.list({
        _tag: "runs",
        filters,
        limit: remaining,
        ...(newest === undefined ? {} : { order: "newest" as const }),
        ...(cursor === undefined ? {} : { cursor })
      }).pipe(
        Effect.tapError((cause) => logReadFailure("list-runs", cause)),
        Effect.mapError((cause) => unavailable("Listing runs failed", cause)),
        Effect.flatMap((response) => {
          if (response._tag !== "runs") return Effect.succeed(accumulated)
          const ids = new Set(accumulated.map((run) => run.runId))
          const added = response.items.filter((run) => {
            if (ids.has(run.runId)) return false
            ids.add(run.runId)
            return true
          }).slice(0, remaining)
          const runs = [...accumulated, ...added]
          if (
            singleRun || added.length === 0 || response.nextCursor === undefined ||
            runs.length >= ceiling || seen.has(response.nextCursor)
          ) return Effect.succeed(runs)
          seen.add(response.nextCursor)
          // Each continued page adds at least one run, so the run ceiling
          // also caps the number of pages at maxWorkspaceRuns.
          return page(runs, seen, response.nextCursor)
        })
      )
    }
    return Effect.suspend(() => page([], new Set()))
  }

  /**
   * The one run a run-scoped selector names, or a typed refusal.
   *
   * Every run-scoped selector goes through here, so an unknown run id is
   * refused the same way for all of them. Reading a run's events alone cannot
   * tell an unknown run from a run with no events: `@smthrs/control`
   * `ControlLive.snapshotForRun` answers an empty stream for both.
   */
  const runOf = (runId: string): Effect.Effect<ControlSchema.RunSummary, GatewayError> =>
    runsMatching({ runId }).pipe(
      Effect.flatMap((runs) => {
        const run = runs.find((candidate) => candidate.runId === runId)
        return run === undefined
          ? Effect.fail(new GatewayError({ code: "run_not_found", message: `No run ${runId}` }))
          : Effect.succeed(run)
      })
    )

  /** Pin the journal between equal summaries; refuse a continuously moving row. */
  const consistentRunSource = (
    before: ControlSchema.RunSummary,
    attempts = 8,
    compactHealth = true
  ): Effect.Effect<RunSource, GatewayError> =>
    Effect.gen(function*() {
      const buffer = yield* eventsOf(before, compactHealth)
      const run = yield* runOf(before.runId)
      if (JSON.stringify(before) === JSON.stringify(run)) return { run, ...buffer }
      if (attempts === 1) return yield* Effect.fail(unavailable("Run changed throughout the snapshot read", undefined))
      return yield* consistentRunSource(run, attempts - 1, compactHealth)
    })

  /** One run and its journal at a reconciled cutoff. */
  const runSourceOf = (runId: string, compactHealth = true): Effect.Effect<RunSource, GatewayError> =>
    Effect.flatMap(runOf(runId), (run) => consistentRunSource(run, 8, compactHealth))

  /** Newest terminal runs, filtered and limited by the control query itself. */
  const durationRunsOf = (flowId: string): Effect.Effect<ReadonlyArray<ControlSchema.RunSummary>, GatewayError> =>
    runsMatching({ flowId, terminal: true }, maxDurationRuns)

  /** Every run a workspace selector folds, and each one's journal. */
  const workspaceSourceOf = (
    selector: GatewaySchema.ProjectionSelector
  ): Effect.Effect<ReadonlyArray<RunSource>, GatewayError> =>
    Effect.flatMap(
      // The inbox asks the control plane which runs are parked rather than
      // reading every run's journal to find out, and a duration fold asks it
      // for one flow's runs rather than for the workspace's.
      selector._tag === "flow-durations"
        ? durationRunsOf(selector.flowId)
        : runsMatching(
          selector._tag === "approvals" ?
            { status: "waiting-approval" }
            : selector._tag === "workspace-runs" && selector.flowId !== undefined
            ? { flowId: selector.flowId }
            : {},
          maxWorkspaceRuns
        ),
      (runs) =>
        Effect.map(
          Effect.forEach(runs, (run) => consistentRunSource(run), { concurrency: 8 }),
          (sources) => sources.filter((source) => eligibleForWorkspace(selector, source))
        )
    )

  /** The reconciled source a snapshot folds. */
  const sourceOf = (selector: GatewaySchema.ProjectionSelector): Effect.Effect<Source, GatewayError> => {
    const runId = scopeOf(selector)
    return runId === undefined
      ? Effect.map(workspaceSourceOf(selector), (runs) => ({ _tag: "workspace" as const, runs }))
      : Effect.map(runSourceOf(runId, selector._tag !== "run-events"), (run) => ({ _tag: "run" as const, run }))
  }

  const snapshot = (
    selector: GatewaySchema.ProjectionSelector,
    after?: GatewaySchema.ProjectionCursor | undefined
  ): Effect.Effect<GatewaySchema.ProjectionSnapshot, GatewayError> =>
    Effect.gen(function*() {
      if (after !== undefined) {
        if (selector._tag !== "run-events") {
          return yield* malformed("Only run-events snapshots accept an after cursor")
        }
        const scope = resumeScope(selector, after)
        if (typeof scope !== "string") return yield* scope
      }
      // `run-events` answers the journal itself, so it pages rather than folds:
      // one bounded read from the caller's cursor, and the position it reached
      // to ask for the next page from. Every other selector answers rows whose
      // size is bounded by the selector, so it folds the reconciled source.
      if (selector._tag === "run-events") {
        const run = yield* runOf(selector.runId)
        const page = yield* runEventsPage(run, after)
        const rows = yield* boundedRows(selector, page.events)
        return yield* snapshotOf({ selector, cursor: cursorOf(selector, page.lastPosition), rows })
      }
      const source = yield* sourceOf(selector)
      const rows = yield* boundedRows(selector, rowsOf(selector, source, now()))
      return yield* snapshotOf({ selector, cursor: cursorOf(selector, cursorPositionOf(source)), rows })
    })

  const snapshotFrames = (
    selector: GatewaySchema.ProjectionSelector,
    source: Source,
    rows: ReadonlyArray<unknown>
  ): Effect.Effect<ReadonlyArray<GatewaySchema.GatewayFrame>, GatewayError> => {
    const cursor = cursorOf(selector, cursorPositionOf(source))
    return Effect.forEach([
      { _tag: "snapshot-start", selector, cursor },
      ...rows.map((row) => ({ _tag: "row", selector, cursor, row })),
      { _tag: "snapshot-end", selector, cursor }
    ], frameOf)
  }

  /**
   * The rows one delta carries.
   *
   * `run-events`' rows are the ordered events themselves, so its delta is the
   * one event that arrived. `transcript` rows are immutable once folded, so
   * its delta is the rows that event appended, numbered after the turns the
   * follower has already counted. Every other selector answers a full
   * replacement folded from the accumulated events, because recomputation is
   * the only delta that cannot disagree with a fresh snapshot. The caller
   * refreshes authoritative rows before compaction so retention and rendering
   * use the same owner even when a fenced status write journals no event.
   */
  const deltaRows = (
    selector: GatewaySchema.ProjectionSelector,
    run: ControlSchema.RunSummary,
    event: ControlSchema.ControlEvent,
    events: ReadonlyArray<ControlSchema.ControlEvent>,
    turnsBefore: number,
    duplicateCall: boolean,
    carry: Diagnosis.Digest | undefined
  ): Effect.Effect<ReadonlyArray<unknown>, GatewayError> => {
    if (selector._tag === "run-events") return Effect.succeed([event])
    if (selector._tag === "transcript") {
      return Effect.succeed(duplicateCall ? [] : transcriptAppend(event, turnsBefore))
    }
    return Effect.succeed(rowsOfRun(selector, { run, events, carry }, now()))
  }

  interface RunFollowState {
    readonly buffer: EventBuffer
    readonly observed: CursorPosition | undefined
    /** Turns the transcript has opened so far; zero for every other selector. */
    readonly turns: number
    /** Derived once from the cursor prefix, then extended in constant time. */
    readonly reportedCalls: Map<string, boolean>
  }

  interface RunDelta {
    readonly run: ControlSchema.RunSummary
    readonly event: ControlSchema.ControlEvent
    readonly events: ReadonlyArray<ControlSchema.ControlEvent>
    readonly carry: Diagnosis.Digest | undefined
    readonly position: CursorPosition
    readonly turnsBefore: number
    readonly duplicateCall: boolean
    readonly replaceTranscript: boolean
  }

  /**
   * Deltas for one run, following from `from` and folding over the events the
   * caller already read plus each event that arrives.
   *
   * A historical run summary rebuilds its health prefix once from the follow
   * replay. Later deltas only append: re-reading history for every event would
   * make a subscription quadratic in run length and resend the whole log on
   * each frame.
   */
  const runDeltaFrames = (
    selector: GatewaySchema.ProjectionSelector,
    source: RunSource,
    from: CursorPosition
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> => {
    const runId = source.run.runId
    const message = `Following ${runId} failed`
    // The final compacted buffer cannot seed an earlier health cursor: a
    // later reading may have replaced the stronger observation held there.
    // Rebuild that prefix in the same bounded fold from the follow replay.
    const replayHealth = selector._tag === "run-summary" && comparePosition(from, source.lastPosition) < 0
    const seedEvents = positionedEvents(source.events)
      .filter(({ position }) => comparePosition(position, from) <= 0)
      .map(({ event }) => event)
    const seed = replayHealth ?
      Effect.succeed(emptyEventBuffer(true)) :
      comparePosition(from, source.lastPosition) === 0
      ? Effect.succeed<EventBuffer>({
        compactHealth: source.compactHealth,
        seen: source.seen,
        events: source.events,
        encodedBytes: source.encodedBytes,
        lastPosition: source.lastPosition,
        carry: source.carry,
        dropped: source.dropped
      })
      : bufferOf(seedEvents, `${message}: the cursor seed is invalid`, source.compactHealth, source.run)
    return Stream.unwrap(Effect.map(seed, (initial) =>
      control.watch({
        runId,
        // Sequence zero also needs replay for empty seeds and derived offsets.
        ...(from.value === 0 || replayHealth ? {} : { afterSequence: from.value - 1 }),
        follow: true
      }).pipe(
        Stream.tapError((cause) => logReadFailure("follow-run", cause)),
        Stream.mapError((cause) => unavailable(message, cause)),
        Stream.mapAccumEffect(
          (): RunFollowState => ({
            buffer: initial,
            observed: undefined,
            turns: selector._tag === "transcript" ? turnsOpened(initial.events) : 0,
            reportedCalls: (() => {
              const seen = new Map<string, boolean>()
              if (selector._tag === "transcript") {
                for (const event of initial.events) {
                  const key = callEventKey(event)
                  if (key !== undefined) {
                    seen.set(
                      key,
                      seen.get(key) === true || (nativeCallEvent(event) ?? nativeStepEvent(event)) !== undefined
                    )
                  }
                }
              }
              return seen
            })()
          }),
          (state, candidate): Effect.Effect<
            readonly [RunFollowState, ReadonlyArray<RunDelta>],
            GatewayError
          > =>
            Effect.flatMap(
              decodedEvent(candidate, `${message}: the control plane returned an invalid event`),
              (event) => {
                if (state.observed !== undefined && event.sequence < state.observed.value) {
                  return Effect.fail(unavailable(`${message}: event sequences moved backward`, undefined))
                }
                const position: CursorPosition = {
                  value: event.sequence,
                  offset: state.observed?.value === event.sequence ? state.observed.offset + 1 : 0
                }
                const nextState: RunFollowState = { ...state, observed: position }
                if (
                  (replayHealth || seedEvents.length > 0 || from.value > 0 || from.offset > 0) &&
                  comparePosition(position, from) <= 0
                ) {
                  return replayHealth
                    ? Effect.map(
                      appendEvent(state.buffer, event, `${message}: cursor history is invalid`, source.run),
                      (buffer) => [{ ...nextState, buffer }, [] as ReadonlyArray<RunDelta>] as const
                    )
                    : Effect.succeed([nextState, [] as ReadonlyArray<RunDelta>] as const)
                }
                const turnsBefore = state.turns
                // A resumed follower must also suppress duplicates of calls
                // reported before its cursor, without re-folding that prefix.
                const callKey = selector._tag === "transcript" ? callEventKey(event) : undefined
                const duplicateCall = callKey !== undefined && state.reportedCalls.has(callKey)
                const authoritative = (nativeCallEvent(event) ?? nativeStepEvent(event)) !== undefined
                const replaceTranscript = duplicateCall && authoritative && state.reportedCalls.get(callKey) === false
                if (callKey !== undefined) {
                  state.reportedCalls.set(callKey, authoritative || state.reportedCalls.get(callKey) === true)
                }
                const turns = selector._tag === "transcript"
                  ? transcriptAppend(event, turnsBefore).at(-1)?.turn ?? turnsBefore
                  : 0
                return Effect.flatMap(
                  selector._tag === "run-summary" || selector._tag === "run-tree" || selector._tag === "approvals"
                    ? runOf(runId)
                    : Effect.succeed(source.run),
                  (run) =>
                    Effect.map(
                      appendEvent(state.buffer, event, `${message}: event history is invalid`, run),
                      (buffer) =>
                        [
                          {
                            buffer,
                            observed: position,
                            turns,
                            reportedCalls: state.reportedCalls
                          } satisfies RunFollowState,
                          [
                            {
                              run,
                              event,
                              events: buffer.events,
                              carry: buffer.carry,
                              position,
                              turnsBefore,
                              duplicateCall,
                              replaceTranscript
                            }
                          ] satisfies ReadonlyArray<RunDelta>
                        ] as const
                    )
                )
              }
            )
        ),
        Stream.mapEffect(({ carry, duplicateCall, event, events, position, replaceTranscript, run, turnsBefore }) =>
          replaceTranscript
            ? Effect.flatMap(boundedRows(selector, GatewayProjection.transcript(events)), (rows) =>
              Effect.forEach([
                { _tag: "snapshot-start", selector, cursor: cursorOf(selector, position) },
                ...rows.map((row) => ({ _tag: "row", selector, cursor: cursorOf(selector, position), row })),
                { _tag: "snapshot-end", selector, cursor: cursorOf(selector, position) }
              ], frameOf))
            : Effect.flatMap(deltaRows(selector, run, event, events, turnsBefore, duplicateCall, carry), (rows) =>
              Effect.flatMap(boundedRows(selector, rows), (delta) =>
                Effect.map(
                  frameOf({
                    _tag: "delta",
                    selector,
                    cursor: cursorOf(selector, position),
                    delta
                  }),
                  (frame) => [frame]
                )))
        ),
        Stream.flattenIterable
      )))
  }

  /**
   * Workspace deltas from the unscoped control follow.
   *
   * Control sequences belong to run partitions, so this stream cannot start
   * after one workspace cursor. It follows without a cursor instead. That
   * replays partition history, and the sources seeded from the snapshot drop
   * events through each run's last folded position. Excluded runs retain only
   * a verdict and replay positions, sharing the source ceiling. Their replay
   * costs no further journal reads until the verdict is evicted.
   *
   * Events are gathered for `workspaceDeltaCoalesceMillis` and admitted as one
   * batch. A batch re-reads each changed run's row once, refolds only those
   * runs' cached rows, and answers one frame, so a burst across many runs
   * costs one frame and one row read per run that changed.
   */
  const workspaceDeltaFrames = (
    selector: GatewaySchema.ProjectionSelector,
    runs: ReadonlyArray<RunSource>
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> =>
    Stream.unwrap(Effect.sync(() => {
      interface FollowedSource {
        source: RunSource
        observed: CursorPosition | undefined
        /** This run's rows, folded when its journal grows rather than on every frame. */
        rows: ReadonlyArray<unknown>
      }
      interface JudgedRun {
        readonly lastPosition: CursorPosition | undefined
        observed: CursorPosition
      }
      const rowsOfSource = (source: RunSource): ReadonlyArray<unknown> =>
        selector._tag === "approvals" ? pendingApprovals(source) : rowsOfRun(selector, source, now())
      const sources = new Map<string, FollowedSource>(runs.map((source) => [
        source.run.runId,
        { source, observed: undefined, rows: rowsOfSource(source) }
      ]))
      // A verdict retains no journal. Undefined lastPosition means run_not_found.
      // Sources and verdicts share one ceiling; only verdicts may be evicted.
      const judged = new Map<string, JudgedRun>()
      const makeRoom = () => {
        if (sources.size + judged.size >= maxWorkspaceRuns) {
          // Callers have room for a source, so a full cache has a verdict.
          judged.delete(judged.keys().next().value!)
        }
      }
      const remember = (runId: string, lastPosition: CursorPosition | undefined, observed: CursorPosition) => {
        judged.delete(runId)
        makeRoom()
        judged.set(runId, { lastPosition, observed })
      }
      /** The followed run created first, the one a newer run displaces at the ceiling. */
      const oldestFollowed = (): FollowedSource | undefined => {
        let oldest: FollowedSource | undefined
        for (const followed of sources.values()) {
          if (oldest === undefined || createdAfter(oldest.source.run, followed.source.run)) oldest = followed
        }
        return oldest
      }
      const noFrames: ReadonlyArray<GatewaySchema.GatewayFrame> = []
      const delta = (): Effect.Effect<ReadonlyArray<GatewaySchema.GatewayFrame>, GatewayError> =>
        Effect.flatMap(
          boundedRows(
            selector,
            selector._tag === "approvals"
              // Each run's pending rows are cached apart; the inbox is folded
              // across all of them, exactly as a snapshot folds it.
              ? approvalInbox([...sources.values()].map(({ rows, source }) => ({ run: source.run, rows })))
              : [...sources.values()].flatMap(({ rows }) => rows)
          ),
          (rows) =>
            Effect.map(
              frameOf({
                _tag: "delta",
                selector,
                cursor: cursorOf(selector, { value: 0, offset: 0 }),
                delta: rows
              }),
              (frame) => [frame]
            )
        )
      const message = "Following the workspace failed"
      /**
       * What one admitted event did to the retained state: nothing a frame
       * must report, a change already folded, or a change to a followed run
       * whose row must be re-read before its rows are refolded.
       */
      type Admission = "unchanged" | "fresh" | "stale"
      const admit = (
        event: ControlSchema.ControlEvent,
        refreshed: Set<string>
      ): Effect.Effect<Admission, GatewayError> =>
        Effect.gen(function*() {
          const runId = event.runId
          if (runId === undefined) return "unchanged"
          const current = sources.get(runId)
          const verdict = judged.get(runId)
          const previous = current?.observed ?? verdict?.observed
          if (previous !== undefined && event.sequence < previous.value) {
            return yield* Effect.fail(unavailable(`${message}: event sequences moved backward`, undefined))
          }
          const position: CursorPosition = {
            value: event.sequence,
            offset: previous?.value === event.sequence ? previous.offset + 1 : 0
          }
          if (current !== undefined) {
            current.observed = position
            if (
              current.source.events.length > 0 && comparePosition(position, current.source.lastPosition) <= 0
            ) return "unchanged"
            if (!refreshed.has(runId)) {
              current.source = { ...current.source, run: yield* runOf(runId) }
              refreshed.add(runId)
            }
            const buffer = yield* appendEvent(
              current.source,
              event,
              `${message}: event history is invalid`,
              current.source.run
            )
            current.source = { run: current.source.run, ...buffer }
            return "stale"
          }
          if (verdict !== undefined) {
            verdict.observed = position
            if (verdict.lastPosition === undefined || comparePosition(position, verdict.lastPosition) <= 0) {
              return "unchanged"
            }
          }
          // At the ceiling a run newer than the oldest followed run displaces
          // it, so the workspace keeps the newest runs as the snapshot does.
          const displaced = sources.size >= maxWorkspaceRuns ? oldestFollowed() : undefined
          if (displaced !== undefined) {
            const newer = yield* runOf(runId).pipe(
              Effect.map((run) => createdAfter(run, displaced.source.run)),
              Effect.catchIf((failure) => failure.code === "run_not_found", () => Effect.succeed(false))
            )
            if (!newer) return "unchanged"
          }
          return yield* runSourceOf(runId).pipe(
            Effect.flatMap((source) => {
              const admitted = source.events.length > 0 && comparePosition(position, source.lastPosition) <= 0
                ? Effect.succeed(source)
                : Effect.map(
                  appendEvent(source, event, `${message}: event history is invalid`, source.run),
                  (buffer): RunSource => ({ run: source.run, ...buffer })
                )
              return Effect.map(admitted, (complete): Admission => {
                if (!eligibleForWorkspace(selector, complete)) {
                  remember(runId, complete.lastPosition, position)
                  return "unchanged"
                }
                judged.delete(runId)
                if (displaced !== undefined && sources.size >= maxWorkspaceRuns) {
                  sources.delete(displaced.source.run.runId)
                }
                makeRoom()
                sources.set(runId, { source: complete, observed: position, rows: rowsOfSource(complete) })
                return "fresh"
              })
            }),
            Effect.catchIf(
              (failure) => failure.code === "run_not_found",
              () => {
                remember(runId, undefined, position)
                return Effect.succeed<Admission>("unchanged")
              }
            )
          )
        })
      /** Refold one grown run using the row refreshed before its batch's compaction, or exclude it. */
      const refresh = (runId: string): Effect.Effect<void, GatewayError> =>
        Effect.gen(function*() {
          const current = sources.get(runId)
          /* v8 ignore next -- only runs still followed after the batch are refreshed. */
          if (current === undefined || current.observed === undefined) return
          const source = current.source
          if (eligibleForWorkspace(selector, source)) {
            current.rows = rowsOfSource(source)
          } else {
            sources.delete(runId)
            remember(runId, source.lastPosition, current.observed)
          }
        })
      return control.watch({ follow: true }).pipe(
        Stream.tapError((cause) => logReadFailure("follow-workspace", cause)),
        Stream.mapError((cause) => unavailable(message, cause)),
        Stream.groupedWithin(workspaceDeltaBatchSize, workspaceDeltaCoalesceMillis),
        Stream.mapEffect((batch) =>
          Effect.gen(function*() {
            const stale = new Set<string>()
            const refreshed = new Set<string>()
            let changed = false
            for (const candidate of batch) {
              const event = yield* decodedEvent(candidate, `${message}: the control plane returned an invalid event`)
              const admission = yield* admit(event, refreshed)
              if (admission === "unchanged") continue
              changed = true
              if (admission === "stale" && event.runId !== undefined) stale.add(event.runId)
            }
            yield* Effect.forEach(stale, refresh, { discard: true })
            return changed ? yield* delta() : noFrames
          })
        ),
        Stream.flattenIterable
      )
    }))

  /**
   * Deltas for a selector.
   *
   * A run selector follows after its sequence cursor. A workspace selector has
   * no resume cursor because control journal sequences belong to per-run
   * partitions, but it can follow every partition without one.
   */
  const deltaFrames = (
    selector: GatewaySchema.ProjectionSelector,
    source: Source,
    from: CursorPosition
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> => {
    // A duration row is ranked over the runs a flow has ALREADY finished, so
    // no event of a live run changes one, and the run that would change one
    // is not in the window until it settles. The honest delta is another
    // snapshot, which is what a client takes.
    if (selector._tag === "flow-durations") return Stream.empty
    return source._tag === "workspace"
      ? workspaceDeltaFrames(selector, source.runs)
      : runDeltaFrames(selector, source.run, from)
  }

  /**
   * The keepalive channel. `Stream.tick` emits immediately and then on the
   * interval, and an immediate keepalive would arrive before the snapshot it
   * is supposed to keep alive; dropping the first tick makes the cadence what
   * it says it is.
   */
  const heartbeats: Stream.Stream<GatewaySchema.GatewayFrame> = Stream.tick(heartbeatMillis).pipe(
    Stream.drop(1),
    Stream.mapEffect(() =>
      Effect.map(Effect.clockWith((clock) => clock.currentTimeMillis), (atMs) => ({
        _tag: "heartbeat" as const,
        atMs
      }))
    )
  )

  /** The run a cursor resumes, or the refusal explaining why it resumes none. */
  const resumeScope = (
    selector: GatewaySchema.ProjectionSelector,
    after: GatewaySchema.ProjectionCursor
  ): string | GatewayError => {
    const candidate = after as unknown as Record<string, unknown>
    if (!Number.isSafeInteger(candidate.value) || (candidate.value as number) < 0) {
      return malformed(
        `Cursor value ${String(candidate.value)} must be a non-negative safe integer`
      )
    }
    if (!Number.isSafeInteger(candidate.offset) || (candidate.offset as number) < 0) {
      return malformed(
        `Cursor offset ${String(candidate.offset)} must be a non-negative safe integer`
      )
    }
    if (!Schema.is(GatewaySchema.ProjectionCursor)(after)) {
      return malformed("The projection cursor is not a valid gateway cursor")
    }
    const runId = scopeOf(selector)
    if (after.projection !== selector._tag) {
      return malformed(
        `A cursor for the ${after.projection} projection cannot resume a ${selector._tag} subscription`
      )
    }
    if (!sameSelector(after.selector, selector)) {
      return malformed("A cursor can resume only the exact selector that issued it")
    }
    if (runId === undefined) {
      return malformed(
        `A ${selector._tag} subscription has no resumable cursor, because control journal sequences belong to per-run partitions`
      )
    }
    if (after.runId !== runId) {
      return malformed(`A cursor for run ${after.runId ?? "none"} cannot resume a subscription to run ${runId}`)
    }
    return runId
  }

  /** Snapshot and follow share the reconciled event buffer. */
  const fromSnapshot = (
    selector: GatewaySchema.ProjectionSelector
  ): Effect.Effect<Stream.Stream<GatewaySchema.GatewayFrame, GatewayError>, GatewayError> =>
    Effect.flatMap(
      sourceOf(selector),
      (source) =>
        Effect.flatMap(boundedRows(selector, rowsOf(selector, source, now())), (rows) =>
          Effect.map(snapshotFrames(selector, source, rows), (frames) =>
            Stream.concat(
              Stream.fromIterable(frames),
              deltaFrames(selector, source, cursorPositionOf(source))
            )))
    )

  /**
   * The deltas after a cursor the client already holds, with no snapshot.
   *
   * The read still happens: a folded projection cannot be recomputed from the
   * events after the cursor alone. What the client skips is receiving rows it
   * already has.
   */
  const fromCursor = (
    selector: GatewaySchema.ProjectionSelector,
    after: GatewaySchema.ProjectionCursor
  ): Effect.Effect<Stream.Stream<GatewaySchema.GatewayFrame, GatewayError>, GatewayError> => {
    const scope = resumeScope(selector, after)
    return typeof scope === "string"
      ? Effect.flatMap(runSourceOf(scope, selector._tag !== "run-events"), (source) => {
        const position = { value: after.value, offset: after.offset }
        const last = source.lastPosition
        if (comparePosition(position, last) > 0) {
          return Effect.fail(malformed(
            `Cursor ${after.value}:${after.offset} cannot resume run ${scope} past its last position ${last.value}:${last.offset}`
          ))
        }
        const retained = position.value === 0 && position.offset === 0 ||
          positionedEvents(source.events).some((candidate) => comparePosition(candidate.position, position) === 0)
        // A valid issued health cursor may have been superseded in the bounded fold.
        // Verify it against the durable stream rather than accepting arbitrary positions.
        const issued = retained ? Effect.succeed(true) : source.compactHealth ?
          control.watch({
            runId: scope,
            follow: false,
            ...(position.value === 0 ? {} : { afterSequence: position.value - 1 })
          }).pipe(
            Stream.takeWhile((event) => event.sequence <= position.value),
            Stream.take(maxEventsPerRun + 1),
            Stream.runCollect,
            Effect.map((events) =>
              events.length <= maxEventsPerRun && events[position.offset]?.sequence === position.value
            ),
            Effect.mapError((cause) => unavailable("Checking the projection cursor failed", cause))
          ) :
          Effect.succeed(false)
        return Effect.flatMap(issued, (valid) =>
          valid
            ? Effect.succeed(runDeltaFrames(selector, source, position))
            : Effect.fail(malformed(`Cursor ${after.value}:${after.offset} was not issued by run ${scope}`)))
      })
      : Effect.fail(scope)
  }

  const subscribe = (
    selector: GatewaySchema.ProjectionSelector,
    after?: GatewaySchema.ProjectionCursor | undefined
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> =>
    Stream.merge(
      Stream.unwrap(after === undefined ? fromSnapshot(selector) : fromCursor(selector, after)),
      heartbeats,
      { haltStrategy: "left" }
    )

  /*
   * The service is generic in its selector; the implementation folds every
   * selector through one code path and is not. The correlation the signature
   * promises is enforced at runtime rather than assumed: `boundedRows`
   * decodes each fold against `GatewaySchema.rowSchemaFor(selector)` and
   * fails the read when a row does not belong to the selector that asked.
   */
  return { snapshot, subscribe } as Service
}

/**
 * Builds the read path over a control plane.
 *
 * Invalid keepalive settings are returned as typed `bind_failed` failures;
 * construction never throws synchronously.
 *
 * @param control the control service to read through
 * @param options the keepalive cadence to use
 * @since 1.0.0
 * @category constructors
 */
export const make = (
  control: ControlService,
  options: { readonly heartbeatMillis?: number | undefined } = {}
): Effect.Effect<Service, GatewayError> =>
  Effect.suspend(() => {
    const refusal = settingRefusal("The gateway keepalive cadence", options.heartbeatMillis)
    return refusal === undefined
      ? Effect.clockWith((clock) =>
        Effect.succeed(
          makeService(
            control,
            options.heartbeatMillis ?? heartbeatIntervalMillis,
            () => clock.currentTimeMillisUnsafe()
          )
        )
      )
      : Effect.fail(refusal)
  })

/**
 * Provides the gateway read path over the ambient control plane.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer: Layer.Layer<Projections, GatewayError, Control> = Layer.effect(Projections)(
  Effect.flatMap(Control, (control) => make(control))
)

/**
 * Provides the gateway read path under an explicit keepalive cadence.
 *
 * @param options the keepalive cadence to use
 * @since 1.0.0
 * @category layers
 */
export const layerWith = (
  options: { readonly heartbeatMillis?: number | undefined }
): Layer.Layer<Projections, GatewayError, Control> =>
  Layer.effect(Projections)(Effect.flatMap(Control, (control) => make(control, options)))
