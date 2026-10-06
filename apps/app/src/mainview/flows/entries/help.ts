import { flow, NoPayload, type CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"

/** /help: the Commands card, read from the live registry (T-UI-14). */
export const helpFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "help", summary: "List these commands", visibility: "core", group: "chat", actors: ["person", "app_agent"], minimumRole: "member", agent: "run", input: NoPayload, handler: async () => { const result = await actions.presentCard("commands", "Commands"); return result === "Commands unavailable" ? result : undefined } })
]
