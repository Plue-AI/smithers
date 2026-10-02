/*
 * The `runs` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { BURNDOWN_STATES } from "../../cards/Burndown"
import { line, text } from "@smthrs/ui/flow-form"
import type { FlowEntry, Namespace } from "../registry"
import { flow } from "./Declare"
import type { CommandActions } from "./Declare"

/** The `runs` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = {
  id: "runs",
  label: "Runs",
  summary: "The runs on your workspace: open, resume, steer, stop"
}

/** The `runs` flows registered as one aggregator block. */
export const runsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "runs.handoff",
    summary: "Prepare an editable handoff brief from a recorded run or plan; the human copies it",
    args: "[sourceCard=id] <runId>",
    input: Schema.Struct({ runId: Schema.String, sourceCard: Schema.optional(Schema.String) }),
    handler: ({ runId, sourceCard }) => actions.prepareRunHandoff(runId, sourceCard)
  }),
  flow({
    name: "runs.attention",
    summary: "Show pending approvals and parked or failed runs on this repository",
    runtime: ["cloud"],
    requires: ["signed-in"],
    args: "[sourceCard=id] [owner/repo]",
    input: Schema.Struct({ repo: Schema.optional(Schema.String), sourceCard: Schema.optional(Schema.String) }),
    handler: (payload) => actions.listRuns({ ...payload, status: "attention" })
  }),
  /*
   * Lane runs — the run lifecycle beyond launch.
   *
   * The inbox (runs.list) answers from the workspace-runs projection; every
   * act is a control procedure over the gateway seam. What the wire does not
   * carry, the flow refuses in words: `by=` names a launcher the run summary
   * does not record, so it is a refusal, never a silently dropped filter.
   */
  flow({
    name: "runs.list",
    form: {
      fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) =>
        line(
          text(payload, "status"),
          text(payload, "flow"),
          text(payload, "by") === undefined ? undefined : `by=${text(payload, "by")}`,
          text(payload, "lineage") === undefined ? undefined : `lineage=${text(payload, "lineage")}`,
          text(payload, "sourceCard") === undefined ? undefined : `sourceCard=${text(payload, "sourceCard")}`,
          text(payload, "repo")
        )
    },
    summary: "List the runs on your workspace",
    runtime: ["cloud"],
    args: "[status] [flow] [by=principal] [lineage=id] [sourceCard=id] [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      status: Schema.optional(Schema.String),
      flow: Schema.optional(Schema.String),
      lineage: Schema.optional(Schema.String),
      by: Schema.optional(Schema.String),
      sourceCard: Schema.optional(Schema.String),
      repo: Schema.optional(Schema.String)
    }),
    handler: (payload) => actions.listRuns(payload)
  }),
  flow({
    name: "runs.open",
    form: { fields: { requestId: { hidden: true } } },
    summary: "Open a run as a card that tracks it",
    runtime: ["cloud"],
    args: "[sourceCard=id] [requestId=id] <runId> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      sourceCard: Schema.optional(Schema.String), runId: Schema.String,
      repo: Schema.optional(Schema.String), requestId: Schema.optional(Schema.String)
    }),
    handler: ({ runId, repo, sourceCard, requestId }) => actions.openRun(runId, repo, sourceCard, requestId)
  }),
  flow({
    name: "runs.resume",
    confirm: "resume the run",
    summary: "Resume a parked run",
    runtime: ["cloud"],
    args: "[sourceCard=id] <runId>",
    requires: ["signed-in"],
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String }),
    handler: ({ runId, sourceCard }) => actions.resumeRun(runId, sourceCard)
  }),
  flow({
    /* Continue answers a runaway guard's park: the workspace resumes the run on the approval. */
    name: "runs.continue",
    summary: "Approve a runaway guard's request, which resumes the run",
    hidden: true,
    userOnly: true,
    userOnlyReason: "approvals belong to the human",
    runtime: ["cloud"],
    args: "[sourceCard=id] <runId> <requestId>",
    requires: ["signed-in"],
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, requestId: Schema.String }),
    handler: ({ runId, requestId, sourceCard }) => actions.continueRun(runId, requestId, sourceCard)
  }),
  flow({
    /* A relaunch is real work on the user's workspace: the launch capability. */
    name: "runs.rerun",
    confirm: "run the flow again",
    summary: "Run a run's flow again with the same input",
    runtime: ["cloud"],
    args: "[sourceCard=id] <runId>",
    requires: ["signed-in"],
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String }),
    handler: ({ runId, sourceCard }) => actions.rerunRun(runId, sourceCard)
  }),
  flow({
    name: "runs.signal",
    confirm: "release the run's wait with a signal",
    summary: "Deliver a named signal to a waiting run",
    runtime: ["cloud"],
    args: "[sourceCard=id] <runId> <name> [json]",
    requires: ["signed-in"],
    input: Schema.Struct({
      sourceCard: Schema.optional(Schema.String), runId: Schema.String,
      name: Schema.String,
      payload: Schema.optional(Schema.String)
    }),
    handler: ({ runId, name, payload, sourceCard }) => actions.signalRun(runId, name, payload, sourceCard)
  }),
  flow({
    name: "runs.steer",
    confirm: "steer the running agent",
    summary: "Send an operator message into a running run",
    runtime: ["cloud"],
    args: "[sourceCard=id] <runId> <message>",
    requires: ["signed-in"],
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, body: Schema.String }),
    handler: ({ runId, body, sourceCard }) => actions.steerRun(runId, body, sourceCard)
  }),
  flow({
    name: "runs.logs",
    summary: "Show a run's transcript on its card (--follow keeps it live)",
    runtimeAny: ["cloud"],
    args: "[sourceCard=id] <runId> [--follow]",
    requires: ["signed-in"],
    input: Schema.Struct({
      sourceCard: Schema.optional(Schema.String), runId: Schema.String,
      follow: Schema.optional(Schema.Boolean)
    }),
    handler: ({ runId, follow, sourceCard }) => actions.showRunLogs(runId, follow, sourceCard)
  }),
  flow({
    name: "runs.steps",
    summary: "Show a run's steps on its card",
    form: { fields: { runId: { label: "Run", kind: "text" } } },
    runtimeAny: ["cloud"],
    args: "[sourceCard=id] <runId>",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String }),
    handler: ({ runId, sourceCard }) => actions.showRunSteps(runId, sourceCard)
  }),
  /*
   * The run trace's own interactions (factory spec 06 §6): the filter chips
   * and the row / bar selection. Hidden from the palette but registered, so
   * the click, the keyboard and the slash door all dispatch through the
   * registry, and the state they change lives in the card payload (§5), never
   * in the component. These reads are available to the agent in the same
   * embedded card; they never maximize a surface. Each reads the journal
   * already on the card.
   */
  flow({
    name: "runs.trace.filter",
    summary: "Filter a run's trace: all, running, failed, model, flow, forks or messages",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "[sourceCard=id] <runId> <all|running|failed|model|flow|forks|messages>",
    input: Schema.Struct({
      sourceCard: Schema.optional(Schema.String), runId: Schema.String,
      filter: Schema.Literals(["all", "running", "failed", "model", "flow", "forks", "messages"])
    }),
    handler: ({ runId, filter, sourceCard }) => actions.traceFilter(runId, filter, sourceCard)
  }),
  flow({
    name: "runs.trace.select",
    summary: "Select a node of a run's trace, optionally scrubbing to a journal seq",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "[sourceCard=id] <runId> <nodeId> [seq]",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, nodeId: Schema.String, seq: Schema.optional(Schema.Number) }),
    handler: ({ runId, nodeId, seq, sourceCard }) => actions.traceSelect(runId, nodeId, seq, sourceCard)
  }),
  flow({
    name: "runs.coding.select",
    summary: "Inspect or collapse a predicted Change in a coding run",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "[sourceCard=id] <runId> <changeId>",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, changeId: Schema.String }),
    handler: ({ runId, changeId, sourceCard }) => actions.selectCodingChange(runId, changeId, sourceCard)
  }),
  flow({
    /* The issue-sweep board's own reader state (cards/BurndownCard.tsx): the same state again shows every state. */
    name: "runs.burndown.filter",
    summary: "Show one state of an issue-sweep run's board, or every state",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "[sourceCard=id] <runId> <skip|ours|claimed|working|adopting|landing|landed|held|failed>",
    input: Schema.Struct({
      sourceCard: Schema.optional(Schema.String), runId: Schema.String,
      filter: Schema.Literals(BURNDOWN_STATES)
    }),
    handler: ({ runId, filter, sourceCard }) => actions.burndownFilter(runId, filter, sourceCard)
  }),
  flow({
    name: "runs.burndown.select",
    summary: "Open or close one issue's detail on an issue-sweep run's board",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "[sourceCard=id] <runId> <issue>",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, item: Schema.Number }),
    handler: ({ runId, item, sourceCard }) => actions.burndownSelect(runId, item, sourceCard)
  }),
  flow({
    name: "runs.trace.view",
    summary: "Show a run's turn explanations, full execution timeline, graph, step list or DevTools in its embedded card",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "[sourceCard=id] <runId> <turns|timeline|graph|steps|devtools>",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, view: Schema.Literals(["turns", "timeline", "graph", "steps", "devtools"]) }),
    handler: ({ runId, view, sourceCard }) => actions.traceView(runId, view, sourceCard)
  }),
  flow({
    /* Pan and zoom stay userOnly gestures (AGENTS.md:35); which node the camera chases is a fact on the card. */
    name: "runs.graph.follow",
    summary: "Keep a run graph's camera on the running node, or let it be",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "[sourceCard=id] <runId> <on|off>",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, follow: Schema.Literals(["on", "off"]) }),
    handler: ({ runId, follow, sourceCard }) => actions.graphFollow(runId, follow === "on", sourceCard)
  }),
  flow({
    /* The run forest (RunForest.ts): open a child execution in place, or none to return to the run's own. */
    name: "runs.graph.execution",
    summary: "Draw one execution of a run's forest on its graph, or the run's own",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "[sourceCard=id] <runId> [executionId]",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, executionId: Schema.optional(Schema.String) }),
    handler: ({ runId, executionId, sourceCard }) => actions.graphExecution(runId, executionId, sourceCard)
  }),
  flow({
    /* Launching a person into a run's harness is consequential: the agent's door confirms (THE THREE-DOOR LAW). */
    name: "runs.takeover",
    summary: "Take over a run from its box's terminal, on its harness session when it has one",
    runtime: ["cloud", "cloud.terminal"],
    confirm: "take over the run in its box's terminal",
    args: "[sourceCard=id] <runId>",
    requires: ["signed-in"],
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String }),
    handler: ({ runId, sourceCard }) => actions.takeOverRun(runId, sourceCard)
  }),
  flow({
    name: "runs.release",
    summary: "Hand a taken-over run back; it carries on by itself",
    runtime: ["cloud", "cloud.terminal"],
    confirm: "exit the harness a person is driving in the box's terminal",
    args: "[sourceCard=id] <runId>",
    requires: ["signed-in"],
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String }),
    handler: ({ runId, sourceCard }) => actions.releaseRun(runId, sourceCard)
  }),
  flow({
    name: "runs.trace.live",
    summary: "Return a run's trace to its latest recorded turn",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "[sourceCard=id] <runId>",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String }),
    handler: ({ runId, sourceCard }) => actions.traceLive(runId, sourceCard)
  }),
  flow({
    /* The raw journal is a debug surface; the controller gates it on verbose. */
    name: "runs.events",
    summary: "Show a run's raw events on its card (verbose)",
    runtime: ["cloud"],
    args: "[sourceCard=id] <runId>",
    requires: ["signed-in"],
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String }),
    handler: ({ runId, sourceCard }) => actions.showRunEvents(runId, sourceCard)
  })
]
