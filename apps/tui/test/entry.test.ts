import { describe, expect, it } from "bun:test"
import * as Transcript from "../src/transcript.ts"
import * as View from "../src/view.tsx"

const props = (item: Transcript.Item, now: number, tick: string): View.EntryProps => ({
  item,
  now,
  tick,
  expanded: false
})

describe("transcript rows under the clock", () => {
  it("keeps a settled row's drawing when only the clock moves", () => {
    const item = Transcript.user(Transcript.empty, "hello", false, 1).items[0]!
    expect(View.sameEntry(props(item, 100, "⠋"), props(item, 200, "⠙"))).toBe(true)
  })

  it("redraws a cell still being written and a running shell on every tick", () => {
    const streaming = Transcript.apply(
      Transcript.apply(Transcript.empty, { _tag: "model-requested" } as never, 1),
      { _tag: "model-delta", delta: { type: "text-delta", text: "Looking" } } as never,
      2
    )
    const cell = streaming.items.at(-1)!
    expect(cell.kind).toBe("cell")
    expect(View.sameEntry(props(cell, 100, "⠋"), props(cell, 200, "⠙"))).toBe(false)
    const running = Transcript.shellStart(Transcript.empty, "sleep 1", false, 1)
    const shell = running.items[0]!
    expect(View.sameEntry(props(shell, 100, "⠋"), props(shell, 200, "⠙"))).toBe(false)
    const finished = Transcript.shellDone(running, shell.id, {
      command: "sleep 1",
      output: "",
      exitCode: 0,
      cancelled: false
    })
    const settled = finished.items[0]!
    expect(View.sameEntry(props(settled, 100, "⠋"), props(settled, 200, "⠙"))).toBe(true)
  })

  it("redraws a row whose item, expansion or selection changed", () => {
    const first = Transcript.user(Transcript.empty, "hello", false, 1)
    const item = first.items[0]!
    const other = Transcript.user(first, "again", false, 2).items[1]!
    expect(View.sameEntry(props(item, 1, "⠋"), props(other, 1, "⠋"))).toBe(false)
    expect(View.sameEntry(props(item, 1, "⠋"), { ...props(item, 1, "⠋"), expanded: true })).toBe(false)
    expect(View.sameEntry(props(item, 1, "⠋"), { ...props(item, 1, "⠋"), selected: true })).toBe(false)
  })
})
