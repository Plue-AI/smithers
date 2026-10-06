import { z } from "zod"
import type { BranchTreeNodeCard } from "@smthrs/rpc/BranchTreeNodeCard"
import { accountOwnerOf } from "../AccountOwner"
import type { SeamContext } from "./SeamContext"
import { designBranchTree } from "./DesignWorld/shell"
import type { DesignWorld } from "./DesignWorld"

const Rows = z.array(z.object({ name: z.string().min(1), kind: z.string(), state: z.string(),
  forked_from: z.object({ ref: z.string() }).nullish(), machine: z.object({ id: z.string() }) }))

/** Read only advertised open branches; nesting follows the server's fork source. */
export function branchTree(value: unknown): BranchTreeNodeCard[] {
  const rows = Rows.parse(value).filter(row => row.state !== "closed")
  const nodes = new Map<string, BranchTreeNodeCard>()
  nodes.set("main", { id: "main", name: "main", kind: "main", present: [], children: [], action: { tag: "branch", label: "Open", args: { name: "main" } } })
  for (const row of rows) {
    if (row.name === "main") continue
    if (nodes.has(row.name)) throw new Error("Repeated branch")
    nodes.set(row.name, { id: row.name, name: row.name, kind: row.kind === "item" ? "item" : "scratch", present: [], children: [], action: { tag: "branch", label: "Open", args: { name: row.name } } })
  }
  for (const row of rows) {
    if (row.name === "main") continue
    const seen = new Set([row.name])
    let parent = row.forked_from?.ref
    while (parent && parent !== "main") {
      if (seen.has(parent)) throw new Error("Cyclic branch tree")
      seen.add(parent)
      parent = rows.find(candidate => candidate.name === parent)?.forked_from?.ref
    }
    const target = nodes.get(row.forked_from?.ref ?? "main") ?? nodes.get("main")!
    target.children.push(nodes.get(row.name)!)
  }
  return [nodes.get("main")!]
}

export function createBranchNavigationSeam(ctx: SeamContext, design: DesignWorld) {
  let pending: Promise<void> | undefined
  return {
    listBookmarks: async () => {
      const owner = accountOwnerOf(ctx.store.collections.identitySessions.get("identity")) ?? null
      const previous = ctx.store.session().branchNavigation
      await ctx.dispatch({ type: "branch.navigation.changed", actor: ctx.actor(), navigation: {
        owner, open: true, selected_branch: previous?.owner === owner ? previous.selected_branch : "main", nodes: previous?.owner === owner ? previous.nodes : []
      } }).isPersisted.promise
      if (pending) return
      const current = () => !ctx.isDisposed?.() && (accountOwnerOf(ctx.store.collections.identitySessions.get("identity")) ?? null) === owner
      const read = async () => {
        const rows: unknown[] = []
        let nodes: BranchTreeNodeCard[] | undefined
        try {
          // The branch API uses offset cursors; never follow an arbitrary Link URL.
          for (let offset = 0; offset < 10000; offset += 100) {
            const response = await ctx.http(`${ctx.baseUrl}/api/branches?limit=100&cursor=${offset}`, { credentials: "same-origin" })
            if (!response.ok) throw new Error("Branches unavailable")
            const page = Rows.parse(await response.json())
            rows.push(...page)
            if (page.length < 100) { nodes = branchTree(rows); break }
          }
          if (!nodes) throw new Error("Branches unavailable")
        } catch (error) {
          if (design.enabled === false) throw error
          nodes = designBranchTree(design.world(), "main")
        }
        if (!current()) return
        const view = ctx.store.session().branchNavigation
        if (view?.owner !== owner) return
        await ctx.dispatch({ type: "branch.navigation.changed", actor: "system", navigation: { ...view, nodes } }).isPersisted.promise
      }
      pending = (ctx.withToast ? ctx.withToast("branch-tree", "Branches", "Branches", read, true, current) : read())
        .then(() => {}).catch(error => { ctx.report?.("branches", error) }).finally(() => { pending = undefined })
    }
  }
}
