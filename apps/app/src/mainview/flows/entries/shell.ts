/*
 * The shell's flows: the crumbs and the branch tree name `branch`, and a
 * slash or the agent reach the same flow. MOCK: the handler moves the viewer
 * through the seeded design world (state/seams/DesignWorld/shell.ts) until
 * the per-member view topic lands (mvp.md §7.2).
 */
import { Schema } from "effect"
import { flow, type CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"
import type { Grammar } from "../SlashPayload"
import { goToBranch, shellViewsOf } from "../../state/seams/DesignWorld/shell"
import { presentDesignBranch } from "./branch"
import { branchSeedAvailable } from "../../state/seams/BranchSeam"

const name: Grammar = args => {
  const text = args?.trim() ?? ""
  if (text.startsWith("{")) {
    try { return { payload: JSON.parse(text) as Record<string, unknown> } } catch { return { error: "Enter a branch name" } }
  }
  return { payload: { name: text === "" ? "main" : text } }
}

/** The shell flows registered as one aggregator block. */
export const shellFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "branch",
     slash: "/branch", cli: ["branch","show"], journey: ["J3"], group: "Branches and machines", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"GET","path":"/api/branches/{name}"}, summary: "Open a branch's card",
    args: "<name|T12>",
    hidden: true,
    discloseToAgent: true,
    grammar: name,
    form: { fields: { operation: { hidden: true }, snapshot: { hidden: true }, recoveryOf: { hidden: true } },
      requires: payload => payload.operation === "workspace-view" ? ["workspaceId"] : payload.operation === "workspace-open" ? undefined : ["name"],
      args: payload => JSON.stringify(payload) },
    payloadRequires: payload => payload.operation ? ["signed-in"] : [],
    agent: "run", input: Schema.Union([
      Schema.Struct({ name: Schema.String, operation: Schema.optional(Schema.Never), workspaceId: Schema.optional(Schema.Never), bookmark: Schema.optional(Schema.Never), repo: Schema.optional(Schema.Never), kind: Schema.optional(Schema.Never), snapshot: Schema.optional(Schema.Never), recoveryOf: Schema.optional(Schema.Never) }),
      Schema.Struct({ operation: Schema.Literal("workspace-view"), workspaceId: Schema.String, name: Schema.optional(Schema.Never), bookmark: Schema.optional(Schema.Never), repo: Schema.optional(Schema.Never), kind: Schema.optional(Schema.Never), snapshot: Schema.optional(Schema.Never), recoveryOf: Schema.optional(Schema.Never) }),
      Schema.Struct({ operation: Schema.Literal("workspace-open"), bookmark: Schema.optional(Schema.String), repo: Schema.optional(Schema.String), kind: Schema.optional(Schema.Literals(["container", "vm"])), snapshot: Schema.optional(Schema.String), recoveryOf: Schema.optional(Schema.String), name: Schema.optional(Schema.Never), workspaceId: Schema.optional(Schema.Never) })
    ]),
    handler: async ({ name: target, operation, workspaceId, bookmark, repo, kind, snapshot, recoveryOf }) => {
      if (operation === "workspace-view") return workspaceId === undefined || actions.live || actions.bootstrap?.capabilities.includes("install") ? "Branch unavailable" : actions.viewWorkspace(workspaceId)
      if (operation === "workspace-open") return actions.bootstrap?.capabilities.includes("install") || !actions.design.enabled ? "Branch unavailable" : actions.openWorkspace(bookmark, repo, kind, snapshot, recoveryOf)
      if (target === undefined) return "Choose a branch"
      if (actions.openBranch) return actions.openBranch(target)
      if (!branchSeedAvailable(actions)) return "Branch unavailable"
      const result = goToBranch(actions.design, actions.design.viewer(), target)
      if (!result.ok) return result.refusal
      await actions.selectConversationBranch(shellViewsOf(actions.design).get(actions.design.viewer())?.at ?? "main")
      await presentDesignBranch(actions, target)
      return { value: result.ack }
    }
  })
]
