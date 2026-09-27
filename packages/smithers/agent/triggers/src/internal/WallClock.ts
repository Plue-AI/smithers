/**
 * Wall-clock cron occurrences in a time zone, daylight saving included.
 *
 * A cron expression names wall-clock times. Searching those times with a UTC
 * cron is exact, so the zone only matters when a wall time is turned into an
 * instant:
 *
 * - A wall time that exists once is that instant.
 * - A wall time inside a spring-forward gap fires at the instant it would have
 *   had on the old offset: a daily 02:30 fires at 03:30 daylight time.
 * - A wall time repeated by fall back fires once, at its first instant. An
 *   expression whose hour field is every hour fires in both passes instead, so
 *   an hourly or minutely schedule keeps running through the repeated hour.
 *
 * Instants are whole seconds in UTC, so millisecond zeroing never reads the
 * host's zone.
 *
 * @since 1.0.0-rc.1
 */

import * as EffectCron from "effect/Cron"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"

const day = 86_400_000
const second = 1_000

/** The zone's wall clock minus UTC at an instant, in milliseconds. */
type Offset = (instant: number) => number

const formatters = new Map<string, Intl.DateTimeFormat>()

const formatter = (timeZone: string): Intl.DateTimeFormat => {
  let format = formatters.get(timeZone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23"
    })
    formatters.set(timeZone, format)
  }
  return format
}

const named = (timeZone: string): Offset => (instant) => {
  const whole = Math.floor(instant / second) * second
  const fields = { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0 }
  for (const part of formatter(timeZone).formatToParts(whole)) {
    if (part.type in fields) fields[part.type as keyof typeof fields] = Number(part.value)
  }
  const wall = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second)
  return wall - whole
}

// Read on every call, so a host whose `TZ` changes is followed.
const host: Offset = (instant) => -new Date(instant).getTimezoneOffset() * 60_000

const offsetOf = (zone: Option.Option<DateTime.TimeZone>): Offset => {
  if (Option.isNone(zone)) return host
  const value = zone.value
  if (DateTime.isTimeZoneOffset(value)) return () => value.offset
  return named(value.id)
}

/**
 * A cron compiled for wall-clock search.
 *
 * @private
 * @since 1.0.0-rc.1
 */
export interface WallCron {
  readonly wall: EffectCron.Cron
  readonly offset: Offset
  readonly everyHour: boolean
}

const compiled = new WeakMap<EffectCron.Cron, WallCron>()

/**
 * Compiles an Effect cron once: its fields as a UTC cron over wall-clock
 * times, and its zone's offset.
 *
 * @private
 * @since 1.0.0-rc.1
 */
export const compile = (cron: EffectCron.Cron): WallCron => {
  let wallCron = compiled.get(cron)
  if (wallCron === undefined) {
    wallCron = {
      wall: EffectCron.make({
        seconds: cron.seconds,
        minutes: cron.minutes,
        hours: cron.hours,
        days: cron.days,
        months: cron.months,
        weekdays: cron.weekdays,
        // Whether day of month and weekday must both match. Effect keeps the
        // flag off its public type, but `make` takes it and every cron has it.
        and: (cron as EffectCron.Cron & { readonly and: boolean }).and,
        tz: DateTime.zoneMakeNamedUnsafe("UTC")
      }),
      offset: offsetOf(cron.tz),
      everyHour: cron.hours.size === 0 || cron.hours.size === 24
    }
    compiled.set(cron, wallCron)
  }
  return wallCron
}

/** The offsets in force from a day before an instant to a day after it. */
const near = (cron: WallCron, instant: number): ReadonlyArray<number> => [
  cron.offset(instant - day),
  cron.offset(instant),
  cron.offset(instant + day)
]

/** The instants one matching wall time fires at, earliest first. */
const resolve = (cron: WallCron, wall: number): ReadonlyArray<number> => {
  const before = cron.offset(wall - day)
  const after = cron.offset(wall + day)
  const candidates = before === after ? [before] : [before, after]
  const valid = candidates.map((offset) => wall - offset).filter((instant) => cron.offset(instant) === wall - instant)
  // No offset reads this wall time back: it is inside a gap.
  if (valid.length === 0) return [wall - before]
  valid.sort((left, right) => left - right)
  return cron.everyHour ? valid : valid.slice(0, 1)
}

/**
 * The first occurrence strictly after `from`. Throws when the wall-clock search
 * is exhausted.
 *
 * @private
 * @since 1.0.0-rc.1
 */
export const next = (cron: WallCron, from: number): number => {
  // Every wall time that can fire after `from` lies after `from` plus the
  // smallest nearby offset.
  let wall = from + Math.min(...near(cron, from))
  let best = Number.POSITIVE_INFINITY
  for (;;) {
    wall = EffectCron.next(cron.wall, wall).getTime()
    if (wall - Math.max(...near(cron, wall)) >= best) return best
    for (const instant of resolve(cron, wall)) if (instant > from && instant < best) best = instant
  }
}

/**
 * The latest occurrence at or before `at`, in whole seconds. Throws when the
 * wall-clock search is exhausted.
 *
 * @private
 * @since 1.0.0-rc.1
 */
export const previousAtOrBefore = (cron: WallCron, at: number): number => {
  const until = Math.floor(at / second) * second
  // Every wall time that can fire at or before `until` lies at or before
  // `until` plus the largest nearby offset.
  let wall = until + Math.max(...near(cron, until)) + second
  let best = Number.NEGATIVE_INFINITY
  for (;;) {
    wall = EffectCron.prev(cron.wall, wall).getTime()
    if (wall - Math.min(...near(cron, wall)) <= best) return best
    for (const instant of resolve(cron, wall)) if (instant <= until && instant > best) best = instant
  }
}
