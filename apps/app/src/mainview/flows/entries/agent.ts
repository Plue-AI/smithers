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
export const namespace: Namespace = { id: "agent", label: "Agents", summary: "The factory’s agents" }

/** The `agent.*` flows: the factory roles and their configuration. */
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
  ]
}
