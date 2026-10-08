/*
 * The `branches` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `branches` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "branches", label: "Branches", summary: "Repository branches" }

/** The `branches` flows registered as one aggregator block. */
export const branchesFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "branches", slash: "/branches", cli: ["branches"], journey: ["J3"], group: "Branches and machines", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", agent: "run", http: {"method":"GET","path":"/api/branches","query":{}},
    summary: "List branches with presence",
    args: "[owner/repo]",
    requires: ["signed-in"],
    grammar: args => {
      if (args?.trim().startsWith("{")) { try { return { payload: JSON.parse(args) } } catch { return { error: "Invalid branch input" } } }
      return { payload: args?.trim() ? { repo: args.trim() } : {} }
    },
    form: { fields: { operation: { hidden: true } }, args: payload => JSON.stringify(payload) },
    input: Schema.Struct({ repo: Schema.optional(Schema.String), operation: Schema.optional(Schema.Literal("workspace")) }),
    handler: ({ repo, operation }) => operation === "workspace" && !actions.bootstrap?.capabilities.includes("install") && actions.design.enabled ? actions.listWorkspaces(repo) : actions.listBookmarks()
  })
]
