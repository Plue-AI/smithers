import { describe, expect, test } from "bun:test"
import * as Activity from "../src/activity.ts"
import * as DevTools from "../src/devtools.ts"
import type * as Flows from "../src/flows.ts"

/*
 * `/devtools` reads the shared projection: the terminal's own run through the
 * activity fold the timeline already uses, a flow tab's run through the
 * events its watch collected. The note is the same text `smthrs runs
 * devtools` prints.
 */

const at = (sequence: number, kind: string, payload: Record<string, unknown>, stamp: number) => ({
  sequence,
  kind,
  occurredAt: stamp,
  payload: { ...payload, at: stamp }
})
const events = [
  at(1, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }, 1000),
  at(2, "control.agent.cell-call-started", { flowName: "files.read", input: { path: "README.md" } }, 1100),
  at(3, "control.agent.cell-call-settled", { flowName: "files.read", outcome: "success", value: "# Smithers" }, 1600)
]
const run = (status: Flows.Run["status"], runId?: string): Flows.Run => ({
  id: "tab-1",
  flow: "review",
  by: "user",
  input: {},
  requested: "{}",
  status,
  startedAt: 0,
  ...(runId === undefined ? {} : { runId })
})
const options = (overrides: Partial<Parameters<typeof DevTools.note>[1]> = {}) => ({
  activity: undefined,
  run: () => undefined,
  journal: () => [],
  width: 80,
  ...overrides
})

describe("/devtools", () => {
  test("a flow tab's run is folded from its events with the run's own lifecycle word", () => {
    const text = DevTools.note(
      "tab-1",
      options({ run: (id) => id === "tab-1" ? run("done", "run-9") : undefined, journal: () => events })
    )
    const lines = text.split("\n")
    expect(lines[0]).toBe("run run-9 · review · completed · 2 spans · t = 600ms")
    expect(lines.slice(1, 4)).toEqual([
      "> ● run run-9 · review                                          600ms   run:run-9",
      "    ● frame 1 · openai:gpt-5.6-sol                              600ms   frame-1",
      "      ● files.read                                              500ms   call-1"
    ])
    expect(text).toContain("Frames 3")
    // The run's own lifecycle word, in the run card's vocabulary where it has one.
    for (
      const [status, word] of [
        ["running", "running"],
        ["failed", "failed"],
        ["cancelled", "cancelled"],
        ["waiting", "waiting-approval"],
        ["parked", "parked"],
        ["queued", "queued"]
      ] as const
    ) {
      expect(DevTools.model(run(status), events).root.status).toBe(word)
    }
    expect(DevTools.model(run("queued"), events).root.id).toBe("run:tab-1")
    expect(DevTools.note("tab-1", options({ run: () => run("requested"), journal: () => [] }))).toBe(
      "No history for tab-1 yet"
    )
  })

  test("a node argument inspects that node", () => {
    const text = DevTools.note("tab-1 call-1", options({ run: () => run("done", "run-9"), journal: () => events }))
    expect(text).toContain(">     ● files.read")
    expect(text).toContain("call · run run-9 · review / frame 1 · openai:gpt-5.6-sol / files.read · completed")
    expect(text).toContain("Output")
    expect(text).toContain("  # Smithers")
    expect(text).toContain("Frames 2")
  })

  test("no argument inspects this conversation's own run, and no run yet says so", () => {
    expect(DevTools.note("", options())).toBe("No run yet")
    let activity = Activity.empty
    activity = Activity.apply(
      activity,
      { _tag: "turn-opened", seat: "openai:gpt-5.6-sol", scope: "chat", frame: 0 } as never,
      1000
    )
    const text = DevTools.note("  ", options({ activity }))
    expect(text.split("\n")[0]).toMatch(/^run terminal · chat · running/)
    expect(DevTools.note(" frame-1", options({ activity }))).toContain("frame · ")
  })

  test("an unknown node and surplus words are refused, and the tab id is what the caller hydrates", () => {
    const flow = options({ run: () => run("done", "run-9"), journal: () => events })
    expect(DevTools.note("tab-1 nope", flow)).toBe("Unknown node: nope")
    expect(DevTools.note("tab-1 call-1 extra", flow)).toBe("Usage: /devtools [id] [node]")
    expect(DevTools.tabOf("  tab-1 call-1")).toBe("tab-1")
    expect(DevTools.tabOf("   ")).toBeUndefined()
  })

  test("an id that names no tab and no node of this conversation is refused in the tab command's words", () => {
    expect(DevTools.note("nope", options())).toBe("Unknown tab: nope")
    let activity = Activity.empty
    activity = Activity.apply(
      activity,
      { _tag: "turn-opened", seat: "openai:gpt-5.6-sol", scope: "chat", frame: 0 } as never,
      1000
    )
    expect(DevTools.note("nope", options({ activity }))).toBe("Unknown tab: nope")
    expect(DevTools.note("frame-1 call-1", options({ activity }))).toBe("Unknown tab: frame-1")
  })
})
