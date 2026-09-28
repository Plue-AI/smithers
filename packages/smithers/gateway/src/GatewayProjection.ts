/**
 * The stable wire rows the gateway serves for each projection, and the pure
 * folds that compute them from control-plane facts.
 *
 * These rows are the whole read contract. Nothing here exposes a store row, a
 * database column, or an engine type: every field is either a
 * `@smthrs/control` projection value or something folded out of the ordered
 * `ControlEvent` deltas `Control.watch` publishes. Wire names are the flows
 * names (`flowId`, `createdAt`, and the `ApprovalTarget.Node` envelope), so a
 * client written against the control plane reads these rows without a
 * translation table.
 *
 * @since 1.0.0
 */

import { ControlFacts, ControlSchema, Health, Monitor } from "@smthrs/control"
import { ExecutionFact } from "@smthrs/journal"
import { Schema } from "effect"
import * as Diagnosis from "./Diagnosis.ts"
import { callScope, openCallIndex, uniqueCallEvents } from "./internal/callEvents.ts"
import * as NativeResolution from "./internal/nativeResolution.ts"
import * as NodeEvents from "./internal/nodeEvents.ts"

/**
 * One run, everything a run card displays, and the diagnosis of what happened
 * to it.
 *
 * `flowId` carries what the old wire split across `run.workflowKey` and
 * `run.workflow`, and `createdAt` carries `run.createdAtMs`: one flows name
 * each, rather than two spellings of one fact.
 *
 * @since 1.0.0
 * @category models
 */
export const RunSummaryRow = Schema.Struct({
  runId: Schema.String,
  flowId: Schema.String,
  statusRollup: Schema.optional(Health.StatusRollup),
  status: ControlSchema.RunStatus,
  lifecycleProvenance: Schema.optional(ControlFacts.LifecycleProvenance),
  executionProvenance: Schema.optional(ExecutionFact.Provenance),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  planId: Schema.optional(Schema.String),
  planDigest: Schema.optional(Schema.String),
  parentRunId: Schema.optional(Schema.String),
  lineageId: Schema.optional(Schema.String),
  roundOrdinal: Schema.optional(Schema.Number),
  waitingReason: Schema.optional(Schema.String),
  steeringPending: Schema.optional(Schema.Number),
  cancellation: Schema.optional(ControlSchema.Cancellation),
  /** The model seat the run's last opened turn ran on. */
  seat: Schema.optional(Schema.String),
  turns: Schema.Number,
  calls: Schema.Number,
  callsFailed: Schema.Number,
  editsAttempted: Schema.Number,
  editsSucceeded: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  /**
   * One line: the run row's status plus the reason that most explains it.
   *
   * Lifecycle provenance distinguishes a covered control fact from a legacy
   * snapshot or a separate engine observation. Missing facts never silently
   * replace a newer observed state with the last recorded status.
   */
  verdict: Schema.String,
  /** The whole diagnosis card, which the old wire called `whatHappened`. */
  diagnosis: Schema.String,
  finalOutput: Schema.optional(Schema.String)
})

/**
 * One run, everything a run card displays, and its diagnosis.
 *
 * @since 1.0.0
 * @category models
 */
export type RunSummaryRow = typeof RunSummaryRow.Type

/**
 * One node of a run, as a tree view renders it.
 *
 * `label` carries what the old wire called `node.cardLabel`, and `seat`
 * carries `node.agent`: the model seat is the flows name for who ran a node.
 *
 * `nodeId` is the ordinal the call opened on, because the emitter names no
 * node. {@link runTree} says why.
 *
 * @since 1.0.0
 * @category models
 */
export const RunTreeRow = Schema.Struct({
  runId: Schema.String,
  nodeId: Schema.String,
  label: Schema.String,
  status: Schema.Literals(["running", "completed", "failed"]),
  seat: Schema.optional(Schema.String),
  startedAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
  parentRunId: Schema.optional(Schema.String)
})

/**
 * One node of a run, as a tree view renders it.
 *
 * @since 1.0.0
 * @category models
 */
export type RunTreeRow = typeof RunTreeRow.Type

/**
 * One approval a run is parked on, carrying the exact payload that decides it.
 *
 * `title` carries the old `approval.requestTitle` and `request` the old
 * `approval.request`; `payload` is the `ApprovalTarget.Node` envelope a client
 * submits back unchanged, so no client reconstructs authority.
 *
 * @since 1.0.0
 * @category models
 */
export const ApprovalRow = Schema.Struct({
  runId: Schema.String,
  /**
   * The execution holding the wait, when this gate is a question a person owes
   * an answer to and it is held below `runId`.
   *
   * `runId` is the run a person opened and the run a decision is addressed to;
   * a `HumanTask` in a nested flow parks its own execution, and the two are
   * different runs. Present only on such a gate, so a reader can tell a
   * question rolled up from a tree from one the named run raised itself, and
   * an inbox can list one question once however many ancestors carry it.
   */
  waitRunId: Schema.optional(Schema.String),
  questionProvenance: Schema.optional(Schema.Literals(["events", "legacy-observation", "unverified-observation"])),
  requestId: Schema.String,
  title: Schema.String,
  request: Schema.Json,
  payload: ControlSchema.ApprovalPayload,
  requestedAt: Schema.Number,
  status: Schema.Literals(["pending", "approved", "denied"])
})

/**
 * One approval a run is parked on.
 *
 * @since 1.0.0
 * @category models
 */
export type ApprovalRow = typeof ApprovalRow.Type

/**
 * The output one node produced.
 *
 * @since 1.0.0
 * @category models
 */
export const NodeOutputRow = Schema.Struct({
  runId: Schema.String,
  nodeId: Schema.String,
  outcome: Schema.Literals(["success", "failure"]),
  output: Schema.String,
  settledAt: Schema.Number
})

/**
 * The output one node produced.
 *
 * @since 1.0.0
 * @category models
 */
export type NodeOutputRow = typeof NodeOutputRow.Type

/**
 * How long one flow's nodes take, per action tag.
 *
 * `samples` is the number of measured executions behind the two percentiles,
 * and it is on the wire because a percentile over one sample and a percentile
 * over twenty are different claims. A tag with no measured execution has no
 * row at all: there is no shape here for an unmeasured prediction.
 *
 * @since 1.0.0
 * @category models
 */
export const FlowDurationRow = Schema.Struct({
  flowId: Schema.String,
  actionTag: Schema.String,
  samples: Schema.Number,
  p50Ms: Schema.Number,
  p90Ms: Schema.Number
})

/**
 * How long one flow's nodes take, per action tag.
 *
 * @since 1.0.0
 * @category models
 */
export type FlowDurationRow = typeof FlowDurationRow.Type

/**
 * One measured execution of one node, as a duration fold's sample.
 *
 * The action tag is the only part of a node's key material that survives a
 * re-key, which is why history is grouped by it rather than by node id or by
 * dispatch key.
 *
 * @since 1.0.0
 * @category models
 */
export interface NodeDuration {
  readonly actionTag: string
  readonly durationMs: number
}

/**
 * One line of a run's turn-by-turn transcript.
 *
 * @since 1.0.0
 * @category models
 */
export const TranscriptRow = Schema.Struct({
  runId: Schema.String,
  sequence: Schema.Number,
  turn: Schema.Number,
  at: Schema.Number,
  kind: Schema.String,
  /** Dispatch identity on current call records; absent on legacy history. */
  callId: Schema.optional(Schema.String),
  text: Schema.String
})

/**
 * One line of a run's turn-by-turn transcript.
 *
 * @since 1.0.0
 * @category models
 */
export type TranscriptRow = typeof TranscriptRow.Type

/** Copies only the optional fields a run summary actually carries. */
const optional = <A>(key: string, value: A | undefined): Record<string, A> =>
  value === undefined ? {} : { [key]: value }

/**
 * Folds one run's summary and events into the served `run-summary` row.
 *
 * @param run the control-plane run summary
 * @param events that run's ordered control events
 * @param now the instant the row is rendered at
 * @param carry the digest of the events a bounded reader dropped before them
 * @since 1.0.0
 * @category projections
 */
export const runSummary = (
  run: ControlSchema.RunSummary,
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  now: number = Math.max(run.updatedAt, events.at(-1)?.occurredAt ?? 0),
  carry?: Diagnosis.Digest | undefined
): RunSummaryRow => {
  const projected = ControlFacts.fold(events, run)
  // Supplying a snapshot guarantees a run: uncovered facts retain that
  // observation; only the event-only fold can return an absent run.
  run = projected.run!
  const native = ExecutionFact.foldControl(events, run.runId, run.executionView)
  // The control fold remains control authority. Native lifecycle is independently
  // replayed/verified against the coherent executor observation when available.
  if (run.executionObservation === "observed" && native?.view !== undefined) {
    const { root, current } = native.view
    run = {
      ...run,
      status: current.status === "pending" ? "accepted" : current.status === "suspended"
        ? current.waiting?.reason === "approval" ||
            (native.view.humanWaits?.length ?? run.pendingWaits?.length ?? 0) > 0
          ? "waiting-approval" :
          "parked"
        : current.status === "running" && (native.view.humanWaits?.length ?? run.pendingWaits?.length ?? 0) > 0
        ? "waiting-approval" :
        current.status,
      waitingReason: current.status === "suspended" ? current.waiting?.reason : undefined,
      parentRunId: root.parentRunId ?? undefined,
      lineageId: root.lineageId,
      roundOrdinal: root.roundOrdinal
    }
  }
  // `carry` is the digest of the events a bounded reader dropped ahead of
  // `events`. Combining it keeps turns, calls, edits and tokens exact for a run
  // whose journal no longer fits one window, so the counters a run card shows
  // describe the whole run and not just its tail.
  const window = Diagnosis.digest(events, run.runId)
  const facts = { ...(carry === undefined ? window : Diagnosis.combine(carry, window)), status: run.status }
  return {
    runId: run.runId,
    flowId: run.flowId,
    status: run.status,
    lifecycleProvenance: projected.provenance,
    ...optional("executionProvenance", native?.provenance),
    statusRollup: statusRollup(run, events, now),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...optional("planId", run.planId),
    ...optional("planDigest", run.planDigest),
    ...optional("parentRunId", run.parentRunId),
    ...optional("lineageId", run.lineageId),
    ...optional("roundOrdinal", run.roundOrdinal),
    ...optional("waitingReason", run.waitingReason),
    ...optional("steeringPending", run.steering?.pending),
    ...optional("cancellation", run.cancellation),
    ...optional("seat", facts.seat),
    turns: facts.turns,
    calls: facts.calls,
    callsFailed: facts.callsFailed,
    editsAttempted: facts.editsAttempted,
    editsSucceeded: facts.editsSucceeded,
    inputTokens: facts.inputTokens,
    outputTokens: facts.outputTokens,
    verdict: Diagnosis.verdict(facts),
    diagnosis: Diagnosis.render({ runId: run.runId, ...optional("flowId", run.flowId) }, facts),
    ...optional("finalOutput", Diagnosis.resolvedOutput(facts))
  }
}

/**
 * Claims a call by its durable dispatch identity. Legacy history has no id:
 * match only legacy starts by flow name (or FIFO when unnamed). A new
 * settlement can close a legacy start after an old parked run resumes, but
 * neither fallback may steal an identified call.
 */
const takeOpenCall = <
  A extends { readonly flowName: string; readonly callId: string | undefined; readonly scope: string | undefined }
>(
  open: Array<A>,
  callId: string | undefined,
  flowName: string | undefined,
  scope: string | undefined
): A | undefined => {
  const found = openCallIndex(open, callId, flowName, scope)
  return found < 0 ? undefined : open.splice(found, 1)[0]
}

/**
 * One agent call, as every node projection sees it: the ordinal it opened on,
 * the seat that ran it, and the settlement that closed it, if one did.
 */
interface CallRecord {
  readonly nodeId: string
  readonly flowName: string
  readonly seat: string | undefined
  readonly startedAt: number
  readonly settlement: CallSettlement | undefined
}

/** What closed a call, and where among the run's settlements it closed. */
interface CallSettlement {
  /** The rank of this settlement among the run's, counting from one. */
  readonly order: number
  /** The run the settlement named, which a malformed journal can omit. */
  readonly runId: string | undefined
  readonly at: number
  readonly outcome: "success" | "failure"
  readonly output: string
}

/**
 * Folds one run's events into the agent calls it made, in the order they
 * opened.
 *
 * This is the only fold that assigns a call its `call-N` identity, records the
 * seat and time it opened on, and pairs a settlement with the call it closed.
 * A client asks for a node's output by the id a tree row carries, so the two
 * projections have to agree on that id; when they counted separately they
 * could disagree, and once did, because skipping an event before the ordinal
 * advanced shifted one fold's keys against the other's. The ordinal therefore
 * advances on every distinct start, whatever else that event is missing.
 * Identified duplicate starts and settlements are ignored. Old idless rows
 * retain their original ordinal/FIFO interpretation; their missing dispatch
 * identity cannot be reconstructed when same-name calls overlapped.
 *
 * `uniqueCallEvents` also normalizes native step facts, so this fold reads the
 * run's own records and one stream per step a module run dispatched. The three
 * classes `Diagnosis` names apply here too, field by field:
 *
 * | Field                   | Class           | Why                                                    |
 * | ----------------------- | --------------- | ------------------------------------------------------ |
 * | `nodeId` (`call-N`)     | aggregate       | one tree lists every call the run made, steps included |
 * | `flowName`, `startedAt` | aggregate       | read off the call's own record                         |
 * | `settlement`            | aggregate       | claimed by call identity within the recorded scope     |
 * | `seat`                  | scope dependent | who ran THIS call, so the turn must be this call's own |
 *
 * There is no root-only field here: a tree row describes a call, never the
 * run's answer or state. A new field has to name its class.
 */
const callHistory = (
  events: ReadonlyArray<ControlSchema.ControlEvent>
): ReadonlyArray<CallRecord> => {
  const calls = new Map<string, CallRecord>()
  const open: Array<
    {
      readonly callId: string | undefined
      readonly flowName: string
      readonly call: CallRecord
      readonly scope: string | undefined
    }
  > = []
  // The seat of the last turn opened in each scope. A module run interleaves
  // steps in one journal, so the run-wide reading attributed one step's seat
  // to another step's calls. A prompt run records one unscoped stream and
  // reads exactly as it did.
  const seats = new Map<string | undefined, string | undefined>()
  let ordinal = 0
  let settlements = 0

  for (const event of uniqueCallEvents(events)) {
    const payload = Diagnosis.asRecord(event.payload)
    if (event.kind === "control.agent.turn-opened") {
      const scope = callScope(event)
      seats.set(scope, Diagnosis.asString(payload.seat) ?? seats.get(scope))
      continue
    }
    if (event.kind === "control.agent.cell-call-started") {
      const callId = Diagnosis.asString(payload.callId)
      ordinal += 1
      const nodeId = `call-${ordinal}`
      const flowName = Diagnosis.asString(payload.flowName) ?? nodeId
      const scope = callScope(event)
      // This scope's own turn, else the run's. A step that opened no turn of
      // its own borrows nothing from a sibling step.
      const seat = seats.get(scope) ?? seats.get(undefined)
      const call: CallRecord = { nodeId, flowName, seat, startedAt: Diagnosis.timeOf(event), settlement: undefined }
      open.push({ callId, flowName, call, scope })
      calls.set(nodeId, call)
      continue
    }
    if (event.kind !== "control.agent.cell-call-settled") continue
    const callId = Diagnosis.asString(payload.callId)
    const claimed = takeOpenCall(open, callId, Diagnosis.asString(payload.flowName), callScope(event))
    if (claimed === undefined) continue
    const failed = Diagnosis.asString(payload.outcome) === "failure"
    settlements += 1
    // Rewriting the entry keeps the call in the position it opened on, which
    // is the order a tree renders.
    calls.set(claimed.call.nodeId, {
      ...claimed.call,
      settlement: {
        order: settlements,
        runId: Diagnosis.asString(payload.runId) ?? event.runId,
        at: Diagnosis.timeOf(event),
        outcome: failed ? "failure" : "success",
        output: failed
          ? Diagnosis.asString(payload.message) ?? ""
          : Diagnosis.asString(payload.value) ?? JSON.stringify(payload.value ?? null)
      }
    })
  }
  return [...calls.values()]
}

/** How a tree row reports a call: settled the way it settled, or still running. */
const treeStatus = (settlement: CallSettlement | undefined): RunTreeRow["status"] => {
  if (settlement === undefined) return "running"
  return settlement.outcome === "failure" ? "failed" : "completed"
}

/**
 * Folds one run's events into its node rows.
 *
 * A node opens on `control.agent.cell-call-started` and settles on the
 * matching `control.agent.cell-call-settled`.
 *
 * AgentSession journals the same `callId` from the harness's dispatch identity
 * on both records. Settlements join on it even when same-name calls overlap
 * and finish out of order. The distinct-start ordinal remains the published
 * `call-N` node key, preserving existing node links. Legacy records without
 * callId retain same-name FIFO pairing, restricted to other legacy records
 * (including a newly identified settlement of an old parked call).
 *
 * The durable engine's own `flows.engine.*` records are not folded here, but
 * that is a choice rather than a limit. A host keeps the control plane and the
 * engine in two databases with two journals (`@smthrs/cli`
 * `NodeControl.databasePath` and `executionDatabasePath`), and
 * `EngineJournalProjection` copies every engine entry of the run into the
 * control journal as a `control.engine.event` envelope, which is how
 * {@link nodeDurations} reads the node records. A tree row is an agent cell
 * call, so what an engine step did reaches this projection as the call that
 * made it.
 *
 * A node that never settled stays `running`, which is how a live tree renders
 * work in flight.
 *
 * @param run the control-plane run summary
 * @param events that run's ordered control events
 * @since 1.0.0
 * @category projections
 */
export const runTree = (
  run: ControlSchema.RunSummary,
  events: ReadonlyArray<ControlSchema.ControlEvent>
): ReadonlyArray<RunTreeRow> =>
  callHistory(events).map((call): RunTreeRow => ({
    runId: run.runId,
    nodeId: call.nodeId,
    label: call.flowName,
    status: treeStatus(call.settlement),
    ...optional("seat", call.seat),
    startedAt: call.startedAt,
    ...optional("endedAt", call.settlement?.at),
    ...optional("parentRunId", run.parentRunId)
  }))

/**
 * The declared question of a human wait, as far as it can be read.
 *
 * `request` is whatever the wait wrote about itself, which for `HumanTask` is
 * `{task, name, kind, prompt, attempt, maxAttempts}`. A wait that declared
 * nothing — an older park, or a plugin's own — still produces a row, because a
 * gate a person cannot see is a run that waits forever; it just has less to
 * render.
 */
const questionOf = (wait: ControlSchema.PendingWait): Record<string, unknown> => Diagnosis.asRecord(wait.request)

/**
 * One pending row for a human wait held anywhere in a run's tree.
 *
 * `runId` is the ROOT: this is the run a person opened, and the run a decision
 * is addressed to. `waitRunId` is the execution actually holding it, because a
 * client routes by run and the control plane routes within the tree.
 *
 * `requestId` is the wait point's own name (`coding-clarification#1`), which is
 * unique within a tree, stable across a re-read, and the name a `Signal`
 * addresses. The token travels in the request too, for a client that would
 * rather submit the exact durable address back.
 */
const humanWaitRow = (
  run: ControlSchema.RunSummary,
  wait: ControlSchema.PendingWait,
  projected?: ExecutionFact.Observation,
  questionProvenance: "events" | "legacy-observation" | "unverified-observation" = "legacy-observation"
): ApprovalRow => {
  const question = projected === undefined ? questionOf(wait) : Diagnosis.asRecord(projected.waiting?.request)
  const name = wait.name ?? Diagnosis.asString(question["name"]) ?? wait.token
  const requestId = wait.attempt === undefined ? name : `${name}#${wait.attempt}`
  const prompt = Diagnosis.asString(question["prompt"])
  const waitFlowId = projected?.flowName ?? wait.flowId
  return {
    runId: run.runId,
    waitRunId: wait.runId,
    questionProvenance,
    requestId,
    title: prompt ?? `Answer needed — ${name}`,
    request: {
      ...question,
      kind: Diagnosis.asString(question["kind"]) ?? "ask",
      name,
      ...(wait.attempt === undefined ? {} : { attempt: wait.attempt }),
      ...(waitFlowId === undefined ? {} : { waitFlowId }),
      token: wait.token
    },
    payload: {
      target: {
        _tag: "Node",
        runId: run.runId,
        requestId,
        digest: wait.token,
        // A human answer grants no capabilities: the envelope a decision binds
        // to is the empty one, the same shape a flow with none carries.
        envelope: { capabilities: [], flows: [], budget: {} }
      },
      scope: "once",
      // The identity is the PARK, not its name: a loop that re-asks one
      // question parks again under the same run, name and attempt, and a
      // name-keyed answer would deduplicate the second decision into the
      // first — accepted, never delivered, and parked forever.
      idempotencyKey: `answer:${run.runId}:${requestId}:${wait.tokenDigest ?? wait.token}`
    },
    requestedAt: projected?.createdAtMs ?? wait.createdAt,
    status: "pending"
  }
}

/**
 * Folds one run's events into its approval rows.
 *
 * A request opens a pending row carrying the submit-ready payload; the
 * matching `control.approval.approved` or `control.approval.denied` closes it
 * without discarding the request, so a decided gate stays readable.
 *
 * A `HumanTask` declares its question on the parked row. Native execution
 * facts carry the redacted question and token digest; verified facts supply
 * its display metadata here. `@smthrs/control` rolls current open waits onto
 * the root as `pendingWaits`, which supply each row's protected wake address.
 * History alone cannot create an answerable human wait. Older observations
 * remain visible with explicit question provenance when native fact coverage
 * is unavailable. These rows come first because they still need an answer.
 *
 * A decision names the gate it closed by `tokenId`. `@smthrs/control`
 * `SqlControlRuntime.lookupApproval` mints that token id from the target, and
 * for the `Node` target a run parks on it is the request id itself, so the two
 * records join on one field. A decision whose `tokenId` or `requestId` names
 * no row is retained for an exact later request. Only a legacy decision that
 * names neither field closes the oldest pending legacy row in that run.
 * Current facts bind the target digest; duplicates cannot reopen a decision.
 *
 * @param events the run's ordered control events
 * @since 1.0.0
 * @category projections
 */
export const approvals = (
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  run?: ControlSchema.RunSummary | undefined
): ReadonlyArray<ApprovalRow> => {
  const native = run === undefined ? undefined : ExecutionFact.foldControl(events, run.runId, run.executionView)
  const observed = run?.pendingWaits?.map((wait) => {
    const projected = native?.provenance.humanWaits === "events" ?
      native.view?.humanWaits?.find((candidate) =>
        candidate.executionId === wait.runId && candidate.waiting?.tokenDigest === wait.tokenDigest
      ) :
      undefined
    return humanWaitRow(
      run,
      wait,
      projected,
      projected === undefined
        ? native?.provenance.humanWaits === "events" ?
          "unverified-observation" :
          native?.provenance.humanWaits ?? "legacy-observation"
        : "events"
    )
  })
  // The current observation supplies wake authority. History supplies only the
  // display metadata that verifies against that exact observed token digest.
  return ControlFacts.fold(events, undefined, observed).approvals
}

/**
 * Folds one run's events into its node outputs, keyed the way {@link runTree}
 * keys its rows: by the ordinal the call opened on.
 *
 * A settled call carries the value it produced, so the row carries that value.
 * A run's own result reaches a client as `RunSummaryRow.finalOutput` instead.
 *
 * @param events the run's ordered control events
 * @since 1.0.0
 * @category projections
 */
export const nodeOutput = (
  events: ReadonlyArray<ControlSchema.ControlEvent>
): ReadonlyArray<NodeOutputRow> => {
  const settled: Array<{ readonly order: number; readonly row: NodeOutputRow }> = []
  for (const call of callHistory(events)) {
    const settlement = call.settlement
    if (settlement === undefined) continue
    // A row names the run it belongs to. A settlement that names none closes
    // its call without producing one.
    if (settlement.runId === undefined) continue
    settled.push({
      order: settlement.order,
      row: {
        runId: settlement.runId,
        nodeId: call.nodeId,
        outcome: settlement.outcome,
        output: settlement.output,
        settledAt: settlement.at
      }
    })
  }
  // A tree reads in the order calls opened; outputs read in the order they
  // settled, which is the order a client watched them arrive.
  return settled.sort((left, right) => left.order - right.order).map((entry) => entry.row)
}

/** The node id every execution gives the flow it was started to run. */
const rootNodeId = "root"

/**
 * The native execution the host bound this control run to, when one is known.
 *
 * Only the host's own binding record names the root, and two records that
 * disagree name nothing: an ambiguous binding cannot tell a callee's
 * execution apart from the root's, so it authorizes no skip.
 *
 * The binding is written once, when the host takes the root up, so a window
 * bounded to a run's newest events is the one window it falls out of. The
 * carried digest keeps it across that eviction, and reading from the carry is
 * what keeps a long run's calls counted the same as a short run's.
 */
const boundExecution = (
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  carry: Diagnosis.Digest | undefined
): string | undefined => {
  let resolution = carry?.nativeResolution
  for (const event of events) resolution = NativeResolution.combine(resolution, NativeResolution.fromEvent(event))
  return resolution === undefined || resolution.conflict === true ? undefined : resolution.binding?.executionId
}

/**
 * A callee's own view of a call its caller already measured.
 *
 * Every execution below the bound root was started by a `FlowCall` node in
 * the execution above it, and that node carries the same action tag over the
 * same span. The caller's node is the one kept, because it is the node a plan
 * carries and the one a graph can join a prediction onto.
 *
 * With no binding nothing is echoed: a fold that cannot name the root cannot
 * tell which `root` record belongs to it, and dropping samples on a guess
 * would answer a smaller history than the flow ran.
 */
const echoedRoot = (bound: string | undefined, executionId: string, nodeId: string): boolean =>
  bound !== undefined && nodeId === rootNodeId && executionId !== bound

/**
 * Folds one run's events into the executions it measured.
 *
 * A node's work starts when the engine recorded it scheduled and ends when it
 * recorded it settled, so a duration is the distance between those two native
 * stamps. Four of the five outcomes contribute nothing: `clean` was served
 * from records rather than run, `failed` measures a collapse, `skipped` was
 * never reached, and `deferred` is scheduling debt. Only `built` ran.
 *
 * A settlement pairs with the LAST schedule of the same execution and node,
 * which is what makes a retried node measure its final attempt rather than
 * the span across every attempt. Two executions of one node id stay apart
 * because the pairing key carries the execution, and a settlement no schedule
 * opened measures nothing rather than measuring from zero.
 *
 * A record that names no action tag contributes nothing either: history is
 * grouped by tag, and a sample with no tag has nowhere honest to go.
 *
 * A called flow is measured once. The engine records one call twice: the
 * caller admits and settles the node that made it, and the callee's own
 * execution admits and settles its `root` over the same span with the same
 * action tag. {@link echoedRoot} drops the callee's copy, so one invocation
 * is one sample rather than two, and `samples` stays the count of executions
 * the flow performed.
 *
 * @param events the run's ordered control events
 * @param carry the digest of the events a bounded window dropped, when it dropped any
 * @since 1.0.0
 * @category projections
 */
export const nodeDurations = (
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  carry?: Diagnosis.Digest | undefined
): ReadonlyArray<NodeDuration> => {
  const bound = boundExecution(events, carry)
  const started = new Map<string, number>()
  const measured: Array<NodeDuration> = []
  for (const event of events) {
    const schedule = NodeEvents.nodeScheduled(event)
    if (schedule !== undefined) {
      if (echoedRoot(bound, schedule.executionId, schedule.payload.nodeId)) continue
      started.set(`${schedule.executionId}\u0000${schedule.payload.nodeId}`, schedule.emittedAtMs)
      continue
    }
    const settlement = NodeEvents.nodeSettled(event)
    if (settlement === undefined) continue
    if (echoedRoot(bound, settlement.executionId, settlement.payload.nodeId)) continue
    if (settlement.payload.outcome !== "built") continue
    const actionTag = settlement.payload.action
    if (actionTag === undefined) continue
    const key = `${settlement.executionId}\u0000${settlement.payload.nodeId}`
    const startedAt = started.get(key)
    if (startedAt === undefined) continue
    started.delete(key)
    const durationMs = settlement.emittedAtMs - startedAt
    // Wall clocks can move backwards, and a completion that predates its own
    // start is a clock fact rather than a duration.
    if (durationMs < 0) continue
    measured.push({ actionTag, durationMs })
  }
  return measured
}

/** The nearest-rank percentile of an ascending sample, which is one observed value. */
const nearestRank = (ascending: ReadonlyArray<number>, percentile: number): number =>
  ascending[Math.ceil((percentile / 100) * ascending.length) - 1]!

/**
 * Folds every measured execution of one flow into one row per action tag.
 *
 * Both percentiles are nearest-rank, so each answer is a duration the flow
 * really took rather than an interpolation between two it did not. Rows are
 * ordered by tag, so two reads of the same history answer in the same order.
 *
 * A tag reaches this function only by having been measured, so every row
 * carries at least one sample, and a flow nothing has measured answers with
 * no rows at all.
 *
 * @param flowId the flow whose history was read
 * @param samples every measured execution of that flow's runs
 * @since 1.0.0
 * @category projections
 */
export const flowDurations = (
  flowId: string,
  samples: ReadonlyArray<NodeDuration>
): ReadonlyArray<FlowDurationRow> => {
  const byTag = new Map<string, Array<number>>()
  for (const sample of samples) {
    const held = byTag.get(sample.actionTag)
    if (held === undefined) byTag.set(sample.actionTag, [sample.durationMs])
    else held.push(sample.durationMs)
  }
  return [...byTag.entries()]
    .sort(([left], [right]) => left < right ? -1 : 1)
    .map(([actionTag, observed]) => {
      const ascending = [...observed].sort((left, right) => left - right)
      return {
        flowId,
        actionTag,
        samples: ascending.length,
        p50Ms: nearestRank(ascending, 50),
        p90Ms: nearestRank(ascending, 90)
      }
    })
}

/** Events the transcript reports verbatim rather than as agent activity. */
const transcriptKinds: ReadonlySet<string> = new Set(["control.approval.requested"])

/**
 * Folds one run's events into a turn-numbered transcript.
 *
 * A row is reported for every `control.run.*` and `control.agent.*` event and
 * for an approval request, and for nothing else: the transcript is what a
 * reader follows, not the whole journal, which `run-events` already serves.
 * The turn counter advances on `control.agent.turn-opened`, so every row
 * carries the turn it belongs to, and each row's text is one display line, so
 * a multi-line seat, message, or question cannot split one row into several.
 *
 * `uniqueCallEvents` normalizes native step facts, so a module run's steps
 * report here too. The classes `Diagnosis` names apply, field by field:
 *
 * | Field  | Class     | Why                                                       |
 * | ------ | --------- | --------------------------------------------------------- |
 * | rows   | aggregate | every row is one event this run recorded, wherever it ran |
 * | `turn` | aggregate | a turn a step opened is a turn this run opened            |
 *
 * No row is root only, because no row claims to be the run's answer or state:
 * a `control.agent.resolved` row says one agent resolved, and the run's own
 * answer is served by `runSummary` from `Diagnosis`. A new field has to name
 * its class.
 *
 * @param events the run's ordered control events
 * @since 1.0.0
 * @category projections
 */
export const transcript = (
  events: ReadonlyArray<ControlSchema.ControlEvent>
): ReadonlyArray<TranscriptRow> => {
  const rows: Array<TranscriptRow> = []
  let turn = 0
  for (const event of uniqueCallEvents(events)) {
    const payload = Diagnosis.asRecord(event.payload)
    const runId = Diagnosis.asString(payload.runId) ?? event.runId
    if (runId === undefined) continue
    const reported = event.kind.startsWith("control.run.") ||
      event.kind.startsWith("control.agent.") ||
      transcriptKinds.has(event.kind)
    if (!reported) continue
    if (event.kind === "control.agent.turn-opened") turn += 1
    rows.push({
      runId,
      sequence: event.sequence,
      turn,
      at: Diagnosis.timeOf(event),
      kind: event.kind,
      ...optional("callId", Diagnosis.asString(payload.callId)),
      text: line(event.kind, payload)
    })
  }
  return rows
}

/** One event as a single transcript line. */
const line = (kind: string, payload: Record<string, unknown>): string => {
  switch (kind) {
    case "control.agent.turn-opened":
      return `turn opened · ${Diagnosis.firstLine(Diagnosis.asString(payload.seat) ?? "")}`
    case "control.agent.model-settled": {
      const usage = Diagnosis.asRecord(payload.usage)
      return `model ${Diagnosis.asNumber(usage.inputTokens) ?? 0} in / ${
        Diagnosis.asNumber(usage.outputTokens) ?? 0
      } out`
    }
    case "control.agent.cell-call-started":
      return `call ${Diagnosis.firstLine(Diagnosis.asString(payload.flowName) ?? "?")}`
    case "control.agent.cell-call-settled":
      return Diagnosis.asString(payload.outcome) === "failure"
        ? `  -> FAIL ${Diagnosis.clip(Diagnosis.firstLine(Diagnosis.asString(payload.message) ?? ""), 100)}`
        : "  -> ok"
    case "control.agent.resolved":
      return `resolved ${Diagnosis.clip(Diagnosis.firstLine(Diagnosis.asString(payload.text) ?? ""), 100)}`
    case "control.approval.requested":
      return `approval requested: ${Diagnosis.firstLine(Diagnosis.asString(payload.question) ?? "")}`
    default:
      return kind.slice("control.".length)
  }
}

/** Fold health from the same authoritative summary and committed event buffer as the run card.
 * Invalid observations and foreign incarnations cannot color the current owner.
 * @category projections
 * @since 1.0.0
 */
export const statusRollup = (
  run: ControlSchema.RunSummary,
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  now: number
): Health.StatusRollup => {
  const incarnation = Health.runIncarnation(run)
  const candidates: Array<Health.RecordedObservation> = []
  const decode = Schema.decodeUnknownOption(Health.HealthObservation)
  let evidenceSeq = 0
  for (const event of events) {
    if (event.kind === Health.statusObservedEventType) {
      const reading = decode(event.payload)
      if (reading._tag === "Some") candidates.push({ observation: reading.value, sequence: event.sequence })
    } else if (!Monitor.isBookkeepingEvent(event.kind)) evidenceSeq = Math.max(evidenceSeq, event.sequence)
  }
  const latest = Health.latestObservation(candidates, `run:${run.runId}`, incarnation)
  return Health.rollup({
    subjectId: `run:${run.runId}`,
    state: run.status,
    incarnation,
    waitingReason: run.waitingReason,
    baseHealth: latest?.observation.baseHealth ??
      Monitor.classify({ summary: run, events, beatsWithoutProgress: 0, stallBeats: 3 }),
    latest,
    now,
    evidenceSeq,
    updatedAt: run.updatedAt
  })
}
