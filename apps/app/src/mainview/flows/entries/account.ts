import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

export const namespace: Namespace = { id: "account", label: "Account", summary: "Settings" }

/** Recorded account commands use the same owner-only Settings door. */
export const accountFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "account.show", summary: "Settings", hidden: true, minimumRole: "owner", actors: ["person"], agent: "never",
    agentReason: "Install status requires the owner’s person session", input: NoPayload,
    handler: async () => { await actions.presentCard("settings", "Settings"); return actions.showSettings() } })
]
