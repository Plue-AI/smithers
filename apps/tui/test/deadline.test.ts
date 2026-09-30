import { describe, expect, it } from "bun:test"
import * as Deadline from "../src/deadline.ts"

const fact = (sequence: number, kind: string, run: Record<string, unknown>) => ({
  sequence,
  kind,
  runId: "run-1",
  occurredAt: sequence,
  payload: { factVersion: 1, baseline: "created", run: { runId: "run-1", ...run } }
})

describe("run deadline", () => {
  it("reads the newest run fact's deadlineAt and ignores every other record", () => {
    expect(Deadline.deadlineAt([])).toBeUndefined()
    expect(Deadline.deadlineAt([fact(1, "control.run.accepted", {})])).toBeUndefined()
    expect(Deadline.deadlineAt([
      fact(1, "control.run.accepted", { deadlineAt: 100 }),
      fact(2, "control.agent.turn-opened", { deadlineAt: 999 }),
      { ...fact(3, "control.run.running", {}), payload: null },
      fact(4, "control.run.running", { deadlineAt: "soon" })
    ] as never)).toBe(100)
    expect(Deadline.deadlineAt([
      fact(1, "control.run.accepted", { deadlineAt: 100 }),
      fact(2, "control.run.running", { deadlineAt: 200 })
    ] as never)).toBe(200)
  })

  it("labels a deadline by clock time today, and with its date on another day", () => {
    const now = new Date(2026, 8, 30, 9, 0).getTime()
    const today = new Date(2026, 8, 30, 14, 32).getTime()
    const clock = new Date(today).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    expect(Deadline.label(today, now)).toBe(clock)
    const tomorrow = new Date(2026, 9, 1, 14, 32).getTime()
    expect(Deadline.label(tomorrow, now)).toBe(
      `${new Date(tomorrow).toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`
    )
  })

  it("is a panel row only while the run is live and has a deadline", () => {
    const now = new Date(2026, 8, 30, 9, 0).getTime()
    const events = [fact(1, "control.run.accepted", { deadlineAt: now + 60_000 })] as never
    expect(Deadline.row(events, true, now)).toEqual([
      { id: "deadline", label: `Deadline ${Deadline.label(now + 60_000, now)}`, details: [] }
    ])
    expect(Deadline.row(events, false, now)).toEqual([])
    expect(Deadline.row([], true, now)).toEqual([])
  })
})
