/**
 * The Summary overview's rows: every worker and flow run grouped as Needs you,
 * Working and Done, each row `glyph name seat clock window cache`. A node that
 * needs the person appears once, flat, under Needs you; the rest keep their
 * worker tree. Pure: `subagent-view.tsx` draws it and `app.tsx` moves over it.
 */
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import * as Asks from "./asks.ts"
import type * as Flows from "./flows.ts"
import { settled } from "./lifecycle.ts"
import type { Model } from "./models.ts"
import { tabTitle } from "./surfaces.ts"
import * as Tabs from "./tabs.ts"
import type * as Transcript from "./transcript.ts"
import * as Tree from "./tree.ts"
import type { Tab } from "./workspace.ts"

export type Group = "needs" | "working" | "done"

export const headings: Record<Group, string> = { needs: "Needs you", working: "Working", done: "Done" }

export interface Row {
  /** Unique in the overview: the worker's tab id, or `flow:<id>`. */
  readonly key: string
  readonly group: Group
  readonly level: number
  readonly worker?: Tab
  readonly run?: Flows.Run
  readonly status: Tab["status"] | Flows.Run["status"]
  readonly name: string
  /** The node kind: a model alias, `fn` for a flow. */
  readonly seat: string
  /** Elapsed, a park's reset time, or blank. */
  readonly clock: string
  /** Context window used, percent. */
  readonly window?: number
  /** Cache hits over input tokens, percent. */
  readonly cache?: number
  /** The worker's ask the person holds. */
  readonly ask?: Asks.Ask
}

export interface Section {
  readonly group: Group
  readonly rows: ReadonlyArray<Row>
}

/** Parked, failed, or a flow waiting for its form: the person acts now. */
export const needsYou = (status: Row["status"]): boolean =>
  status === "input" || status === "parked" || status === "failed"

/** `R / ↑` and `context / window`, from the usage the footer meter reads. */
export const usage = (
  usage: Transcript.Transcript["usage"],
  window: number
): { readonly window?: number; readonly cache?: number } => ({
  ...(usage.context > 0 && window > 0 ? { window: Math.round((usage.context / window) * 100) } : {}),
  // A provider that reports no cached tokens gets no figure, never a false 0%.
  ...(usage.cached > 0 && usage.input > 0 ? { cache: Math.round((usage.cached / usage.input) * 100) } : {})
})

const at = (ms: number): string => {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

export const rows = (input: {
  readonly tabs: ReadonlyArray<Tab>
  readonly runs: ReadonlyArray<Flows.Run>
  readonly transcript: (id: string) => Transcript.Transcript
  readonly contextWindow: (seat: string) => number
  readonly models: ReadonlyArray<Model>
  readonly now: number
  /** Open asks; those the person holds put their asker under Needs you. */
  readonly asks?: ReadonlyArray<Asks.Ask>
}): ReadonlyArray<Section> => {
  const asking = (tab: Tab) => input.asks?.find((ask) => ask.from === tab.id && ask.holder === Asks.person)
  const needs = (tab: Tab) =>
    needsYou(tab.status) || asking(tab) !== undefined || (tab.driver !== undefined && tab.status === "waiting")
  const worker = (tab: Tab, group: Group, level: number): Row => {
    const seat = tab.activeSeat ?? tab.seat
    return {
      key: tab.id,
      group,
      level,
      worker: tab,
      status: tab.status,
      name: tabTitle(tab),
      seat: tab.harness?.vendor ?? Tabs.model(seat, input.models),
      clock: tab.status === "parked" && tab.wakeAt !== undefined
        ? at(tab.wakeAt)
        : tab.status === "queued"
        ? ""
        : SubagentCard.duration(Tabs.elapsed(tab, input.now)),
      ...usage(input.transcript(tab.id).usage, input.contextWindow(seat)),
      ...(asking(tab) === undefined ? {} : { ask: asking(tab)! })
    }
  }
  const flow = (run: Flows.Run, group: Group): Row => ({
    key: `flow:${run.id}`,
    group,
    level: 0,
    run,
    status: run.status,
    name: run.flow,
    seat: "fn",
    clock: run.status === "queued" ? "" : SubagentCard.duration((run.endedAt ?? input.now) - run.startedAt)
  })
  const byId = new Map(input.tabs.map((tab) => [tab.id, tab]))
  const needing: Array<Row> = input.tabs.filter(needs).map((tab) => worker(tab, "needs", 0))
  // Each tree keeps its shape without the nodes Needs you already lists: their children rise a level.
  const trees: Array<{ readonly live: boolean; readonly tabs: Array<{ tab: Tab; level: number }> }> = []
  for (const node of Tree.walk(input.tabs)) {
    if (node.level === 0) trees.push({ live: false, tabs: [] })
    const tree = trees.at(-1)!
    if (needs(node.tab)) continue
    const lifted = [...ancestors(input.tabs, node.tab)].filter((id) => needs(byId.get(id)!)).length
    tree.tabs.push({ tab: node.tab, level: node.level - lifted })
    if (!settled(node.tab.status)) trees[trees.length - 1] = { ...tree, live: true }
  }
  const working: Array<Row> = []
  const done: Array<Row> = []
  for (const tree of trees) {
    for (const each of tree.tabs) {
      const group = tree.live ? "working" : "done"
      ;(tree.live ? working : done).push(worker(each.tab, group, each.level))
    }
  }
  for (const run of input.runs) {
    if (needsYou(run.status)) needing.push(flow(run, "needs"))
    else if (settled(run.status)) done.push(flow(run, "done"))
    else working.push(flow(run, "working"))
  }
  return ([["needs", needing], ["working", working], ["done", done]] as const)
    .filter(([, list]) => list.length > 0)
    .map(([group, list]) => ({ group, rows: list }))
}

const ancestors = (tabs: ReadonlyArray<Tab>, tab: Tab): ReadonlySet<string> => {
  const found = new Set<string>()
  for (let parent = tab.parent; parent !== undefined && !found.has(parent);) {
    found.add(parent)
    parent = tabs.find((each) => each.id === parent)?.parent
  }
  return found
}

/** Every selectable row, top to bottom. */
export const flat = (sections: ReadonlyArray<Section>): ReadonlyArray<Row> => sections.flatMap((each) => each.rows)

/** `61% 91%`: window used, then cache hit; blank when unmeasured. */
export const meter = (row: Pick<Row, "window" | "cache">): string =>
  [row.window === undefined ? "" : `${row.window}%`, row.cache === undefined ? "" : `${row.cache}%`]
    .filter((each) => each !== "").join(" ")

/** What `space` shows for a row: the pending question, a failure or park, else the last step. */
export const peek = (row: Row, transcript: (id: string) => Transcript.Transcript): ReadonlyArray<string> => {
  if (row.ask !== undefined) {
    return [
      row.ask.question,
      ...(row.ask.options === undefined ? [] : [row.ask.options.join(" · ")]),
      ...(row.ask.trail.length > 1 ? [`asked ${row.ask.trail.slice(0, -1).join(" → ")} → you`] : [])
    ]
  }
  if (row.run !== undefined) return row.run.message === undefined ? [] : [row.run.message]
  const tab = row.worker
  if (tab === undefined) return []
  if (tab.failure !== undefined) return [tab.failure.headline, tab.failure.line].filter((line) => line !== "")
  if (tab.status === "done" && tab.answer !== undefined) return [tab.answer.replace(/\s+/g, " ").slice(0, 400)]
  const cell = transcript(tab.id).items.findLast((item) => item.kind === "cell")
  if (cell?.kind !== "cell") return []
  const call = cell.calls.at(-1)
  return [call === undefined ? cell.prose.replace(/\s+/g, " ").slice(0, 400) : `${call.flow} ${call.subject}`]
}
