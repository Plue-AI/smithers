/**
 * A control run's approved deadline, read from its own control events: the
 * run fact every `control.run.*` record carries holds the `deadlineAt` the
 * control plane stamped when it accepted the run, so the terminal shows the
 * value the app's run card and `smthrs runs show` show.
 */
import type { ControlSchema } from "@smthrs/control"
import type * as Panels from "./panels.ts"

/** When the run's deadline passes, from the newest run fact that names one. */
export const deadlineAt = (events: ReadonlyArray<ControlSchema.ControlEvent>): number | undefined => {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (!event.kind.startsWith("control.run.")) continue
    const payload = event.payload as { readonly run?: { readonly deadlineAt?: unknown } } | null
    const at = payload?.run?.deadlineAt
    if (typeof at === "number" && Number.isFinite(at)) return at
  }
  return undefined
}

/** `14:32`, or `Sep 30 14:32` on another day than `now`. */
export const label = (at: number, now: number): string => {
  const date = new Date(at)
  const clock = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return date.toDateString() === new Date(now).toDateString()
    ? clock
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`
}

/** The deadline as a panel row while the run is live; none once it settled or without one. */
export const row = (
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  live: boolean,
  now: number = Date.now()
): ReadonlyArray<Panels.Row> => {
  const at = deadlineAt(events)
  return at === undefined || !live ? [] : [{ id: "deadline", label: `Deadline ${label(at, now)}`, details: [] }]
}
