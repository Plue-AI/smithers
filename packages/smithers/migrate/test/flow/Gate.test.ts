/**
 * The gates, over the real fixtures they were written for: a project whose
 * database still holds runs, a project whose runs have all finished, and a
 * pack whose constructs have no counterpart.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Gate from "@smthrs/migrate/flow/Gate"
import * as Report from "@smthrs/migrate/Report"
import * as Scan from "@smthrs/migrate/Scan"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { copyFixture, fixture, hashTree, nodeLayer } from "../fixtures/helpers.ts"

const now = 1_780_000_000_000

const buildDb = async (root: string): Promise<void> => {
  const module = await import(pathToFileURL(join(fixture("persisted-db"), "make-db.mjs")).href) as {
    build: (target: string, now: number) => string
  }
  module.build(root, now)
}

const scanOf = (root: string) => Scan.scan(root, { runState: { now } }).pipe(Effect.provide(nodeLayer))

describe("Gate.incompleteScan", () => {
  it("ignores unrelated warnings and names every unread path without dropping their causes", () => {
    const unrelated = { code: "mixed-authoring-api", file: "a.tsx", message: "Mixed API" }
    expect(Gate.incompleteScan([unrelated])).toBeUndefined()
    const one = Gate.incompleteScan([unrelated, {
      code: "incomplete-scan",
      file: "secret/a.ts",
      message: "permission denied: a"
    }])
    expect(one?.code).toBe("unsupported-project")
    expect(one?.message).toContain("1 path was skipped. Make it readable")
    expect(one?.details).toBe("permission denied: a")

    const two = Gate.incompleteScan([
      { code: "incomplete-scan", file: "secret/a.ts", message: "permission denied: a" },
      unrelated,
      { code: "incomplete-scan", file: "secret/b.ts", message: "permission denied: b" }
    ])
    expect(two?.code).toBe("unsupported-project")
    expect(two?.message).toContain("2 paths were skipped. Make them readable")
    expect(two?.details).toBe("permission denied: a\npermission denied: b")
  })
})

describe("Gate.evaluate", () => {
  it.effect("passes scan and plan whatever the project holds", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      yield* Effect.promise(() => buildDb(root))
      const scan = yield* scanOf(root)

      expect(scan.runState.verdict).toBe("blocked")
      yield* Gate.evaluate(scan, { mode: "scan" })
      yield* Gate.evaluate(scan, { mode: "plan" })
    }))

  it.effect("refuses apply while a database still holds runs", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      yield* Effect.promise(() => buildDb(root))
      const before = hashTree(root)
      const scan = yield* scanOf(root)

      const failure = yield* Effect.flip(Gate.evaluate(scan, { mode: "apply" }))

      expect(failure.code).toBe("run-state-blocked")
      expect(failure.message).toContain("--acknowledge-run-state")
      expect(failure.details).toContain("smithers cancel")
      // A refused gate is a refused gate: nothing was read in write mode.
      expect(Object.fromEntries(hashTree(root))).toEqual(Object.fromEntries(before))
    }))

  it.effect("refuses apply on a history-only project too", () =>
    Effect.gen(function*() {
      // The fixture without its database still carries `.smithers/executions`,
      // which is 0.x run state whose runs have all finished.
      const root = copyFixture("persisted-db")
      const scan = yield* scanOf(root)

      expect(scan.runState.verdict).toBe("history-only")
      const failure = yield* Effect.flip(Gate.evaluate(scan, { mode: "apply" }))

      expect(failure.code).toBe("run-state-blocked")
      expect(failure.message).toContain("history-only")
    }))

  it.effect("proceeds past run state once the operator acknowledges it", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      yield* Effect.promise(() => buildDb(root))
      const scan = yield* scanOf(root)

      yield* Gate.evaluate(scan, { mode: "apply", acknowledgeRunState: true, allowUnsafe: "all" })
    }))

  it.effect("refuses apply while a construct has no counterpart, and names each one", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const scan = yield* scanOf(root)
      const unsafe = Gate.unsafeConstructs(scan)

      expect(unsafe.length).toBeGreaterThan(0)
      const failure = yield* Effect.flip(
        Gate.evaluate(scan, { mode: "apply", acknowledgeRunState: true })
      )

      expect(failure.code).toBe("unsafe-blocked")
      for (const construct of unsafe) expect(failure.message).toContain(construct)
      expect(failure.message).toContain("--allow-unsafe")
    }))

  it.effect("waives only the constructs the operator listed", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const scan = yield* scanOf(root)
      const unsafe = Gate.unsafeConstructs(scan)
      const first = unsafe[0]!

      expect(Gate.unwaived(scan, [first])).toEqual(unsafe.slice(1))
      expect(Gate.unwaived(scan, "all")).toEqual([])
      expect(Gate.unwaived(scan, undefined)).toEqual(unsafe)

      yield* Gate.evaluate(scan, { mode: "apply", acknowledgeRunState: true, allowUnsafe: unsafe })
    }))

  it.effect("refuses apply over a scan that left part of the project unread, and names what it skipped", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const deep = join(root, ...Array.from({ length: 14 }, (_, index) => `d${index}`))
      mkdirSync(deep, { recursive: true })
      writeFileSync(join(deep, "lost.jsx"), "/** @jsxImportSource smthrs */\n")
      const scan = yield* scanOf(root)

      expect(scan.detection.warnings.some((warning) => warning.code === "incomplete-scan")).toBe(true)
      // Reading is still allowed; editing an incomplete plan is not.
      yield* Gate.evaluate(scan, { mode: "plan" })
      const failure = yield* Effect.flip(Gate.evaluate(scan, { mode: "apply" }))
      expect(failure.code).toBe("unsupported-project")
      expect(failure.message).toContain("did not read the whole project")
      expect(failure.details).toContain("d0/d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/d12")
      // The report-side gate reads the same warnings the report carries.
      const report = Scan.toReport(scan, "apply", "2026-09-01T00:00:00.000Z")
      const fromReport = yield* Effect.flip(Gate.evaluateReport(report, { mode: "apply" }))
      expect(fromReport.code).toBe("unsupported-project")
    }))

  it.effect("passes a clean project with nothing unsafe", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const scan = yield* scanOf(root)

      expect(scan.runState.verdict).toBe("clean")
      expect(Gate.instructions(scan)).toEqual([])
      yield* Gate.evaluate(scan, { mode: "apply" })
    }))
})

describe("Gate.evaluateReport", () => {
  it.effect("keeps both run-state verdicts blocked after a durable report is restored", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const history = yield* scanOf(root)
      yield* Effect.promise(() => buildDb(root))
      const live = yield* scanOf(root)
      for (
        const [scan, verdict, instruction] of [
          [history, "history-only", "archive the database"],
          [live, "blocked", "smithers cancel"]
        ] as const
      ) {
        expect(scan.runState.verdict).toBe(verdict)
        const saved = Report.toJson(Scan.toReport(scan, "apply", "2026-09-01T00:00:00.000Z"))
        const report = Schema.decodeUnknownSync(Report.MigrationReport)(JSON.parse(saved))
        expect(report.runState.verdict).toBe(verdict)
        expect(report.runState.instructions.some((line) => line.includes(instruction))).toBe(true)
        const failure = yield* Effect.flip(Gate.evaluateReport(report, { mode: "apply" }))
        expect(failure.code).toBe("run-state-blocked")
        expect(failure.message).toContain(`(${verdict})`)
        expect(failure.details).toContain(instruction)
        expect(failure.details).toBe(report.runState.instructions.join("\n"))
        yield* Gate.evaluateReport(report, { mode: "plan" })
        yield* Gate.evaluateReport(report, { mode: "apply", acknowledgeRunState: true, allowUnsafe: "all" })
      }
    }))

  it.effect("requires an explicit unsafe construct waiver on the report replay path", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const scan = yield* scanOf(root)
      const report = Scan.toReport(scan, "apply", "2026-09-01T00:00:00.000Z")
      const unsafe = Gate.unsafeInReport(report)
      expect(unsafe).toEqual(["UI"])
      expect(Gate.unwaivedInReport(report, "all")).toEqual([])
      expect(Gate.unwaivedInReport(report, [])).toEqual(["UI"])
      expect(Gate.unwaivedInReport(report, ["UI"])).toEqual([])
      const refusal = yield* Effect.flip(Gate.evaluateReport(report, { mode: "apply" }))
      expect(refusal.code).toBe("unsafe-blocked")
      expect(refusal.message).toContain("1 construct has no safe translation")
      expect(refusal.message).toContain("UI")
      expect(refusal.details).toBe("UI")
      yield* Gate.evaluateReport(report, { mode: "apply", allowUnsafe: ["UI"] })
      yield* Gate.evaluateReport(report, { mode: "apply", allowUnsafe: "all" })
    }))
})
