/**
 * Persisted run wire contracts and historical run decoding.
 * @since 1.0.0
 */
import { z } from "zod"
import { GatewayWorkspaceIdSchema } from "./GatewayWorkspace.ts"
import { StatusRollupSchema } from "./Health.ts"
import { PLUE_FAULTS } from "./PlueFailureCodes.ts"

export { MonitorCardSchema, RunViewStateSchema } from "./MonitorCard.ts"
export type { MonitorCard, RunViewProps } from "./MonitorCard.ts"

/**
 * One plan node as a card carries it: the flow-plan card's row, and the
 * snapshot a launch writes onto the run it started.
 *
 * Only the part a graph draws is kept. A plan node's full key material carries
 * the call's own payload and its JSON schemas, and everything in a card
 * payload is written to disk by the persistence backend, so the card holds the
 * node's address, its key, its edges, its tier and the action it dispatches,
 * and nothing else.
 */
export const PlanCardNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(["step", "agent", "merge"]),
  key: z.string(),
  dependsOn: z.array(z.string()),
  /** The key material's own tier: what the node may do to the world. */
  tier: z.enum(["sealed", "compensable", "irreversible"]),
  /** The action or flow the node dispatches; a merge node dispatches neither. */
  action: z.string().optional(),
  status: z.enum(["cached", "run"])
})

/**
 * The graph a plan was built from, as a card carries it: the labelled edges,
 * and where the graph builder saw each node declared.
 *
 * A `PlanCardNode` carries `dependsOn`, which is ONE unlabelled edge set: it
 * cannot tell a value dependency from a `catch` arm or from an ordering edge
 * a write conflict added, and the declaration site is deliberately not part
 * of the key material a node is addressed by. Both are the workspace's own
 * observations, so both ride here, and a host that reported neither leaves
 * this absent rather than making its reader guess them back.
 *
 * The plan door's card and the snapshot a launch writes onto the run it
 * started carry the same shape, because it is the same answer.
 */
export const PlanCardGraphSchema = z.object({
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      reason: z.enum(["value", "continuation", "failure", "conflict", "lane-merge"])
    })
  ),
  nodes: z.array(
    z.object({
      id: z.string(),
      declaredAt: z.object({ path: z.string(), line: z.number().int().nonnegative() }).optional()
    })
  ).optional(),
  /**
   * The revision of the tree those declaration sites were read out of.
   *
   * A site is a path and a line, and neither says which bytes were at that
   * line: the workspace moves, so the same path after an edit or a branch
   * switch is a different file. The drawer's Code tab reads the file AT this
   * revision, and a card that carries none shows no code at all rather than
   * code it cannot bind to what ran (D-068).
   */
  sourceRevision: z.string().min(1).optional()
})

/**
 * Which of a selected node's tabs a graph card is showing.
 *
 * Each word names evidence the engine actually records, and a tab whose
 * evidence this node has none of is absent rather than empty (D-035). The
 * enum is the vocabulary, never a promise that every node has all of it.
 */
const GraphDrawerTabSchema = z.enum(["in", "declaration", "code", "output", "events", "attempts"])

/**
 * Which node of a graph a card has open, and which of its tabs.
 *
 * Reader state lives on the card like every other view state, so a reload
 * restores the drawer a person left open and no component owns it.
 */
export const GraphDrawerSchema = z.object({
  node: z.string().optional(),
  tab: GraphDrawerTabSchema.optional(),
  /*
   * A refused read of the file a node was declared in: the path it was for
   * and the refusal in the seam's own words. The Code tab renders the file
   * card the read writes, so a read that wrote none has to say so somewhere
   * a reader can see it, and the card is that place. Absent is the normal
   * case, including "not read yet".
   */
  codeError: z.object({ path: z.string(), message: z.string() }).optional()
})

/**
 * The retained legacy run payload. Historical fork spans remain data; the
 * retired forks filter decodes to all before reaching any live action.
 * @since 1.0.0
 * @category schemas
 */
export const LegacyRunTracePayloadSchema = z.object({
  statusRollup: StatusRollupSchema.optional(),
  repo: z.string(),
  /** Owning Plue gateway binding; omission identifies a legacy unbound run. */
  workspaceId: GatewayWorkspaceIdSchema.optional(),
  /** Version 1 records an explicit legacy route when workspaceId is absent. */
  gatewayBindingVersion: z.literal(1).optional(),
  runId: z.string(),
  workflow: z.string(),
  phase: z.enum([
    "launching",
    "running",
    "waiting-approval",
    "reconnecting",
    /*
     * Wave 12 §3 — the bounded client stance. A run the workspace never
     * finishes goes QUIET rather than being polled forever: after a
     * generous stale bound with no event progress the card says so
     * plainly and offers stop/retry. Honest, not silent, and not a
     * pump hammering a workspace that has stopped answering.
     */
    "quiet",
    /*
     * The human stopped WATCHING and the workspace refused the
     * gateway's Cancel, so "cancelled" would be a claim about the
     * workspace that nothing proves — the honest state is the one
     * about this client.
     */
    "stopped",
    "completed",
    "failed",
    "cancelled",
    "no-capacity"
  ]),
  steps: z.array(z.string()),
  result: z.string().nullable(),
  error: z.string().optional(),
  /** The failed run's stamped fault, from its run row: whose problem, and the error it came from. */
  failure: z.object({ class: z.enum(PLUE_FAULTS), tag: z.string() }).optional(),
  /** Failure to observe evidence; never replaces the run’s recorded diagnosis. */
  observationError: z.string().optional(),
  /**
   * Legacy field name, kept so persisted cards parse: the summary
   * projection's `updatedAt` (when the card last heard from the run),
   * not an event cursor — the pump re-reads the projections in full.
   */
  lastSeq: z.number().int().nonnegative(),
  /** How long the run had gone without progress when it went quiet. */
  quietForMs: z.number().int().nonnegative().optional(),
  /*
   * Lane runs — the run lifecycle the card surfaces. All optional so
   * cards persisted before the lane parse.
   */
  /** The launch input, so `runs.rerun` relaunches the same flow with the same arguments. */
  input: z.record(z.string(), z.unknown()).optional(),
  /**
   * The run's kind (factory spec 06 §3): "prototype" for a run
   * `feature.prototype` started, "implement" for an Implement run.
   * Prototype is a run kind, never a card kind: it selects the
   * never-promoted banner, drops the Steer row and narrows the filters.
   * Absent for every other run.
   */
  kind: z.string().optional(),
  /** Why a live run is not moving, in the control plane's word ("approval", "timer", "executor" when accepted). */
  waiting: z.string().optional(),
  /** Whether an operator steer is queued for the run. */
  steeringPending: z.boolean().optional(),
  /** When the run's approved deadline passes, in epoch milliseconds; absent without one. */
  deadlineAt: z.number().optional(),
  /** Which secondary tab the card shows under the trace; the steps tail by default. */
  facet: z.enum(["steps", "transcript", "events"]).optional(),
  /** A remote facet read, pinned to its original card, account and gateway. */
  facetRequest: z.object({
    id: z.string(),
    owner: z.string(),
    repo: z.string(),
    runId: z.string(),
    workspaceId: z.string().optional(),
    facet: z.enum(["transcript", "events"]),
    state: z.enum(["pending", "complete", "failed"]),
    follow: z.boolean().optional(),
    toggleFollow: z.boolean().optional(),
    error: z.string().optional()
  }).optional(),
  /** Whether the transcript keeps following the live run. */
  follow: z.boolean().optional(),
  /** The transcript tab's rows, merged from the transcript projection while the card follows. */
  transcriptAtRevision: z.number().int().nonnegative().optional(),
  transcriptRows: z
    .array(
      z.object({
        sequence: z.number(),
        turn: z.number().optional(),
        at: z.number().optional(),
        kind: z.string(),
        text: z.string()
      })
    )
    .optional(),
  /**
   * The run's journal: its control events in journal order, as the
   * `run-events` projection serves them. The trace folds from these
   * (RunTrace.ts) and the verbose events tab lists them raw.
   */
  events: z.array(z.record(z.string(), z.unknown())).optional(),
  /** The selected trace node (a span id from the fold); absent selects the newest frame while live tail holds, else the run. */
  selection: z.string().optional(),
  /** The scrub cursor, a journal sequence: the trace renders the journal up to it. Absent renders the whole journal. */
  cursorSeq: z.number().int().nonnegative().optional(),
  /** The tree's active filter (factory spec 06 §2, §3); `all` when absent. */
  filter: z.preprocess(
    value => value === "forks" ? "all" : value,
    z.enum(["all", "running", "failed", "model", "flow", "messages"])
  ).optional(),
  /** Whether the trace follows the newest frame (factory spec 06 §2); true when absent. A select turns it off. */
  liveTail: z.boolean().optional(),
  /**
   * Progressive inspection uses one card: a cheap turn list by default,
   * the full timeline, the run's graph, its steps or its DevTools on demand.
   */
  traceView: z.enum(["turns", "timeline", "graph", "steps", "devtools"]).optional(),
  /**
   * The plan the launch was approved on, snapshotted when the run started.
   *
   * The graph view draws these nodes and folds the engine's own node
   * records onto them (FlowGraphStatus.ts). It is absent for a run this
   * client did not launch, and the graph then draws the nodes the engine
   * recorded instead.
   */
  plan: z.object({
    planId: z.string(),
    digest: z.string(),
    nodes: z.array(PlanCardNodeSchema),
    /**
     * The labelled edges and declaration sites the same answer carried.
     * Without them a graph drawn before the first event has only
     * `dependsOn`, and an unlabelled edge is what it draws.
     */
    graph: PlanCardGraphSchema.optional()
  }).optional(),
  /**
   * The graph view's own reader state: `follow` keeps the camera on the
   * running node, and `node` with `tab` is the drawer a reader opened.
   */
  graph: z.object({
    follow: z.boolean().optional(),
    /** The run-forest execution a reader opened; absent draws the run's own (cards/RunForest.ts). */
    execution: z.string().optional(),
    ...GraphDrawerSchema.shape
  }).optional(),
  /** A person is driving the run from its box's terminal session (runs.takeover); Release clears it. */
  takeover: z.object({ terminalSessionId: z.string() }).optional(),
  /** The predicted Change inspected within the recorded coding plan. */
  codingChangeId: z.string().optional(),
  /** An issue-sweep run's board: the one state it narrows to, and the issue whose detail is open. */
  burndown: z.object({
    filter: z.enum(["skip", "ours", "claimed", "working", "adopting", "landing", "landed", "held", "failed"])
      .optional(),
    item: z.number().int().nonnegative().optional()
  }).optional(),
  /**
   * The card's last `runs.signal`: `pending` while the workspace has not
   * answered, `failed` with its refusal, `sent` once accepted. `afterSeq`
   * is the journal sequence the card had read when it asked, so a wait
   * scheduled later is a new wait the signal did not answer.
   */
  signalRequest: z.object({
    name: z.string(),
    state: z.enum(["pending", "failed", "sent"]),
    afterSeq: z.number().int().nonnegative(),
    error: z.string().optional()
  }).optional(),
  /** Local launch intent, retained until the authoring run's real receipt arrives. */
  authoring: z.object({
    requestId: z.string(),
    owner: z.string(),
    launchError: z.string().optional()
  }).optional()
})
