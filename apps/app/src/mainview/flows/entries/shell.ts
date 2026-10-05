/*
 * The shell's flows: the crumbs, the branch tree and a TODO card's Open
 * branch name `branch`, and a slash or the agent reach the same flow. An
 * install opens the branch it serves; off an install (MOCK) the handler moves
 * the viewer through the seeded design world (state/seams/DesignWorld/
 * shell.ts) until the per-member view topic lands (mvp.md §7.2).
 */
import { Schema } from "effect"
import { flow, type CommandActions } from "./Declare"
import type { FlowEntry } from "../registry"
import type { Grammar } from "../SlashPayload"
import { goToBranch } from "../../state/seams/DesignWorld/shell"
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
    summary: "Open a branch",
    args: "<name|T12>",
    hidden: true,
    discloseToAgent: true,
    grammar: name,
    input: Schema.Struct({ name: Schema.String }),
    handler: async ({ name: target }) => {
      // An install opens the branch it serves (GET /api/branches/{b}); a refusal is the install's message.
      if (actions.openBranch) return actions.openBranch(target)
      if (actions.bootstrap || actions.live) return "Branch unavailable"
      const result = goToBranch(actions.design, actions.design.viewer(), target)
      if (!result.ok) return result.refusal
      await presentDesignBranch(actions, target)
      return { value: result.ack }
    }
  })
]
