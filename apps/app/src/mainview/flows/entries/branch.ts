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

/** A slash argument or the JSON a card button sends. */
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
    flow({ name: "branch.fork", slash: "/branch.fork", cli: ["branch","fork"], journey: ["J7"], group: "Branches and machines", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/branches"}, summary: "Fork a scratch branch", args: "<branch>", hidden: true, discloseToAgent: true,
      grammar: field("from"), agent: "run", input: Schema.Struct({ from: Schema.NonEmptyString, name: Schema.optional(Schema.NonEmptyString) }),
      handler: async ({ from, name }) => {
        // An install forks through the stack service: {from: "main" | "T2", name?}; a bare `/branch.fork T2` names the source.
        if (actions.forkBranch) {
          const source = from.trim()
          if (source === "") return "Fork main or a TODO such as T2"
          return actions.forkBranch({ from: source, ...(name ? { name } : {}) })
        }
        if (actions.design.enabled === false) return "Branch unavailable"
        const forked = branchOf(from)
        if (forked === undefined) return `No branch ${from}`
        const result = design.fork(forked.id, design.viewer())
        if (!result.ok) return result.refusal
        return result.id === undefined ? undefined : openBranch(result.id)
      } }),
    flow({ name: "branch.add-to-stack",   slash: "/branch.add-to-stack", cli: ["branch","add-to-stack"], journey: ["J7"], group: "Branches and machines", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/branches/{branch}/add-to-stack"}, summary: "Add a scratch branch as a TODO", args: "<branch>", hidden: true, discloseToAgent: true,
      grammar: field("branch"), agent: "confirm", input: Schema.Struct({ branch: Schema.String, text: Schema.optional(Schema.String) }),
      // A✓ (mvp.md Appendix B): the agent asks; only the person's press commits the TODO. The confirmation carries the branch it named.
      confirm: payload => `add ${String(payload.branch)} to the stack`,
      confirmArgs: payload => payload.text === undefined ? String(payload.branch) : JSON.stringify(payload),
      handler: ({ branch }) => {
        if (actions.design.enabled === false) return "Branch unavailable"
        const target = branchOf(branch)
        if (target === undefined) return `No branch ${branch}`
        const result = design.addToStack(target.id, design.viewer())
        return result.ok ? undefined : result.refusal
      } }),
    flow({ name: "branch.rebase",   slash: "/branch.rebase", cli: ["branch","rebase"], journey: ["J7"], group: "Branches and machines", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/branches/{branch}/rebase"}, summary: "Rebase this branch now", args: "<branch>", hidden: true, discloseToAgent: true,
      grammar: field("branch"), agent: "run", input: BranchInput,
      handler: ({ branch }) => {
        if (actions.design.enabled === false) return "Branch unavailable"
        const target = branchOf(branch)
        if (target === undefined) return `No branch ${branch}`
        const result = design.rebaseNow(target.id, design.viewer())
        return result.ok ? undefined : result.refusal
      } }),
    flow({ name: "terminal",   slash: "/terminal", cli: null, journey: ["J3","J6"], group: "Branches and machines", visibility: "core", actors: ["person","app_agent"], minimumRole: "member", http: null, summary: "Open a terminal on a branch", args: "<branch>", hidden: true, discloseToAgent: true,
      grammar: field("branch"), agent: "run", input: BranchInput,
      handler: async ({ branch }) => {
        if (actions.bootstrap?.capabilities.includes("install") || (!actions.bootstrap && actions.live)) return "Terminal unavailable"
        const target = branchOf(branch)
        if (target === undefined) return `No branch ${branch}`
        const result = design.newTerminal(target.id, design.viewer())
        if (!result.ok) return result.refusal
        return result.id === undefined ? undefined : openTerminal(result.id)
      } }),
    flow({ name: "terminal.watch", agent: "never", actors: ["person"], minimumRole: "member", visibility: "in-card", summary: "Watch a terminal", args: "<terminal>", hidden: true,
      grammar: field("id"), input: Schema.Struct({ id: Schema.String }),
      handler: ({ id }) => {
        if (actions.bootstrap?.capabilities.includes("install") || (!actions.bootstrap && actions.live)) return "Terminal unavailable"
        const terminal = design.world().terminals.find(each => each.id === id)
        if (terminal !== undefined && terminal.owner !== design.viewer()) design.watchTerminal(id, design.viewer())
        return openTerminal(id)
      } }),
    flow({ name: "terminal.send", summary: "Run a command in your terminal", args: "<terminal> <command>", hidden: true,
      grammar: field("id"), input: Schema.Struct({ id: Schema.String, command: Schema.String }),
      handler: ({ id, command }) => {
        if (actions.bootstrap?.capabilities.includes("install") || (!actions.bootstrap && actions.live)) return "Terminal unavailable"
        const result = design.typeTerminal(id, command, design.viewer())
        return result.ok ? undefined : result.refusal
      } }),
    flow({ name: "ssh", agent: "never",   slash: "/ssh", cli: null, journey: ["J3"], group: "Account and settings", visibility: "core", actors: ["person"], minimumRole: "member", http: null, summary: "Copy the SSH line for a branch", args: "<branch>", hidden: true, discloseToAgent: true,
      grammar: field("branch"), input: BranchInput,
      handler: ({ branch }) => {
        if (actions.design.enabled === false) return "Branch unavailable"
        const target = branchOf(branch)
        return target === undefined ? `No branch ${branch}` : { value: designSshLine(design.world(), target) }
      } })
  ]
}

/** The `branch` flow's card: tree rows, branch chips and `/branch <name>` open it. */
export const presentDesignBranch = async (actions: CommandActions, name: string): Promise<void> => {
  if (actions.design.enabled === false) return
  const branch = designBranchFor(actions.design.world(), name)
  if (branch !== undefined) await actions.presentBranchCard("branch", branch.id, branch.name)
}
