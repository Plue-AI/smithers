/*
 * The Branch and Terminal flows (T-APP-10, T-APP-12). MOCK: each handler acts
 * on the seeded design world (state/seams/DesignWorld) until the §6.3
 * /api/branches routes and the terminal stream land; then the handlers POST
 * those routes and the card reads topic `branch:<id>`.
 */
import { Schema } from "effect"
import { flow, type CommandActions, type CommandResult } from "./Declare"
import type { FlowEntry } from "../registry"
import type { Grammar } from "../SlashPayload"
import { designBranchFor, designSshLine } from "../../state/seams/DesignWorld/branch"

/** `/branch.fork retry-webhooks`, or the JSON a card button sends. */
const field = (key: string): Grammar => args => {
  const text = args?.trim() ?? ""
  if (text.startsWith("{")) {
    try { return { payload: JSON.parse(text) as Record<string, unknown> } } catch { return { error: "Enter a branch" } }
  }
  return { payload: text === "" ? {} : { [key]: text } }
}

const BranchInput = Schema.Struct({ branch: Schema.String })

export const branchFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => {
  const design = actions.design
  const branchOf = (name: string) => designBranchFor(design.world(), name)
  const openBranch = async (id: string): Promise<CommandResult> => {
    const branch = design.world().branches.find(each => each.id === id)
    if (branch === undefined) return "No such branch"
    await actions.presentBranchCard("branch", branch.id, branch.name)
  }
  const openTerminal = async (id: string): Promise<CommandResult> => {
    const terminal = design.world().terminals.find(each => each.id === id)
    if (terminal === undefined) return "No such terminal"
    await actions.presentBranchCard("terminal", terminal.id, terminal.title)
  }
  return [
    flow({ name: "branch.fork", summary: "Fork a scratch branch", args: "<branch>", hidden: true, discloseToAgent: true,
      grammar: field("name"), input: Schema.Struct({ name: Schema.optional(Schema.String), branch: Schema.optional(Schema.String) }),
      handler: async ({ name, branch }) => {
        if (actions.bootstrap || actions.live) return "Branch unavailable"
        const from = branchOf(branch ?? name ?? "")
        if (from === undefined) return `No branch ${branch ?? name ?? ""}`
        const result = design.fork(from.id, design.viewer())
        if (!result.ok) return result.refusal
        return result.id === undefined ? undefined : openBranch(result.id)
      } }),
    flow({ name: "branch.add-to-stack", summary: "Add a scratch branch as a TODO", args: "<branch>", hidden: true, discloseToAgent: true,
      grammar: field("branch"), input: Schema.Struct({ branch: Schema.String, text: Schema.optional(Schema.String) }),
      // A✓ (mvp.md Appendix B): the agent asks; only the person's press commits the TODO. The confirmation carries the branch it named.
      confirm: payload => `add ${String(payload.branch)} to the stack`,
      confirmArgs: payload => payload.text === undefined ? String(payload.branch) : JSON.stringify(payload),
      handler: ({ branch }) => {
        if (actions.bootstrap || actions.live) return "Branch unavailable"
        const target = branchOf(branch)
        if (target === undefined) return `No branch ${branch}`
        const result = design.addToStack(target.id, design.viewer())
        return result.ok ? undefined : result.refusal
      } }),
    flow({ name: "branch.rebase", summary: "Rebase this branch now", args: "<branch>", hidden: true, discloseToAgent: true,
      grammar: field("branch"), input: BranchInput,
      handler: ({ branch }) => {
        if (actions.bootstrap || actions.live) return "Branch unavailable"
        const target = branchOf(branch)
        if (target === undefined) return `No branch ${branch}`
        const result = design.rebaseNow(target.id, design.viewer())
        return result.ok ? undefined : result.refusal
      } }),
    flow({ name: "terminal", summary: "Open a terminal on a branch", args: "<branch>", hidden: true, discloseToAgent: true,
      grammar: field("branch"), input: BranchInput,
      handler: async ({ branch }) => {
        if (actions.bootstrap || actions.live) return "Terminal unavailable"
        const target = branchOf(branch)
        if (target === undefined) return `No branch ${branch}`
        const result = design.newTerminal(target.id, design.viewer())
        if (!result.ok) return result.refusal
        return result.id === undefined ? undefined : openTerminal(result.id)
      } }),
    flow({ name: "terminal.watch", summary: "Watch a terminal", args: "<terminal>", hidden: true,
      grammar: field("id"), input: Schema.Struct({ id: Schema.String }),
      handler: ({ id }) => {
        if (actions.bootstrap || actions.live) return "Terminal unavailable"
        const terminal = design.world().terminals.find(each => each.id === id)
        if (terminal !== undefined && terminal.owner !== design.viewer()) design.watchTerminal(id, design.viewer())
        return openTerminal(id)
      } }),
    flow({ name: "terminal.send", summary: "Run a command in your terminal", args: "<terminal> <command>", hidden: true,
      grammar: field("id"), input: Schema.Struct({ id: Schema.String, command: Schema.String }),
      handler: ({ id, command }) => {
        if (actions.bootstrap || actions.live) return "Terminal unavailable"
        const result = design.typeTerminal(id, command, design.viewer())
        return result.ok ? undefined : result.refusal
      } }),
    flow({ name: "ssh", summary: "Copy the SSH line for a branch", args: "<branch>", hidden: true, discloseToAgent: true,
      grammar: field("branch"), input: BranchInput,
      handler: ({ branch }) => {
        if (actions.bootstrap || actions.live) return "Branch unavailable"
        const target = branchOf(branch)
        return target === undefined ? `No branch ${branch}` : { value: designSshLine(design.world(), target) }
      } })
  ]
}

/** The `branch` flow's card: tree rows, branch chips and `/branch <name>` open it. */
export const presentDesignBranch = async (actions: CommandActions, name: string): Promise<void> => {
  if (actions.bootstrap || actions.live) return
  const branch = designBranchFor(actions.design.world(), name)
  if (branch !== undefined) await actions.presentBranchCard("branch", branch.id, branch.name)
}
