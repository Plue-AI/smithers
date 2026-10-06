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
  flow({ name: "agent", grammar: args => ({ payload: args?.trim() ? { name: args.trim() } : {} }), summary: "Configure an agent", args: "<name>", slash: "/agent", cli: ["agent"],
    group: "Advanced", journey: ["J11"], visibility: "advanced", actors: ["person", "app_agent", "external_agent"],
    minimumRole: "member", agent: "run", http: { method: "GET", path: "/api/agents/{name}" },
    input: Schema.Struct({ name: Schema.NonEmptyString }), handler: ({ name }) => actions.listAgents(name) }),
  flow({
    name: "agents", slash: "/agents", cli: ["agents"], journey: ["J11"], group: "Advanced", visibility: "advanced", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"GET","path":"/api/agents"},
    summary: "The factory's agents",
    agent: "run", input: NoPayload,
    handler: () => actions.listAgents()
  }),
  flow({ name: "agent.open", visibility: "in-card", agent: "run", actors: ["person","app_agent"], minimumRole: "member", summary: "Configure an agent", hidden: true, input: Schema.Struct({ role: Schema.String }),
    grammar: args => ({ payload: args?.trim() ? { role: args.trim() } : {} }), handler: ({ role }) => actions.listAgents(role) }),
  flow({ name: "agent.model", summary: "Change model", hidden: true, visibility: "in-card", agent: "never", actors: ["person"], minimumRole: "owner", agentReason: "Only the owner’s browser session changes models",
    input: Schema.Struct({ role: Schema.String, model: Schema.String }),
    grammar: args => { try { return { payload: JSON.parse(args ?? "{}") } } catch { const [role, model] = (args ?? "").trim().split(/\s+/); return { payload: { ...(role ? {role}:{}), ...(model ? {model}:{}) } } } },
    form: { submitLabel: "Save", args: payload => JSON.stringify(payload) }, handler: input => actions.assignAgentModel(input.role, input.model) }),
  ]
}

