/*
 * MOCK SEAM, shell lane (delete with ./index.ts). The crumbs and branch tree
 * read the seeded world here; the `branch` stub flow writes where the viewer
 * is. Replaced by topic `home` (branch rows + presence) and the per-member
 * `view:<member>:<branch>` topic (mvp.md §7.2) once those land.
 */
import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import type { Actor, TodoState } from "@smthrs/rpc/CardPrimitives"
import { PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
import type { BranchTreeNodeCard } from "@smthrs/rpc/BranchTreeNodeCard"
import { memberOf, STACK, todoOf, type ActorId, type DesignBranch, type DesignWorld, type DesignWorldRows } from "./index"
import { randomUuid } from "../../../runtime/RandomUuid"

/** Where a viewer is: `main` or a branch id. Per person, never shared. */
export interface DesignShellView { readonly id: ActorId; readonly at: string }

const createShellViews = () => createCollection(localOnlyCollectionOptions<DesignShellView, ActorId>({
  id: `design-shell-${randomUuid()}`,
  getKey: row => row.id,
  initialData: []
}))
export type DesignShellViews = ReturnType<typeof createShellViews>

/* One view collection per DesignWorld instance; it dies with the instance. */
const views = new WeakMap<DesignWorld, DesignShellViews>()
export const shellViewsOf = (design: DesignWorld): DesignShellViews => {
  const existing = views.get(design)
  if (existing !== undefined) return existing
  const created = createShellViews()
  views.set(design, created)
  return created
}

/** The `branch` stub flow: go to main or a branch; a branch records presence. */
export const goToBranch = (design: DesignWorld, who: ActorId, name: string): { readonly ok: true; readonly ack: string } | { readonly ok: false; readonly refusal: string } => {
  const world = design.world()
  const branch = name === "main" ? undefined : world.branches.find(each => each.id === name || each.name === name)
    ?? world.branches.find(each => each.id === todoByRef(world, name)?.branch)
  if (name !== "main" && branch === undefined) return { ok: false, refusal: `No branch ${name}` }
  const collection = shellViewsOf(design)
  const at = branch?.id ?? "main"
  if (collection.has(who)) collection.update(who, draft => { draft.at = at })
  else collection.insert({ id: who, at })
  if (branch !== undefined) design.visit(branch.id, who)
  return { ok: true, ack: branch === undefined ? "Opened main" : `Opened ${branch.name}` }
}

const todoByRef = (world: DesignWorldRows, ref: string) => world.todos.find(each => each.ref.toLowerCase() === ref.toLowerCase())

const STATE: Record<string, TodoState> = { "needs-you": "needs_you", "in-review": "in_review" }

const lane = (index: number): 0 | 1 | 2 | 3 | 4 | 5 => Math.max(0, Math.min(5, index)) as 0 | 1 | 2 | 3 | 4 | 5

/** A design actor id as the rpc Actor the Views render. */
export const designActor = (world: DesignWorldRows, who: ActorId): Actor => {
  if (who === "outside") return { kind: "outside", color_index: 7 }
  if (who === STACK) return { kind: "agent", id: STACK, agent: "smithers", avatar_url: PlaceholderAvatarUrl, name: "Smithers", color_index: 6 }
  if (who.startsWith("agent:")) {
    const branch = world.branches.find(each => each.id === who.slice("agent:".length))
    const item = branch?.item === undefined ? undefined : todoOf(world, branch.item)
    const owner = item === undefined ? undefined : memberOf(world, item.owner)
    return {
      kind: "agent", id: who, agent: "coding", avatar_url: PlaceholderAvatarUrl, name: "Coding agent",
      ...(owner === undefined ? {} : { for_member: { login: owner.login, name: owner.name, avatar_url: PlaceholderAvatarUrl } }),
      color_index: owner === undefined ? 6 : lane(owner.lane)
    }
  }
  const [person, via] = who.split("~")
  const member = memberOf(world, person!)
  if (via !== undefined && via !== "ssh") return { kind: "agent", id: who, agent: via === "smithers" ? "smithers" : via === "claude" ? "claude-code" : via === "codex" ? "codex" : "external",
    avatar_url: PlaceholderAvatarUrl, ...(member === undefined ? {} : { for_member: { login: member.login, name: member.name, avatar_url: PlaceholderAvatarUrl } }), color_index: lane(member?.lane ?? 6) }
  return { kind: "person", login: member?.login ?? person!, name: member?.name ?? person!, avatar_url: PlaceholderAvatarUrl,
    ...(via === "ssh" ? { via: "ssh" as const } : {}), color_index: lane(member?.lane ?? 0) }
}

const refNumber = (ref: string): number | undefined => {
  const n = Number(ref.replace(/^T/i, ""))
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** The branch tree: main, its item branches in stack order, scratch branches last, forks nested. */
export const designBranchTree = (world: DesignWorldRows, at: string): BranchTreeNodeCard[] => {
  const order = (branch: DesignBranch): number => {
    const index = branch.item === undefined ? -1 : world.repo.stack.indexOf(branch.item)
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  const node = (branch: DesignBranch): BranchTreeNodeCard => {
    const item = branch.item === undefined ? undefined : todoOf(world, branch.item)
    const todo = item === undefined ? undefined : refNumber(item.ref)
    const state = item === undefined ? undefined : STATE[item.state] ?? item.state as TodoState
    return {
      id: branch.id, name: branch.name, kind: item === undefined ? "scratch" : "item",
      ...(todo === undefined ? {} : { todo }), ...(state === undefined ? {} : { state }),
      present: branch.presence.slice(0, 3).map(each => designActor(world, each.who)),
      action: { tag: "branch", label: "Open", args: { name: branch.id } },
      children: childrenOf(branch.id)
    }
  }
  const childrenOf = (parent: string): BranchTreeNodeCard[] => world.branches
    .filter(branch => branch.from === parent && (branch.machine !== "closed" || branch.id === at))
    .sort((left, right) => order(left) - order(right))
    .map(node)
  return [{ id: "main", name: "main", kind: "main", present: [], action: { tag: "branch", label: "Open", args: { name: "main" } }, children: childrenOf("main") }]
}
