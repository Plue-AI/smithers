/*
 * The `runs` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { line, text } from "@smthrs/ui/flow-form"
import type { FlowEntry, Namespace } from "../registry"
import { flow, type CommandActions } from "./Declare"
import type { Grammar } from "../SlashPayload"
import { activeTraces } from "../../state/seams/DesignWorld/run"

/** The `runs` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = {
  id: "runs",
  label: "Runs",
  summary: "The runs on your workspace: open, resume, steer, stop"
}

/** `/run <id>`: a run id, a TODO id, its ref ("T9") or its number; or the JSON a card button sends. */
const runGrammar: Grammar = args => {
  const text = args?.trim() ?? ""
  if (text.startsWith("{")) {
    try { return { payload: JSON.parse(text) as Record<string, unknown> } } catch { return { error: "Enter a run" } }
  }
  return { payload: text === "" ? {} : { id: text } }
}

/** The `runs` flows registered as one aggregator block. */
export const runsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  // The doors share the install's authenticated run topic, retained preflight
  // evidence, and the design provider outside an install.
  return [
  flow({ name: "run.view", summary: "Select a run detail", args: "<cardId> [JSON view]",
    input: Schema.Struct({ cardId: Schema.String, selected: Schema.optional(Schema.String),
      at: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      tab: Schema.optional(Schema.Literals(["run", "journal", "custom"])) }),
    handler: ({ cardId, ...patch }) => actions.setRunView(cardId, patch) }),
  flow({ name: "monitor", summary: "Every run, with its debug view", slash: "/monitor", cli: ["monitor"],
    group: "Advanced", journey: ["J11"], visibility: "advanced", actors: ["person", "app_agent", "external_agent"],
    minimumRole: "member", agent: "run", http: { method: "GET", path: "/api/runs" },
    input: Schema.Struct({}), handler: () => actions.listRunMonitors() }),
  flow({ name: "runs",   slash: "/runs", cli: ["runs","list"], journey: ["J4"], group: "Runs", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"GET","path":"/api/runs"}, summary: "Active and attention-needing runs", agent: "run", input: Schema.Struct({}),
    handler: async () => {
      const traces = activeTraces(actions.design.world())
      for (const trace of traces) await actions.presentRun(trace.id, trace.title, false)
      return { value: traces.length === 0 ? "No active runs" : `${traces.length} active ${traces.length === 1 ? "run" : "runs"}` }
    } }),
  flow({ name: "run",   slash: "/run", cli: ["runs","show"], journey: ["J4"], group: "Runs", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"GET","path":"/api/runs/{id}"}, summary: "Open a run's card", args: "<id>", grammar: runGrammar,
    agent: "run", input: Schema.Struct({ id: Schema.String }), handler: ({ id }) => actions.openRunMonitor(id, false) }),
  flow({ name: "run.inspect",   slash: "/run.inspect", cli: ["run","inspect"], journey: ["J11"], group: "Advanced", visibility: "advanced", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"GET","path":"/api/runs/{id}"}, summary: "Open a run's monitor", args: "<id>", grammar: runGrammar,
    agent: "run", input: Schema.Struct({ id: Schema.String }), handler: ({ id }) => actions.openRunMonitor(id, true) }),
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
    name: "runs.continue", visibility: "in-card",
    summary: "Approve a runaway guard's request, which resumes the run",
    hidden: true,
    agent: "never" as const,
    agentReason: "approvals belong to the human",
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
    name: "runs.signal", visibility: "in-card", hidden: true, discloseToAgent: false,
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
    name: "runs.trace.filter", visibility: "in-card",
    summary: "Filter a run's trace: all, running, failed, model, flow or messages",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "[sourceCard=id] <runId> <all|running|failed|model|flow|messages>",
    input: Schema.Struct({
      sourceCard: Schema.optional(Schema.String), runId: Schema.String,
      filter: Schema.Literals(["all", "running", "failed", "model", "flow", "messages"])
    }),
    handler: ({ runId, filter, sourceCard }) => actions.traceFilter(runId, filter, sourceCard)
  }),
  flow({
    name: "runs.trace.select", visibility: "in-card",
    summary: "Select a node of a run's trace, optionally scrubbing to a journal seq",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "[sourceCard=id] <runId> <nodeId> [seq]",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, nodeId: Schema.String, seq: Schema.optional(Schema.Number) }),
    handler: ({ runId, nodeId, seq, sourceCard }) => actions.traceSelect(runId, nodeId, seq, sourceCard)
  }),
  flow({
    name: "runs.coding.select", visibility: "in-card",
    summary: "Inspect or collapse a predicted Change in a coding run",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "[sourceCard=id] <runId> <changeId>",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, changeId: Schema.String }),
    handler: ({ runId, changeId, sourceCard }) => actions.selectCodingChange(runId, changeId, sourceCard)
  }),
  flow({
    name: "runs.trace.view", visibility: "in-card",
    summary: "Show a run's turn explanations, full execution timeline, graph, step list or DevTools in its embedded card",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "[sourceCard=id] <runId> <turns|timeline|graph|steps|devtools>",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, view: Schema.Literals(["turns", "timeline", "graph", "steps", "devtools"]) }),
    handler: ({ runId, view, sourceCard }) => actions.traceView(runId, view, sourceCard)
  }),
  flow({
    /* Pan and zoom stay userOnly gestures (AGENTS.md:35); which node the camera chases is a fact on the card. */
    name: "runs.graph.follow", visibility: "in-card",
    summary: "Keep a run graph's camera on the running node, or let it be",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "[sourceCard=id] <runId> <on|off>",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, follow: Schema.Literals(["on", "off"]) }),
    handler: ({ runId, follow, sourceCard }) => actions.graphFollow(runId, follow === "on", sourceCard)
  }),
  flow({
    /* The run forest (RunForest.ts): open a child execution in place, or none to return to the run's own. */
    name: "runs.graph.execution", visibility: "in-card",
    summary: "Draw one execution of a run's forest on its graph, or the run's own",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "[sourceCard=id] <runId> [executionId]",
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, executionId: Schema.optional(Schema.String) }),
    handler: ({ runId, executionId, sourceCard }) => actions.graphExecution(runId, executionId, sourceCard)
  }),
  flow({
    name: "runs.trace.live", visibility: "in-card",
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
}
