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
    agent: "run", input: Schema.Struct({ name: Schema.String }),
    handler: async ({ name: target }) => {
      if (actions.openBranch) return actions.openBranch(target)
      if (actions.design.enabled === false) return "Branch unavailable"
      const result = goToBranch(actions.design, actions.design.viewer(), target)
      if (!result.ok) return result.refusal
      await actions.selectConversationBranch(shellViewsOf(actions.design).get(actions.design.viewer())?.at ?? "main")
      await presentDesignBranch(actions, target)
      return { value: result.ack }
    }
  })
]
