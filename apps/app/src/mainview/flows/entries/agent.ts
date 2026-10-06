/*
 * The `agent` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `agent` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "agent", label: "Agents", summary: "Delegate work to an agent role" }

/** The `agent.*` flows: roles, delegation and the list. */
export const agentFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  return [
  flow({ name: "agents", summary: "The factory’s agents", input: NoPayload, handler: () => actions.listAgents() }),
  flow({ name: "agent", summary: "Agent", input: Schema.Struct({ name: Schema.String }),
    grammar: args => ({ payload: args?.trim() ? { name: args.trim() } : {} }), handler: ({ name }) => actions.listAgents(name) }),
  flow({ name: "agent.open", summary: "Configure an agent", hidden: true, input: Schema.Struct({ role: Schema.String }),
    grammar: args => ({ payload: args?.trim() ? { role: args.trim() } : {} }), handler: ({ role }) => actions.listAgents(role) }),
  flow({ name: "agent.model", summary: "Change model", hidden: true, userOnly: true, userOnlyReason: "Only the owner’s browser session changes models",
    input: Schema.Struct({ role: Schema.String, model: Schema.String }),
    grammar: args => { try { return { payload: JSON.parse(args ?? "{}") } } catch { const [role, model] = (args ?? "").trim().split(/\s+/); return { payload: { ...(role ? {role}:{}), ...(model ? {model}:{}) } } } },
    form: { submitLabel: "Save", args: payload => JSON.stringify(payload) }, handler: input => actions.assignAgentModel(input.role, input.model) }),
  flow({
    name: "agent.list", hidden: true,
    summary: "Show the agents and their runs",
    input: NoPayload,
    handler: () => actions.listAgents()
  }),
  ]
}

