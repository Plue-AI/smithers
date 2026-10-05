import type { CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"

// T-APP-06: no Members door until roster/revocation, authorization, conversation,
// actors, catalog, View and live providers pass their joint activation checks.
export const membersFlows = (_actions: CommandActions): ReadonlyArray<FlowEntry> => []
