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

