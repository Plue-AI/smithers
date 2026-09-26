/** Live tab hierarchy projected into the standard panel model. */
import type * as Panels from "./panels.ts"
import type * as Transcript from "./transcript.ts"
import type { Tab } from "./workspace.ts"

const glyph: Record<string, string> = {
  requested: "○",
  queued: "○",
  running: "●",
  waiting: "●",
  parked: "⏸",
  done: "✓",
  failed: "✗",
  cancelled: "✗"
}
const elapsed = (tab: Tab, now: number): string =>
  tab.launchedAt === undefined ?
    "—" :
    `${Math.max(0, Math.floor(((tab.endedAt ?? now) - tab.launchedAt) / 60_000))}m`
/** Builds a current tree from tabs and their latest captions. */
export const panel = (
  rootId: string,
  tabs: ReadonlyArray<Tab>,
  transcript: (id: string) => Transcript.Transcript,
  now = Date.now()
): Panels.Panel => {
  const byParent = new Map<string, Array<Tab>>()
  for (const tab of tabs) {
    const siblings = byParent.get(tab.parent ?? "") ?? []
    siblings.push(tab)
    byParent.set(tab.parent ?? "", siblings)
  }
  const root = tabs.find((tab) => tab.id === rootId)
  const rows: Array<Panels.Row> = []
  const visit = (tab: Tab, level: number) => {
    const children = byParent.get(tab.id) ?? []
    const done = children.filter((child) => child.status === "done").length
    const caption = transcript(tab.id).items.filter((item) => item.kind === "cell").at(-1)
    const current = caption?.kind === "cell" ? caption.prose.replace(/\s+/g, " ").slice(0, 48) : ""
    const seat = (tab.activeSeat ?? tab.seat).split(":").at(-1) ?? tab.seat
    rows.push({
      id: `tree:${tab.id}`,
      label: `${"  ".repeat(level)}${children.length ? "▾ " : "  "}${glyph[tab.status] ?? "○"} ${tab.title}  ${seat}  ${
        elapsed(tab, now)
      }${current ? `  ${current}` : ""}${children.length ? `  ${done}/${children.length} children` : ""}`.slice(0, 240),
      status: tab.status,
      details: []
    })
    for (const child of children) visit(child, level + 1)
  }
  if (root !== undefined) visit(root, 0)
  const descendants = rows.length
  const running = rows.filter((row) => row.status === "running" || row.status === "waiting").length
  const queued = rows.filter((row) => row.status === "queued").length
  const parked = rows.filter((row) => row.status === "parked").length
  return {
    id: `tree:${rootId}`,
    title: root?.title ?? rootId,
    summary: `${descendants} agents · ${running} running · ${queued} queued · ${parked} parked`,
    rows
  }
}
