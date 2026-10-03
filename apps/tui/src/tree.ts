/** Live tab hierarchy: the Summary overview's worker tree, and a root's tree as a standard panel. */
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import type * as Panels from "./panels.ts"
import * as Tabs from "./tabs.ts"
import type * as Transcript from "./transcript.ts"
import type { Tab } from "./workspace.ts"

/** A tab and how deep it sits under the walk's roots. */
export interface Node {
  readonly tab: Tab
  readonly level: number
}

/**
 * Tabs depth first, each after its parent, in request order: under `rootId`
 * (itself first), or every top-level tab and its descendants.
 */
export const walk = (tabs: ReadonlyArray<Tab>, rootId?: string): ReadonlyArray<Node> => {
  const byParent = new Map<string, Array<Tab>>()
  for (const tab of tabs) {
    const siblings = byParent.get(tab.parent ?? "") ?? []
    siblings.push(tab)
    byParent.set(tab.parent ?? "", siblings)
  }
  const nodes: Array<Node> = []
  const visit = (tab: Tab, level: number) => {
    nodes.push({ tab, level })
    for (const child of byParent.get(tab.id) ?? []) visit(child, level + 1)
  }
  const roots = rootId === undefined
    ? byParent.get("") ?? []
    : tabs.filter((tab) => tab.id === rootId)
  for (const root of roots) visit(root, 0)
  return nodes
}

/** A tab and every descendant, the tab first. */
export const branch = (tabs: ReadonlyArray<Tab>, id: string): ReadonlyArray<Tab> =>
  walk(tabs, id).map((node) => node.tab)

/** Builds a current tree from tabs and their latest captions. */
export const panel = (
  rootId: string,
  tabs: ReadonlyArray<Tab>,
  transcript: (id: string) => Transcript.Transcript,
  now = Date.now()
): Panels.Panel => {
  const root = tabs.find((tab) => tab.id === rootId)
  const rows: Array<Panels.Row> = walk(tabs, rootId).map(({ tab, level }) => {
    const children = tabs.filter((child) => child.parent === tab.id)
    const done = children.filter((child) => child.status === "done").length
    const caption = transcript(tab.id).items.filter((item) => item.kind === "cell").at(-1)
    const current = caption?.kind === "cell" ? caption.prose.replace(/\s+/g, " ").slice(0, 48) : ""
    const seat = Tabs.seatName(tab, [])
    const clock = tab.launchedAt === undefined ? "—" : SubagentCard.duration((tab.endedAt ?? now) - tab.launchedAt)
    return {
      id: `tree:${tab.id}`,
      label: `${"  ".repeat(level)}${children.length ? "▾ " : "  "}${
        SubagentCard.glyph(tab.status, now).glyph
      } ${tab.title}  ${seat}  ${clock}${current ? `  ${current}` : ""}${
        children.length ? `  ${done}/${children.length} children` : ""
      }`.slice(0, 240),
      status: tab.status,
      details: []
    }
  })
  const running = rows.filter((row) => row.status === "running" || row.status === "waiting").length
  const queued = rows.filter((row) => row.status === "queued").length
  const parked = rows.filter((row) => row.status === "parked").length
  return {
    id: `tree:${rootId}`,
    title: root?.title ?? rootId,
    summary: `${rows.length} agents · ${running} running · ${queued} queued · ${parked} parked`,
    rows
  }
}
