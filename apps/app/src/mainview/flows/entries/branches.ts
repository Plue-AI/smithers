/*
 * The `branches` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `branches` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "branches", label: "Branches", summary: "Repository branches" }

/** The `branches` flows registered as one aggregator block. */
export const branchesFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "branches", slash: "/branches", cli: ["branches"], journey: ["J3"], group: "Branches and machines", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", agent: "run", http: {"method":"GET","path":"/api/branches"},
    summary: "List branches with presence",
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: () => actions.listBookmarks()
  })
]
