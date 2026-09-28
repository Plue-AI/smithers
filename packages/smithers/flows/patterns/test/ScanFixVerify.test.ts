import { describe, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Glob from "@smthrs/std/Glob"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as ScanFixVerify from "../src/ScanFixVerify.ts"
import { execute } from "./Execute.ts"
import { callsTo } from "./Graphs.ts"

// One stage flow per role, tagged with its own name. Core named a stage by the
// single capability it declared and counted calls by reading that capability
// back off key material; `@smthrs/flow` names a call by the callee's tag, so
// the shared `callsTo` counts exactly the same calls by that tag.
const flowNamed = (tag: string) =>
  Flow.make(tag, {
    payload: {
      input: Schema.optional(Schema.Unknown),
      iteration: Schema.optional(Schema.Unknown),
      issue: Schema.optional(Schema.Unknown),
      index: Schema.optional(Schema.Unknown),
      issues: Schema.optional(Schema.Unknown),
      fixes: Schema.optional(Schema.Unknown)
    },
    success: Schema.Unknown,
    error: Schema.Unknown,
    capabilities: [tag],
    body: Node.capture({ tag }, (payload) => Node.succeed(payload))
  })

const scan = flowNamed("sfv/scan")
const fix = flowNamed("sfv/fix")
const verify = flowNamed("sfv/verify")

interface Issue {
  readonly id: string
}

const scripted = (rounds: ReadonlyArray<ReadonlyArray<Issue>>) =>
(
  { iteration }: { readonly iteration: number }
): Effect.Effect<ReadonlyArray<Issue>> => Effect.succeed(rounds[iteration - 1] ?? [])

describe("ScanFixVerify", () => {
  it("declares a bounded scan, fan-out fix, and verify per retry", () => {
    const pattern = ScanFixVerify.make({
      scan,
      fix,
      verify,
      maxRetries: 2,
      maxIssues: 3,
      concurrency: 2
    })
    const graph = Graph.build(pattern, { input: { path: "src" } })

    expect(Flow.isFlow(pattern)).toBe(true)
    expect(callsTo(graph, "sfv/scan")).toHaveLength(2)
    expect(callsTo(graph, "sfv/fix")).toHaveLength(6)
    expect(callsTo(graph, "sfv/verify")).toHaveLength(2)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(4)
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const options = { scan, fix, verify, maxRetries: 1, maxIssues: 1, concurrency: 1 }
    const pattern = ScanFixVerify.make({ ...options, name: "lint-fix", description: "Fix what the linter found." })

    expect(pattern._tag).toBe("lint-fix")
    expect(pattern.description).toBe("Fix what the linter found.")
    expect(ScanFixVerify.make(options).description).toBeUndefined()
  })

  it("rejects bounds below one", () => {
    const options = { scan, fix, verify, maxRetries: 1, maxIssues: 1, concurrency: 1 }
    for (
      const invalid of [
        { ...options, maxRetries: 0 },
        { ...options, maxIssues: 0 },
        { ...options, concurrency: 0 }
      ]
    ) {
      expect(() => ScanFixVerify.make(invalid)).toThrow(
        expect.objectContaining({
          code: "invalid_decorator",
          message: "ScanFixVerify maxRetries, maxIssues, and concurrency must be positive safe integers"
        })
      )
    }
  })

  it.effect("fixes every issue, verifies once, and stops when the next scan is clean", () =>
    Effect.gen(function*() {
      const events: Array<string> = []
      const verified: Array<ReadonlyArray<Issue>> = []
      const report = yield* ScanFixVerify.run({ path: "src" }, {
        maxRetries: 3,
        concurrency: 1,
        scan: scripted([[{ id: "a" }, { id: "b" }], []]),
        fix: ({ index, issue }) =>
          Effect.sync(() => events.push(`start-${issue.id}`)).pipe(
            Effect.andThen(Effect.yieldNow),
            Effect.andThen(Effect.sync(() => events.push(`end-${issue.id}`))),
            Effect.as(`fixed-${index}`)
          ),
        verify: ({ issues }) =>
          Effect.sync(() => {
            verified.push(issues)
            return { resolved: false }
          })
      })

      expect(events).toEqual(["start-a", "end-a", "start-b", "end-b"])
      expect(verified).toHaveLength(1)
      expect(report.iterations).toBe(2)
      expect(report.remaining).toEqual([])
      expect(report.resolved).toBe(true)
      expect(report.verifications).toEqual([{ resolved: false }])
    }))

  it.effect("overlaps fixes up to the concurrency bound", () =>
    Effect.gen(function*() {
      const events: Array<string> = []
      let inFlight = 0
      let peak = 0
      yield* ScanFixVerify.run({ path: "src" }, {
        maxRetries: 1,
        concurrency: 2,
        scan: scripted([[{ id: "a" }, { id: "b" }, { id: "c" }]]),
        fix: ({ issue }) =>
          Effect.sync(() => {
            inFlight++
            peak = Math.max(peak, inFlight)
            events.push(`start-${issue.id}`)
          }).pipe(
            Effect.andThen(Effect.yieldNow),
            Effect.andThen(Effect.sync(() => {
              inFlight--
              events.push(`end-${issue.id}`)
            })),
            Effect.as(issue.id)
          ),
        verify: () => Effect.succeed({ resolved: false })
      })

      // Three issues at a bound of two: the third fix cannot start until one of
      // the first two has finished. Unbounded fan-out would peak at three and
      // start `c` before any fix ended.
      expect(peak).toBe(2)
      expect(events.indexOf("start-c")).toBeGreaterThan(events.indexOf("end-a"))
      expect(events).toEqual(["start-a", "start-b", "end-a", "start-c", "end-b", "end-c"])
    }))

  it.effect("fans out over the issues the scan returned, not a mid-round mutation", () =>
    Effect.gen(function*() {
      const fixed: Array<string> = []
      // A scanner that hands back a live array, and a fix that appends to it.
      // The fan-out is a snapshot of what the scan returned, so the appended
      // issue belongs to the next round's scan and never to this round.
      const found: Array<Issue> = [{ id: "a" }, { id: "b" }]
      let round = 0
      const report = yield* ScanFixVerify.run({ path: "src" }, {
        maxRetries: 1,
        concurrency: 1,
        scan: () => Effect.succeed(round++ === 0 ? found : []),
        fix: ({ index, issue }) =>
          Effect.sync(() => {
            fixed.push(`${index}:${issue.id}`)
            found.push({ id: `spawned-${issue.id}` })
            return issue.id
          }),
        verify: ({ fixes }) => Effect.succeed({ resolved: fixes.length === 2 })
      })

      expect(fixed).toEqual(["0:a", "1:b"])
      expect(report.verifications).toEqual([{ resolved: true }])
    }))

  it.effect("rescans after a resolved verification and ends only on a clean scan", () =>
    Effect.gen(function*() {
      const scanned: Array<number> = []
      const rounds = scripted([[{ id: "a" }], []])
      const report = yield* ScanFixVerify.run({ path: "src" }, {
        maxRetries: 3,
        concurrency: 2,
        scan: (input) => {
          scanned.push(input.iteration)
          return rounds(input)
        },
        fix: ({ issue }) => Effect.succeed(issue.id),
        verify: () => Effect.succeed({ resolved: true })
      })

      // The verifier said the round was resolved. The loop still rescans, and
      // that second, empty scan is what ends it.
      expect(scanned).toEqual([1, 2])
      expect(report.iterations).toBe(2)
      expect(report.resolved).toBe(true)
      expect(report.remaining).toEqual([])
      expect(report.verifications).toEqual([{ resolved: true }])
    }))

  it.effect("keeps scanning to the bound when a resolved verification is wrong", () =>
    Effect.gen(function*() {
      const scanned: Array<number> = []
      const report = yield* ScanFixVerify.run({ path: "src" }, {
        maxRetries: 3,
        concurrency: 2,
        scan: (input) => {
          scanned.push(input.iteration)
          return Effect.succeed([{ id: "a" }])
        },
        fix: ({ issue }) => Effect.succeed(issue.id),
        verify: () => Effect.succeed({ resolved: true })
      })

      // A verifier verdict is evidence about one round, never the terminal:
      // the scan that keeps finding the issue outranks it.
      expect(scanned).toEqual([1, 2, 3])
      expect(report.iterations).toBe(3)
      expect(report.resolved).toBe(false)
      expect(report.remaining).toEqual([{ id: "a" }])
      expect(report.verifications).toEqual([{ resolved: true }, { resolved: true }, { resolved: true }])
    }))

  it("reads the signals a verifier may carry", () => {
    expect(ScanFixVerify.resolved(true)).toBe(true)
    expect(ScanFixVerify.resolved({ resolved: true })).toBe(true)
    expect(ScanFixVerify.resolved(false)).toBe(false)
    expect(ScanFixVerify.resolved(Object.create({ resolved: true }))).toBe(false)
    expect(ScanFixVerify.resolved("resolved")).toBe(false)
    expect(ScanFixVerify.resolved({ resolved: "true" })).toBe(false)
    expect(ScanFixVerify.resolved(undefined)).toBe(false)
  })

  it.effect("reports the remaining issues when the retry bound is reached", () =>
    Effect.gen(function*() {
      const report = yield* ScanFixVerify.run({ path: "src" }, {
        maxRetries: 2,
        concurrency: 2,
        scan: () => Effect.succeed([{ id: "a" }]),
        fix: ({ issue }) => Effect.succeed(issue.id),
        verify: () => Effect.succeed({ resolved: false })
      })

      expect(report.iterations).toBe(2)
      expect(report.resolved).toBe(false)
      expect(report.remaining).toEqual([{ id: "a" }])
      expect(report.verifications).toHaveLength(2)
    }))

  it.effect("never fixes or verifies when the first scan is clean", () =>
    Effect.gen(function*() {
      let fixed = 0
      let verifications = 0
      const report = yield* ScanFixVerify.run({ path: "src" }, {
        maxRetries: 2,
        concurrency: 1,
        scan: () => Effect.succeed([] as ReadonlyArray<Issue>),
        fix: () => Effect.sync(() => ++fixed),
        verify: () => Effect.sync(() => ({ resolved: ++verifications > 0 }))
      })

      expect(fixed).toBe(0)
      expect(verifications).toBe(0)
      expect(report).toEqual({ iterations: 1, remaining: [], resolved: true, verifications: [] })
    }))

  it.effect("validates the bounds before scanning", () =>
    Effect.gen(function*() {
      let scanned = 0
      const failure = yield* ScanFixVerify.run({ path: "src" }, {
        maxRetries: 0,
        concurrency: 1,
        scan: () => Effect.sync(() => (++scanned, [] as ReadonlyArray<Issue>)),
        fix: () => Effect.succeed(0),
        verify: () => Effect.succeed({ resolved: true })
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
      expect(failure.code).toBe("invalid_decorator")
      expect(failure.message).toBe(
        "ScanFixVerify maxRetries, maxIssues, and concurrency must be positive safe integers"
      )
      expect(scanned).toBe(0)
    }))

  describe("executed declaration matches run", () => {
    // Every stage calls the real `@smthrs/std` glob action, so the scripted
    // implementation below records exactly the stage calls a run made.
    const glob = Glob.flow.action!
    const called: Array<string> = []
    let rounds: ReadonlyArray<ReadonlyArray<string>> = []
    const globLayer = glob.toLayer((payload) =>
      Effect.sync(() => {
        const pattern = (payload as { readonly pattern: string }).pattern
        called.push(pattern)
        const round = /^scan\/(\d+)$/.exec(pattern)
        const paths = round === null ? [] : rounds[Number(round[1]) - 1] ?? []
        return { paths, total: paths.length, truncated: false }
      })
    )
    const stage = <F extends Schema.Struct.Fields>(
      tag: string,
      payload: F,
      pattern: (input: any) => string,
      answer: (input: any, paths: ReadonlyArray<string>) => unknown
    ) =>
      Flow.make(tag, {
        payload,
        success: Schema.Unknown,
        error: Schema.Unknown,
        body: Node.capture({ tag }, (input: any) =>
          Node.map(
            Node.all({ found: glob.call({ pattern: pattern(input) }), input: Node.succeed(input) }),
            Node.capture({ tag, answer: true }, (settled: any) => answer(settled.input, settled.found.paths))
          ))
      })
    const scanStage = stage(
      "sfv/exec-scan",
      { input: Schema.Unknown, iteration: Schema.Number },
      ({ iteration }) => `scan/${iteration}`,
      (_, paths) => paths
    )
    const fixStage = stage(
      "sfv/exec-fix",
      { issue: Schema.Unknown, index: Schema.Number, iteration: Schema.Number },
      ({ index, iteration }) => `fix/${iteration}/${index}`,
      ({ issue }) => `fixed ${issue}`
    )
    const verifyStage = stage(
      "sfv/exec-verify",
      { input: Schema.Unknown, issues: Schema.Unknown, fixes: Schema.Unknown, iteration: Schema.Number },
      ({ iteration }) => `verify/${iteration}`,
      ({ fixes, iteration }) => ({ fixes, iteration })
    )
    const executed = async (script: ReadonlyArray<ReadonlyArray<string>>, executionId: string) => {
      called.length = 0
      rounds = script
      const pattern = ScanFixVerify.make({
        scan: scanStage,
        fix: fixStage,
        verify: verifyStage,
        maxRetries: 2,
        maxIssues: 3,
        concurrency: 3
      })
      return { report: await execute(pattern, { input: "repo" }, executionId, globLayer), calls: [...called] }
    }
    const ran = (script: ReadonlyArray<ReadonlyArray<string>>) =>
      Effect.runPromise(ScanFixVerify.run("repo", {
        maxRetries: 2,
        concurrency: 3,
        scan: ({ iteration }) => Effect.succeed(script[iteration - 1] ?? []),
        fix: ({ issue }) => Effect.succeed(`fixed ${issue}`),
        verify: ({ fixes, iteration }) => Effect.succeed({ fixes, iteration })
      }))

    it("fixes only the issues the scan returned and stops on a clean rescan", async () => {
      const script = [["issue-a"], []]
      const { report, calls } = await executed(script, "sfv-clean-rescan")

      expect(calls).toEqual(["scan/1", "fix/1/0", "verify/1", "scan/2"])
      expect(report).toEqual({
        iterations: 2,
        remaining: [],
        resolved: true,
        verifications: [{ fixes: ["fixed issue-a"], iteration: 1 }]
      })
      expect(report).toEqual(await ran(script))
    })

    it("never fixes or verifies when the first scan is clean", async () => {
      const { report, calls } = await executed([], "sfv-clean-first")

      expect(calls).toEqual(["scan/1"])
      expect(report).toEqual({ iterations: 1, remaining: [], resolved: true, verifications: [] })
      expect(report).toEqual(await ran([]))
    })

    it("reports the remaining issues and every verification at the retry bound", async () => {
      const script = [["issue-a", "issue-b"], ["issue-b"]]
      const { report, calls } = await executed(script, "sfv-bound")

      expect([...calls].sort()).toEqual(
        ["fix/1/0", "fix/1/1", "fix/2/0", "scan/1", "scan/2", "verify/1", "verify/2"]
      )
      expect(report).toEqual({
        iterations: 2,
        remaining: ["issue-b"],
        resolved: false,
        verifications: [
          { fixes: ["fixed issue-a", "fixed issue-b"], iteration: 1 },
          { fixes: ["fixed issue-b"], iteration: 2 }
        ]
      })
      expect(report).toEqual(await ran(script))
    })
  })
})
