import { flow, NoPayload, type CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"

/** /help: the Commands card, read from the live registry (T-UI-14). */
export const helpFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "help",   slash: "/help", cli: null, journey: [], group: "Ask", visibility: "core", actors: ["person","app_agent"], minimumRole: "member", http: null, summary: "List these commands", agent: "run", input: NoPayload, handler: async () => { const result = await actions.presentCard("commands", "Commands"); return result === "Commands unavailable" ? result : undefined } })
]
