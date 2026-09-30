import { describe, expect, test } from "bun:test"
import { ageLabel, dateLabel, dayLabel, durationLabel, timeLabel, untilLabel } from "./Timestamps"

/*
 * §28.9: the transcript is persisted, so a stamp is read on days other than
 * the one it was written on. A bare clock reading made a message from last
 * week indistinguishable from one three minutes ago.
 */

const at = (iso: string): number => new Date(iso).getTime()

describe("a transcript stamp says which day it belongs to", () => {
  const now = at("2026-08-19T14:00:00")

  test("a stamp from today is the time alone", () => {
    const label = timeLabel(at("2026-08-19T02:51:00"), now)
    expect(label).not.toContain("Yesterday")
    expect(label).toMatch(/2:51/)
  })

  test("a stamp from the previous calendar day says Yesterday", () => {
    expect(timeLabel(at("2026-08-18T23:51:00"), now)).toStartWith("Yesterday ")
  })

  test("a stamp later today is the time alone, and one on a later day carries its date", () => {
    expect(timeLabel(at("2026-08-19T23:30:00"), now)).toMatch(/^\d{1,2}:30/)
    const tomorrow = timeLabel(at("2026-08-20T00:30:00"), now)
    expect(tomorrow).not.toContain("Yesterday")
    expect(tomorrow).toContain("20")
    expect(tomorrow).toMatch(/12:30|00:30/)
  })

  test("an older stamp carries its date", () => {
    const label = timeLabel(at("2026-08-12T23:51:00"), now)
    expect(label).not.toContain("Yesterday")
    expect(label).toContain("12")
  })

  test("the hour is not zero-padded by hand", () => {
    expect(timeLabel(at("2026-08-19T02:51:00"), now)).not.toStartWith("02:")
  })

  test("a stamp from later today is still the time alone — a clock skew is not a day", () => {
    expect(timeLabel(at("2026-08-19T23:00:00"), now)).not.toContain("Yesterday")
  })
})

/*
 * ADR 0005 "Rate limits": a reset is always ahead. `ageLabel` clamps a future
 * instant to "just now" (review finding 2 — the line read "resets just now"
 * for a reset minutes away), so the future has its own vocabulary.
 */
describe("a distance to an instant ahead", () => {
  const now = at("2026-09-02T12:28:00")

  test("minutes ahead count down, rounded up so the reset is never claimed early", () => {
    expect(untilLabel("2026-09-02T12:40:00", now)).toBe("in 12 min")
    expect(untilLabel("2026-09-02T12:39:30", now)).toBe("in 12 min")
    expect(untilLabel("2026-09-02T12:28:30", now)).toBe("in under a minute")
  })

  test("an hour or more ahead reads as the clock time", () => {
    const label = untilLabel("2026-09-02T14:05:00", now)
    expect(label).toStartWith("at ")
    expect(label).toMatch(/2:05/)
  })

  test("an instant already reached reads now; an unparseable stamp renders verbatim", () => {
    expect(untilLabel("2026-09-02T12:20:00", now)).toBe("now")
    expect(untilLabel("soon", now)).toBe("soon")
  })

  test("the age vocabulary still clamps the future — which is why the reset never uses it", () => {
    expect(ageLabel("2026-09-02T12:40:00", now)).toBe("just now")
  })
})

/*
 * Review finding ui-cards-tabs/maintainability/4: five duration formatters and
 * three ISO slicers lived in the cards while this module claimed the whole
 * vocabulary. The rules below are the ones the surviving copies agreed on.
 */
describe("a duration in words", () => {
  test("under a second reads in whole milliseconds", () => {
    expect(durationLabel(0)).toBe("0ms")
    expect(durationLabel(940)).toBe("940ms")
    expect(durationLabel(999)).toBe("999ms")
  })

  test("a fractional millisecond is rounded, never printed raw", () => {
    expect(durationLabel(12.339_999_999)).toBe("12ms")
    expect(durationLabel(0.4)).toBe("0ms")
  })

  test("a second or more reads to a tenth", () => {
    expect(durationLabel(1000)).toBe("1.0s")
    expect(durationLabel(1234)).toBe("1.2s")
    expect(durationLabel(12_000)).toBe("12.0s")
    expect(durationLabel(90_600)).toBe("90.6s")
  })
})

describe("a recorded stamp as a card prints it", () => {
  test("an ISO stamp keeps its own zone: date, space, clock, no seconds", () => {
    expect(dateLabel("2026-08-11T09:00:00Z")).toBe("2026-08-11 09:00")
    expect(dayLabel("2026-08-11T09:00:00Z")).toBe("2026-08-11")
  })

  test("the calendar day alone drops the clock", () => {
    expect(dayLabel("2026-08-11T23:59:59.999Z")).toBe("2026-08-11")
  })

  test("a stamp is sliced, never re-parsed — a non-stamp is truncated, never Invalid Date", () => {
    expect(dateLabel("never")).toBe("never")
    expect(dayLabel("never")).toBe("never")
    expect(dateLabel("unknown")).not.toContain("Invalid")
  })
})
