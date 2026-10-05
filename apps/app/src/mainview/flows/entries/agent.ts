/*
 * The `agent` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"
import type { Grammar } from "../SlashPayload"

/** The `agent` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "agent", label: "Agents", summary: "Delegate work to an agent role" }

/** `/agent.codex <prompt>` takes the rest of the line; a form or confirm button sends `{"prompt": …}`. */
export const promptGrammar: Grammar = args => {
  const text = args?.trim() ?? ""
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return { payload: parsed as Record<string, unknown> }
    } catch { /* a prompt that starts with a brace */ }
  }
  return { payload: text === "" ? {} : { prompt: text } }
}

/** The agent CLIs a host may start (#3730), each behind the capability that says this host starts it. */
const launchFlows = [
  { name: "agent.codex", agent: "codex", label: "Codex", capability: "launch.codex" },
  { name: "agent.claude", agent: "claude-code", label: "Claude Code", capability: "launch.claude-code" }
] as const

/** The `agent.*` flows: roles, delegation and the list, and starting an agent CLI on the host (#3730). */
export const agentFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  return [
  flow({
    name: "agent.list",
    summary: "Show the agents and their runs",
    input: NoPayload,
    handler: () => actions.listAgents()
  }),
  ...launchFlows.map(({ name, agent, label, capability }) => flow({
    /* Launching a harness is consequential: the agent's call renders the confirm card and the person's press starts it. */
    name,
    summary: `Start ${label} on this machine and show its conversation`,
    runtime: [capability],
    args: "<prompt>",
    input: Schema.Struct({ prompt: Schema.NonEmptyString }),
    grammar: promptGrammar,
    form: { submitLabel: "Start", fields: { prompt: { label: "Prompt" } }, args: payload => JSON.stringify(payload) },
    confirm: `start ${label}`,
    confirmArgs: payload => JSON.stringify(payload),
    handler: ({ prompt }) => actions.startAgent(agent, prompt)
  })),
  ]
}
