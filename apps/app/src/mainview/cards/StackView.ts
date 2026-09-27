/*
 * What the History card shows, derived from one `@smthrs/rpc/Mythical`
 * snapshot: the counts row, the lanes, and the ordered stack rows. Pure, so
 * the card, the homepage block and their tests read the same projection.
 */
import type { MythicalAccount, MythicalChange, MythicalItem, MythicalLane, MythicalStack, MythicalWiki } from "@smthrs/rpc/Mythical"
import { isSettledItemState } from "@smthrs/rpc/Mythical"

/** Items a lane is working on: from launch until the pull request is open. */
export const ACTIVE_ITEM_STATES: ReadonlySet<MythicalItem["state"]> = new Set([
  "running", "delivering", "integrating", "verifying", "proposing", "waiting", "retrying"
])

/*
 * The owner's words for where an item is (#1745): one label per API state.
 * `running` covers planning and implementing (the plan is recorded only when
 * the request run finishes), `waiting` is a verified result waiting on main.
 */
export const itemStateLabel = (item: MythicalItem): string => {
  switch (item.state) {
    case "running": return "implementing"
    case "delivering": return "checking"
    case "integrating": return "rebasing"
    case "verifying": return "checking"
    case "waiting": return "ready"
    case "retrying": return item.integration?.conflict === undefined ? "retrying" : "conflict"
    case "proposed": return "PR open"
    case "skipped": return "declined"
    default: return item.state
  }
}

/** A person decides these; the retry route accepts exactly them, for issue items. */
export const retryable = (item: MythicalItem): boolean =>
  item.issue !== undefined && (item.state === "blocked" || item.state === "rejected" || item.state === "skipped")

/** `#12 Title` for an issue; a chat item is named by the stack change it made, else its id. */
export const itemTitle = (stack: MythicalStack, item: MythicalItem): string => {
  if (item.issue !== undefined) return `#${item.issue.number} ${item.issue.title}`
  return stack.changes.find((change) => change.itemId === item.id)?.title ?? item.id.slice(0, 8)
}

/** The one line under a row: why it stopped, or which paths conflicted. */
export const itemReason = (item: MythicalItem): string | undefined => {
  const paths = item.integration?.conflict?.paths ?? []
  if (item.state === "retrying" && paths.length > 0) return paths.join(", ")
  return item.reason === undefined || item.reason === "" ? undefined : item.reason
}

export interface StackCounts {
  readonly changes: number
  /** Changes main contains. */
  readonly landed: number
  readonly busy: number
  readonly maxParallel: number
  readonly queued: number
  readonly open: number
  readonly blocked: number
  readonly declined: number
}

/** Items holding a lane: the snapshot lists only lanes below maxParallel, so a lowered limit still counts them. */
const laneItems = (stack: MythicalStack): ReadonlyArray<MythicalItem> =>
  stack.items.filter((item) => item.lane !== undefined && !settled(item))

export const stackCounts = (stack: MythicalStack): StackCounts => ({
  changes: stack.changes.length,
  landed: stack.changes.filter((change) => change.state === "landed").length,
  busy: laneItems(stack).length,
  maxParallel: stack.limits.maxParallel,
  queued: stack.items.filter((item) => item.state === "queued").length,
  open: stack.items.filter((item) => item.state === "proposed").length,
  blocked: stack.items.filter((item) => item.state === "blocked" || item.state === "rejected").length,
  declined: stack.items.filter((item) => item.state === "skipped").length
})

/** One row of the ordered stack: an item not yet on the stack, or a stack change with its item. */
export type StackRow =
  | { readonly kind: "item"; readonly key: string; readonly item: MythicalItem }
  | { readonly kind: "change"; readonly key: string; readonly change: MythicalChange; readonly item: MythicalItem | undefined }

const pendingRank = (item: MythicalItem): number =>
  ACTIVE_ITEM_STATES.has(item.state) ? 0 :
  item.state === "queued" ? 1 :
  item.state === "blocked" || item.state === "rejected" ? 2 :
  3

/*
 * The stack top down: work not yet on the stack (lanes first, then the queue,
 * then what a person has to decide, then declined), above the stack's own
 * changes tip first, each change joined to the item that owns it.
 */
export const stackRows = (stack: MythicalStack): ReadonlyArray<StackRow> => {
  const items = new Map(stack.items.map((item) => [item.id, item]))
  const onStack = new Set(stack.changes.flatMap((change) => change.itemId === undefined ? [] : [change.itemId]))
  const pending = stack.items
    .filter((item) => !onStack.has(item.id) && item.state !== "landed" && item.state !== "cancelled")
    .map((item, index) => ({ item, index }))
    .sort((a, b) => pendingRank(a.item) - pendingRank(b.item) || (a.item.lane ?? 99) - (b.item.lane ?? 99) || a.index - b.index)
    .map(({ item }): StackRow => ({ kind: "item", key: `item:${item.id}`, item }))
  const changes = stack.changes.map((change, index): StackRow => ({
    kind: "change",
    key: `change:${change.changeId}:${index}`,
    change,
    item: change.itemId === undefined ? undefined : items.get(change.itemId)
  }))
  return [...pending, ...changes]
}

export interface LaneRow {
  readonly index: number
  readonly workspaceId: string | undefined
  readonly item: MythicalItem | undefined
  /** The snapshot's lane, when it lists one: its start, account and seat. */
  readonly lane: MythicalLane | undefined
}

/** The lanes with the item each is working on, including a lane above a lowered limit that still holds one. */
export const laneRows = (stack: MythicalStack): ReadonlyArray<LaneRow> => {
  const byLane = new Map(laneItems(stack).map((item) => [item.lane!, item]))
  const indexes = [...new Set([...stack.lanes.map((lane) => lane.index), ...byLane.keys()])].sort((a, b) => a - b)
  return indexes.map((index) => {
    const lane = stack.lanes.find((row) => row.index === index)
    return { index, workspaceId: lane?.workspaceId, item: byLane.get(index), lane }
  })
}

const PROVIDER_NAMES: Readonly<Record<MythicalAccount["provider"], string>> = { claude: "Claude", codex: "Codex" }

/** The account a lane's latest call used, and how many more served it: `work@example.com +1`. */
export const accountLabel = (account: MythicalAccount): string =>
  `${account.label ?? PROVIDER_NAMES[account.provider]}${account.count > 1 ? ` +${account.count - 1}` : ""}`

/** The Wiki row: its page count, the edited count when any, and the Retry reason of a failed refresh. */
export interface WikiRow {
  readonly state: MythicalWiki["state"]
  readonly pages: string
  readonly edited: string | undefined
  /** Present only while a refresh failed: the row offers Retry with this line under it. */
  readonly failure: string | undefined
}

/** The chip tone of the wiki's freshness (D-09b): current is information, failed is danger, refreshing and stale are in progress. */
export const wikiTone = (state: MythicalWiki["state"]): "info" | "danger" | "brand" => state === "current" ? "info" : state === "failed" ? "danger" : "brand"

export const wikiRow = (wiki: MythicalWiki): WikiRow => ({
  state: wiki.state,
  pages: `${wiki.pages} ${wiki.pages === 1 ? "page" : "pages"}`,
  edited: wiki.edited > 0 ? `${wiki.edited} edited` : undefined,
  failure: wiki.state === "failed" ? wiki.error ?? "" : undefined
})

/** Whether an item is out of the lanes: settled, or its pull request is open. */
export function settled(item: MythicalItem): boolean {
  return isSettledItemState(item.state) || item.state === "proposed"
}
