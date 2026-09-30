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

describe("timeline event labels", () => {
  test("the live end names completion in product words", () => {
    const event = Scrubber.event(activity)
    expect(event.label).toBe("Done")
    expect(event.index).toBe(event.total)
    expect(event.total).toBeGreaterThan(0)
    expect(event.label).not.toMatch(/completed|sufficiency|unmoved|claim/)
  })

  test("the selected edit names the file and never leaks a later outcome", () => {
    const edit = model.milestones[0]!
    const event = Scrubber.event(activity, edit.seq)
    expect(event.label).toContain("approvals.ts")
    expect(event.label).not.toContain("Done")
    expect(event.index).toBeLessThan(event.total)
  })

  test("empty activity has no invented event", () => {
    expect(Scrubber.event(Activity.empty)).toEqual({ label: "", tone: "text", index: 0, total: 0 })
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
