/*
 * The History card as the factory's issue list: every item of one mythical
 * snapshot in one of three groups, and the measured numbers above them. Pure,
 * so the card, the homepage block and their tests read one projection.
 *
 * - Needs you: a person acts now. `blocked` (out of attempts), `rejected`
 *   (its pull request closed unmerged; Retry sends it back), and `proposed`
 *   (its pull request is open and nothing merges it but a person).
 * - Working: the factory holds it. The lane states (ACTIVE_ITEM_STATES) and
 *   `queued`, waiting for a lane.
 * - Done: nothing more happens on its own. `landed`, and the grey outcomes
 *   `declined`, `skipped` and `cancelled` (declined keeps its Retry). Given
 *   the card's clock, only the items that moved in the last day ("Done
 *   today"); the metrics view lists every settled item.
 */
import type { MythicalItem, MythicalStack } from "@smthrs/rpc/Mythical"
import { isSettledItemState } from "@smthrs/rpc/Mythical"
import { ACTIVE_ITEM_STATES, itemStateLabel } from "./StackView"

export type IssueGroupId = "needs-you" | "working" | "done"

export interface IssueGroup {
  readonly id: IssueGroupId
  readonly label: string
  readonly glyph: string
  readonly items: ReadonlyArray<MythicalItem>
}

const NEEDS_YOU: ReadonlySet<MythicalItem["state"]> = new Set(["blocked", "rejected", "proposed"])

export const issueGroupOf = (item: MythicalItem): IssueGroupId =>
  NEEDS_YOU.has(item.state) ? "needs-you" :
  ACTIVE_ITEM_STATES.has(item.state) || item.state === "queued" ? "working" :
  "done"

const at = (iso: string | undefined): number => {
  const value = iso === undefined ? Number.NaN : Date.parse(iso)
  return Number.isNaN(value) ? 0 : value
}

const DAY_MS = 86_400_000

/*
 * Needs you oldest first (the longest wait on top); Working lanes first in
 * lane order, then the queue in snapshot order; Done newest first, and with
 * `now` only the Done items whose `updatedAt` is within the last 24 h.
 */
export const issueGroups = (stack: MythicalStack, now?: number): ReadonlyArray<IssueGroup> => {
  const indexed = stack.items.map((item, index) => ({ item, index }))
  const of = (id: IssueGroupId) => indexed.filter(({ item }) => issueGroupOf(item) === id)
  /* An item with no readable stamp (the view writes "" for a null column) stays listed rather than vanishing. */
  const today = (row: { readonly item: MythicalItem }): boolean =>
    now === undefined || Number.isNaN(Date.parse(row.item.updatedAt)) || now - at(row.item.updatedAt) <= DAY_MS
  const working = (row: { readonly item: MythicalItem }): number => row.item.state === "queued" ? 1 : 0
  return [
    { id: "needs-you", label: "Needs you", glyph: "◆",
      items: of("needs-you").sort((a, b) => at(a.item.updatedAt) - at(b.item.updatedAt) || a.index - b.index).map(({ item }) => item) },
    { id: "working", label: "Working", glyph: "◐",
      items: of("working").sort((a, b) => working(a) - working(b) || (a.item.lane ?? 99) - (b.item.lane ?? 99) || a.index - b.index)
        .map(({ item }) => item) },
    { id: "done", label: "Done", glyph: "●",
      items: of("done").filter(today).sort((a, b) => at(b.item.updatedAt) - at(a.item.updatedAt) || a.index - b.index).map(({ item }) => item) }
  ]
}

/** The one word a Needs-you row wears: why it stopped, else its state (`PR open`). */
export const issueWord = (item: MythicalItem): string =>
  item.state === "proposed" || item.reason === undefined || item.reason === "" ? itemStateLabel(item) : item.reason

/*
 * How long a landed item took from the service first observing its issue
 * (`createdAt`, which can include time skipped waiting for a label) to the
 * poller seeing it on main (`updatedAt`); absent without both stamps.
 */
export const issueToLandedMs = (item: MythicalItem): number | undefined => {
  if (item.state !== "landed" || item.createdAt === undefined) return undefined
  const start = Date.parse(item.createdAt)
  const end = Date.parse(item.updatedAt)
  return Number.isNaN(start) || Number.isNaN(end) || end < start ? undefined : end - start
}

/** A compact duration: `45m`, `6h`, `3d`. */
export const spanLabel = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(ms / 3_600_000)
  return hours < 48 ? `${hours}h` : `${Math.round(ms / 86_400_000)}d`
}

export interface StackMetrics {
  readonly landed: number
  /** Items a lane worked to an outcome or the planner declined: the landed ratio's denominator. */
  readonly decided: number
  /** Stack changes of kind `revert`. */
  readonly reverts: number
  /** The median issue→landed of landed items that carry `createdAt`; absent when none does. */
  readonly p50Ms: number | undefined
}

const median = (values: ReadonlyArray<number>): number | undefined => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/*
 * The outcomes that count against landed: `landed`, `rejected` and `blocked`
 * (a lane worked the item) and `declined` (the planner read it and said no).
 * `skipped` and `cancelled` never started, so counting them would charge the
 * factory for issues it was never asked to do.
 */
const DECIDED: ReadonlySet<MythicalItem["state"]> = new Set(["landed", "rejected", "blocked", "declined"])

export const stackMetrics = (stack: MythicalStack): StackMetrics => ({
  landed: stack.items.filter((item) => item.state === "landed").length,
  decided: stack.items.filter((item) => DECIDED.has(item.state)).length,
  reverts: stack.changes.filter((change) => change.kind === "revert").length,
  p50Ms: median(stack.items.flatMap((item) => {
    const ms = issueToLandedMs(item)
    return ms === undefined ? [] : [ms]
  }))
})

/** The settled items, newest first: the rows of the metrics table. */
export const settledItems = (stack: MythicalStack): ReadonlyArray<MythicalItem> =>
  stack.items.map((item, index) => ({ item, index }))
    .filter(({ item }) => isSettledItemState(item.state))
    .sort((a, b) => at(b.item.updatedAt) - at(a.item.updatedAt) || a.index - b.index)
    .map(({ item }) => item)
