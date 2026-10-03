/**
 * Behavioral projection contract checks for Monitor.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { MonitorCardSchema } from "../../src/MonitorCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Monitor.ts"

cardContract("Monitor", MonitorCardSchema, fixtures)

describe("Monitor usage boundaries", () => {
  test("phases and cells retain stable IDs before summaries arrive", () => {
    const phase = MonitorCardSchema.parse(fixtures.running).attempts[0]!.phases[0]!
    expect(phase).toMatchObject({ id: "attempt-1-check", title: "Ran checks · 2 failed" })
    expect(phase.cells[0]).toMatchObject({ id: "attempt-1-check-run", label: "Ran pnpm test · 2 failed" })
    expect(phase).not.toHaveProperty("summary")
    expect(phase.cells[0]).not.toHaveProperty("explain")
  })

  test("phase and cell IDs are required independently of model summaries", () => {
    for (const location of ["phase", "cell"] as const) {
      const changed = structuredClone(fixtures.summarized)
      const phase = changed.attempts[0]!.phases[0]!
      Reflect.deleteProperty(location === "phase" ? phase : phase.cells[0]!, "id")
      expect(MonitorCardSchema.safeParse(changed).success).toBe(false)
    }
  })

  test("steps and cells accept the frozen state and kind vocabulary", () => {
    for (const state of ["done", "current", "waiting", "failed", "next", "held"] as const) {
      const changed = structuredClone(fixtures.running)
      changed.attempts[0]!.steps[0]!.state = state
      changed.attempts[0]!.graph[0]!.state = state
      expect(MonitorCardSchema.safeParse(changed).success).toBe(true)
    }
    const changed = structuredClone(fixtures.running)
    changed.attempts[0]!.phases[0]!.cells[0]!.kind = "answer"
    expect(MonitorCardSchema.safeParse(changed).success).toBe(true)
  })

  test("step I/O preserves named arbitrary values inside its attempt", () => {
    const changed = structuredClone(fixtures.running)
    changed.attempts[0]!.steps[0]!.input = [{ name: "request", value: { prompt: "Fix", nested: [null, true] } }]
    changed.attempts[0]!.steps[0]!.output = [{ name: "result", value: { ok: true, metadata: { commit: "r1" } } }]
    expect(MonitorCardSchema.parse(changed)).toEqual(changed)
    expect(changed.attempts[0]!.steps[0]!.agent).toEqual({ name: "reviewer", model: "gpt-6.1-sol" })
  })
  test("token counts accept zero and reject negative or fractional tokens", () => {
    const base = MonitorCardSchema.parse(fixtures.running)
    for (const value of [0, 1, -1, 0.5]) {
      expect(MonitorCardSchema.safeParse({ ...base, tokens: value }).success).toBe(value === 0 || value === 1)
      const changed = structuredClone(base)
      changed.attempts[0]!.phases[0]!.cells[0]!.tokens = value
      expect(MonitorCardSchema.safeParse(changed).success).toBe(value === 0 || value === 1)
    }
  })
  test.each(["time_s", "cost_usd"] as const)(
    "%s accepts zero/fractions and rejects negative/nonfinite values",
    (field) => {
      const base = MonitorCardSchema.parse(fixtures.running)
      for (const value of [0, 0.01, -1, NaN, Infinity]) {
        expect(MonitorCardSchema.safeParse({ ...base, [field]: value }).success).toBe(value === 0 || value === 0.01)
      }
    }
  )
  test("phase and cell durations accept zero/fractions and reject negative values", () => {
    const base = MonitorCardSchema.parse(fixtures.running)
    for (const value of [0, 0.25, -1]) {
      const phase = structuredClone(base)
      phase.attempts[0]!.phases[0]!.took_s = value
      expect(MonitorCardSchema.safeParse(phase).success).toBe(value >= 0)
      const cell = structuredClone(base)
      cell.attempts[0]!.phases[0]!.cells[0]!.took_s = value
      expect(MonitorCardSchema.safeParse(cell).success).toBe(value >= 0)
    }
  })
})
