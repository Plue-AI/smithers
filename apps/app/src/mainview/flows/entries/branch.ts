/*
 * The Branch and Terminal flows (T-APP-10, T-APP-12). MOCK: each handler acts
 * on the seeded design world (state/seams/DesignWorld) until the §6.3
 * /api/branches routes and the terminal stream land; then the handlers POST
 * those routes and the card reads topic `branch:<id>`.
 */
import { Schema } from "effect"
import { TodoPlacementSchema } from "@smthrs/rpc/CardAction"
import { copyText } from "@smthrs/ui"
import type { CommandGesture } from "../CommandGesture"
import { z } from "zod"
import { flow, type CommandActions, type CommandResult } from "./Declare"
import type { FlowEntry } from "../registry"
import type { Grammar } from "../SlashPayload"
import { designBranchFor, designSshLine } from "../../state/seams/DesignWorld/branch"
import { branchSeedAvailable } from "../../state/seams/BranchSeam"

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
    flow({ name:"branch.archive", slash:"/branch.archive", cli:["branch","archive"], journey:["J7"], group:"Branches and machines", visibility:"core", actors:["person","app_agent","external_agent"], minimumRole:"member", agent:"confirm", http:{method:"POST",path:"/api/branches/{branch}/archive"}, summary:"Archive a scratch branch", args:"<branch>", hidden:true,
      grammar:field("branch"), input:BranchInput, confirm:payload=>`archive ${String(payload.branch)}`, confirmArgs:payload=>String(payload.branch),
      handler:({branch})=>actions.archiveBranch ? actions.archiveBranch(branch) : "Branch unavailable" }),
    flow({ name: "branch.fork", slash: "/branch.fork", cli: ["branch","fork"], journey: ["J7"], group: "Branches and machines", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/branches"}, summary: "Fork a scratch branch", args: "<branch>", hidden: true, discloseToAgent: true,
      grammar: field("from"), agent: "run", input: Schema.Struct({ from: Schema.NonEmptyString, name: Schema.optional(Schema.NonEmptyString) }),
      handler: async ({ from, name }) => {
        // The shared stack service captures awake sources before selecting a revision.
        if (actions.forkBranch) {
          const source = from.trim()
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
      grammar: field("branch"), agent: "confirm", input: Schema.Struct({ branch: Schema.String, text: Schema.optional(Schema.String), title: Schema.optional(Schema.NonEmptyString), acceptance: Schema.optional(Schema.Array(Schema.String)), after: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))), before: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))) }),
      // A✓ (mvp.md Appendix B): the agent asks; only the person's press commits the TODO. The confirmation carries the branch it named.
      confirm: payload => `add ${String(payload.branch)} to the stack`,
      confirmArgs: payload => payload.text === undefined && payload.after === undefined && payload.before === undefined && payload.title === undefined && payload.acceptance === undefined ? String(payload.branch) : JSON.stringify(payload),
      handler: ({ branch, text, title, acceptance, after, before }) => {
        if (!TodoPlacementSchema.safeParse({ after, before }).success) return "Choose after or before"
        if (actions.addBranchToStack) return actions.addBranchToStack({ branch, ...(title === undefined ? {} : { title }), ...(acceptance === undefined ? {} : { acceptance }), ...(text === undefined ? {} : { text }), ...(after === undefined ? {} : { after }), ...(before === undefined ? {} : { before }) })
        if (actions.design.enabled === false) return "Branch unavailable"
        const target = branchOf(branch)
        if (target === undefined) return `No branch ${branch}`
        const result = design.addToStack(target.id, design.viewer())
        return result.ok ? undefined : result.refusal
      } }),
    flow({ name: "branch.rebase",   slash: "/branch.rebase", cli: ["branch","rebase"], journey: ["J7"], group: "Branches and machines", visibility: "core", actors: ["person","app_agent","external_agent"], minimumRole: "member", http: {"method":"POST","path":"/api/branches/{branch}","defaults":{"op":"rebase"}}, summary: "Rebase this branch now", args: "<branch>", hidden: true, discloseToAgent: true,
      grammar: field("branch"), agent: "run", input: Schema.Struct({ branch: Schema.String, conflict_change: Schema.optional(Schema.NonEmptyString), onto_revision: Schema.optional(Schema.NonEmptyString) }),
      handler: ({ branch, conflict_change, onto_revision }) => {
        if (actions.branchControls) return actions.branchControls.request("rebase", branch, { conflict_change, onto_revision })
        if (conflict_change !== undefined || onto_revision !== undefined) return "Branch unavailable"
        if (actions.design.enabled === false) return "Branch unavailable"
        const target = branchOf(branch)
        if (target === undefined) return `No branch ${branch}`
        const result = design.rebaseNow(target.id, design.viewer())
        return result.ok ? undefined : result.refusal
      } }),
    flow({ name: "terminal",   slash: "/terminal", cli: null, journey: ["J3","J6"], group: "Branches and machines", visibility: "core", actors: ["person","app_agent"], minimumRole: "member", http: { method: "POST", path: "/api/terminals" }, summary: "Open a terminal on a branch", args: "<branch>", hidden: true, discloseToAgent: true,
      grammar: field("branch"), agent: "run", input: Schema.Union([
        Schema.Struct({ branch: Schema.String, operation: Schema.optional(Schema.Never), id: Schema.optional(Schema.Never), command: Schema.optional(Schema.Never) }),
        Schema.Struct({ branch: Schema.optional(Schema.Never), operation: Schema.Literal("command"), id: Schema.String, command: Schema.String })
      ]),
      handler: async ({ branch, operation, id, command }) => {
        if (operation === "command") return actions.writeTerminal({ id, command })

        if (actions.openBranchTerminal) return actions.openBranchTerminal(branch)
        if (actions.bootstrap?.capabilities.includes("install") || (!actions.bootstrap && actions.live)) return "Terminal unavailable"
        const target = branchOf(branch)
        if (target === undefined) return `No branch ${branch}`
        const result = design.newTerminal(target.id, design.viewer())
        if (!result.ok) return result.refusal
        return result.id === undefined ? undefined : openTerminal(result.id)
      } }),
    flow({ name: "terminal.watch", agent: "never", actors: ["person"], minimumRole: "member", visibility: "in-card", summary: "Watch a terminal", args: "<terminal>", hidden: true,
      grammar: field("id"), input: Schema.Struct({ id: Schema.String }),
      handler: async ({ id }) => {
        if (actions.terminalCards?.available() && actions.terminalCards.branch(id)) {
          await actions.presentBranchCard("terminal", id, "Terminal")
          return
        }
        if (actions.bootstrap?.capabilities.includes("install") || (!actions.bootstrap && actions.live)) return "Terminal unavailable"
        const terminal = design.world().terminals.find(each => each.id === id)
        if (terminal !== undefined && terminal.owner !== design.viewer()) design.watchTerminal(id, design.viewer())
        return openTerminal(id)
      } }),
    flow({ name: "ssh", agent: "never",   slash: "/ssh", cli: ["ssh"], journey: ["J3"], group: "Account and settings", visibility: "core", actors: ["person"], minimumRole: "member", http: { method: "GET", path: "/api/ssh", query: { branch: "branch" } }, summary: "Copy the SSH line for a branch", args: "<branch>", hidden: true, discloseToAgent: true,
      grammar: field("branch"), input: BranchInput,
      handler: async ({ branch }, _signal, _call, gesture?: CommandGesture) => {
        const copy = async (result: CommandResult): Promise<CommandResult> => {
          if (result && typeof result === "object" && "value" in result && (gesture?.copyText || typeof document !== "undefined")) {
            const copied = await copyText(result.value, gesture?.copyText)
            if (!copied.ok) return "Copy failed"
          }
          return result
        }
        if (actions.live || actions.bootstrap?.capabilities.includes("install")) {
          const snapshot = actions.live?.getSnapshot(`branch:${branch}`)
          const decoded = !snapshot?.error && z.object({ id: z.literal(branch), ssh_line: z.string().min(1) }).safeParse(snapshot?.data)
          if (decoded && decoded.success) return copy({ value: decoded.data.ssh_line })
          if (!snapshot?.error && actions.branchSshLine) return copy(await actions.branchSshLine(branch, _signal))
          if (actions.design.enabled === false || actions.bootstrap?.capabilities.includes("install")
            || (snapshot?.error && snapshot.error !== "unsupported" && snapshot.error !== "unknown_topic")) return "Branch unavailable"
        }
        if (actions.design.enabled === false) return "Branch unavailable"
        const target = branchOf(branch)
        return copy(target === undefined ? `No branch ${branch}` : { value: designSshLine(design.world(), target) })
      } })
  ]
}

/** The `branch` flow's card: tree rows, branch chips and `/branch <name>` open it. */
export const presentDesignBranch = async (actions: CommandActions, name: string): Promise<void> => {
  if (!branchSeedAvailable(actions)) return
  const branch = designBranchFor(actions.design.world(), name)
  if (branch !== undefined) await actions.presentBranchCard("branch", branch.id, branch.name)
}
