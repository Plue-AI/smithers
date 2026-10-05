import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Window } from "happy-dom"
import { fixtures } from "@smthrs/rpc/fixtures/Timeline"
import type { TimelineLine } from "@smthrs/rpc/TimelineCard"
import { spanOf, Timeline } from "./Timeline"

/*
 * A zoomed line (T-UI-08 zoom, #3728) stands for a run of entries: it says how many and when, names itself for a
 * screen reader, marks its level, and keeps its act as a control of its own. Its markup is read from a server render
 * in a window of its own, so this file leaves no global DOM behind for the suites that run after it (a registered
 * window breaks their registration, and a torn-down one breaks React DOM for them). The click contract, a line jumps
 * to its first entry and its act calls the flow without jumping, is driven for the `zoomed` fixture by
 * cards/views/Views.test.tsx through Timeline.stories.tsx, as for every other line.
 */

const CLOCK = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" })
const DAY = new Intl.DateTimeFormat([], { month: "short", day: "numeric" })
const clock = (at: number): string => CLOCK.format(at)
const day = (at: number): string => DAY.format(at)

const render = (lines: ReadonlyArray<TimelineLine>, on_screen: readonly [string, string] = ["", ""]) => {
  const window = new Window()
  window.document.body.innerHTML = renderToStaticMarkup(<Timeline lines={[...lines]} on_screen={[on_screen[0], on_screen[1]]} onAction={() => {}} onView={() => {}} />)
  return window.document.body
}

const zoomed = fixtures.zoomed.model.lines
const byId = (id: string): TimelineLine => zoomed.find(line => line.entry_id === id)!

describe("a zoomed timeline line", () => {
  test("carries its level, count and same-day span, and names itself by them", () => {
    const body = render(zoomed, fixtures.zoomed.model.on_screen)
    for (const line of zoomed) {
      const item = body.querySelector(`li[data-entry="${line.entry_id}"]`)!
      const button = item.querySelector(":scope > button")!
      expect(item.getAttribute("data-zoom")).toBe(line.zoom === undefined ? null : String(line.zoom.level))
      expect(item.getAttribute("data-kind")).toBe(line.kind)
      expect(item.getAttribute("data-tone")).toBe(line.tone)
      expect(button.getAttribute("type")).toBe("button")
      if (line.zoom === undefined) {
        expect(button.getAttribute("aria-label")).toBeNull()
        expect(item.querySelector(".mvp-tl-zoom")).toBeNull()
        continue
      }
      const { count, from, to } = line.zoom
      // The locale's own range: one meridiem when both ends share it (`9:10 – 10:32 AM`), two when they differ.
      const span = CLOCK.formatRange(from!, to!)
      expect(span).toContain(clock(to!))
      expect(item.querySelector(".mvp-tl-zoom")!.textContent).toBe(`${count} entries · ${span}`)
      expect(item.querySelector(".mvp-tl-zoom time")!.textContent).toBe(span)
      expect(button.getAttribute("aria-label")).toBe(`${count} entries, ${clock(from!)} to ${clock(to!)}: ${line.title}`)
      // The stacked node: one bar per level above the entry, capped at the coarsest look; no entry glyph beside it.
      expect(item.querySelectorAll(".mvp-tl-node .mvp-tl-stack rect")).toHaveLength(Math.min(line.zoom.level, 3) + 1)
      expect(item.querySelector(".mvp-tl-node .lucide-check, .mvp-tl-node .lucide-x, .mvp-tl-node .lucide-circle-alert, .mvp-tl-node .mvp-avatar")).toBeNull()
      // The run's summary stays with the model; the count and span are the words.
      expect(item.textContent).not.toContain(line.summary!)
    }
    // The band and freshness read as before.
    expect([...body.querySelectorAll("li[data-in-view]")].map(item => item.getAttribute("data-entry"))).toEqual(["entry-756", "entry-757"])
    expect(body.querySelector("li[data-fresh]")!.getAttribute("data-entry")).toBe("entry-757")
    // Short chats are unchanged: no zoom attribute, no stacked node.
    const plain = render(fixtures.timeline.model.lines, fixtures.timeline.model.on_screen)
    expect(plain.querySelectorAll("li[data-zoom], .mvp-tl-stack, .mvp-tl-zoom")).toHaveLength(0)
    expect(plain.querySelectorAll("li[data-entry]")).toHaveLength(fixtures.timeline.model.lines.length)
  })

  test("a level past 3 keeps its number and wears the coarsest node", () => {
    const deep: TimelineLine = { ...byId("entry-1"), zoom: { ...byId("entry-1").zoom!, level: 5 } }
    const body = render([deep])
    const item = body.querySelector("li[data-entry]")!
    expect(item.getAttribute("data-zoom")).toBe("5")
    expect(item.querySelectorAll(".mvp-tl-stack rect")).toHaveLength(4)
    expect(body.querySelector('li[data-entry="entry-1"] button')!.getAttribute("aria-label")).toBe(`237 entries, ${clock(deep.zoom!.from!)} to ${clock(deep.zoom!.to!)}: ${deep.title}`)
  })

  test("a span across days reads as dates, and a line without times has no span", () => {
    const from = new Date(2026, 9, 3, 23, 50).getTime(), to = new Date(2026, 9, 5, 0, 10).getTime()
    expect(spanOf({ from, to })).toEqual({ text: DAY.formatRange(from, to), from: day(from), to: day(to) })
    expect(DAY.formatRange(from, to)).toContain(day(from))
    const noon = [new Date(2026, 9, 5, 11, 48).getTime(), new Date(2026, 9, 5, 12, 5).getTime()] as const
    expect(spanOf({ from: noon[0], to: noon[1] })).toEqual({ text: CLOCK.formatRange(noon[0], noon[1]), from: clock(noon[0]), to: clock(noon[1]) })
    // Ends out of order still read forwards; one instant reads once.
    expect(spanOf({ from: noon[1], to: noon[0] })).toEqual(spanOf({ from: noon[0], to: noon[1] }))
    expect(spanOf({ from: noon[0], to: noon[0] })!.text).toBe(clock(noon[0]))
    expect(spanOf({ from })).toBeUndefined()
    expect(spanOf({})).toBeUndefined()
    const dated: TimelineLine = { ...byId("entry-1"), zoom: { level: 3, count: 237, last_entry_id: "entry-237", from, to } }
    const timeless: TimelineLine = { ...byId("entry-404"), zoom: { level: 3, count: 289, last_entry_id: "entry-692" } }
    const body = render([dated, timeless])
    expect(body.querySelector('li[data-entry="entry-1"] .mvp-tl-zoom')!.textContent).toBe(`237 entries · ${DAY.formatRange(from, to)}`)
    expect(body.querySelector('li[data-entry="entry-1"] button')!.getAttribute("aria-label")).toBe(`237 entries, ${day(from)} to ${day(to)}: ${dated.title}`)
    expect(body.querySelector('li[data-entry="entry-404"] .mvp-tl-zoom')!.textContent).toBe("289 entries")
    expect(body.querySelector('li[data-entry="entry-404"] button')!.getAttribute("aria-label")).toBe(`289 entries: ${timeless.title}`)
  })

  test("a title the fast model wrote wears the written mark before it; the run's own title wears none (#3732)", () => {
    const written: TimelineLine = { ...byId("entry-1"), title: "Hardened webhook retries", zoom: { ...byId("entry-1").zoom!, written: true } }
    const body = render([written, byId("entry-404"), ...fixtures.timeline.model.lines])
    const title = body.querySelector('li[data-entry="entry-1"] .mvp-tl-text b')!
    expect(title.textContent).toBe("Hardened webhook retries")
    expect(title.firstElementChild!.matches("svg.mvp-written[aria-hidden=true]")).toBe(true)
    expect(body.querySelector('li[data-entry="entry-1"] button')!.getAttribute("aria-label")).toBe(`237 entries, ${clock(written.zoom!.from!)} to ${clock(written.zoom!.to!)}: Hardened webhook retries`)
    expect(body.querySelectorAll(".mvp-written")).toHaveLength(1)
    expect(body.querySelector('li[data-entry="entry-404"] .mvp-tl-text b')!.textContent).toBe(byId("entry-404").title)
  })

  test("a run's act is its own control beside the line, never inside it", () => {
    const body = render(zoomed, fixtures.zoomed.model.on_screen)
    const asking = body.querySelector('li[data-entry="entry-733"]')!
    const act = asking.querySelector('.mvp-tl-actions > button[data-flow="todo.answer"]')!
    expect(act.textContent).toBe("Answer")
    expect(act.getAttribute("disabled")).toBeNull()
    expect(asking.querySelector(":scope > button button")).toBeNull()
    expect(asking.querySelectorAll("button")).toHaveLength(2)
    // A run whose act no longer applies shows none, and a line is one control.
    expect(body.querySelector('li[data-entry="entry-717"] button[data-flow]')).toBeNull()
    expect(body.querySelectorAll('li[data-entry="entry-717"] button')).toHaveLength(1)
  })
})
