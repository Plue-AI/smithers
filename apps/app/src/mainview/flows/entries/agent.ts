/*
 * The `agent` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `agent` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "agent", label: "Agents", summary: "Delegate work to an agent role" }

/** The user-only reason for the bare `subagents` surface switch. */
export const SUBAGENTS_USER_ONLY_REASON = "a surface switch; every subagent already sits in the conversation as its card"

/** The bare `subagents` surface switch (ctrl+s), registered with the other top-level surfaces (#2190). */
export const subagentsSurfaceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "subagents",
    summary: "See every subagent",
    userOnly: true,
    userOnlyReason: SUBAGENTS_USER_ONLY_REASON,
    input: NoPayload,
    handler: () => actions.showSubagents()
  })
]

/** The `agent.*` flows: roles, delegation and the list. */
export const agentFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  return [
  flow({
    name: "agent.list",
    summary: "Show the agents and their runs",
    input: NoPayload,
    handler: () => actions.listAgents()
  }),
  ]
}

