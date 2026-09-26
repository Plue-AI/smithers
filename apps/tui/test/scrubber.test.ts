import { describe, expect, test } from "bun:test"
import * as Activity from "../src/activity.ts"
import * as Scrubber from "../src/scrubber.ts"
import * as Session from "../src/session.ts"
import * as Transcript from "../src/transcript.ts"

/** A real worker session recorded by the TUI, large payloads clipped. */
const fixture = new URL("./fixtures/timeline-worker.jsonl", import.meta.url).pathname
const transcript = Session.restore(Session.load(fixture)).transcript
const activity = transcript.activity!
const model = Activity.model(activity)
const cells = transcript.items.filter((item): item is Extract<Transcript.Item, { kind: "cell" }> =>
  item.kind === "cell"
)

describe("scrubber layout from a recorded session", () => {
  test("phase segments tile the track in journal order and never overflow", () => {
    for (const width of [160, 110, 80, 50, 30, 16]) {
      const layout = Scrubber.layout(activity, width)
      expect(layout.lead + layout.track + layout.tail).toBeLessThanOrEqual(width)
      let column = 0
      for (const segment of layout.segments) {
        expect(segment.left).toBe(column)
        expect(segment.width).toBeGreaterThan(0)
        column += segment.width
      }
      expect(column).toBe(layout.track)
      for (const tick of layout.ticks) {
        expect(tick.column).toBeGreaterThanOrEqual(0)
        expect(tick.column).toBeLessThan(layout.track)
        expect(tick.left + tick.label.length).toBeLessThanOrEqual(layout.track)
      }
    }
  })

  test("wide segments carry the phase the shared fold named", () => {
    const layout = Scrubber.layout(activity, 160)
    expect(layout.segments.map((segment) => segment.phase)).toEqual(model.bands.map((band) => band.phase))
    expect(layout.segments.map((segment) => segment.label).filter((label) => label !== "")).toEqual(
      expect.arrayContaining(["Researching", "Stuck"])
    )
  })

  test("ticks are the fold's milestones, including the verdict", () => {
    const layout = Scrubber.layout(activity, 160)
    expect(layout.ticks.map((tick) => tick.label)).toEqual(["approvals.ts", "completed"])
    expect(layout.ticks.map((tick) => tick.tone)).toEqual(["brand", "good"])
  })

  test("narrow widths drop words before they drop marks", () => {
    const layout = Scrubber.layout(activity, 30)
    expect(layout.ticks).toHaveLength(2)
    expect(layout.ticks.every((tick) => tick.label === "")).toBe(true)
    expect(layout.rows).toBe(0)
    expect(layout.segments.every((segment) => segment.label === "" || segment.label.length + 1 <= segment.width)).toBe(
      true
    )
  })

  test("the knob follows the live end; a cursor moves it and dims what is ahead", () => {
    const live = Scrubber.layout(activity, 120)
    expect(live.knob).toBe(live.track - 1)
    expect(live.segments.every((segment) => segment.reached)).toBe(true)
    const first = model.bands[0]!.seq
    const early = Scrubber.layout(activity, 120, first)
    expect(early.knob).toBe(0)
    expect(early.segments[0]!.reached).toBe(true)
    expect(early.segments.at(-1)!.reached).toBe(false)
    expect(early.phase).toBe("Researching")
  })

  test("the right block reads the phase at the playhead and its elapsed time", () => {
    const done = Scrubber.layout(activity, 120)
    expect(done.phase).toBe("Done")
    expect(done.elapsed).toMatch(/^\d+:\d{2}$/)
    const stuck = model.bands.find((band) => band.phase === "stuck")!
    expect(Scrubber.layout(activity, 120, stuck.seq).phase).toBe("Stuck")
    expect(Scrubber.clock(68_000)).toBe("1:08")
    expect(Scrubber.clock(3_725_000)).toBe("1:02:05")
  })

  test("the phase comes from journal timestamps, never the render clock", () => {
    const running: Activity.Activity = { ...activity, status: "running" }
    const end = activity.records.at(-1)!.occurredAt!
    for (const subject of [activity, running]) {
      for (const cursor of [undefined, ...activity.records.map((record) => record.sequence!)]) {
        const phases = [end, end + 60_000, end + 86_400_000].map((now) =>
          Scrubber.layout(subject, 120, cursor, now).phase
        )
        expect(new Set(phases).size).toBe(1)
      }
    }
    expect(Scrubber.layout(activity, 120, 204, end + 86_400_000).phase).toBe("Implementing")
  })

  test("a column resolves to the last record at or before it", () => {
    const layout = Scrubber.layout(activity, 120)
    expect(Scrubber.layout(activity, 120, Scrubber.seqAt(layout, 0)).knob).toBe(0)
    expect(Scrubber.seqAt(layout, 1)).toBeGreaterThanOrEqual(Scrubber.seqAt(layout, 0))
    expect(Scrubber.seqAt(layout, layout.track - 1)).toBe(activity.records.at(-1)!.sequence!)
    const tick = layout.ticks[0]!
    expect(Scrubber.seqAt(layout, tick.column)).toBeGreaterThanOrEqual(tick.seq)
  })
})

describe("scrubber navigation", () => {
  const opened = activity.records.filter((record) => record.kind === "control.agent.turn-opened").map((record) =>
    record.sequence!
  )

  test("left and right step frame to frame; brackets step event to event", () => {
    expect(Scrubber.key(activity, undefined, "left")).toBe(opened.at(-1))
    expect(Scrubber.key(activity, opened[3], "right")).toBe(opened[4])
    expect(Scrubber.key(activity, opened[3], "left")).toBe(opened[2])
    expect(Scrubber.key(activity, opened[0], "left")).toBe(opened[0])
    // From inside a frame the arrows reach the neighbouring frames, never the same one.
    expect(Scrubber.key(activity, opened[3]! + 1, "left")).toBe(opened[2])
    expect(Scrubber.key(activity, opened[3]! + 1, "right")).toBe(opened[4])
    expect(Scrubber.key(activity, opened[0], "home")).toBe(activity.records[0]!.sequence)
    expect(Scrubber.key(activity, opened[0], "end")).toBe(activity.records.at(-1)!.sequence!)
    const [edit, verdict] = model.milestones
    expect(Scrubber.key(activity, opened[0], "]")).toBe(edit!.seq)
    expect(Scrubber.key(activity, edit!.seq, "]")).toBe(verdict!.seq)
    expect(Scrubber.key(activity, verdict!.seq, "[")).toBe(edit!.seq)
    expect(Scrubber.key(activity, opened[0], "x")).toBeUndefined()
  })

  test("a position names the numbered step it happened in", () => {
    const edit = model.milestones[0]!
    const id = Scrubber.target(transcript, edit.seq)
    const cell = cells.find((each) => each.id === id)!
    expect(cell.calls.some((call) => call.subject.includes("approvals.ts") || call.flow === "patch")).toBe(true)
    // Every frame that produced a cell lands on one of its own cells.
    for (const [index, seq] of opened.entries()) {
      const landed = cells.find((each) => each.id === Scrubber.target(transcript, seq))
      if (landed !== undefined) expect(landed.frame).toBeLessThanOrEqual(index + 1)
    }
  })

  test("a step reads its frame's line and callouts from the shared fold", () => {
    const tested = cells.find((cell) => Scrubber.step(transcript, cell).line?.verb === "ran")!
    const step = Scrubber.step(transcript, tested)
    expect(step.line?.subject).toContain("bun test")
    expect(step.line?.result).toBe("exit 0")
    expect(Scrubber.outcome(step.line!)).toBe("exit 0")
  })

  test("a later turn keeps the earlier turn's steps readable", () => {
    const next = Transcript.user(transcript, "next request", false, Date.now())
    expect(next.activity).toEqual(Activity.empty)
    const tested = cells.find((cell) => Scrubber.step(transcript, cell).line?.verb === "ran")!
    expect(Scrubber.step(next, tested).line).toEqual(Scrubber.step(transcript, tested).line)
  })
})
