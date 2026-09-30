/*
 * One timestamp vocabulary for the whole app.
 *
 * A bare clock reading is only unambiguous within the calendar day it was
 * stamped in. The transcript is persisted, so reopening it tomorrow — or
 * leaving a session open across midnight — rendered a message from last week
 * as `11:51 PM`, indistinguishable from one three minutes ago (§28.9). A
 * stamp outside today therefore says which day it belongs to.
 */

/** The clock reading in the user's locale — never zero-padded by hand. */
const clock = (at: Date): string => at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

/** Whole days between two instants, by calendar day rather than by elapsed time. */
const dayGap = (at: Date, now: Date): number => {
  const day = (value: Date): number => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000
  return day(now) - day(at)
}

/**
 * A stamp for the transcript and its cards: the time alone inside today,
 * "Yesterday" the day before, and the date beyond that.
 */
export const timeLabel = (createdAt: number, now: number = Date.now()): string => {
  const at = new Date(createdAt)
  const gap = dayGap(at, new Date(now))
  // A stamp later today reads as a clock too; a later day (a deadline) names its date.
  if (gap === 0) return clock(at)
  if (gap === 1) return `Yesterday ${clock(at)}`
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock(at)}`
}

/*
 * A short age for a recent instant (`4 min ago`) — the vocabulary the sync
 * cards use for "last sync" and rate-limit resets (ADR 0005). An unparseable
 * stamp renders verbatim rather than a lie; past a day the stamp vocabulary
 * reads better than an hour count.
 */
export const ageLabel = (iso: string, now: number = Date.now()): string => {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return timeLabel(at, now)
}

/*
 * A short distance to an instant still AHEAD (`in 12 min`, `at 12:40`) — the
 * vocabulary for a rate-limit reset (ADR 0005 "Rate limits"). `ageLabel`
 * clamps a future instant to "just now", which told the user a limit had
 * already reset while GitHub would still refuse the call; a reset is always
 * ahead, so it needs its own words. An instant already reached reads `now`;
 * an unparseable stamp renders verbatim rather than a lie.
 */
export const untilLabel = (iso: string, now: number = Date.now()): string => {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const seconds = Math.round((at - now) / 1000)
  if (seconds <= 0) return "now"
  if (seconds < 60) return "in under a minute"
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `in ${minutes} min`
  return `at ${timeLabel(at, now)}`
}

/*
 * A duration in words (`940ms`, `1.2s`) — the vocabulary the run, target and
 * check cards use for wall time. Five hand-rolled copies disagreed on the
 * sub-second branch (review finding 4): the surviving rule is a tenth of a
 * second at a second and above, whole milliseconds below it, so a fractional
 * `performance.now()` delta never renders as `12.339999999ms`.
 */
export const durationLabel = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)

/*
 * A recorded stamp as a card prints it: `2026-08-11T09:00:00Z` reads
 * `2026-08-11 09:00`. This slices the recorded text rather than parsing it,
 * so the stamp keeps the zone it was recorded in and a string that is not a
 * stamp is truncated rather than rendered as `Invalid Date`. Use `timeLabel`
 * instead wherever the reading should follow the reader's clock.
 */
export const dateLabel = (iso: string): string => iso.replace("T", " ").slice(0, 16)

/** The calendar day of a recorded stamp, on the same terms as `dateLabel`: `2026-08-11`. */
export const dayLabel = (iso: string): string => iso.slice(0, 10)

/*
 * A running clock since an instant (`4:07`, `1:02:09`) — how long a Stack
 * lane has worked on its item. An unreadable stamp renders nothing.
 */
export const elapsedLabel = (startedAt: string, now: number): string | undefined => {
  const at = Date.parse(startedAt)
  if (Number.isNaN(at)) return undefined
  const total = Math.max(0, Math.floor((now - at) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`
}
