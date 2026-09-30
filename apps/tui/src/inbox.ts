/**
 * The Summary overview's rows: every worker and flow run grouped as Needs you,
 * Working, Failed and Done, each row `glyph name seat clock window cache`, each
 * build target waiting for approval under Needs you, and each active monitor
 * under Working. Needs you holds only what the person can answer now: an ask
 * they hold, an approval, a build target, a flow's form, a frame waiting for
 * its driver. A node listed there, or under Failed, appears once, flat; the
 * rest keep their worker tree. A parked node waits under Working for its
 * reset. A failure a later run of the same work finished supersedes goes to
 * Done. Pure: `subagent-view.tsx` draws it and `app.tsx` moves over it.
 */
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import * as Asks from "./asks.ts"
import type * as Flows from "./flows.ts"
import { settled } from "./lifecycle.ts"
import * as Models from "./models.ts"
import type * as Monitors from "./monitors.ts"
import { tabTitle } from "./surfaces.ts"
import * as Tabs from "./tabs.ts"
import * as TargetApprovals from "./target-approvals.ts"
import type * as Transcript from "./transcript.ts"
import * as Tree from "./tree.ts"
import type { Tab } from "./workspace.ts"

export type Group = "needs" | "working" | "failed" | "done"

export const headings: Record<Group, string> = {
  needs: "Needs you",
  working: "Working",
  failed: "Failed",
  done: "Done"
}

/** The Failed heading's key: selectable, it opens and closes the group. */
export const failedKey = "group:failed"

export interface Row {
  /** Unique in the overview: the worker's tab id, `flow:<id>`, `target:<plan id>`, or `monitor:<id>`. */
  readonly key: string
  readonly group: Group
  readonly level: number
  readonly worker?: Tab
  readonly run?: Flows.Run
  /** A build target revision waiting for approval: `y` approves it, `n` denies it. */
  readonly target?: TargetApprovals.Row
  /** An active monitor: `x` stops it. */
  readonly monitor?: Pick<Monitors.Monitor, "id" | "title" | "watch" | "createdAt">
  readonly status: Tab["status"] | Flows.Run["status"]
  readonly name: string
  /** A worker's model alias; blank for a flow run and beside a park's reset. */
  readonly seat: string
  /** Elapsed, how long an ask has waited, `resets 21:43` for a park, or blank. */
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

/** `resets 21:43`: when a park's provider lets it go on. */
export const resets = (wakeAt: number): string => `resets ${at(wakeAt)}`

/** `0:12`: how long an ask has waited for the person. */
export const waited = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

/** A failed tab a later run of the same work under the same parent finished. */
export const superseded = (tab: Tab, tabs: ReadonlyArray<Tab>): boolean =>
  tab.status === "failed" &&
  tabs.some((other) =>
    other.id !== tab.id && other.status === "done" && other.parent === tab.parent && other.title === tab.title &&
    other.startedAt >= tab.startedAt
  )

/** A failed flow run a later run of the same flow with the same input, as filled, finished. */
const supersededRun = (run: Flows.Run, runs: ReadonlyArray<Flows.Run>): boolean => {
  const input = JSON.stringify(run.input)
  return runs.some((other) =>
    other.id !== run.id && other.status === "done" && other.flow === run.flow &&
    JSON.stringify(other.input) === input && other.startedAt >= run.startedAt
  )
}

export const rows = (input: {
  readonly tabs: ReadonlyArray<Tab>
  readonly runs: ReadonlyArray<Flows.Run>
  readonly transcript: (id: string) => Transcript.Transcript
  readonly contextWindow: (seat: string) => number
  readonly models: ReadonlyArray<Models.Model>
  readonly now: number
  /** Open asks; those the person holds put their asker under Needs you. */
  readonly asks?: ReadonlyArray<Asks.Ask>
  /** Build target revisions waiting for approval; each is a Needs you row. */
  readonly targets?: ReadonlyArray<TargetApprovals.Row>
  /** Only the active ones show. */
  readonly monitors?: ReadonlyArray<Pick<Monitors.Monitor, "id" | "title" | "watch" | "createdAt" | "status">>
  /** Where pending approvals come from: a tab id or `flow:<id>`; each puts its node under Needs you. */
  readonly approvals?: ReadonlyArray<string>
}): ReadonlyArray<Section> => {
  const asking = (tab: Tab) => input.asks?.find((ask) => ask.from === tab.id && ask.holder === Asks.person)
  const approving = (key: string) => input.approvals?.includes(key) === true
  const needs = (tab: Tab) =>
    asking(tab) !== undefined || approving(tab.id) || (tab.driver !== undefined && tab.status === "waiting")
  const failing = (tab: Tab) => tab.status === "failed" && !superseded(tab, input.tabs)
  /** Listed once, flat, under Needs you or Failed. */
  const flat = (tab: Tab) => needs(tab) || failing(tab)
  const worker = (tab: Tab, group: Group, level: number): Row => {
    const seat = tab.activeSeat ?? tab.seat
    const ask = asking(tab)
    const parked = tab.status === "parked" && tab.wakeAt !== undefined
    return {
      key: tab.id,
      group,
      level,
      worker: tab,
      status: tab.status,
      name: tabTitle(tab),
      seat: parked ? "" : Models.seatName(tab, input.models),
      clock: parked
        ? resets(tab.wakeAt)
        : ask !== undefined
        ? waited(input.now - ask.askedAt)
        : tab.status === "queued"
        ? ""
        : SubagentCard.duration(Tabs.elapsed(tab, input.now)),
      ...usage(input.transcript(tab.id).usage, input.contextWindow(seat)),
      ...(ask === undefined ? {} : { ask })
    }
  }
  const flow = (run: Flows.Run, group: Group): Row => ({
    key: `flow:${run.id}`,
    group,
    level: 0,
    run,
    status: run.status,
    name: run.flow,
    seat: "",
    clock: run.status === "queued" ? "" : SubagentCard.duration((run.endedAt ?? input.now) - run.startedAt)
  })
  const byId = new Map(input.tabs.map((tab) => [tab.id, tab]))
  const needing: Array<Row> = input.tabs.filter(needs).map((tab) => worker(tab, "needs", 0))
  const failed: Array<Row> = input.tabs.filter((tab) => !needs(tab) && failing(tab)).map((tab) =>
    worker(tab, "failed", 0)
  )
  // Each tree keeps its shape without the nodes listed flat: their children rise a level.
  const trees: Array<{ readonly live: boolean; readonly tabs: Array<{ tab: Tab; level: number }> }> = []
  for (const node of Tree.walk(input.tabs)) {
    if (node.level === 0) trees.push({ live: false, tabs: [] })
    const tree = trees.at(-1)!
    if (flat(node.tab)) continue
    const lifted = [...ancestors(input.tabs, node.tab)].filter((id) => flat(byId.get(id)!)).length
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
  for (const target of input.targets ?? []) {
    needing.push({
      key: `target:${target.key}`,
      group: "needs",
      level: 0,
      target,
      status: "input",
      name: TargetApprovals.label(target),
      seat: "target",
      clock: ""
    })
  }
  for (const run of input.runs) {
    if (run.status === "input" || approving(`flow:${run.id}`)) needing.push(flow(run, "needs"))
    else if (run.status === "failed" && !supersededRun(run, input.runs)) failed.push(flow(run, "failed"))
    else if (settled(run.status)) done.push(flow(run, "done"))
    else working.push(flow(run, "working"))
  }
  for (const monitor of input.monitors ?? []) {
    if (monitor.status !== "active") continue
    working.push({
      key: `monitor:${monitor.id}`,
      group: "working",
      level: 0,
      monitor: { id: monitor.id, title: monitor.title, watch: monitor.watch, createdAt: monitor.createdAt },
      status: "running",
      name: monitor.title,
      seat: "monitor",
      clock: SubagentCard.duration(Math.max(0, input.now - monitor.createdAt))
    })
  }
  return ([["needs", needing], ["working", working], ["failed", failed], ["done", done]] as const)
    .filter(([, list]) => list.length > 0)
    .map(([group, list]) => ({ group, rows: list }))
}

/** How many things the person can answer now: the Needs you rows, and approvals no row shows. */
export const count = (sections: ReadonlyArray<Section>, unlisted = 0): number =>
  (sections.find((section) => section.group === "needs")?.rows.length ?? 0) + unlisted

const ancestors = (tabs: ReadonlyArray<Tab>, tab: Tab): ReadonlySet<string> => {
  const found = new Set<string>()
  for (let parent = tab.parent; parent !== undefined && !found.has(parent);) {
    found.add(parent)
    parent = tabs.find((each) => each.id === parent)?.parent
  }
  return found
}

/** Every row a person can select, top to bottom: a closed Failed group shows only its heading. */
export const flat = (sections: ReadonlyArray<Section>, failedOpen = false): ReadonlyArray<Row> =>
  sections.flatMap((each) => each.group === "failed" && !failedOpen ? [] : each.rows)

/** The overview's selectable keys, top to bottom, the Failed heading included. */
export const keys = (sections: ReadonlyArray<Section>, failedOpen: boolean): ReadonlyArray<string> =>
  sections.flatMap((each) => [
    ...(each.group === "failed" ? [failedKey] : []),
    ...(each.group === "failed" && !failedOpen ? [] : each.rows.map((row) => row.key))
  ])

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
  if (row.monitor !== undefined) return [row.monitor.watch]
  const tab = row.worker
  if (tab === undefined) return []
  // A backup seat answering, as `fable → sol`.
  const backup = tab.activeSeat !== undefined && tab.activeSeat !== tab.seat
    ? [`${Models.labelOf(tab.seat, [])} → ${Models.labelOf(tab.activeSeat, [])}`]
    : []
  if (tab.failure !== undefined) {
    return [Tabs.outcome(tab), tab.failure.line, ...backup].filter((line) => line !== "")
  }
  if (tab.status === "parked") {
    return [
      `parked${tab.wakeAt === undefined ? "" : ` · ${resets(tab.wakeAt)}`} · ${
        tab.parks ?? 0
      }/${QuotaPolicy.defaultMaxParks}`,
      ...backup
    ]
  }
  if (tab.status === "done" && tab.answer !== undefined) return [tab.answer.replace(/\s+/g, " ").slice(0, 400)]
  const cell = transcript(tab.id).items.findLast((item) => item.kind === "cell")
  if (cell?.kind !== "cell") return []
  const call = cell.calls.at(-1)
  return [call === undefined ? cell.prose.replace(/\s+/g, " ").slice(0, 400) : `${call.flow} ${call.subject}`]
}
