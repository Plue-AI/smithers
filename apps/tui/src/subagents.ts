/**
 * Workers as subagent cards: the adapter from a tab and its transcript into
 * `@smthrs/rpc/SubagentCard`, the batches a parent transcript shows as card
 * grids at the call that delegated them, the `◉ title finished` rows, and
 * how arrows move between cards. Every glyph, string and layout number comes
 * from `SubagentCard`; nothing here draws.
 */
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import * as WorkerControls from "@smthrs/rpc/WorkerControls"
import type { Model } from "./models.ts"
import { tabTitle } from "./surfaces.ts"
import * as Tabs from "./tabs.ts"
import * as Timeline from "./timeline.ts"
import * as Transcript from "./transcript.ts"
import * as Tree from "./tree.ts"
import type { Tab } from "./workspace.ts"

const states = { running: "pending", ok: "done", failed: "error" } as const

const sum = (counts: ReadonlyArray<{ readonly added: number; readonly removed: number }>) =>
  counts.reduce((total, each) => ({ added: total.added + each.added, removed: total.removed + each.removed }), {
    added: 0,
    removed: 0
  })

/** A flow call as a card's tool row. */
export const entry = (call: Transcript.Call): SubagentCard.Entry => {
  const lines = call.patches !== undefined && call.patches.length > 0
    ? sum(call.patches.map((each) => SubagentCard.diffCounts(each.patch)))
    : call.change !== undefined && call.status !== "failed"
    ? SubagentCard.diffCounts(Transcript.unified(call.change))
    : undefined
  return {
    kind: "tool",
    tool: call.flow,
    state: states[call.status],
    target: call.subject,
    ...(call.verb === undefined ? {} : { verb: { pending: call.verb.pending, done: call.verb.success } }),
    ...(lines === undefined ? {} : { added: lines.added, removed: lines.removed })
  }
}

/** A worker tab and its transcript as the shared card model. */
export const subagent = (
  tab: Tab,
  transcript: Transcript.Transcript,
  models: ReadonlyArray<Model>
): SubagentCard.Subagent => {
  const cells = transcript.items.filter((item) => item.kind === "cell")
  return {
    title: tabTitle(tab),
    status: tab.status,
    model: Tabs.seatName(tab, models),
    startedAt: tab.startedAt,
    ...(tab.endedAt === undefined ? {} : { endedAt: tab.endedAt }),
    entries: cells.flatMap((cell): Array<SubagentCard.Entry> => [
      ...(cell.prose.trim() === "" ? [] : [{ kind: "text" as const, text: cell.prose }]),
      ...cell.calls.map(entry)
    ]),
    files: cells.flatMap((cell) =>
      cell.calls.flatMap((call) =>
        call.undone === true
          ? []
          : (call.patches ?? []).map((each) => ({ path: each.path, ...SubagentCard.diffCounts(each.patch) }))
      )
    )
  }
}

/** Workers one parent requested between the same two rows of its transcript. */
export interface Batch {
  readonly key: string
  /** The parent transcript item the grid follows: the cell that delegated, else the item before the request. */
  readonly anchor: string | undefined
  /** When the first worker was requested. */
  readonly at: number
  readonly tabs: ReadonlyArray<Tab>
}

/**
 * The children of `parent` (the chat when undefined) grouped by where they were
 * requested. A child whose title matches an `agent.delegate` call follows that
 * call's cell; any other child follows the last item before its request.
 */
export const batches = (
  transcript: Transcript.Transcript,
  tabs: ReadonlyArray<Tab>,
  parent?: string
): ReadonlyArray<Batch> => {
  const children = tabs.filter((tab) => tab.parent === parent)
  const anchors = new Map<string, string | undefined>()
  for (const item of transcript.items) {
    if (item.kind !== "cell") continue
    for (const call of item.calls) {
      if (call.flow !== "agent.delegate") continue
      const child = children.find((tab) =>
        !anchors.has(tab.id) && tab.title === call.subject && tab.startedAt >= call.startedAt
      )
      if (child !== undefined) anchors.set(child.id, item.id)
    }
  }
  const rows = Timeline.rows(transcript)
  const groups = new Map<string, Array<Tab>>()
  for (const tab of children) {
    const anchor = anchors.get(tab.id) ?? rows.findLast((row) => row.at <= tab.startedAt)?.item.id
    const key = anchor ?? ""
    groups.set(key, [...groups.get(key) ?? [], tab])
  }
  return [...groups].map(([anchor, members]) => ({
    key: `batch:${members[0]!.id}`,
    anchor: anchor === "" ? undefined : anchor,
    at: Math.min(...members.map((tab) => tab.startedAt)),
    tabs: members
  }))
}

/** What a transcript view draws, in order: its own rows, card grids and finished rows. */
export type Line =
  | { readonly kind: "row"; readonly key: string; readonly row: Timeline.Row }
  | { readonly kind: "grid"; readonly key: string; readonly batch: Batch }
  | { readonly kind: "finished"; readonly key: string; readonly tab: Tab }

/**
 * `rows` with each batch's grid after its anchor row (or the last row before
 * it when the anchor is filtered out), and a `◉ title finished` row where
 * each settled worker ended, never above its own grid.
 */
export const lines = (rows: ReadonlyArray<Timeline.Row>, groups: ReadonlyArray<Batch>): ReadonlyArray<Line> => {
  const before = (at: number) => rows.findLastIndex((row) => row.at <= at)
  const slots = new Map<number, Array<Line>>()
  const place = (slot: number, line: Line) => slots.set(slot, [...slots.get(slot) ?? [], line])
  const finished: Array<{ readonly slot: number; readonly at: number; readonly line: Line }> = []
  for (const batch of groups) {
    const anchored = batch.anchor === undefined ? -1 : rows.findIndex((row) => row.item.id === batch.anchor)
    const slot = anchored >= 0 ? anchored : before(batch.at)
    place(slot, { kind: "grid", key: batch.key, batch })
    for (const tab of batch.tabs) {
      if (WorkerControls.live(tab.status) || tab.endedAt === undefined) continue
      finished.push({
        slot: Math.max(slot, before(tab.endedAt)),
        at: tab.endedAt,
        line: { kind: "finished", key: `finished:${tab.id}`, tab }
      })
    }
  }
  for (const each of finished.toSorted((a, b) => a.at - b.at)) place(each.slot, each.line)
  return [
    ...slots.get(-1) ?? [],
    ...rows.flatMap((row, index): Array<Line> => [
      { kind: "row", key: row.key, row },
      ...slots.get(index) ?? []
    ])
  ]
}

/** A card's focus key in a transcript view. */
export const cardKey = (id: string): string => `agent:${id}`

export type Direction = "up" | "down" | "left" | "right" | "next" | "previous"

/**
 * The card a key moves focus to. `order` is every focusable card in the view,
 * top to bottom; `grids` are the subagent grids' card keys. Up and down move
 * between a grid's rows by column, then leave the grid; the rest step in order.
 */
export const move = (
  order: ReadonlyArray<string>,
  grids: ReadonlyArray<ReadonlyArray<string>>,
  width: number,
  focused: string,
  direction: Direction
): string => {
  const step = (from: string, by: number) => order[(order.indexOf(from) + by + order.length) % order.length]!
  const grid = grids.find((keys) => keys.includes(focused))
  if (grid === undefined || (direction !== "up" && direction !== "down")) {
    return step(focused, direction === "up" || direction === "left" || direction === "previous" ? -1 : 1)
  }
  const layout = SubagentCard.grid(width, grid.length)
  const cell = layout.flat().find((each) => each.index === grid.indexOf(focused))!
  const target = layout[cell.row + (direction === "up" ? -1 : 1)]
  if (target === undefined) return direction === "up" ? step(grid[0]!, -1) : step(grid.at(-1)!, 1)
  const nearest = target.reduce((best, each) => Math.abs(each.x - cell.x) < Math.abs(best.x - cell.x) ? each : best)
  return grid[nearest.index]!
}

/**
 * A proof-of-concept lane: a child worker running the agent `poc` (or `…/poc`). It answers
 * questions and never lands.
 */
export const isPoc = (tab: Pick<Tab, "agent">): boolean => tab.agent !== undefined && /(^|\/)poc$/i.test(tab.agent.name)

/**
 * The superexpert split: a worker with a POC lane among its children, as two
 * lanes of cards. `undefined` for any other worker.
 */
export const lanes = (
  tabs: ReadonlyArray<Tab>,
  id: string
): { readonly implement: ReadonlyArray<Tab>; readonly poc: ReadonlyArray<Tab> } | undefined => {
  const branch = Tree.branch(tabs, id)
  const pocRoots = tabs.filter((tab) => tab.parent === id && isPoc(tab))
  if (pocRoots.length === 0) return undefined
  const poc = new Set(pocRoots.flatMap((root) => Tree.branch(tabs, root.id)).map((tab) => tab.id))
  return { implement: branch.filter((tab) => !poc.has(tab.id)), poc: branch.filter((tab) => poc.has(tab.id)) }
}
