import { flow, NoPayload, type CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"

/** /help: the Commands card, read from the live registry (T-UI-14). */
export const helpFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "help", summary: "List these commands", input: NoPayload, handler: async () => { await actions.presentCard("commands", "Commands") } })
]
