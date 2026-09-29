/*
 * What a run did to its graph: the pure fold.
 *
 * The `run-events` projection copies the engine's own journal onto the run,
 * verbatim, inside a `control.engine.event` envelope. Five of those event
 * types describe a graph rather than an execution: the plan record carries the
 * nodes and the edges, and the node records say when each one was scheduled,
 * re-keyed and settled. This module turns those rows into the state a card
 * draws, and touches no seam, no DOM and no layout engine, so the states are
 * provable against a recorded run (FlowGraphStatus.test.ts).
 *
 * The fold is keyed by EXECUTION, not by node id alone, because node ids are
 * addresses within one graph and nothing more: a recorded fixture run carries
 * four executions and every one of them names a node `root`. A card asks for
 * the execution that drove the plan it holds, or the one whose flow it
 * launched; `runGraphOf` is that question and it answers nothing when neither
 * is known, rather than guessing which graph the reader meant.
 *
 * Nothing here invents a state. The five outcome words are the engine's
 * (`built`, `clean`, `failed`, `skipped`, `deferred` — D-041), and a node with
 * no record of its own is `pending` until an evidence gap makes even that
 * unsayable.
 */
import * as EngineEvent from "@smthrs/journal/EngineEvent"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { Option, Schema } from "effect"
import type { JournalRecord } from "./RunTrace"

/*
 * The private control bridge's envelope, as EngineTrace.ts:9-26 decodes it.
 * It is declared twice because it is not a shared contract: it is the shape
 * one projection writes, and a reader that imported another reader's copy
 * would be coupled to that reader rather than to the projection.
 */
const Envelope = Schema.Struct({
  version: Schema.Literal(1),
  executionId: JournalEvent.RunId,
  generation: JournalEvent.NonNegativeQuantity,
  sequence: JournalEvent.Seq,
  eventId: Schema.String,
  sourceId: JournalEvent.SourceId,
  sourceSequence: JournalEvent.SourceSeq,
  emittedAtMs: JournalEvent.TimestampMs,
  eventType: Schema.NonEmptyString,
  payload: Schema.Json,
  meta: Schema.Json
})
type Envelope = typeof Envelope.Type

const decodeEnvelope = Schema.decodeUnknownOption(Envelope)
const decodePlan = Schema.decodeUnknownOption(EngineEvent.PlanRecordedPayload, { onExcessProperty: "error" })
const decodeSubgraph = Schema.decodeUnknownOption(EngineEvent.SubgraphAppendedPayload, { onExcessProperty: "error" })
const decodeScheduled = Schema.decodeUnknownOption(EngineEvent.NodeScheduledPayload, { onExcessProperty: "error" })
const decodeSettled = Schema.decodeUnknownOption(EngineEvent.NodeSettledPayload, { onExcessProperty: "error" })
const decodeInvalidated = Schema.decodeUnknownOption(EngineEvent.NodeInvalidatedPayload, { onExcessProperty: "error" })
const decodeGap = Schema.decodeUnknownOption(Schema.Struct({
  executionId: Schema.String,
  generation: Schema.NullOr(Schema.Number)
}))

/** The event types that describe a graph. Everything else is an execution's business. */
const PLAN_RECORDED = EngineEvent.nodeEventTypes.planRecorded
const SUBGRAPH_APPENDED = EngineEvent.nodeEventTypes.subgraphAppended
const NODE_SCHEDULED = EngineEvent.nodeEventTypes.nodeScheduled
const NODE_SETTLED = EngineEvent.nodeEventTypes.nodeSettled
const NODE_INVALIDATED = EngineEvent.nodeEventTypes.nodeInvalidated

/**
 * How far a node got.
 *
 * `unproven` is not a fourth lifecycle stage: it is what the other three
 * become once the projection admits a hole in the history, because a node
 * that reads `pending` after a gap is a claim the evidence does not support.
 */
export type NodeRunStatus = "pending" | "running" | "settled" | "unproven"

/** The five settlement words `flows.engine.node-settled` carries. */
export type NodeOutcome = typeof EngineEvent.NodeSettledPayload.Type["outcome"]

/** A bounded, redacted preview of what one node settled with (D-052). */
export type NodeResult = typeof EngineEvent.NodeResultSummary.Type

/** What one node's records say happened to it. */
export interface NodeRun {
  readonly status: NodeRunStatus
  /** Present only once the node settled, and always the engine's own word. */
  readonly outcome?: NodeOutcome
  /** How many attempts the NODE records number; an action's own retries are not these. */
  readonly attempts: number
  readonly startedAt?: number
  readonly settledAt?: number
  /** The action or flow the node dispatches; a merge node dispatches neither. */
  readonly action?: string
  /**
   * The dispatch identities this node ran under, as its settlement named
   * them (D-052). It is the join to `flows.engine.attempt-started`, which
   * carries a step key digest and no node id. A node that dispatched nothing
   * claims an empty list; a node that has not settled claims none at all.
   */
  readonly stepKeyDigests?: ReadonlyArray<string>
  /**
   * What the node settled with, bounded and redacted by the writer: the
   * value for `built` and `clean`, the typed failure for `failed`.
   */
  readonly result?: NodeResult
}

/**
 * What a node says it is doing, in one word (D-026, D-041).
 *
 * A node with no record of its own reads `pending`: silence is a state too.
 * The word is the engine's own — the five settlement words, or the lifecycle
 * stage the records reached — and never a synonym.
 */
export const stateWord = (run: NodeRun | undefined): string =>
  run === undefined ? "pending" : run.status === "settled" ? run.outcome ?? "settled" : run.status

/** One node of the graph a run drove, as the plan record carries it. */
export interface RunGraphNode {
  readonly id: string
  /** Open text: the two executors name their kinds differently and both are true. */
  readonly kind: string
  readonly dependsOn: ReadonlyArray<string>
  readonly tier: "sealed" | "compensable" | "irreversible"
  readonly action?: string
  /** Where the declaration was written, repo-relative, when the writer knew. */
  readonly declaredAt?: { readonly path: string; readonly line: number }
  /** Drawn around the recorded graph (RunForest.ts): a whole flow, run or trigger, with no records of its own. */
  readonly forest?: true
  /** A forest node's own state word; a recorded node reads its word off the fold. */
  readonly word?: string
  /** What a forest node's Open button runs: the execution in place, or the run's own card. */
  readonly door?: { readonly flow: "runs.graph.execution" | "runs.open"; readonly args: string }
}

/**
 * Why one node waits for another, in the vocabulary of whoever drew it: the
 * engine's three (`EngineEvent.EdgeSummary`), plus the two more a plan's
 * graph builder can state (`ControlSchema.PlanEdgeReason`).
 */
export type RunGraphEdgeReason = "value" | "continuation" | "failure" | "conflict" | "lane-merge"
  /* The run forest's own three (RunForest.ts): a spawn, a trigger firing, a POC lane that never lands. */
  | "spawn" | "fires" | "poc"

/**
 * One edge of that graph.
 *
 * `reason` is absent when the source knew none. A plan names its edges
 * through each node's `dependsOn`, which says WHICH nodes wait and never
 * WHY, and a writer without reasons omits the field rather than labelling
 * every edge `value` — the engine's own schema refuses to guess it
 * (`EngineEvent.NodeGraph`), and so does this.
 */
export interface RunGraphEdge {
  readonly from: string
  readonly to: string
  readonly reason?: RunGraphEdgeReason
}

/** One execution's graph, and the state of each of its nodes. */
export interface RunExecutionGraph {
  readonly executionId: string
  /** The projection generation these rows belong to; a later one rewinds this execution. */
  readonly generation: number
  readonly flow?: string
  readonly planId?: string
  readonly nodes: ReadonlyArray<RunGraphNode>
  readonly edges: ReadonlyArray<RunGraphEdge>
  readonly status: ReadonlyMap<string, NodeRun>
  /**
   * The revision the writer read these declaration sites out of, when every
   * page of this execution named the same one.
   *
   * A page that names none, and two pages that disagree, both leave this
   * absent: the sites are one set and there is no one revision to open them
   * at, so the reader opens nothing rather than the wrong file (D-068).
   */
  readonly sourceRevision?: string
}

/** Every graph one run's journal describes. */
export interface RunGraphFold {
  readonly executions: ReadonlyArray<RunExecutionGraph>
  /** True once the history has a hole, admitted or unreadable; the covered nodes read `unproven`. */
  readonly unproven: boolean
  /** The sequences of engine rows this fold could not decode; empty is the normal case. */
  readonly unreadable: ReadonlyArray<number>
}

interface Building {
  executionId: string
  generation: number
  flow?: string
  planId?: string
  /** How many graph pages have been absorbed; the first one sets the revision. */
  pages: number
  sourceRevision?: string
  nodes: Map<string, RunGraphNode>
  edges: Array<RunGraphEdge>
  runs: Map<
    string,
    {
      status: NodeRunStatus
      outcome?: NodeOutcome
      attempts: number
      startedAt?: number
      settledAt?: number
      action?: string
      stepKeyDigests?: ReadonlyArray<string>
      result?: NodeResult
    }
  >
  gapped: boolean
}

const building = (executionId: string, generation: number): Building => ({
  executionId,
  generation,
  pages: 0,
  nodes: new Map(),
  edges: [],
  runs: new Map(),
  gapped: false
})

type NodeRunState = Building["runs"] extends Map<string, infer State> ? State : never

const runOf = (execution: Building, nodeId: string): NodeRunState => {
  const existing = execution.runs.get(nodeId)
  if (existing !== undefined) return existing
  const fresh: NodeRunState = { status: "pending", attempts: 0 }
  execution.runs.set(nodeId, fresh)
  return fresh
}

/** The nodes and edges of one recorded page, folded into the execution that wrote it. */
const absorb = (execution: Building, graph: typeof EngineEvent.NodeGraph.Type | undefined): void => {
  if (graph === undefined) return
  /*
   * The revision every page of this execution agrees on, or none. The first
   * page states it; any later page that states something else — including
   * nothing — leaves the execution with no revision at all, because a site
   * from one page opened at another page's revision is a file nobody
   * recorded (D-068).
   */
  if (execution.pages === 0) execution.sourceRevision = graph.sourceRevision
  else if (execution.sourceRevision !== graph.sourceRevision) execution.sourceRevision = undefined
  execution.pages += 1
  for (const node of graph.nodes) {
    /*
     * A node wider than one page is seated with no dependencies on it and
     * continued on the pages that follow, each carrying the next disjoint
     * slice of `dependsOn` (`@smthrs/flow`'s `planPages`). The slices are
     * UNIONED: replacing the held node would keep only the last slice, and a
     * fan-in would read as a node with two dependencies.
     */
    const held = execution.nodes.get(node.id)
    execution.nodes.set(node.id, {
      id: node.id,
      kind: node.kind,
      dependsOn: held === undefined ? [...node.dependsOn] : [...held.dependsOn, ...node.dependsOn],
      tier: node.tier,
      ...(node.action === undefined ? {} : { action: node.action }),
      ...(node.declaredAt === undefined ? {} : { declaredAt: { path: node.declaredAt.path, line: node.declaredAt.line } })
    })
  }
  for (const edge of graph.edges ?? []) execution.edges.push({ from: edge.from, to: edge.to, reason: edge.reason })
}

/**
 * The graph state of every execution this run's journal describes.
 *
 * Rows are read in journal order and deduplicated on the producer identity the
 * projection writes, `(executionId, generation, sequence)`, so a projection
 * that repeats a page — which it does, because it holds no durable cursor —
 * folds to the same state as one that does not. A row whose generation is
 * older than the one this execution has reached is dropped, and a newer one
 * rewinds that execution alone: the earlier generation's settlements describe
 * work the rewind discarded.
 *
 * A row this fold cannot decode counts as a hole in the history, like a gap
 * the projection admits, because every payload here is read strictly and a
 * record this build does not know is a record whose meaning is unavailable.
 */
export const foldRunGraph = (records: ReadonlyArray<JournalRecord> = []): RunGraphFold => {
  const executions = new Map<string, Building>()
  const unreadable: Array<number> = []
  const seen = new Set<string>()
  let unproven = false

  /*
   * A row this fold cannot read is a hole in the history, exactly like a gap
   * the projection admits: whatever it said about its execution is unknowable,
   * and a node left reading `pending` would be a claim nothing supports. The
   * envelope names the execution the row belongs to; a row whose envelope is
   * itself the unreadable part names nobody, so it covers the whole run.
   */
  const lost = (sequence: number | undefined, executionId?: string): void => {
    unreadable.push(sequence ?? -1)
    unproven = true
    if (executionId === undefined) {
      for (const execution of executions.values()) execution.gapped = true
      return
    }
    const execution = executions.get(executionId)
    if (execution !== undefined) execution.gapped = true
  }

  const reach = (envelope: Envelope): Building | undefined => {
    const current = executions.get(envelope.executionId)
    if (current === undefined) {
      const fresh = building(envelope.executionId, envelope.generation)
      executions.set(envelope.executionId, fresh)
      return fresh
    }
    if (envelope.generation < current.generation) return undefined
    if (envelope.generation > current.generation) {
      const rewound = building(envelope.executionId, envelope.generation)
      rewound.gapped = current.gapped
      executions.set(envelope.executionId, rewound)
      return rewound
    }
    return current
  }

  for (const row of records) {
    if (row.kind === "control.engine.projection-gap") {
      unproven = true
      const scoped = decodeGap(row.payload)
      if (Option.isNone(scoped)) {
        for (const execution of executions.values()) execution.gapped = true
        continue
      }
      const execution = executions.get(scoped.value.executionId)
      if (execution === undefined) {
        executions.set(scoped.value.executionId, { ...building(scoped.value.executionId, scoped.value.generation ?? 0), gapped: true })
        continue
      }
      execution.gapped = true
      continue
    }
    if (row.kind !== "control.engine.event") continue
    const decoded = decodeEnvelope(row.payload)
    if (Option.isNone(decoded)) {
      lost(row.sequence)
      continue
    }
    const envelope = decoded.value
    if (
      envelope.eventType !== PLAN_RECORDED && envelope.eventType !== SUBGRAPH_APPENDED &&
      envelope.eventType !== NODE_SCHEDULED && envelope.eventType !== NODE_SETTLED &&
      envelope.eventType !== NODE_INVALIDATED
    ) continue
    const identity = `${envelope.executionId}\u0000${envelope.generation}\u0000${envelope.sequence}`
    if (seen.has(identity)) continue
    seen.add(identity)
    const execution = reach(envelope)
    if (execution === undefined) continue

    if (envelope.eventType === PLAN_RECORDED) {
      const payload = decodePlan(envelope.payload)
      if (Option.isNone(payload)) {
        lost(row.sequence, envelope.executionId)
        continue
      }
      execution.flow = payload.value.flow
      if (payload.value.planId !== undefined) execution.planId = payload.value.planId
      absorb(execution, payload.value.graph)
      continue
    }
    if (envelope.eventType === SUBGRAPH_APPENDED) {
      const payload = decodeSubgraph(envelope.payload)
      if (Option.isNone(payload)) {
        lost(row.sequence, envelope.executionId)
        continue
      }
      if (payload.value.flow !== undefined) execution.flow = payload.value.flow
      if (payload.value.planId !== undefined) execution.planId = payload.value.planId
      absorb(execution, payload.value.graph)
      continue
    }
    if (envelope.eventType === NODE_SCHEDULED) {
      const payload = decodeScheduled(envelope.payload)
      if (Option.isNone(payload)) {
        lost(row.sequence, envelope.executionId)
        continue
      }
      const run = runOf(execution, payload.value.nodeId)
      run.status = "running"
      run.attempts = Math.max(run.attempts, payload.value.attempt)
      run.startedAt ??= envelope.emittedAtMs
      if (payload.value.action !== undefined) run.action = payload.value.action
      continue
    }
    if (envelope.eventType === NODE_INVALIDATED) {
      const payload = decodeInvalidated(envelope.payload)
      if (Option.isNone(payload)) {
        lost(row.sequence, envelope.executionId)
        continue
      }
      // A re-keyed dispatch identity is still the same admitted node. The work
      // did not restart, so neither does the state.
      runOf(execution, payload.value.nodeId)
      continue
    }
    const payload = decodeSettled(envelope.payload)
    if (Option.isNone(payload)) {
      lost(row.sequence, envelope.executionId)
      continue
    }
    const run = runOf(execution, payload.value.nodeId)
    run.status = "settled"
    run.outcome = payload.value.outcome
    run.attempts = Math.max(run.attempts, payload.value.attempts)
    run.settledAt = envelope.emittedAtMs
    if (payload.value.action !== undefined) run.action = payload.value.action
    if (payload.value.stepKeyDigests !== undefined) run.stepKeyDigests = payload.value.stepKeyDigests
    if (payload.value.result !== undefined) run.result = payload.value.result
  }

  return {
    unproven,
    unreadable,
    executions: [...executions.values()].map((execution): RunExecutionGraph => {
      const status = new Map<string, NodeRun>()
      for (const id of execution.nodes.keys()) runOf(execution, id)
      for (const [id, run] of execution.runs) {
        // A settlement recorded BEFORE the hole is still a settlement. Only
        // what the hole could have swallowed becomes unsayable.
        const settled = run.status === "settled"
        status.set(id, {
          status: execution.gapped && !settled ? "unproven" : run.status,
          ...(run.outcome === undefined ? {} : { outcome: run.outcome }),
          attempts: run.attempts,
          ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
          ...(run.settledAt === undefined ? {} : { settledAt: run.settledAt }),
          ...(run.action === undefined ? {} : { action: run.action }),
          ...(run.stepKeyDigests === undefined ? {} : { stepKeyDigests: run.stepKeyDigests }),
          ...(run.result === undefined ? {} : { result: run.result })
        })
      }
      return {
        executionId: execution.executionId,
        generation: execution.generation,
        ...(execution.flow === undefined ? {} : { flow: execution.flow }),
        ...(execution.planId === undefined ? {} : { planId: execution.planId }),
        nodes: [...execution.nodes.values()],
        edges: execution.edges,
        ...(execution.sourceRevision === undefined ? {} : { sourceRevision: execution.sourceRevision }),
        status
      }
    })
  }
}

/**
 * The execution whose graph a card is asking about.
 *
 * A run's journal describes every execution it drove, and a plan names one of
 * them. The plan's node ids are the exact join, so they are tried first; a run
 * launched elsewhere has no plan on the card, and then the flow it launched is
 * the join. Neither answers nothing rather than picking the largest graph:
 * drawing the wrong execution's nodes under a plan's heading would be a lie
 * about what ran.
 *
 * Node ids are addresses within one graph, so several executions cover a plan
 * equally often: every execution of the recorded run names `root` and
 * `root.flow`. The flow the card launched breaks that tie, because journal
 * order would hand the plan to whichever execution the wrapper wrote first.
 */
export const runGraphOf = (
  fold: RunGraphFold,
  by: { readonly planNodeIds?: ReadonlyArray<string>; readonly flow?: string }
): RunExecutionGraph | undefined => {
  const wanted = new Set(by.planNodeIds ?? [])
  if (wanted.size > 0) {
    let best: { graph: RunExecutionGraph; covered: number } | undefined
    for (const execution of fold.executions) {
      const covered = execution.nodes.reduce((count, node) => wanted.has(node.id) ? count + 1 : count, 0)
      if (covered === 0) continue
      const tied = best !== undefined && covered === best.covered &&
        by.flow !== undefined && execution.flow === by.flow && best.graph.flow !== by.flow
      if (best === undefined || covered > best.covered || tied) best = { graph: execution, covered }
    }
    if (best !== undefined) return best.graph
  }
  return by.flow === undefined ? undefined : fold.executions.find((execution) => execution.flow === by.flow)
}
