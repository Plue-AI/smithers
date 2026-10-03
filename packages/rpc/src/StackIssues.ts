/**
 * The History card as the factory's issue list: every item of one mythical
 * snapshot in one of three groups, and the measured numbers above them. Pure,
 * so the card, the homepage block and their tests read one projection.
 *
 * - Needs you: a person acts now. `blocked` (out of attempts) and `rejected`
 *   (its pull request closed unmerged; Retry sends it back).
 * - Working: the factory holds it. The lane states (ACTIVE_ITEM_STATES),
 *   `queued`, waiting for a lane, and `proposed`, its TODO in review (spec
 *   §4.1.0), not a person's to act on until a review asks.
 * - Done: nothing more happens on its own. `landed`, and the grey outcomes
 *   `declined` and `cancelled` (declined keeps its Retry). `skipped` never
 *   entered the factory and is omitted. Given
 *   the card's clock, only the items that moved in the last day ("Done
 *   today"); the metrics view lists every settled item.
 *
 * @since 1.0.0
 */

import type { MythicalItem, MythicalStack } from "./Mythical.ts"
import { isMythicalMisroute, isSettledItemState } from "./Mythical.ts"
import { ACTIVE_ITEM_STATES, itemStateLabel } from "./StackView.ts"

/**
 * Which group an issue is listed under.
 *
 * @category models
 * @since 1.0.0
 */
export type IssueGroupId = "needs-you" | "working" | "done"

/**
 * One group of the issue list: its label, glyph and items.
 *
 * @category models
 * @since 1.0.0
 */
export interface IssueGroup {
  readonly id: IssueGroupId
  readonly label: string
  readonly glyph: string
  readonly items: ReadonlyArray<MythicalItem>
}

const NEEDS_YOU: ReadonlySet<MythicalItem["state"]> = new Set(["blocked", "rejected"])

/**
 * The group an issue is listed under.
 *
 * @category projections
 * @since 1.0.0
 */
export const issueGroupOf = (item: MythicalItem): IssueGroupId =>
  NEEDS_YOU.has(item.state) ?
    "needs-you" :
    ACTIVE_ITEM_STATES.has(item.state) || item.state === "queued" || item.state === "proposed" || item.state === "unknown" ?
    "working" :
    "done"

const at = (iso: string | undefined): number => {
  const value = iso === undefined ? Number.NaN : Date.parse(iso)
  return Number.isNaN(value) ? 0 : value
}

const DAY_MS = 86_400_000

/**
 * Needs you oldest first (the longest wait on top); Working lanes first in
 * lane order, then the queue in snapshot order; Done newest first, and with
 * `now` only the Done items whose `updatedAt` is within the last 24 h.
 *
 * @category projections
 * @since 1.0.0
 */
export const issueGroups = (stack: MythicalStack, now?: number): ReadonlyArray<IssueGroup> => {
  const indexed = stack.items.map((item, index) => ({ item, index })).filter(({ item }) => item.state !== "skipped")
  const of = (id: IssueGroupId) => indexed.filter(({ item }) => issueGroupOf(item) === id)
  /* An item with no readable stamp (the view writes "" for a null column) stays listed rather than vanishing. */
  const today = (row: { readonly item: MythicalItem }): boolean =>
    now === undefined || Number.isNaN(Date.parse(row.item.updatedAt)) || now - at(row.item.updatedAt) <= DAY_MS
  const working = (row: { readonly item: MythicalItem }): number => row.item.state === "queued" ? 1 : 0
  return [
    {
      id: "needs-you",
      label: "Needs you",
      glyph: "◆",
      items: of("needs-you").sort((a, b) => at(a.item.updatedAt) - at(b.item.updatedAt) || a.index - b.index).map((
        { item }
      ) => item)
    },
    {
      id: "working",
      label: "Working",
      glyph: "◐",
      items: of("working").sort((a, b) =>
        working(a) - working(b) || (a.item.lane ?? 99) - (b.item.lane ?? 99) || a.index - b.index
      )
        .map(({ item }) => item)
    },
    {
      id: "done",
      label: "Done",
      glyph: "●",
      items: of("done").filter(today).sort((a, b) => at(b.item.updatedAt) - at(a.item.updatedAt) || a.index - b.index)
        .map(({ item }) => item)
    }
  ]
}

/**
 * The one word a Needs-you row wears: why it stopped, else its state (`PR open`).
 *
 * @category projections
 * @since 1.0.0
 */
export const issueWord = (item: MythicalItem): string =>
  item.failure === undefined && item.state === "proposed" || item.reason === undefined || item.reason === "" ||
    (item.todo?.veryHard === true && item.state !== "running" && item.reason.startsWith("very hard"))
    ? itemStateLabel(item)
    : item.reason

const isVeryHardContinuation = (item: MythicalItem): boolean =>
  item.todo?.veryHard === true && ACTIVE_ITEM_STATES.has(item.state) && item.state !== "retrying"

/**
 * The current plan and continuation, shown only while a lane works the TODO.
 *
 * @since 1.0.0
 * @category projections
 */
export const issueProgress = (item: MythicalItem): string | undefined => {
  if (item.todo === undefined || !ACTIVE_ITEM_STATES.has(item.state)) return undefined
  const plan = `plan ${Math.min(item.todo.replans + 1, 3)} of 3`
  return isVeryHardContinuation(item) ? `${plan} · very hard` : plan
}

/**
 * How long a landed item took from the service first observing its issue
 * (`createdAt`, which can include time skipped waiting for a label) to the
 * poller seeing it on main (`updatedAt`); absent without both stamps.
 *
 * @category projections
 * @since 1.0.0
 */
export const issueToLandedMs = (item: MythicalItem): number | undefined => {
  if (item.state !== "landed" || item.createdAt === undefined) return undefined
  const start = Date.parse(item.createdAt)
  const end = Date.parse(item.updatedAt)
  return Number.isNaN(start) || Number.isNaN(end) || end < start ? undefined : end - start
}

/**
 * A compact duration: `45m`, `6h`, `3d`.
 *
 * @category projections
 * @since 1.0.0
 */
export const spanLabel = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(ms / 3_600_000)
  return hours < 48 ? `${hours}h` : `${Math.round(ms / 86_400_000)}d`
}

/**
 * The measured numbers above the issue list.
 *
 * @category models
 * @since 1.0.0
 */
export interface StackMetrics {
  readonly landed: number
  /** Items a lane worked to an outcome or the planner declined: the landed ratio's denominator. */
  readonly decided: number
  /** Stack changes of kind `revert`. */
  readonly reverts: number
  /** The median issue→landed of landed items that carry `createdAt`; absent when none does. */
  readonly p50Ms: number | undefined
  /** Landed items a person did not edit, divided by landed items, as a whole percentage. */
  readonly landedUnedited: number
  readonly landedUneditedShare: number | undefined
  /** All recorded model spend in USD nanos, divided by the landed TODO count, as dollars. */
  readonly costPerLanded: number | undefined
  readonly misroutes: number
  readonly replans: number
  /** TODOs currently in their very-hard continuation. */
  readonly veryHard: number
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

/**
 * The measured numbers of one snapshot.
 *
 * @category projections
 * @since 1.0.0
 */
export const stackMetrics = (stack: MythicalStack): StackMetrics => {
  const landed = stack.items.filter((item) => item.state === "landed")
  const costs = stack.items.flatMap((item) => item.costNanos === undefined ? [] : [item.costNanos])
  return {
    landed: landed.length,
    decided: stack.items.filter((item) => DECIDED.has(item.state)).length,
    reverts: stack.changes.filter((change) => change.kind === "revert").length,
    p50Ms: median(stack.items.flatMap((item) => {
      const ms = issueToLandedMs(item)
      return ms === undefined ? [] : [ms]
    })),
    landedUnedited: landed.filter((item) => item.humanEdited !== true).length,
    landedUneditedShare: landed.length === 0
      ? undefined
      : Math.round(100 * landed.filter((item) => item.humanEdited !== true).length / landed.length),
    costPerLanded: landed.length === 0 || costs.length === 0
      ? undefined
      : costs.reduce((sum, cost) => sum + cost, 0) / 1_000_000_000 / landed.length,
    misroutes: stack.items.filter((item) => item.route !== undefined && isMythicalMisroute(item.route)).length,
    replans: stack.items.reduce((sum, item) => sum + (item.todo?.replans ?? 0), 0),
    veryHard: stack.items.filter(isVeryHardContinuation).length
  }
}

/**
 * Short, ordered labels for the one-line metric header in both hosts.
 *
 * @since 1.0.0
 * @category projections
 */
export const stackMetricLabels = (
  metrics: StackMetrics
): ReadonlyArray<{ readonly id: string; readonly text: string }> => [
  ...(metrics.decided === 0 ? [] : [{ id: "landed", text: `${metrics.landed}/${metrics.decided} landed` }]),
  ...(metrics.landedUneditedShare === undefined
    ? []
    : [{ id: "unedited", text: `${metrics.landedUneditedShare}% landed unedited` }]),
  ...(metrics.p50Ms === undefined ? [] : [{ id: "p50", text: `${spanLabel(metrics.p50Ms)} p50` }]),
  ...(metrics.costPerLanded === undefined ? [] : [{ id: "cost", text: `$${metrics.costPerLanded.toFixed(2)}/landed` }]),
  { id: "reverts", text: `${metrics.reverts} ${metrics.reverts === 1 ? "revert" : "reverts"}` },
  { id: "misroutes", text: `${metrics.misroutes} ${metrics.misroutes === 1 ? "misroute" : "misroutes"}` },
  { id: "replans", text: `${metrics.replans} ${metrics.replans === 1 ? "replan" : "replans"}` },
  ...(metrics.veryHard === 0 ? [] : [{ id: "very-hard", text: `${metrics.veryHard} very hard` }])
]

/**
 * The settled items, newest first: the rows of the metrics table.
 *
 * @category projections
 * @since 1.0.0
 */
export const settledItems = (stack: MythicalStack): ReadonlyArray<MythicalItem> =>
  stack.items.map((item, index) => ({ item, index }))
    .filter(({ item }) => isSettledItemState(item.state) && item.state !== "skipped")
    .sort((a, b) => at(b.item.updatedAt) - at(a.item.updatedAt) || a.index - b.index)
    .map(({ item }) => item)
