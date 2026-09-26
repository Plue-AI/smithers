import { preparedView, type ViewAction } from "../PreparedView"
/*
 * The notifications seam: GET /api/notifications/list and
 * PUT /api/notifications/mark-read. Reference: multi
 * src/smithersCloud/notifications.ts.
 */
import type { Card } from "../AppState"
import type { SeamContext } from "./SeamContext"
import { captureCloudOwner, readErrorMessage } from "./SeamContext"
import { SIGN_OUT_REFUSAL } from "./CloudSignIn"

export interface NotificationsSeam {
  readonly listNotifications: ViewAction<[]>
  readonly markNotificationsRead: () => ReturnType<ViewAction<[]>>
}

/** One page is plenty for a transcript card; the platform caps pages anyway. */
const LIST_LIMIT = 20

type NotificationItem = Extract<Card, { kind: "notifications" }>["payload"]["items"][number]

const str = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value : null

/**
 * One wire notification, in EITHER shape the product meets.
 *
 * The reference implementation read GitHub's shape — `subject.title`,
 * `repository.full_name`, `unread: boolean`. The platform this app actually
 * talks to sends `subject` as a plain string, no repository object, and
 * `status: "unread" | "read"`. Reading only the GitHub shape made `title` null
 * for every real row, so every real row dropped and the empty state was the
 * only state this seam could ever render (§19.1).
 */
const parseNotification = (value: unknown): NotificationItem | null => {
  if (value === null || typeof value !== "object") return null
  const wire = value as Record<string, unknown>
  const id = wire.id
  if (typeof id !== "string" && typeof id !== "number") return null
  const subject = wire.subject
  const title = subject !== null && typeof subject === "object"
    ? str((subject as { title?: unknown }).title)
    : (str(subject) ?? str(wire.title))
  if (title === null) return null
  const repository = wire.repository
  const repo = repository !== null && typeof repository === "object"
    ? str((repository as { full_name?: unknown }).full_name)
    : (str(repository) ?? str(wire.repo))
  return {
    id: String(id),
    title,
    repo,
    reason: str(wire.reason),
    createdAt: str(wire.updated_at) ?? str(wire.created_at),
    // `unread` defaults true when absent, so `read` is only ever explicit.
    read: wire.unread === false || wire.status === "read"
  }
}

/** The rows the platform sent, and how many of them were unreadable. */
interface ParsedList {
  readonly items: NotificationItem[]
  readonly sent: number
}

/** The list body is a bare array (reference parseNotificationListBody). */
const parseNotificationList = (body: unknown): ParsedList => {
  const rows = Array.isArray(body) ? body : []
  const items: NotificationItem[] = []
  for (const value of rows) {
    const item = parseNotification(value)
    if (item !== null) items.push(item)
  }
  return { items, sent: rows.length }
}

export const createNotificationsSeam = (ctx: SeamContext): NotificationsSeam => {
  const listNotifications = preparedView(ctx, () => ({ id: "notifications", title: "Notifications", read: async () => {
    // The reference's query params: `all` includes read rows (the card shows
    // both and counts the unread), `limit` bounds the page.
    const query = new URLSearchParams()
    query.set("limit", String(LIST_LIMIT))
    query.set("all", "true")
    let response: Response
    try {
      response = await ctx.http(`${ctx.baseUrl}/api/notifications/list?${query.toString()}`)
    } catch {
      return "Your notifications couldn't be loaded — the platform didn't answer."
    }
    if (!response.ok) {
      return readErrorMessage(response, "Your notifications couldn't be loaded right now.")
    }
    const body = (await response.json().catch(() => undefined)) as unknown
    const { items, sent } = parseNotificationList(body)
    /*
     * Rows that arrive and cannot be read are not "nothing new". Claiming an
     * empty inbox over an answer we failed to parse is the silent-failure
     * shape: say the answer was unreadable instead.
     */
    if (sent > 0 && items.length === 0) {
      return `Your notifications came back in a shape Smithers couldn't read (${sent} ${sent === 1 ? "row" : "rows"}).`
    }
    const card: Card = {
      id: "notifications",
      kind: "notifications",
      title: "Notifications",
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload: {
        unread: items.filter((item) => !item.read).length,
        items
      }
    }
    return { card }
  } }))

  const markNotificationsRead = async (): ReturnType<ViewAction<[]>> => {
    const current = captureCloudOwner(ctx, false)
    if (!current()) return SIGN_OUT_REFUSAL
    let response: Response
    try {
      response = await ctx.http(`${ctx.baseUrl}/api/notifications/mark-read`, { method: "PUT" })
    } catch {
      return current() ? "Your notifications couldn't be marked read — the platform didn't answer." : SIGN_OUT_REFUSAL
    }
    if (!current()) return SIGN_OUT_REFUSAL
    // The platform answers 205 on success (reference markAllNotificationsRead).
    if (response.status !== 205 && !response.ok) {
      const message = await readErrorMessage(response, "Your notifications couldn't be marked read right now.")
      return current() ? message : SIGN_OUT_REFUSAL
    }
    // Re-fetch so the card states the platform's answer, not our assumption.
    return listNotifications()
  }

  return { listNotifications, markNotificationsRead }
}
