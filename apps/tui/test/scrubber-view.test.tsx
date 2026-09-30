import { testRender } from "@opentui/react/test-utils"
import { afterEach, describe, expect, test } from "bun:test"
import { ActivityView } from "../src/activity-view.tsx"
import * as Activity from "../src/activity.ts"
import * as Scrubber from "../src/scrubber.ts"
import * as Session from "../src/session.ts"
import * as View from "../src/view.tsx"

const fixture = new URL("./fixtures/timeline-worker.jsonl", import.meta.url).pathname
const activity = Session.restore(Session.load(fixture)).transcript.activity!
const model = Activity.model(activity)

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
})

/** The dock keeps one blank row above itself. */
const top = 1

const draw = async (width: number, cursor?: number) => {
  const selected: Array<number> = []
  const paused: Array<boolean> = []
  setup = await testRender(
    <box style={{ width, flexDirection: "column" }}>
      <ActivityView
        activity={activity}
        width={width}
        now={Date.now()}
        title="Worker"
        cursor={cursor}
        focused={cursor !== undefined}
        onSelect={(seq) => selected.push(seq)}
        onPause={() => paused.push(true)}
      />
    </box>,
    { width, height: 8 }
  )
  await setup.renderOnce()
  return { frame: setup.captureCharFrame(), selected, paused }
}

describe("the scrubber on screen", () => {
  test("draws labelled phases, tick labels, the pause button, and phase with elapsed time", async () => {
    const { frame } = await draw(120)
    expect(frame).toContain("Researching")
    expect(frame).toContain("approvals.ts")
    expect(frame).toContain("completed")
    expect(frame).toContain("Pause")
    expect(frame).toContain("Done")
    expect(frame).toMatch(/\d+:\d{2}/)
    expect(frame).toContain("●")
  })

  test("never draws wider than the terminal", async () => {
    for (const width of [120, 60, 30]) {
      const { frame } = await draw(width)
      for (const line of frame.split("\n")) expect(line.trimEnd().length).toBeLessThanOrEqual(width)
      setup?.renderer.destroy()
      setup = undefined
    }
  })

  test("a click on a tick label jumps to its milestone", async () => {
    const { selected } = await draw(120)
    const layout = Scrubber.layout(activity, 120)
    const tick = layout.ticks.find((each) => each.label === "approvals.ts")!
    await setup!.mockMouse.click(layout.lead + tick.left + 1, top + tick.row)
    expect(selected).toEqual([model.milestones[0]!.seq])
  })

  test("a click on the track jumps to the position under it, and Pause pauses", async () => {
    const { selected, paused } = await draw(120)
    const layout = Scrubber.layout(activity, 120)
    const trackRow = top + layout.rows + 1
    await setup!.mockMouse.click(layout.lead, trackRow)
    expect(selected).toEqual([Scrubber.seqAt(layout, 0)])
    await setup!.mockMouse.click(2, trackRow)
    expect(paused).toEqual([true])
  })

  test("a paused cursor moves the knob and names the phase there", async () => {
    const stuck = model.bands.find((band) => band.phase === "stuck")!
    const { frame } = await draw(120, stuck.seq)
    expect(frame).toContain("Stuck")
    expect(frame).toContain("Live")
  })
})

describe("the default cell", () => {
  const call = (flow: string, subject: string, extra: object = {}) => ({
    flow,
    subject,
    status: "ok" as const,
    startedAt: 0,
    endedAt: 0,
    ...extra
  })
  const cell = {
    kind: "cell" as const,
    id: "8",
    index: 2,
    prose: "Delegate the fix.",
    source: "const result = await ctx.call(\"agent.delegate\", {\n  prompt: \"Fix math.js\"\n})",
    status: "done" as const,
    calls: [
      call("agent.delegate", "Fix math.js"),
      call("ui.publish", "status"),
      call("monitor.watch", "ci"),
      call("bash", "node check.mjs", { exit: 0 })
    ],
    printed: "one\ntwo",
    startedAt: 0,
    endedAt: 38_000,
    turn: 0,
    frame: 2
  }
  const draw = async (item: typeof cell, expanded: boolean) => {
    setup = await testRender(
      <box style={{ width: 90 }}>
        <View.Entry item={item} now={0} tick="" expanded={expanded} step={{ notes: [] }} />
      </box>,
      { width: 90, height: 24 }
    )
    await setup.renderOnce()
    return setup.captureCharFrame()
  }

  test("shows only what the program did, and Ctrl+O shows the program", async () => {
    const shown = await draw(cell, false)
    expect(shown).toContain("$ bash node check.mjs  exit 0")
    for (const hidden of ["ctx.call", "agent.delegate", "ui.publish", "monitor.watch", "printed", "0ms", "38.0s"]) {
      expect(shown).not.toContain(hidden)
    }
    setup!.renderer.destroy()
    const expanded = await draw(cell, true)
    for (const program of ["ctx.call", "agent.delegate", "ui.publish", "one", "0ms"]) {
      expect(expanded).toContain(program)
    }
  })

  test("draws nothing for a rejected cell or one that only ran plumbing", async () => {
    expect((await draw({ ...cell, calls: cell.calls.slice(0, 2) }, false)).trim()).toBe("")
    setup!.renderer.destroy()
    expect((await draw({ ...cell, status: "rejected" as never, error: "syntax" } as never, false)).trim()).toBe("")
  })
})

describe("numbered steps", () => {
  const cell = {
    kind: "cell" as const,
    id: "7",
    index: 13,
    prose: "Spot-check the two named cases and finish.",
    source: "await ctx.call(\"bash\", { command: \"pytest -rA -k slash\" })",
    status: "done" as const,
    calls: [],
    printed: "",
    startedAt: 0,
    endedAt: 1_200,
    turn: 0,
    frame: 1
  }
  const line = {
    spanId: "frame-1",
    frame: 1,
    verb: "Ran",
    subject: "pytest -rA -k slash",
    result: "3 passed",
    failed: false,
    wrote: false
  }
  const notes = [
    {
      seq: 4,
      spanId: "frame-1",
      tone: "good" as const,
      title: "sufficiency",
      body: "bash failed before the change and passed after it.",
      evidence: ["pytest -rA", "pytest -rA -k slash"]
    },
    { seq: 5, spanId: "frame-1", tone: "bad" as const, title: "claim refused", body: "complete 0, overclaims 1." }
  ]

  test("a selected step reads its number, its line, its outcome at the right, the quoted intent, and its callouts", async () => {
    setup = await testRender(
      <box style={{ width: 90 }}>
        <View.Entry item={cell} now={0} tick="" expanded={false} selected step={{ line, notes }} />
      </box>,
      { width: 90, height: 24 }
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    const header = frame.split("\n").find((row) => row.includes("13"))!
    expect(header).toMatch(/▾ 13\s+Ran pytest -rA -k slash\s+3 passed\s+1\.2s/)
    expect(frame).toContain("“Spot-check the two named cases and finish.”")
    expect(frame).not.toContain("✓ sufficiency")
    expect(frame).not.toContain("complete 0, overclaims 1.")
    expect(frame).toContain("pytest -rA -k slash")
    expect(frame).toContain("△ claim refused")
  })

  test("keeps routine tree diagnostics behind expand while retaining their evidence", async () => {
    const diagnostic = {
      seq: 6,
      spanId: "frame-1",
      tone: "warn" as const,
      title: "unmoved",
      body: "The tree did not change.",
      evidence: ["a".repeat(64)]
    }
    for (const expanded of [false, true]) {
      setup = await testRender(
        <box style={{ width: 90 }}>
          <View.Entry item={cell} now={0} tick="" expanded={expanded} step={{ line, notes: [...notes, diagnostic] }} />
        </box>,
        { width: 90, height: 30 }
      )
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame.includes("unmoved")).toBe(expanded)
      expect(frame.includes("a".repeat(64))).toBe(expanded)
      expect(frame.includes("sufficiency")).toBe(expanded)
      expect(frame.includes("complete 0, overclaims 1.")).toBe(expanded)
      expect(frame).toContain("△ claim refused")
      setup.renderer.destroy()
      setup = undefined
    }
  })

  test("a click on the header folds the step to one line and keeps its callouts", async () => {
    setup = await testRender(
      <box style={{ width: 90 }}>
        <View.Entry item={cell} now={0} tick="" expanded={false} selected step={{ line, notes }} />
      </box>,
      { width: 90, height: 24 }
    )
    await setup.renderOnce()
    await setup.mockMouse.click(4, 0)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("▸ 13")
    expect(frame).not.toContain("Spot-check")
    expect(frame).toContain("△ claim refused")
  })
})

test("approval subjects and keys remain separate across terminal widths", async () => {
  const subject = "node --test test/parser/quoted-arguments-and-unicode-paths-regression.test.mjs"
  for (const width of [40, 60, 80, 120]) {
    setup = await testRender(
      <box style={{ width }}>
        <View.Approval
          width={width}
          request={{ flow: "bash", subject, always: true }}
          scope="all bash"
          armed
          more={0}
        />
      </box>,
      { width, height: 12 }
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    const lines = frame.split("\n").map((line) => line.trim())
    expect(frame).toContain("y allow  n deny  a all bash")
    if (width < 90) {
      expect(lines.filter((line) => line !== "" && !line.startsWith("y allow")).join("")).toBe(`? bash ${subject}`)
    } else {
      expect(frame).toContain(subject + "  ")
    }
    setup.renderer.destroy()
    setup = undefined
  }
})
