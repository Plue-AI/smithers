/**
 * Serializable control-plane values shared by local and RPC projections.
 *
 * @since 0.1.0
 */

import { EngineEvent, ExecutionFact } from "@smthrs/journal"
import * as SteerPayload from "@smthrs/notifications/SteerPayload"
import * as PersistedPlan from "@smthrs/plan/Plan"
import { BudgetOnExceeded, DiscoveryWarning } from "@smthrs/registry/Descriptor"
import { Schema } from "effect"
import { Origin } from "./Lineage.ts"

/**
 * A durable control-plane run identifier.
 *
 * @since 0.1.0
 * @category models
 */
export const RunId = Schema.String

/**
 * A durable control-plane run identifier.
 *
 * @since 0.1.0
 * @category models
 */
export type RunId = typeof RunId.Type

/**
 * A registry flow identifier.
 *
 * @since 0.1.0
 * @category models
 */
export const FlowId = Schema.String

/**
 * A registry flow identifier.
 *
 * @since 0.1.0
 * @category models
 */
export type FlowId = typeof FlowId.Type

/**
 * A caller-supplied key that makes a control mutation idempotent.
 *
 * @since 0.1.0
 * @category models
 */
export const IdempotencyKey = Schema.String

/**
 * A caller-supplied key that makes a control mutation idempotent.
 *
 * @since 0.1.0
 * @category models
 */
export type IdempotencyKey = typeof IdempotencyKey.Type

/**
 * A server-authenticated identity stamped at the control boundary.
 *
 * @since 0.1.0
 * @category models
 */
export const Principal = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  stampedAt: Schema.Number
})

/**
 * A server-authenticated identity stamped at the control boundary.
 *
 * @since 0.1.0
 * @category models
 */
export type Principal = typeof Principal.Type

/**
 * The capabilities, flows, budget, and placement approved for a plan.
 *
 * `budget` holds the run's approved ceilings: `tokens`, `milliseconds` of
 * active time, and `usd` in dollars. An absent ceiling is no ceiling.
 *
 * @since 0.1.0
 * @category models
 */
export const Envelope = Schema.Struct({
  capabilities: Schema.Array(Schema.String),
  flows: Schema.Array(Schema.String),
  budget: Schema.Struct({
    tokens: Schema.optional(Schema.Number),
    milliseconds: Schema.optional(Schema.Number),
    usd: Schema.optional(Schema.Number),
    onExceeded: Schema.optional(BudgetOnExceeded)
  }),
  host: Schema.optional(Schema.String)
})

/**
 * The capabilities, flows, budget, and placement approved for a plan.
 *
 * @since 0.1.0
 * @category models
 */
export type Envelope = typeof Envelope.Type

/**
 * The durability selected for an approval grant.
 *
 * @since 0.1.0
 * @category models
 */
export const GrantScope = Schema.Literals(["once", "run", "remembered"])

/**
 * The durability selected for an approval grant.
 *
 * @since 0.1.0
 * @category models
 */
export type GrantScope = typeof GrantScope.Type

/**
 * A plan or in-run approval target. The digest and full envelope are submitted
 * with the target so the server can verify exactly what the caller reviewed.
 *
 * @since 0.1.0
 * @category models
 */
export const ApprovalTarget = Schema.Union([
  Schema.TaggedStruct("Plan", {
    planId: Schema.String,
    digest: Schema.String,
    envelope: Envelope
  }),
  Schema.TaggedStruct("Node", {
    runId: RunId,
    requestId: Schema.String,
    digest: Schema.String,
    envelope: Envelope
  })
])

/**
 * A plan or in-run approval target.
 *
 * @since 0.1.0
 * @category models
 */
export type ApprovalTarget = typeof ApprovalTarget.Type

/**
 * The complete, reviewable payload emitted by planning and submitted unchanged
 * when an approval decision is made.
 *
 * @since 0.1.0
 * @category models
 */
export const ApprovalPayload = Schema.Struct({
  target: ApprovalTarget,
  scope: GrantScope,
  idempotencyKey: IdempotencyKey
})

/**
 * The complete, reviewable payload emitted by planning.
 *
 * @since 0.1.0
 * @category models
 */
export type ApprovalPayload = typeof ApprovalPayload.Type

/**
 * What `smithers plan` reports for one node before anything runs.
 *
 * The two outcomes fall out of step keys for free — a key either hits the
 * step cache or it does not — which is why they are reported here rather than
 * discovered during execution. The third outcome, `release`, belongs to
 * orphan reconciliation and is deliberately not part of a plan card.
 *
 * @since 0.1.0
 * @category models
 */
export const PlanNodeStatus = Schema.Literals(["cached", "run"])

/**
 * What `smithers plan` reports for one node before anything runs.
 *
 * @since 0.1.0
 * @category models
 */
export type PlanNodeStatus = typeof PlanNodeStatus.Type

/**
 * One keyed node of the plan an approval is being taken on.
 *
 * `key` is an `@smthrs/keys` `Key` produced by `@smthrs/plan`'s step-key
 * compiler, so a node named here and a node recorded in the persisted plan are
 * the same node. Ids are lookup addresses and are never hashed.
 *
 * @since 0.1.0
 * @category models
 */
export const PlanNode = Schema.Struct({
  ...PersistedPlan.PlanNode.fields,
  status: PlanNodeStatus
})

/**
 * One keyed node of the plan an approval is being taken on.
 *
 * @since 0.1.0
 * @category models
 */
export type PlanNode = typeof PlanNode.Type

/**
 * Why one node of a plan waits for another.
 *
 * These are the reasons the two shipped graph builders already record.
 * `value` consumes an upstream result and `continuation` is the sequencing
 * edge of a builder or a branch arm, from both. `failure` is `@smthrs/flow`'s
 * recovery arm; `conflict` is the ordering edge `@smthrs/core`'s
 * write-conflict pass adds, and `lane-merge` orders laned writers with their
 * merge. A host reports the vocabulary of the builder it graphs with.
 *
 * @since 0.1.0
 * @category models
 */
export const PlanEdgeReason = Schema.Literals(["value", "continuation", "failure", "conflict", "lane-merge"])

/**
 * Why one node of a plan waits for another.
 *
 * @since 0.1.0
 * @category models
 */
export type PlanEdgeReason = typeof PlanEdgeReason.Type

/**
 * One labelled edge of the graph a plan was built from.
 *
 * @since 0.1.0
 * @category models
 */
export const PlanEdge = Schema.Struct({
  from: Schema.NonEmptyString,
  to: Schema.NonEmptyString,
  reason: PlanEdgeReason
})

/**
 * One labelled edge of the graph a plan was built from.
 *
 * @since 0.1.0
 * @category models
 */
export type PlanEdge = typeof PlanEdge.Type

/**
 * One node of the built graph, as the reader of a plan drills into it.
 *
 * It carries the address and the declaration site, and nothing else: the
 * keyed node beside it (`PlanNode`) already says what the node is and what it
 * would do, and this is the one fact about it the key material deliberately
 * does not hold. `declaredAt` is the journal's own schema, so a plan card and
 * a run's records state a declaration site the same way and under the same
 * refusal of an absolute path; a host that cannot make a path relative to its
 * own root omits it.
 *
 * @since 0.1.0
 * @category models
 */
export const PlanGraphNode = Schema.Struct({
  id: Schema.NonEmptyString,
  declaredAt: Schema.optionalKey(EngineEvent.DeclaredAt)
})

/**
 * One node of the built graph, as the reader of a plan drills into it.
 *
 * @since 0.1.0
 * @category models
 */
export type PlanGraphNode = typeof PlanGraphNode.Type

/**
 * The shape of the graph a plan was built from, for a reader that draws it.
 *
 * A `PlanNode` carries `dependsOn`, which is one unlabelled edge set: it
 * cannot tell a value dependency from a `catch` arm or from an ordering edge
 * a write conflict added. The graph builder knows which is which, so a host
 * that graphs a flow reports the reasons here rather than making every reader
 * guess them back.
 *
 * `nodes` is the same statement about provenance: the builder observed where
 * each node was declared and the key material deliberately does not carry it,
 * so it travels here, beside the edges and outside the digest. A host that
 * reports none is a host whose reader cannot open the code, not a host whose
 * plan is wrong.
 *
 * @since 0.1.0
 * @category models
 */
export const PlanGraph = Schema.Struct({
  edges: Schema.Array(PlanEdge),
  nodes: Schema.optional(Schema.Array(PlanGraphNode)),
  /**
   * The revision of the workspace those declaration sites were read out of.
   *
   * A site is a path and a line, and neither says which bytes were there: a
   * host's working tree moves, so the same path after an edit or a branch
   * switch is a different file. This is the immutable name of the tree the
   * host loaded the flow from — a jj working-copy commit id, or a git commit
   * for a tree that still matches one — and a reader asks the content route
   * for the file AT this revision rather than for whatever is on disk now.
   *
   * A host that cannot name one reports nothing, and a reader that has
   * nothing shows no code at all rather than code it cannot bind (D-068).
   *
   * Exactly the forty lowercase hex digits the only producer emits
   * (`SourceRevision.objectId`), because the app puts this value straight
   * into a contents route's `?ref=` and a route that spawns jj or git from it
   * should never see anything else.
   */
  sourceRevision: Schema.optional(
    Schema.NonEmptyString.check(Schema.makeFilter((value) => /^[0-9a-f]{40}$/.test(value)))
  )
})

/**
 * The shape of the graph a plan was built from, for a reader that draws it.
 *
 * @since 0.1.0
 * @category models
 */
export type PlanGraph = typeof PlanGraph.Type

/**
 * The reviewable, signed payload returned by planning and resubmitted to
 * approval without reconstructing authority client-side.
 *
 * `nodes` is the keyed node graph the plan phase produced. It is part of the
 * card, and part of the digest an approval binds to, because "approve this
 * flow with this input" and "approve this graph of keyed work" are different
 * promises: a change that re-keys a node changes what will run, and an
 * approval taken against the old graph must not authorize the new one. A host
 * that has not built a graph reports an empty one and loses nothing.
 *
 * @since 0.1.0
 * @category models
 */
export const PlanCard = Schema.Struct({
  planId: Schema.String,
  flowId: FlowId,
  digest: Schema.String,
  inputSummary: Schema.String,
  envelope: Envelope,
  deployClass: Schema.Boolean,
  /** Executable source/metadata identity supplied by a discovery-based host. */
  executionDigest: Schema.optional(Schema.String),
  plan: Schema.optional(PersistedPlan.Plan),
  nodes: Schema.Array(PlanNode),
  /**
   * The labelled edges of the graph this plan was built from, and where its
   * nodes were declared.
   *
   * Deliberately OUTSIDE the digest an approval binds to: the edges and the
   * declaration sites describe the plan a reader draws, and nothing here
   * changes what will run. The
   * persisted plan's own digest already covers keys, edges, effects,
   * conflicts, priorities and generations, so a host that starts reporting
   * this field re-plans to the digest it planned to before and every parked
   * approval still validates.
   */
  graph: Schema.optional(PlanGraph),
  approval: ApprovalPayload
})

/**
 * The reviewable, signed payload returned by planning and resubmitted to
 * approval without reconstructing authority client-side.
 *
 * @since 0.1.0
 * @category models
 */
export type PlanCard = typeof PlanCard.Type

/**
 * Stable statuses projected for a durable run.
 *
 * @since 0.1.0
 * @category models
 */
export const RunStatus = Schema.Literals([
  "accepted",
  "running",
  "parked",
  "waiting-approval",
  "cancelled",
  "completed",
  "failed"
])

/**
 * Stable statuses projected for a durable run.
 *
 * @since 0.1.0
 * @category models
 */
export type RunStatus = typeof RunStatus.Type

/**
 * How a run came to exist, when it did not start on its own.
 *
 * Defined by `@smthrs/control/Lineage` and re-exported here so a serializable
 * projection needs one import.
 *
 * @since 0.1.0
 * @category models
 */
export const RunOrigin = Origin

/**
 * How a run came to exist, when it did not start on its own.
 *
 * @since 0.1.0
 * @category models
 */
export type RunOrigin = typeof RunOrigin.Type

/**
 * Where a cancellation came from.
 *
 * `control` is an operator asking through this plane, and it is the only
 * source that can name a principal. `cascade` is a run swept up in an
 * ancestor's cancellation. `engine` is everything the runtime decided on its
 * own account: a lease expiry, a budget, a supervisor.
 *
 * @since 0.1.0
 * @category models
 */
export const CancelSource = Schema.Literals(["control", "engine", "cascade"])

/**
 * Where a cancellation came from.
 *
 * @since 0.1.0
 * @category models
 */
export type CancelSource = typeof CancelSource.Type

/**
 * Who cancelled a run, why, and on whose behalf.
 *
 * A durable cancellation is anonymous on its own: the run row records that
 * somebody asked and when, and nothing else. This is the attribution the
 * journal adds back. `principal` and `reason` are present exactly when a
 * request named them, which a cascade inherits from the request that started
 * it and an engine-decided cancellation never has.
 *
 * @since 0.1.0
 * @category models
 */
export const Cancellation = Schema.Struct({
  requestedAt: Schema.Number,
  source: CancelSource,
  principal: Schema.optional(Principal),
  reason: Schema.optional(Schema.String),
  /** The cancelled ancestor this run was swept up with, on a cascade. */
  cascadedFrom: Schema.optional(RunId)
})

/**
 * Who cancelled a run, why, and on whose behalf.
 *
 * @since 0.1.0
 * @category models
 */
export type Cancellation = typeof Cancellation.Type

/**
 * One open wait somewhere in a run tree that a person has to end.
 *
 * A run that calls another flow parks the CHILD execution, not the run an
 * operator named. `run-3` of `coding/request` sat at `waiting-reason: event`
 * while the question a person owed an answer to — `coding-clarification` —
 * was parked three executions below it on `coding/PreparePlan`. Every reader
 * that asked the named run what it was waiting on was therefore told "an
 * event", which is true of that one row and false of the run tree: nothing
 * was going to arrive, because the run was waiting on a human.
 *
 * This is the wait as the ROOT of the tree reports it. `runId` is the
 * execution actually holding it, which is what a decision has to be routed
 * to; `token` is the durable wait address, submitted back unchanged;
 * `request` is what the wait declared about itself, which for a `HumanTask`
 * is `{kind, name, prompt, attempt, maxAttempts}`.
 *
 * @since 1.0.0
 * @category models
 */
export const PendingWait = Schema.Struct({
  /** The execution parked on this wait, which may be the root run itself. */
  runId: RunId,
  /** The flow that execution is running. */
  flowId: Schema.optional(FlowId),
  /** The supervisor vocabulary this wait parked under, always `approval` here. */
  reason: Schema.String,
  /** The durable wait address a decision is routed to. */
  token: Schema.String,
  /** Digest used to join replayed display facts to this current operational address. */
  tokenDigest: Schema.optional(Schema.String),
  /** The wait point's own name, when the token addresses a named one. */
  name: Schema.optional(Schema.String),
  /** Which attempt of a re-asked question this is, counting from 1. */
  attempt: Schema.optional(Schema.Number),
  /** What the wait declared about itself, absent when it declared nothing. */
  request: Schema.optional(Schema.Json),
  /** When the execution holding this wait was created. */
  createdAt: Schema.Number
})

/**
 * One open wait somewhere in a run tree that a person has to end.
 *
 * @since 1.0.0
 * @category models
 */
export type PendingWait = typeof PendingWait.Type

/**
 * A compact summary for run listings and status projections.
 *
 * @since 0.1.0
 * @category models
 */
export const RunSummary = Schema.Struct({
  /** Whether lifecycle fields were observed in the engine or no engine row was visible. */
  executionObservation: Schema.optional(Schema.Literals(["observed", "missing"])),
  /** Exact native semantic observation; never a control-stream fact. */
  executionView: Schema.optional(ExecutionFact.View),
  runId: RunId,
  flowId: FlowId,
  status: RunStatus,
  planId: Schema.optional(Schema.String),
  planDigest: Schema.optional(Schema.String),
  /** The flow's executable identity when the run started; resume refuses a different one. */
  executionDigest: Schema.optional(Schema.String),
  /** The engine version that started the run. */
  engineVersion: Schema.optional(Schema.String),
  /**
   * How the code that would resume this run differs from the code it
   * recorded. Computed by an exact run lookup, never stored; absent when
   * nothing changed or the run is terminal.
   */
  codeDrift: Schema.optional(Schema.Struct({
    recorded: Schema.optional(Schema.String),
    current: Schema.optional(Schema.String),
    recordedEngine: Schema.optional(Schema.String),
    currentEngine: Schema.optional(Schema.String)
  })),
  ownerId: Schema.optional(Schema.String),
  /**
   * The authenticated principal that launched this run through the control
   * plane. A reader that does not see every run sees only the runs its own
   * principal launched. Absent on a run the engine created (a child, a fork,
   * a later trampoline round) and on a run launched before it was recorded;
   * only a reader that sees every run sees those.
   */
  launchedBy: Schema.optional(Schema.Struct({ id: Schema.String, kind: Schema.String })),
  /**
   * The run this one branched from: the spawning run, the forked-from run, or
   * the previous trampoline round. Absent on a run with no ancestor.
   */
  parentRunId: Schema.optional(RunId),
  /**
   * The trampoline lineage this run is a round of, and which round it is.
   * Both absent means a lineage of one, read as round 0 of itself.
   */
  lineageId: Schema.optional(Schema.String),
  roundOrdinal: Schema.optional(Schema.Number),
  origin: Schema.optional(RunOrigin),
  /**
   * What a parked run is holding on: `approval`, `event`, `timer`, `quota`, or
   * a reason a plugin declared. Absent on a run that is not parked, and on a
   * park whose owner released the run without declaring one.
   *
   * The CLI's `ps` and `status` listings also render `executor` here for a run
   * that has sat at `accepted` with no owner process past the launch handoff
   * window. That value is computed at render time and never stored, so a
   * reader going through the control RPC, the gateway projection, or a plugin
   * sees the field absent on the same run.
   */
  waitingReason: Schema.optional(Schema.String),
  /** What has been steered to this run and not yet delivered. */
  steering: Schema.optional(Schema.Struct({ pending: Schema.Number })),
  /**
   * A resume this run has been told to take and no host has taken up yet.
   *
   * A decision on an in-run approval restarts the run server-side, and the
   * process that decides is usually not the process that hosts the execution:
   * an operator's `smithers approve`, a gateway, a second CLI. The intent is
   * therefore recorded durably here, and the host that owns the execution
   * takes it up on its next tick and clears it. The number is the durable
   * sequence of the request, so an operator can tell a delegation that is
   * still outstanding from one that has been taken up. Absent means nothing
   * is waiting to be taken up.
   */
  pendingResume: Schema.optional(Schema.Number),
  /**
   * The executor claim this run was parked under.
   *
   * A parked execution releases its owner columns — that is what makes it
   * resumable at all — so after a park nothing on the row says which process
   * is hosting it. Every process that shares the databases can therefore see
   * the parked execution and resume it, including a short-lived `smithers
   * approve` that would drive the run and then exit. The fence the park was
   * written under is recorded here instead, so the host that parked the run
   * recognizes its own park and every other composition can tell that the
   * execution is not its to take up (triage B-15). Absent on a run that is not
   * parked, and on a park written by something that held no fence.
   */
  parkedBy: Schema.optional(Schema.String),
  /** Who cancelled this run, why, and on whose behalf. Absent until one did. */
  cancellation: Schema.optional(Cancellation),
  /**
   * Open human waits anywhere in this run's tree, nearest execution first.
   *
   * Present only when there is at least one, so a run nobody owes an answer
   * carries no field rather than an empty array. `status` rolls up with it:
   * a run any of whose descendants is parked on `approval` reports
   * `waiting-approval`, which is what the existing inbox filters select on.
   */
  pendingWaits: Schema.optional(Schema.Array(PendingWait)),
  createdAt: Schema.Number,
  updatedAt: Schema.Number
})

/**
 * A compact summary for run listings and status projections.
 *
 * @since 0.1.0
 * @category models
 */
export type RunSummary = typeof RunSummary.Type

/**
 * The bookkeeping every steer variant carries.
 *
 * `principal` stays here even though `CancelInput` argues a wire principal is
 * a client naming someone else, and the difference is who the callers are. A
 * cancel is only ever an operator command, so the server can be its sole
 * source of identity. A steer is not: `agent/send` steers a child run and
 * attributes the message to the parent flow, which is an identity no
 * authenticator knows and no operator issued. Dropping the field would erase
 * that attribution, so the field remains and `ControlServer` overwrites it
 * with the authenticated principal on every steer that arrives over RPC. An
 * in-process caller keeps naming its own.
 */
const steerEnvelope = {
  messageId: Schema.String,
  /**
   * The run this message is for. `Control.steer` refuses a message whose
   * `runId` disagrees with the one the call names: the notification would be
   * admitted to the call's run while the stored message claimed another, and an
   * operator reading it later would be told it belongs somewhere it was never
   * delivered.
   */
  runId: RunId,
  principal: Principal,
  /**
   * When the caller says it wrote the message. It is the caller's own
   * statement, recorded on `control.steer.enqueued` and never used to decide
   * anything. Over RPC the server's own clock is already on
   * `principal.stampedAt`, which is the time a decision may be replayed
   * against.
   */
  createdAt: Schema.Number
}

/**
 * An operator message inserted into the transcript at the next turn boundary.
 *
 * `kind` is optional here and required on every other variant, which is what
 * keeps a steer written before the vocabulary widened readable: a body and no
 * kind is a message, and always was.
 *
 * @since 0.1.0
 * @category models
 */
export const MessageSteer = Schema.Struct({
  ...steerEnvelope,
  kind: Schema.optional(Schema.Literal("Message")),
  body: Schema.String
})

/**
 * A model-seat change that applies from the next turn on.
 *
 * @since 0.1.0
 * @category models
 */
export const SeatSteer = Schema.Struct({ ...steerEnvelope, ...SteerPayload.SeatPayload.fields })

/**
 * A thinking-level change that applies from the next turn on.
 *
 * @since 0.1.0
 * @category models
 */
export const ThinkingSteer = Schema.Struct({ ...steerEnvelope, ...SteerPayload.ThinkingPayload.fields })

/**
 * Tools added to the active set for future turns.
 *
 * @since 0.1.0
 * @category models
 */
export const ToolsSteer = Schema.Struct({ ...steerEnvelope, ...SteerPayload.ToolsPayload.fields })

/**
 * A durable operator steer delivered at an execution turn boundary.
 *
 * An operator steers a run for four different reasons, and only one of them is
 * something to tell the model. Saying "your seat changed" would spend a turn on
 * bookkeeping; changing the seat is what was asked for. So the four are one
 * union rather than four free-text conventions the harness would have to
 * parse.
 *
 * @since 0.1.0
 * @category models
 */
export const SteerMessage = Schema.Union([MessageSteer, SeatSteer, ThinkingSteer, ToolsSteer])

/**
 * A durable operator steer delivered at an execution turn boundary.
 *
 * @since 0.1.0
 * @category models
 */
export type SteerMessage = typeof SteerMessage.Type

/**
 * The stored steering item one steer carries.
 *
 * The envelope — who asked, when, for which run — is control-plane
 * bookkeeping. What crosses into the notification queue is the item alone, in
 * the vocabulary `@smthrs/notifications` defines and the harness reads back.
 *
 * @param message the steer
 * @since 0.1.0
 * @category conversions
 */
export const steerItem = (message: SteerMessage): SteerPayload.SteerPayload => {
  switch (message.kind) {
    case undefined:
    case "Message":
      return { kind: "Message", body: message.body }
    case "Seat":
      return { kind: "Seat", seat: message.seat }
    case "Thinking":
      return { kind: "Thinking", thinking: message.thinking }
    case "Tools":
      return { kind: "Tools", toolNames: message.toolNames }
  }
}

/**
 * A durable, named signal delivered to a waiting run.
 *
 * @since 0.1.0
 * @category models
 */
export const SignalPayload = Schema.Struct({
  name: Schema.String,
  payload: Schema.Json
})

/**
 * A durable, named signal delivered to a waiting run.
 *
 * @since 0.1.0
 * @category models
 */
export type SignalPayload = typeof SignalPayload.Type

/**
 * The RPC request schema for planning.
 *
 * The wire accepts JSON because an RPC request must be serializable. The local
 * `Control.PlanInput` keeps `input` as `unknown` so a runtime can decode its
 * flow's own input schema before anything crosses a transport.
 *
 * @since 0.1.0
 * @category models
 */
export const PlanInputSchema = Schema.Struct({
  flowId: FlowId,
  input: Schema.Json,
  idempotencyKey: Schema.optional(IdempotencyKey),
  budget: Schema.optional(Envelope.fields.budget)
})

/**
 * The RPC request schema for starting a plan or resuming a run.
 *
 * @since 0.1.0
 * @category models
 */
export const RunInputSchema = Schema.Union([
  Schema.TaggedStruct("Plan", {
    planId: Schema.String,
    digest: Schema.String,
    envelope: Envelope,
    idempotencyKey: IdempotencyKey
  }),
  Schema.TaggedStruct("Resume", {
    runId: RunId,
    idempotencyKey: IdempotencyKey,
    allowCodeDrift: Schema.optional(Schema.Boolean)
  })
])

/**
 * The RPC request schema for an approval decision.
 *
 * The authenticated server supplies the principal, so a client cannot name a
 * different identity on the wire.
 *
 * @since 0.1.0
 * @category models
 */
export const ApprovalInputSchema = ApprovalPayload

/**
 * The RPC request schema for steering a run.
 *
 * @since 0.1.0
 * @category models
 */
export const SteerInputSchema = Schema.Struct({
  runId: RunId,
  message: SteerMessage,
  idempotencyKey: IdempotencyKey
})

/**
 * The RPC request schema for signaling a run.
 *
 * @since 0.1.0
 * @category models
 */
export const SignalInputSchema = Schema.Struct({
  runId: RunId,
  signal: SignalPayload,
  idempotencyKey: IdempotencyKey
})

/**
 * The shared fields of an RPC run mutation request.
 *
 * @since 0.1.0
 * @category models
 */
export const RunMutationInputSchema = Schema.Struct({ runId: RunId, idempotencyKey: IdempotencyKey })

/**
 * The RPC request schema for a lifecycle mutation that records a reason.
 *
 * The reason is on the wire because the server records it with the decision.
 * The principal is absent because the authenticated server stamps it.
 *
 * @since 0.1.0
 * @category models
 */
export const ReasonedMutationInputSchema = Schema.Struct({
  ...RunMutationInputSchema.fields,
  reason: Schema.optional(Schema.String)
})

/**
 * The RPC request schema for cancellation.
 *
 * Cancellation currently has the same wire shape as every reasoned lifecycle
 * mutation. This named alias keeps the operation's public contract explicit.
 *
 * @since 0.1.0
 * @category models
 */
export const CancelInputSchema = ReasonedMutationInputSchema

/**
 * The RPC request schema for resume: a reasoned mutation that may accept a
 * changed flow.
 *
 * @since 1.0.0
 * @category models
 */
export const ResumeInputSchema = Schema.Struct({
  ...ReasonedMutationInputSchema.fields,
  allowCodeDrift: Schema.optional(Schema.Boolean)
})

/**
 * A checkpoint in one journal entry's expansion. Without `offset`, the whole
 * entry is consumed. With it, only members through that zero-based index are
 * consumed. Pass the cursor back unchanged with the same run id.
 *
 * @since 0.1.0
 * @category models
 */
export const WatchCursor = Schema.Struct({
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(Number.MAX_SAFE_INTEGER)),
  offset: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(Number.MAX_SAFE_INTEGER))
  )
})

/**
 * A checkpoint in one journal entry's expansion.
 *
 * @since 0.1.0
 * @category models
 */
export type WatchCursor = typeof WatchCursor.Type

/**
 * A journal-projection cursor, optional run restriction, and delivery mode.
 * Omitting `follow` preserves the live-stream behavior; `false` requests a
 * finite snapshot of entries durable when the request is handled.
 *
 * @since 0.1.0
 * @category models
 */
export const WatchFilter = Schema.Struct({
  runId: Schema.optional(RunId),
  /** Resume after a fully consumed source entry, including all its deltas. Requires `runId`. */
  afterSequence: Schema.optional(Schema.Number),
  /** Resume after one emitted event, even inside an expansion. Requires `runId`. Cannot be combined with `afterSequence`. */
  afterCursor: Schema.optional(WatchCursor),
  follow: Schema.optional(Schema.Boolean)
})

/**
 * A resumable journal-projection watch cursor and optional run restriction.
 *
 * @since 0.1.0
 * @category models
 */
export type WatchFilter = typeof WatchFilter.Type

/**
 * One ordered journal-projection delta streamed by `watch`.
 *
 * @since 0.1.0
 * @category models
 */
export const ControlEvent = Schema.Struct({
  /** Present on `ControlLive.watch` events; absent on raw projections and older providers. */
  cursor: Schema.optional(WatchCursor),
  sequence: Schema.Number,
  kind: Schema.String,
  runId: Schema.optional(RunId),
  occurredAt: Schema.Number,
  payload: Schema.Json
})

/**
 * One ordered journal-projection delta streamed by `watch`.
 *
 * @since 0.1.0
 * @category models
 */
export type ControlEvent = typeof ControlEvent.Type

/**
 * How many items a listing returns when the caller names no `limit`.
 *
 * A listing with no bound returned the whole collection and paid one pending
 * steer query per run, so `smithers ps` on a busy project grew without bound.
 * A default is the smallest fix that keeps every caller working: a client that
 * wants more walks `nextCursor`.
 *
 * @since 0.1.0
 * @category models
 */
export const defaultPageSize = 100

/**
 * The largest `limit` a listing accepts.
 *
 * The cap is the resource bound: a remote bearer holder cannot ask one request
 * to project an unbounded number of rows.
 *
 * @since 0.1.0
 * @category models
 */
export const maxPageSize = 500

/**
 * A page size a listing can actually make progress on.
 *
 * `0`, a negative size, a fraction, `NaN`, and `Infinity` are all refused. A
 * zero-sized page used to answer `{ items: [], nextCursor: "0" }`, which is a
 * cursor a client loops on forever.
 *
 * @since 0.1.0
 * @category models
 */
export const PageLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(maxPageSize)
)

/**
 * How a claimed trigger occurrence ended.
 *
 * The same six words `@smthrs/triggers` records in its fire ledger. They are
 * declared here rather than imported because the triggers package depends on
 * this one (its scheduler launches runs through `Control`), so the vocabulary
 * has to live on the control side of that edge.
 *
 * @since 1.0.0
 * @category models
 */
export const FireOutcome = Schema.Literals(["launched", "completed", "skipped", "buffered", "superseded", "failed"])

/**
 * How a claimed trigger occurrence ended.
 *
 * @since 1.0.0
 * @category models
 */
export type FireOutcome = typeof FireOutcome.Type

/**
 * One registered trigger as a listing reports it.
 *
 * `nextOccurrencesMs` is the store clock's view of the next fires, computed at
 * read time, so an operator sees when a schedule will next run without
 * evaluating the cron expression client-side. `schedulerLastTickMs` is the
 * last poll the scheduler recorded; absent means no scheduler has ticked on
 * this host, so an enabled trigger is not going to fire. `activeRunId` names
 * the run the trigger is currently holding, and is absent while the trigger
 * holds a reservation rather than a launched run.
 *
 * @since 1.0.0
 * @category models
 */
export const TriggerSummary = Schema.Struct({
  triggerId: Schema.String,
  flowId: FlowId,
  input: Schema.Json,
  cron: Schema.String,
  timezone: Schema.optional(Schema.String),
  overlap: Schema.Literals(["skip", "buffer-one", "supersede"]),
  catchUp: Schema.Literals(["none", "one", "all"]),
  maxCatchUp: Schema.optional(Schema.Number),
  enabled: Schema.Boolean,
  revision: Schema.Number,
  lastFiredAtMs: Schema.optional(Schema.Number),
  pendingAtMs: Schema.optional(Schema.Number),
  activeRunId: Schema.optional(RunId),
  nextOccurrencesMs: Schema.Array(Schema.Number),
  schedulerLastTickMs: Schema.optional(Schema.Number)
})

/**
 * One registered trigger as a listing reports it.
 *
 * @since 1.0.0
 * @category models
 */
export type TriggerSummary = typeof TriggerSummary.Type

/**
 * One claimed trigger occurrence and what became of it.
 *
 * `outcome` is `null` while the occurrence is claimed and not yet reported,
 * which is the window between a claim and its `recordResult`. `waiting` names
 * what a launched run is parked on when the ledger can see it.
 *
 * @since 1.0.0
 * @category models
 */
export const FireSummary = Schema.Struct({
  triggerId: Schema.String,
  occurrenceAtMs: Schema.Number,
  outcome: Schema.NullOr(FireOutcome),
  runId: Schema.optional(RunId),
  error: Schema.optional(Schema.String),
  waiting: Schema.optional(Schema.Literal("approval"))
})

/**
 * One claimed trigger occurrence and what became of it.
 *
 * @since 1.0.0
 * @category models
 */
export type FireSummary = typeof FireSummary.Type

/**
 * A typed listing request for discovered flows, durable runs, registered
 * triggers, or the trigger fire ledger.
 *
 * `principalId` selects the runs whose `launchedBy.id` it names. It narrows a
 * listing; it is not an authorization boundary. The server restricts a reader
 * that does not see every run to the runs its own principal launched, whatever
 * filter it sends.
 *
 * @since 0.1.0
 * @category models
 */
export const ListRequest = Schema.Union([
  Schema.TaggedStruct("flows", {
    filters: Schema.optional(Schema.Json),
    cursor: Schema.optional(Schema.String),
    limit: Schema.optional(PageLimit)
  }),
  Schema.TaggedStruct("runs", {
    filters: Schema.optional(Schema.Struct({
      runId: Schema.optional(RunId),
      flowId: Schema.optional(FlowId),
      status: Schema.optional(RunStatus),
      terminal: Schema.optional(Schema.Boolean),
      principalId: Schema.optional(Schema.String),
      parentRunId: Schema.optional(RunId),
      lineageId: Schema.optional(Schema.String),
      /** Runs created at or after this epoch millisecond. */
      since: Schema.optional(Schema.Number),
      /** Runs created before this epoch millisecond. */
      until: Schema.optional(Schema.Number),
      /** Runs a fire of this trigger started. */
      triggerId: Schema.optional(Schema.String)
    })),
    /** Creation time, newest or oldest first; omitted preserves the historical listing order. */
    order: Schema.optional(Schema.Literals(["newest", "oldest"])),
    cursor: Schema.optional(Schema.String),
    limit: Schema.optional(PageLimit)
  }),
  Schema.TaggedStruct("triggers", {
    filters: Schema.optional(Schema.Struct({
      triggerId: Schema.optional(Schema.String),
      flowId: Schema.optional(FlowId),
      enabled: Schema.optional(Schema.Boolean)
    })),
    cursor: Schema.optional(Schema.String),
    limit: Schema.optional(PageLimit)
  }),
  Schema.TaggedStruct("fires", {
    filters: Schema.optional(Schema.Struct({
      triggerId: Schema.optional(Schema.String),
      runId: Schema.optional(RunId),
      outcome: Schema.optional(FireOutcome)
    })),
    cursor: Schema.optional(Schema.String),
    limit: Schema.optional(PageLimit)
  })
])

/**
 * A typed listing request for discovered flows, durable runs, registered
 * triggers, or the trigger fire ledger.
 *
 * @since 0.1.0
 * @category models
 */
export type ListRequest = typeof ListRequest.Type

/**
 * A typed page returned for a flow, run, trigger, or fire listing.
 *
 * @since 0.1.0
 * @category models
 */
export const ListResponse = Schema.Union([
  Schema.TaggedStruct("flows", {
    items: Schema.Array(
      Schema.Struct({ flowId: FlowId, description: Schema.String, inputSchema: Schema.optional(Schema.Json) })
    ),
    warnings: Schema.optional(Schema.Array(DiscoveryWarning)),
    nextCursor: Schema.optional(Schema.String)
  }),
  Schema.TaggedStruct("runs", {
    items: Schema.Array(RunSummary),
    nextCursor: Schema.optional(Schema.String)
  }),
  Schema.TaggedStruct("triggers", {
    items: Schema.Array(TriggerSummary),
    nextCursor: Schema.optional(Schema.String)
  }),
  Schema.TaggedStruct("fires", {
    items: Schema.Array(FireSummary),
    nextCursor: Schema.optional(Schema.String)
  })
])

/**
 * A typed page returned for a flow, run, trigger, or fire listing.
 *
 * @since 0.1.0
 * @category models
 */
export type ListResponse = typeof ListResponse.Type

/**
 * The idempotent outcome returned by every control mutation.
 *
 * @since 0.1.0
 * @category models
 */
export const Receipt = Schema.Union([
  Schema.TaggedStruct("Accepted", { receiptId: Schema.String, runId: Schema.optional(RunId) }),
  Schema.TaggedStruct("AlreadyApplied", { receiptId: Schema.String, runId: Schema.optional(RunId) }),
  Schema.TaggedStruct("Parked", {
    receiptId: Schema.String,
    planId: Schema.String,
    status: Schema.Literal("waiting-approval")
  }),
  Schema.TaggedStruct("Conflict", { message: Schema.String }),
  Schema.TaggedStruct("Terminal", { runId: RunId, status: RunStatus })
])

/**
 * The idempotent outcome returned by every control mutation.
 *
 * @since 0.1.0
 * @category models
 */
export type Receipt = typeof Receipt.Type
