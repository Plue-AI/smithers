/** Request anchors and keyboard order for host-owned run cards. */
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import type { Run } from "./flows.ts"
import * as Timeline from "./timeline.ts"
import type * as Transcript from "./transcript.ts"
import * as Tree from "./tree.ts"
import type { Tab } from "./workspace.ts"

/** A settled worker's evidence in one line: each changed file's counts, and its last command's exit status. */
export interface Result {
  readonly files: ReadonlyArray<SubagentCard.File>
  readonly check?: { readonly command: string; readonly exit: number }
}

/**
 * A whole command on one line, as the shell read it: a line break reads as `;`
 * unless the line already continues (`&&`, `|`, `\`).
 */
export const oneLine = (command: string): string =>
  command.split("\n").map((line) => line.trim()).filter((line) => line !== "").reduce((joined, line) =>
    joined === ""
      ? line
      : joined.endsWith("\\")
      ? `${joined.slice(0, -1).trimEnd()} ${line}`
      : /(?:;|&&|\|\||\||\{|\(|\bthen|\bdo|\belse)$/.test(joined)
      ? `${joined} ${line}`
      : `${joined}; ${line}`, "")

/** A command that shows version control's state (`git diff`, `jj st`) checks nothing about the work. */
const inspects = (command: string): boolean => /^\s*(?:git|jj)\b/.test(command)

/**
 * A worker's result from its transcript: files summed per path in first-seen order, undone changes left
 * out, and its last command that checked the work.
 */
export const result = (transcript: Transcript.Transcript): Result => {
  const byPath = new Map<string, SubagentCard.File>()
  let check: Result["check"]
  for (const item of transcript.items) {
    if (item.kind !== "cell") continue
    for (const call of item.calls) {
      const command = oneLine(call.subject)
      if (call.exit !== undefined && !inspects(command)) check = { command, exit: call.exit }
      for (const patch of call.patches ?? []) {
        if (patch.undone === true) continue
        const counts = SubagentCard.diffCounts(patch.patch)
        const seen = byPath.get(patch.path)
        byPath.set(patch.path, {
          path: patch.path,
          added: (seen?.added ?? 0) + counts.added,
          removed: (seen?.removed ?? 0) + counts.removed
        })
      }
    }
  }
  return { files: [...byPath.values()], ...(check === undefined ? {} : { check }) }
}

/** Workers one parent requested between the same two rows of its transcript. */
export interface Batch {
  readonly key: string
  /** The parent transcript item the grid follows: the cell that delegated, else the item before the request. */
  readonly anchor: string | undefined
  /** When the first worker was requested. */
  readonly at: number
  readonly tabs: ReadonlyArray<Tab>
  readonly runs?: ReadonlyArray<Run>
}

/**
 * The children of `parent` (the chat when undefined) grouped by where they were
 * requested. A child whose title matches an `agent.delegate` call follows that
 * call's cell; any other child follows the last item before its request.
 */
export const batches = (
  transcript: Transcript.Transcript,
  tabs: ReadonlyArray<Tab>,
  parent?: string,
  runs: ReadonlyArray<Run> = []
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
  const batches: Array<Batch> = [...groups].map(([anchor, members]) => ({
    key: `batch:${members[0]!.id}`,
    anchor: anchor === "" ? undefined : anchor,
    at: Math.min(...members.map((tab) => tab.startedAt)),
    tabs: members
  }))
  if (parent === undefined) {
    for (const run of runs) {
      const requested = transcript.items.find((item) => item.kind === "run" && item.surface === `flow:${run.id}`)
      const call = transcript.items.findLast((item) =>
        item.kind === "cell" &&
        item.calls.some((call) =>
          call.flow === "smithers.run" && call.subject === run.flow && call.startedAt <= run.startedAt
        )
      )
      const anchor = requested?.id ?? call?.id ?? rows.findLast((row) => row.at <= run.startedAt)?.item.id
      const batch = batches.find((batch) => batch.anchor === anchor)
      if (batch === undefined) {
        batches.push({ key: `batch:flow:${run.id}`, anchor, at: run.startedAt, tabs: [], runs: [run] })
      } else batches[batches.indexOf(batch)] = { ...batch, runs: [...batch.runs ?? [], run] }
    }
  }
  return batches.toSorted((a, b) => a.at - b.at)
}

/** What a transcript view draws, in order: its own rows and run cards. */
export type Line =
  | { readonly kind: "row"; readonly key: string; readonly row: Timeline.Row }
  | { readonly kind: "grid"; readonly key: string; readonly batch: Batch }
  | { readonly kind: "earlier"; readonly key: string; readonly batches: number }

/**
 * Rows with each batch's cards after its request, rewritten in place on settle.
 */
export const earlierKey = (parent?: string): string =>
  parent === undefined ? "subagents:earlier" : `subagents:earlier:${parent}`

export const lines = (
  rows: ReadonlyArray<Timeline.Row>,
  groups: ReadonlyArray<Batch>,
  open = false,
  parent?: string
): ReadonlyArray<Line> => {
  const earlier = SubagentCard.earlierBatches(groups.toSorted((a, b) => a.at - b.at), open)
  const hidden = new Set(earlier)
  const before = (at: number) => rows.findLastIndex((row) => row.at <= at)
  const slots = new Map<number, Array<Line>>()
  const place = (slot: number, line: Line) => slots.set(slot, [...slots.get(slot) ?? [], line])
  for (const batch of groups) {
    const anchored = batch.anchor === undefined ? -1 : rows.findIndex((row) => row.item.id === batch.anchor)
    const slot = anchored >= 0 ? anchored : before(batch.at)
    if (hidden.has(batch)) {
      if (batch === earlier[0]) place(slot, { kind: "earlier", key: earlierKey(parent), batches: earlier.length })
      continue
    }
    place(slot, { kind: "grid", key: batch.key, batch })
  }
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

/** Cards move in their visible, top-to-bottom order. */
export const move = (
  order: ReadonlyArray<string>,
  focused: string,
  direction: Direction
): string => {
  const step = (from: string, by: number) => order[(order.indexOf(from) + by + order.length) % order.length]!
  return step(focused, direction === "up" || direction === "left" || direction === "previous" ? -1 : 1)
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
