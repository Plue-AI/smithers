/*
 * The graph drill-in flows: which node a graph card has open, and which of
 * that node's tabs.
 *
 * They live in their own module so the run card's flows (entries/runs.ts) and
 * the flow namespace (entries/flow.ts) stay where they are, and they register
 * only where the flow builder does (D-038, D-050): with the flag off there is
 * no leaf, no catalog row and no act, so the app is the app it was.
 *
 * Every one is hidden: a drill-in is raised from the canvas, and the slash
 * menu lists the doors a person types, not the gestures a card wires.
 */
import { Schema } from "effect"
import { GRAPH_DRAWER_TABS } from "../../state/controller/graph"
import type { FlowEntry } from "../registry"
import { flow } from "./Declare"
import type { CommandActions } from "./Declare"

/**
 * The tab words a flow accepts.
 *
 * The list is the card schema's own (state/controller/graph.ts), so a word
 * this schema takes is a word the payload can hold: the two cannot drift.
 */
const Tab = Schema.Literals(GRAPH_DRAWER_TABS)

/** `runs.graph.select`, `runs.graph.tab`, `flow.plan.select` and `flow.plan.tab`. */
export const graphFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "runs.graph.select", visibility: "in-card",
    summary: "Open one node of a run's graph, or close the one that is open",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "[sourceCard=id] <runId> [nodeId]",
    input: Schema.Struct({
      sourceCard: Schema.optional(Schema.String),
      runId: Schema.String,
      nodeId: Schema.optional(Schema.String)
    }),
    handler: ({ runId, nodeId, sourceCard }) => actions.selectGraphNode(runId, nodeId, sourceCard)
  }),
  flow({
    name: "runs.graph.tab", visibility: "in-card",
    summary: "Show one tab of the node a run's graph has open",
    runtimeAny: ["cloud"],
    hidden: true,
    args: `[sourceCard=id] <runId> <${GRAPH_DRAWER_TABS.join("|")}>`,
    input: Schema.Struct({ sourceCard: Schema.optional(Schema.String), runId: Schema.String, tab: Tab }),
    handler: ({ runId, tab, sourceCard }) => actions.graphNodeTab(runId, tab, sourceCard)
  }),
  flow({
    name: "flow.plan.select", visibility: "in-card",
    summary: "Open one node of a plan's graph, or close the one that is open",
    runtimeAny: ["cloud"],
    hidden: true,
    args: "<cardId> [nodeId]",
    input: Schema.Struct({ cardId: Schema.String, nodeId: Schema.optional(Schema.String) }),
    handler: ({ cardId, nodeId }) => actions.selectPlanNode(cardId, nodeId)
  }),
  flow({
    name: "flow.plan.tab", visibility: "in-card",
    summary: "Show one tab of the node a plan's graph has open",
    runtimeAny: ["cloud"],
    hidden: true,
    args: `<cardId> <${GRAPH_DRAWER_TABS.join("|")}>`,
    input: Schema.Struct({ cardId: Schema.String, tab: Tab }),
    handler: ({ cardId, tab }) => actions.planNodeTab(cardId, tab)
  })
]
