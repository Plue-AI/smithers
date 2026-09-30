import { rgbToHex } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, describe, expect, test } from "bun:test"
import { ActivityView } from "../src/activity-view.tsx"
import * as Activity from "../src/activity.ts"
import * as Approvals from "../src/approvals.ts"
import * as Scrubber from "../src/scrubber.ts"
import * as Session from "../src/session.ts"
import { color } from "../src/theme.ts"
import * as View from "../src/view.tsx"

const fixture = new URL("./fixtures/timeline-worker.jsonl", import.meta.url).pathname
const activity = Session.restore(Session.load(fixture)).transcript.activity!

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
})

const draw = async (width: number, cursor?: number, focused = true, drawn: Activity.Activity = activity) => {
  const selected: Array<number> = []
  const paused: Array<boolean> = []
  setup = await testRender(
    <box style={{ width, flexDirection: "column" }}>
      <ActivityView
        activity={drawn}
        width={width}
        now={Date.now()}
        title="Worker"
        cursor={cursor}
        focused={focused}
        onSelect={(seq) => selected.push(seq)}
        onPause={() => paused.push(true)}
      />
      <text>Transcript stays here</text>
    </box>,
    { width, height: 8 }
  )
  await setup.renderOnce()
  return { frame: setup.captureCharFrame(), selected, paused }
}

describe("timeline overlay", () => {
  test("stays absent until focused", async () => {
    const { frame } = await draw(80, undefined, false)
    expect(frame.split("\n")[0]).toContain("Transcript stays here")
    expect(frame).not.toContain("esc Back")
    expect(frame).not.toContain("Pause")
  })

  test("a person's stop reads `Stopped` in the faint color, never the failure red", async () => {
    const running = {
      records: activity.records.filter((record) => record.kind?.startsWith("control.run.") !== true),
      status: "running" as const
    }
    const end = activity.records.at(-1)!.occurredAt!
    const stopped = Activity.finish(running, "cancelled", end, "Stopped")
    const failed = Activity.finish(running, "failed", end, "boom")
    const tone = async (drawn: Activity.Activity, label: string) => {
      await draw(80, undefined, true, drawn)
      const spans = setup!.captureSpans().lines.flatMap((line) => line.spans).filter((span) =>
        span.text.includes(label)
      )
      setup!.renderer.destroy()
      setup = undefined
      expect(spans.length).toBeGreaterThan(0)
      return spans.map((span) => rgbToHex(span.fg))
    }
    for (const fg of await tone(stopped, "Stopped")) expect(fg).toBe(color.faint)
    for (const fg of await tone(failed, "Failed")) expect(fg).toBe(color.danger)
  })

  test.each([110, 80, 40])("uses one row at width %s and retains navigation", async (width) => {
    const { frame } = await draw(width)
    const rows = frame.split("\n")
    expect(rows[0]).toContain("Done")
    expect(rows[0]).toContain("esc Back")
    expect(rows[1]).toContain("Transcript stays here")
    expect(frame).not.toContain("completed")
    expect(frame).not.toContain("Researching")
    expect(frame).not.toContain("Pause")
    for (const line of rows) expect(line.trimEnd().length).toBeLessThanOrEqual(width)
  })

  test("arrows inspect earlier and later frames while Back leaves inspection", async () => {
    const cursor = Activity.openings(activity)[3]!
    const { frame, selected, paused } = await draw(80, cursor)
    const row = frame.split("\n")[0]!
    await setup!.mockMouse.click(row.indexOf("◂"), 0)
    await setup!.mockMouse.click(row.indexOf("▸"), 0)
    await setup!.mockMouse.click(row.indexOf("esc Back") + 1, 0)
    expect(selected).toEqual([Scrubber.key(activity, cursor, "left")!, Scrubber.key(activity, cursor, "right")!])
    expect(paused).toEqual([true])
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
    expect(shown).toContain("✓ node check.mjs  exit 0")
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
  const keys = "y Allow once  n Deny  a Allow commands this run"
  for (const width of [40, 60, 80, 120]) {
    setup = await testRender(
      <box style={{ width }}>
        <View.Approval
          width={width}
          request={{ flow: "bash", subject }}
          choices={Approvals.choices({ action: "proc:spawn", flow: "bash", always: true })}
          armed
          more={0}
          lines={4}
        />
      </box>,
      { width, height: 12 }
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    const lines = frame.split("\n").map((line) => line.trim()).filter((line) => line !== "")
    const shown = lines.slice(0, lines.findIndex((line) => line.startsWith("y Allow")))
    expect(frame.replace(/\s+/g, " ")).toContain(keys.replace(/\s+/g, " "))
    expect(frame).not.toContain("{")
    if (width < 90) expect(shown.join("")).toBe(`? run ${subject}`)
    else expect(frame).toContain("? run node --test")
    setup.renderer.destroy()
    setup = undefined
  }
})

test("an approval puts its keys beside the command only when both fit whole in the row's width", async () => {
  const rows = async (width: number, subject: string, worker?: string) => {
    setup = await testRender(
      <box style={{ width }}>
        <View.Approval
          width={width}
          request={{ flow: "bash", subject }}
          choices={Approvals.choices({ action: "proc:spawn", flow: "bash", always: true })}
          armed
          more={0}
          lines={4}
          {...(worker === undefined ? {} : { worker })}
        />
      </box>,
      { width: 140, height: 8 }
    )
    await setup.renderOnce()
    const lines = setup.captureCharFrame().split("\n").map((line) => line.trim()).filter((line) => line !== "")
    setup.renderer.destroy()
    setup = undefined
    return lines
  }
  const keys = "y Allow once  n Deny  a Allow commands this run"
  expect(await rows(82, "git status --porcelain", "Fix math.js")).toEqual([
    "↳ Fix math.js ? run git status --porcelain",
    keys
  ])
  const long = "node --test test/parser/quoted-arguments-regression.test.mjs"
  expect(await rows(110, long)).toEqual([`? run ${long}`, keys])
  const [row] = await rows(110, "git status --porcelain", "Fix math.js")
  expect(row!.replace(/\s+/g, " ")).toBe(`↳ Fix math.js ? run git status --porcelain ${keys.replace(/\s+/g, " ")}`)
})

test("an edit approval shows its changed lines, bounded, and offers the change's keys", async () => {
  const request = {
    flow: "edit",
    subject: "math.js",
    preview: {
      added: 3,
      removed: 1,
      lines: [
        "-export function add(a, b) { return a - b; }",
        "+export function add(a, b) { return a + b; }",
        "+// one",
        "+// two"
      ]
    }
  }
  setup = await testRender(
    <box style={{ width: 80 }}>
      <View.Approval
        width={80}
        request={request}
        choices={Approvals.choices({ action: "fs:write", flow: "edit", always: true })}
        armed
        more={0}
        lines={2}
      />
    </box>,
    { width: 80, height: 12 }
  )
  await setup.renderOnce()
  const lines = setup.captureCharFrame().split("\n").map((line) => line.trim()).filter((line) => line !== "")
  expect(lines).toEqual([
    "? edit math.js  +3 −1",
    "- export function add(a, b) { return a - b; }",
    "+ export function add(a, b) { return a + b; }",
    "…",
    "y Allow once  n Deny change  a Allow edits this run"
  ])
})
