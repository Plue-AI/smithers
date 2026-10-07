import { Data } from "effect"
import { ActorSchema } from "@smthrs/rpc/CardPrimitives"
import type { LiveTopics } from "../useTopic"
import { z } from "zod"
import type { BranchTreeNodeCard } from "@smthrs/rpc/BranchTreeNodeCard"
import { accountOwnerOf } from "../AccountOwner"
import type { SeamContext } from "./SeamContext"
import { designBranchTree } from "./DesignWorld/shell"
import type { DesignWorld } from "./DesignWorld"

export class BranchNavigationFailure extends Data.TaggedError("BranchNavigationFailure")<{ readonly sentence: "Repeated branch" | "Cyclic branch tree" | "Branches unavailable" }> {
  override get message() { return this.sentence }
}

const Rows = z.array(z.object({ name: z.string().min(1), kind: z.string(), state: z.string(),
  forked_from: z.object({ ref: z.string() }).nullish(), machine: z.object({ id: z.string() }) }))

/** Read only advertised open branches; nesting follows the server's fork source. */
export function branchTree(value: unknown): BranchTreeNodeCard[] {
  const rows = Rows.parse(value).filter(row => row.state !== "closed")
  const nodes = new Map<string, BranchTreeNodeCard>()
  nodes.set("main", { id: "main", name: "main", kind: "main", present: [], children: [], action: { tag: "branch", label: "Open", args: { name: "main" } } })
  for (const row of rows) {
    if (row.name === "main") continue
    if (nodes.has(row.name)) throw new BranchNavigationFailure({ sentence: "Repeated branch" })
    nodes.set(row.name, { id: row.name, name: row.name, kind: row.kind === "item" ? "item" : "scratch", present: [], children: [], action: { tag: "branch", label: "Open", args: { name: row.name } } })
  }
  for (const row of rows) {
    if (row.name === "main") continue
    const seen = new Set([row.name])
    let parent = row.forked_from?.ref
    while (parent && parent !== "main") {
      if (seen.has(parent)) throw new BranchNavigationFailure({ sentence: "Cyclic branch tree" })
      seen.add(parent)
      parent = rows.find(candidate => candidate.name === parent)?.forked_from?.ref
    }
    const target = nodes.get(row.forked_from?.ref ?? "main") ?? nodes.get("main")!
    target.children.push(nodes.get(row.name)!)
  }
  return [nodes.get("main")!]
}

export function createBranchNavigationSeam(ctx: SeamContext, design: DesignWorld, options?: { live?: LiveTopics; onDispose?: (dispose: () => void) => void }) {
  let pending: Promise<void> | undefined
  const watches = new Map<string, () => void>()
  const stop = () => { for (const unsubscribe of watches.values()) unsubscribe(); watches.clear() }
  const identity = options?.onDispose ? ctx.store.collections.identitySessions.subscribeChanges(() => {
    const view = ctx.store.session().branchNavigation
    if (view && view.owner !== (accountOwnerOf(ctx.store.collections.identitySessions.get("identity")) ?? null)) stop()
  }) : undefined
  options?.onDispose?.(() => { stop(); identity?.unsubscribe() })
  const Presence = z.object({ presence: z.array(z.object({ actor: ActorSchema })) })
  const observe = (rows: unknown[], owner: string | null) => {
    stop()
    for (const row of Rows.parse(rows)) {
      const topic = `branch:${row.machine.id}`
      const update = () => {
        const view = ctx.store.session().branchNavigation
        if (ctx.isDisposed?.() || view?.owner !== owner || (accountOwnerOf(ctx.store.collections.identitySessions.get("identity")) ?? null) !== owner) return
        const snapshot = options?.live?.getSnapshot(topic)
        const parsed = !snapshot?.error ? Presence.safeParse(snapshot?.data) : undefined
        const present = parsed?.success ? parsed.data.presence.map(entry => entry.actor)
          .sort((a, b) => Number(a.kind !== "person") - Number(b.kind !== "person")) : []
        const patch = (nodes: BranchTreeNodeCard[]): BranchTreeNodeCard[] => nodes.map(node => ({ ...node,
          ...(node.id === row.name ? { present } : {}), children: patch(node.children) }))
        void ctx.dispatch({ type: "branch.navigation.changed", actor: "system", navigation: { ...view, nodes: patch(view.nodes) } }).isPersisted.promise
      }
      if (options?.live) { watches.set(topic, options.live.subscribe(topic, update)); update() }
    }
  }
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
        let real = true
        let nodes: BranchTreeNodeCard[] | undefined
        try {
          // The branch API uses offset cursors; never follow an arbitrary Link URL.
          for (let offset = 0; offset < 10000; offset += 100) {
            const response = await ctx.http(`${ctx.baseUrl}/api/branches?limit=100&cursor=${offset}`, { credentials: "same-origin" })
            if (!response.ok) throw new BranchNavigationFailure({ sentence: "Branches unavailable" })
            const page = Rows.parse(await response.json())
            rows.push(...page)
            if (page.length < 100) { nodes = branchTree(rows); break }
          }
          if (!nodes) throw new BranchNavigationFailure({ sentence: "Branches unavailable" })
        } catch (error) {
          if (design.enabled === false) throw error
          real = false
          nodes = designBranchTree(design.world(), "main")
        }
        if (!current()) return
        const view = ctx.store.session().branchNavigation
        if (view?.owner !== owner) return
        await ctx.dispatch({ type: "branch.navigation.changed", actor: "system", navigation: { ...view, nodes } }).isPersisted.promise
        if (real) observe(rows, owner)
      }
      pending = (ctx.withToast ? ctx.withToast("branch-tree", "Branches", "Branches", read, true, current) : read())
        .then(() => {}).catch(error => { ctx.report?.("branches", error) }).finally(() => { pending = undefined })
    }
  }
}
