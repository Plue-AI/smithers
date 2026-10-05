import { describe, expect, test } from "bun:test"
import type { TimelineLine } from "@smthrs/rpc/TimelineCard"
import { TimelineLineSchema } from "@smthrs/rpc/TimelineCard"
import { foldedLine, zoomLevels, zoomTimeline, ZOOM_DEFAULTS } from "./TimelineZoom"

const line = (id: number, kind: TimelineLine["kind"], tone: TimelineLine["tone"] = "quiet", extra: Partial<TimelineLine> = {}): TimelineLine =>
  ({ entry_id: `e${id}`, kind, title: `${kind} ${id}`, tone, glyph: { event: "ok" }, ...extra })

/** A conversation shaped like an agent session: a prompt, then answers each followed by a few steps. */
const session = (length: number, promptEvery = 120): TimelineLine[] => Array.from({ length }, (_, id) =>
  line(id, id % promptEvery === 0 ? "prompt" : id % 3 === 1 ? "answer" : id % 3 === 2 ? "event" : "card"))

/** Every shown line stands for the entries from its id to its last id; together they are the conversation, once, in order. */
const covered = (lines: ReadonlyArray<TimelineLine>, shown: ReadonlyArray<TimelineLine>): string[] => {
  const position = new Map(lines.map((each, index) => [each.entry_id, index]))
  return shown.flatMap(each => {
    const first = position.get(each.entry_id)!
    const last = each.zoom === undefined ? first : position.get(each.zoom.last_entry_id)!
    return lines.slice(first, last + 1).map(entry => entry.entry_id)
  })
}
const levelOf = (each: TimelineLine): number => each.zoom?.level ?? 0
const ids = (lines: ReadonlyArray<TimelineLine>) => lines.map(each => each.entry_id)

/** A seeded generator, so a failing case is reproducible from its seed. */
const random = (seed: number) => () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648

describe("short conversations", () => {
  test("at or under the threshold, the lines are shown as they are", () => {
    const lines = session(ZOOM_DEFAULTS.threshold)
    expect(zoomTimeline(lines, ["e10", "e12"])).toEqual(lines)
    expect(zoomTimeline([], undefined)).toEqual([])
  })

  test("one line over the threshold zooms", () => {
    const shown = zoomTimeline(session(ZOOM_DEFAULTS.threshold + 1), undefined)
    expect(shown.some(each => each.zoom !== undefined)).toBe(true)
  })
})

describe("the levels", () => {
  test("level 1 starts at every prompt and answer; level 2 at every prompt; no group exceeds its cap", () => {
    const lines = [line(0, "prompt"), line(1, "answer"), line(2, "event"), line(3, "card"), line(4, "answer"), line(5, "prompt"), line(6, "event")]
    const [one, two, three] = zoomLevels(lines)
    expect(one.map(group => [group.first, group.last])).toEqual([[0, 0], [1, 3], [4, 4], [5, 6]])
    expect(two.map(group => [group.first, group.last])).toEqual([[0, 4], [5, 6]])
    expect(three.map(group => [group.first, group.last])).toEqual([[0, 6]])
  })

  test("there are at least three levels, and more until the coarsest has at most `cap` groups", () => {
    expect(zoomLevels(Array.from({ length: 70 }, (_, id) => line(id, "event")))).toHaveLength(3)
    const deep = zoomLevels(Array.from({ length: 100_000 }, (_, id) => line(id, id % 5 === 0 ? "answer" : "event")))
    expect(deep.length).toBeGreaterThan(3)
    expect(deep.at(-1)!.length).toBeLessThanOrEqual(8)
    expect(deep.map(level => level[0]!.level)).toEqual(deep.map((_, index) => index + 1))
  })

  test("a long run without a message still folds by the caps", () => {
    const lines = Array.from({ length: 1_000 }, (_, id) => line(id, "event"))
    const [one, two, three] = zoomLevels(lines)
    expect(one).toHaveLength(125)
    expect(two).toHaveLength(16)
    expect(three).toHaveLength(2)
    for (const level of [one, two, three]) for (const group of level) expect(group.children.length).toBeLessThanOrEqual(8)
  })

  test("level 3 starts at a prompt only once it is half full, so a run of short exchanges shares one group", () => {
    const lines = Array.from({ length: 40 }, (_, id) => line(id, id % 2 === 0 ? "prompt" : "answer"))
    const [, two, three] = zoomLevels(lines)
    expect(two).toHaveLength(20)
    expect(three.map(group => group.children.length)).toEqual([4, 4, 4, 4, 4])
  })
})

describe("zooming around the band", () => {
  const lines = session(2_000)

  test("the band's lines are one per entry, and nothing is lost or repeated", () => {
    const shown = zoomTimeline(lines, ["e1000", "e1006"])
    expect(covered(lines, shown)).toEqual(ids(lines))
    const band = shown.slice(shown.findIndex(each => each.entry_id === "e1000"), shown.findIndex(each => each.entry_id === "e1006") + 1)
    expect(ids(band)).toEqual(ids(lines.slice(1000, 1007)))
    expect(band.every(each => each.zoom === undefined)).toBe(true)
  })

  test("all three levels show, coarser with distance, and the rail stays short", () => {
    const shown = zoomTimeline(lines, ["e1000", "e1006"])
    for (const level of [0, 1, 2, 3]) expect(shown.map(levelOf)).toContain(level)
    expect(shown.length).toBeLessThan(70)
    for (const each of shown) TimelineLineSchema.parse(each)
  })

  test("without a band, or with one naming no line, the band is the last line", () => {
    const latest = zoomTimeline(lines, undefined)
    expect(latest.at(-1)).toEqual(lines.at(-1)!)
    expect(latest[0]!.zoom!.level).toBeGreaterThanOrEqual(3)
    expect(zoomTimeline(lines, ["gone", "gone"])).toEqual(latest)
  })

  test("a band named backwards or by one known end still focuses there", () => {
    expect(zoomTimeline(lines, ["e1006", "e1000"])).toEqual(zoomTimeline(lines, ["e1000", "e1006"]))
    const half = zoomTimeline(lines, ["e500", "gone"])
    expect(half.find(each => each.entry_id === "e500")?.zoom).toBeUndefined()
  })

  test("the band at the very start shows the start in full and folds the end", () => {
    const shown = zoomTimeline(lines, ["e0", "e3"])
    expect(ids(shown.slice(0, 4))).toEqual(["e0", "e1", "e2", "e3"])
    expect(shown.at(-1)!.zoom!.level).toBeGreaterThanOrEqual(3)
  })

  test("radii and caps can be set", () => {
    const tight = zoomTimeline(lines, ["e1000", "e1000"], undefined, { radius: [0, 0, 0] })
    const wide = zoomTimeline(lines, ["e1000", "e1000"], undefined, { radius: [6, 3, 1] })
    expect(tight.length).toBeLessThan(wide.length)
    expect(covered(lines, tight)).toEqual(ids(lines))
    expect(covered(lines, wide)).toEqual(ids(lines))
  })
})

describe("a folded line", () => {
  test("is titled by its first prompt, else its first answer, else its first line, and counts what it holds", () => {
    const lines = [line(0, "event"), line(1, "answer"), line(2, "prompt"), line(3, "card", "failed"), line(4, "answer")]
    expect(foldedLine(lines, { level: 2, first: 0, last: 4 })).toMatchObject({
      entry_id: "e0", kind: "prompt", title: "prompt 2", summary: "1 prompt · 2 answers · 2 steps · 1 failed",
      zoom: { level: 2, count: 5, last_entry_id: "e4" }
    })
    expect(foldedLine(lines, { level: 1, first: 0, last: 1 })).toMatchObject({ kind: "answer", title: "answer 1", summary: "1 answer · 1 step" })
    expect(foldedLine(lines, { level: 1, first: 3, last: 3 })).toMatchObject({ kind: "card", title: "card 3", summary: "1 step · 1 failed" })
  })

  test("takes its most urgent tone and act, so a far Needs you or failure still shows", () => {
    const answer = { tag: "todo.answer" as const, label: "Answer", args: { n: "12" } }
    const retry = { tag: "todo.retry" as const, label: "Retry", args: { n: "9" } }
    const lines = [line(0, "event", "done"), line(1, "card", "failed", { action: retry }), line(2, "card", "attention", { action: answer }), line(3, "event", "live", { fresh: true })]
    expect(foldedLine(lines, { level: 1, first: 0, last: 3 })).toMatchObject({ tone: "attention", glyph: { event: "attention" }, action: answer, fresh: true })
    expect(foldedLine(lines, { level: 1, first: 0, last: 1 })).toMatchObject({ tone: "failed", glyph: { event: "failed" }, action: retry })
    expect(foldedLine(lines, { level: 1, first: 3, last: 3 })).toMatchObject({ tone: "live", glyph: { event: "running" } })
    const quiet = foldedLine(lines, { level: 1, first: 0, last: 0 })
    expect(quiet).toMatchObject({ tone: "done", glyph: { event: "ok" } })
    expect(quiet.action).toBeUndefined()
    expect(quiet.fresh).toBeUndefined()
  })

  test("spans the times its entries carry, and none when they carry none", () => {
    const lines = [line(0, "prompt"), line(1, "answer"), line(2, "event")]
    const times = new Map([["e0", 3_000], ["e2", 9_000], ["e1", 0]])
    expect(foldedLine(lines, { level: 1, first: 0, last: 2 }, times).zoom).toEqual({ level: 1, count: 3, last_entry_id: "e2", from: 3_000, to: 9_000 })
    expect(foldedLine(lines, { level: 1, first: 0, last: 2 }).zoom).toEqual({ level: 1, count: 3, last_entry_id: "e2" })
  })
})

describe("properties over random conversations", () => {
  const kinds: ReadonlyArray<TimelineLine["kind"]> = ["prompt", "answer", "answer", "card", "event", "event", "event"]
  const tones: ReadonlyArray<TimelineLine["tone"]> = ["quiet", "quiet", "quiet", "done", "live", "failed", "attention"]

  test("for 300 seeded conversations and bands: full cover in order, band unfolded, coarser with distance, bounded length", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed)
      const length = 1 + Math.floor(next() * 4_000)
      const lines = Array.from({ length }, (_, id) => line(id, kinds[Math.floor(next() * kinds.length)]!, tones[Math.floor(next() * tones.length)]!))
      const a = Math.floor(next() * length), b = Math.min(length - 1, a + Math.floor(next() * 12))
      const shown = zoomTimeline(lines, [`e${a}`, `e${b}`])
      const context = `seed ${seed}, ${length} lines, band ${a}-${b}`
      expect(covered(lines, shown), context).toEqual(ids(lines))
      if (length <= ZOOM_DEFAULTS.threshold) { expect(shown, context).toEqual(lines); continue }
      const top = shown.findIndex(each => each.entry_id === `e${a}`)
      const bottom = shown.findIndex(each => each.entry_id === `e${b}`)
      expect(shown.slice(top, bottom + 1).map(levelOf), context).toEqual(Array.from({ length: b - a + 1 }, () => 0))
      // Walking away from the band, a folded line's level never drops back down; an unfolded line out there is a
      // lone entry (a group of one cannot fold).
      const [one] = zoomLevels(lines)
      const lone = new Set(one.filter(group => group.first === group.last).map(group => `e${group.first}`))
      const away = [shown.slice(0, top).reverse(), shown.slice(bottom + 1)]
      for (const side of away) {
        let level = 0
        for (const each of side) {
          if (each.zoom === undefined) { if (level > 0) expect(lone.has(each.entry_id), `${context}: ${each.entry_id}`).toBe(true); continue }
          expect(each.zoom.level, context).toBeGreaterThanOrEqual(level)
          level = each.zoom.level
        }
      }
      expect(shown.length, context).toBeLessThanOrEqual(90)
      for (const each of shown) if (each.zoom) expect(each.zoom.count, context).toBeGreaterThanOrEqual(2)
    }
  })

  test("coarser levels are added as needed, so the rail stays short and fast at any length", () => {
    for (const length of [1_000, 10_000, 50_000, 200_000]) {
      const lines = session(length, 400)
      const started = performance.now()
      const shown = zoomTimeline(lines, [`e${length / 2}`, `e${length / 2 + 10}`])
      expect(performance.now() - started).toBeLessThan(100)
      expect(shown.length, `${length} lines`).toBeLessThan(90)
      expect(covered(lines, shown)).toEqual(ids(lines))
    }
  })
})
