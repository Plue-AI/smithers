import * as Binding from "@smthrs/scorers/Binding"
import * as ScorerRunner from "@smthrs/scorers/Runner"
import type * as Sampling from "@smthrs/scorers/Sampling"
import * as Scorer from "@smthrs/scorers/Scorer"
import { ScorerError } from "@smthrs/scorers/ScorerError"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Tracer from "effect/Tracer"
import { describe, expect, it } from "vitest"
import * as CaseExecutor from "../src/CaseExecutor.ts"
import { EvalError } from "../src/EvalError.ts"
import * as Report from "../src/Report.ts"
import * as Runner from "../src/Runner.ts"
import * as Suite from "../src/Suite.ts"

const target = { name: "target" } as const
const scorerFlow = Scorer.make({
  id: "packages/smithers/agent/evals/test/Runner/exact",
  version: "1",
  name: "exact",
  score: ({ output, groundTruth }) =>
    Effect.succeed({
      score: Object.is(output, groundTruth ?? output) ? 1 : 0,
      reason: "exact"
    })
})
const binding = Binding.make({ scorer: scorerFlow, appliesTo: target })
const runOptions = { runId: "run", at: "2026-01-01T00:00:00.000Z" } as const

const executorFor = (
  run: (suiteCase: Suite.Case) => Effect.Effect<CaseExecutor.Execution, EvalError>
): Layer.Layer<CaseExecutor.CaseExecutor> => Layer.succeed(CaseExecutor.CaseExecutor)(CaseExecutor.make(run))

const succeeding = executorFor((suiteCase) =>
  Effect.succeed({ output: suiteCase.input, stepKey: "step", latencyMs: 0, target })
)

const suiteOf = (
  name: string,
  bindings: ReadonlyArray<Suite.Binding>,
  cases: ReadonlyArray<Suite.Case> = [{ name: "one", input: 1 }]
): Promise<Suite.Suite> => Effect.runPromise(Suite.make({ name, concurrency: 1, bindings, cases }))

/** Runs an effect that must fail and returns the typed failure it raised. */
const failureOf = (effect: Effect.Effect<unknown, EvalError, never>): Promise<EvalError> =>
  Effect.runPromise(Effect.flip(effect))

describe("Runner", () => {
  it("runs a case three times and reports pass@k", async () => {
    const suite = await suiteOf("trials", [binding], [{ name: "one", input: 1, expected: 1 }])
    let calls = 0
    const executor = executorFor(() =>
      Effect.sync(() => ({
        output: ++calls % 3 === 0 ? 0 : 1,
        stepKey: "step",
        latencyMs: 0,
        target
      }))
    )
    const options = { ...runOptions, trials: 3, k: 2 }
    const first = await Effect.runPromise(Runner.run(suite, options).pipe(Effect.provide(executor)))
    expect(calls).toBe(3)
    expect(first.observations).toHaveLength(3)
    expect(first.cases[0]?.trials).toMatchObject({ n: 3, passes: 2, passAt1: 2 / 3, passAtK: 1 })
    expect(first.trials).toMatchObject({ passAt1: 2 / 3, passAtK: 1 })
    calls = 0
    const second = await Effect.runPromise(Runner.run(suite, options).pipe(Effect.provide(executor)))
    expect(JSON.stringify(first.observations)).toBe(JSON.stringify(second.observations))
  })

  it.each([
    { trials: 0, k: undefined },
    { trials: 1001, k: undefined },
    { trials: 1.5, k: undefined },
    { trials: Number.NaN, k: undefined },
    { trials: 2, k: 0 },
    { trials: 2, k: 1.5 },
    { trials: 2, k: 3 },
    { trials: undefined, k: 2 }
  ])("refuses trials $trials with k $k before running a case", async ({ k, trials }) => {
    const suite = await suiteOf("bounds", [binding], [{ name: "one", input: 1, expected: 1 }])
    let calls = 0
    const executor = executorFor((suiteCase) =>
      Effect.sync(() => {
        calls += 1
        return { output: suiteCase.input, stepKey: "step", latencyMs: 0, target }
      })
    )
    const error = await failureOf(Runner.run(suite, { ...runOptions, trials, k }).pipe(Effect.provide(executor)))
    expect(error).toBeInstanceOf(EvalError)
    expect(error.code).toBe("invalid_trials")
    expect(error.message).toBe("trials must be an integer from 1 to 1000 and k must be an integer from 1 to trials")
    expect(error.path).toBe("options.trials")
    expect(calls).toBe(0)
  })

  it("bounds k by the suite's own trials when the run names none", async () => {
    const suite = await Effect.runPromise(
      Suite.make({
        name: "suite-trials",
        concurrency: 1,
        trials: 2,
        bindings: [binding],
        cases: [{ name: "one", input: 1, expected: 1 }]
      })
    )
    const run = await Effect.runPromise(Runner.run(suite, { ...runOptions, k: 2 }).pipe(Effect.provide(succeeding)))
    expect(run.k).toBe(2)
    expect(run.cases[0]?.trials).toMatchObject({ n: 2, passes: 2, passAtK: 1 })
    const error = await failureOf(Runner.run(suite, { ...runOptions, k: 3 }).pipe(Effect.provide(succeeding)))
    expect(error.code).toBe("invalid_trials")
  })

  it("runs a suite value that declares no trials exactly once", async () => {
    const made = await suiteOf("untrialled", [binding], [{ name: "one", input: 1, expected: 1 }])
    const suite: Suite.Suite = { ...made, trials: undefined }
    let calls = 0
    const executor = executorFor((suiteCase) =>
      Effect.sync(() => {
        calls += 1
        return { output: suiteCase.input, stepKey: "step", latencyMs: 0, target }
      })
    )
    const run = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(executor)))
    expect(calls).toBe(1)
    expect(run.k).toBe(1)
    expect(run.cases[0]?.trials).toMatchObject({ n: 1, passes: 1, passAt1: 1 })
    expect(run.observations.map((observation) => observation.case)).toEqual(["one"])
  })

  it("runs a suite under an Eval.run span and each case under an Eval.case span", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const suite = await suiteOf("traced", [binding], [{ name: "one", input: 1 }, { name: "two", input: 2 }])
    await Effect.runPromise(
      Runner.run(suite, runOptions).pipe(Effect.provide(succeeding), Effect.withTracer(tracer))
    )
    const named = (name: string) => spans.filter((span) => span.name === name)
    expect(named("Eval.run").map((span) => Object.fromEntries(span.attributes))).toEqual([
      { suite: "traced", runId: "run" }
    ])
    expect(named("Eval.case").map((span) => span.attributes.get("case"))).toEqual(["one", "two"])
    expect(
      named("Eval.case").every((span) => span.parent?._tag === "Some" && span.parent.value === named("Eval.run")[0])
    )
      .toBe(true)
  })

  it("flattens control characters in a returned step key and a wrapped target failure", async () => {
    const suite = await suiteOf("s", [], [{ name: "one", input: 1 }, { name: "two", input: 2 }])
    const executor = executorFor((suiteCase) =>
      suiteCase.name === "one"
        ? Effect.succeed({
          output: suiteCase.input,
          stepKey: "step\n::warning::forged from stepKey\u001b[2K\u009b2K\u202e",
          latencyMs: 0,
          target
        })
        : Effect.fail(new EvalError({ code: "executor", message: "boom\n::error::forged from target\u007f" }))
    )
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(executor)))

    expect(result.cases[0]?.execution?.stepKey).toBe("step ::warning::forged from stepKey [2K 2K ")
    expect(result.cases[1]?.error?.message).toBe("Target failed for case 'two': boom ::error::forged from target ")
    // The original message stays on the cause for anyone debugging the target.
    expect((result.cases[1]?.error?.cause as EvalError).message).toBe("boom\n::error::forged from target\u007f")
  })

  it("isolates mutating executors and scorers across sequential and concurrent runs", async () => {
    const executorSeen: unknown[] = []
    const scorerSeen: unknown[] = []
    const mutator = Scorer.make({
      id: "packages/smithers/agent/evals/test/Runner/mutator",
      version: "1",
      score: ({ input, groundTruth, context }) =>
        Effect.sync(() => {
          scorerSeen.push(structuredClone({ input, groundTruth, context }))
          ;(input as { rows: number[] }).rows.push(99)
          ;(groundTruth as { rows: number[] }).rows.push(99)
          ;(context as { rows: number[] }).rows.push(99)
          return { score: 1 }
        })
    })
    const data = { rows: [1] }
    const suite = await Effect.runPromise(Suite.make({
      name: "isolated",
      concurrency: 2,
      cases: [{ name: "expected", input: data, expected: data }, { name: "fallback", input: data }],
      bindings: [0, 1].map(() => Binding.make({ scorer: mutator, appliesTo: target, groundTruth: data, context: data }))
    }))
    const executor = executorFor((suiteCase) =>
      Effect.gen(function*() {
        executorSeen.push(structuredClone(suiteCase))
        ;(suiteCase.input as typeof data).rows.push(2)
        if (suiteCase.expected !== undefined) (suiteCase.expected as typeof data).rows.push(2)
        Object.assign(suiteCase, { name: "changed" })
        yield* Effect.yieldNow
        return { output: suiteCase.input, stepKey: "step", latencyMs: 0, target }
      })
    )
    const run = Runner.run(suite, runOptions).pipe(Effect.provide(executor))
    const first = await Effect.runPromise(run)
    const second = await Effect.runPromise(run)
    const concurrent = await Effect.runPromise(Effect.all([run, run], { concurrency: 2 }))
    for (const result of [first, second, ...concurrent]) {
      expect(result.cases.map((entry) => entry.case)).toEqual(["expected", "fallback"])
      expect(result.cases.map((entry) => entry.execution?.output)).toEqual([
        { rows: [1, 2] },
        { rows: [1, 2] }
      ])
      expect(result.observations.map((entry) => entry.kind)).toEqual(["score", "score", "score", "score"])
    }
    expect(executorSeen).toHaveLength(8)
    for (let index = 0; index < executorSeen.length; index += 2) {
      expect(executorSeen.slice(index, index + 2)).toEqual([
        { name: "expected", input: data, expected: data },
        { name: "fallback", input: data }
      ])
    }
    expect(scorerSeen).toHaveLength(16)
    for (const entry of scorerSeen) expect(entry).toEqual({ input: data, groundTruth: data, context: data })
    expect(suite.cases).toEqual([
      { name: "expected", input: data, expected: data },
      { name: "fallback", input: data }
    ])
    for (const entry of suite.bindings) {
      expect(entry.groundTruth).toEqual(data)
      expect(entry.context).toEqual(data)
    }
  })

  it("keeps declaration order under bounded concurrency", async () => {
    const suite = await Effect.runPromise(
      Suite.make({
        name: "order",
        concurrency: 2,
        bindings: [binding],
        cases: [{ name: "slow", input: 1 }, { name: "fast", input: 2 }]
      })
    )
    const slowStarted = Deferred.makeUnsafe<void>()
    const releaseSlow = Deferred.makeUnsafe<void>()
    const executor = CaseExecutor.make((suiteCase) =>
      suiteCase.name === "slow"
        ? Deferred.succeed(slowStarted, void 0).pipe(
          Effect.andThen(Deferred.await(releaseSlow)),
          Effect.as({ output: suiteCase.input, stepKey: suiteCase.name, latencyMs: 20, target })
        )
        : Effect.succeed({ output: suiteCase.input, stepKey: suiteCase.name, latencyMs: 1, target })
    )
    const scorer = {
      runBatch: (requests: ReadonlyArray<Runner.ScoreJob>) =>
        Effect.succeed(
          requests.map((request) => ({
            ...request.observation,
            kind: "score" as const,
            score: 1,
            reason: "ok",
            at: 0
          }))
        )
    }
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Runner.run(suite, { ...runOptions, scorer }).pipe(Effect.forkChild())
        yield* Deferred.await(slowStarted)
        yield* Deferred.succeed(releaseSlow, void 0)
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(executor)),
        Effect.scoped
      )
    )
    expect(result.cases.map((caseResult) => caseResult.case)).toEqual(["slow", "fast"])
  })

  it("suspends synchronous scorer callback throws inside each job", async () => {
    const broken = Scorer.make({
      id: "packages/smithers/agent/evals/test/Runner/synchronous-throw",
      version: "1",
      score: () => {
        throw new TypeError("synchronous scorer crash")
      }
    })
    const suite = await suiteOf("synchronous-throw", [Binding.make({ scorer: broken, appliesTo: target })])
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(result.observations).toMatchObject([{
      kind: "inconclusive",
      reason: expect.stringContaining("synchronous scorer crash")
    }])
  })

  it.each([false, true])("preserves adapter receivers and forwards concurrency (correlated=%s)", async (correlated) => {
    class OrderOnly implements Runner.ScoreBatchRunner {
      resultScore = 0.75
      seenConcurrency: number | undefined

      runBatch(jobs: ReadonlyArray<Runner.ScoreJob>, options?: { readonly concurrency?: number | undefined }) {
        this.seenConcurrency = options?.concurrency
        return Effect.succeed(jobs.map((job) => ({
          ...job.observation,
          kind: "score" as const,
          score: this.resultScore,
          at: job.at
        })))
      }
    }
    class Correlated extends OrderOnly {
      runBatchCorrelated(
        jobs: ReadonlyArray<Runner.ScoreJob>,
        options?: { readonly concurrency?: number | undefined }
      ) {
        return this.runBatch(jobs, options).pipe(
          Effect.map((observations) =>
            observations.map((observation, index) => ({ identity: jobs[index]!.identity, observation })).reverse()
          )
        )
      }
    }
    const scorer = correlated ? new Correlated() : new OrderOnly()
    const suite = await Effect.runPromise(Suite.make({
      name: "receiver",
      concurrency: 2,
      bindings: [binding],
      cases: [{ name: "one", input: 1 }, { name: "two", input: 2 }]
    }))
    const result = await Effect.runPromise(
      Runner.run(suite, { ...runOptions, scorer }).pipe(
        Effect.provide(
          executorFor((suiteCase) =>
            Effect.succeed({ output: suiteCase.input, stepKey: suiteCase.name, latencyMs: 0, target })
          )
        )
      )
    )
    expect(scorer.seenConcurrency).toBe(2)
    expect(result.observations).toMatchObject([
      { case: "one", kind: "score", score: 0.75 },
      { case: "two", kind: "score", score: 0.75 }
    ])
  })

  it.each([false, true])("guards uncoercible batch failures (correlated=%s)", async (correlated) => {
    const fail = () =>
      Effect.fail({
        toString() {
          throw new Error("uncoercible cause")
        }
      })
    const scorer: Runner.ScoreBatchRunner = {
      runBatch: fail,
      ...(correlated ? { runBatchCorrelated: fail } : {})
    }
    const suite = await suiteOf("uncoercible", [binding], [{ name: "one", input: 1 }, { name: "two", input: 2 }])
    const result = await Effect.runPromise(
      Runner.run(suite, { ...runOptions, scorer }).pipe(
        Effect.provide(
          executorFor((suiteCase) =>
            Effect.succeed({ output: suiteCase.input, stepKey: suiteCase.name, latencyMs: 0, target })
          )
        )
      )
    )
    expect(result.observations).toMatchObject([
      { case: "one", kind: "inconclusive", reason: expect.stringContaining("<uncoercible cause>") },
      { case: "two", kind: "inconclusive", reason: expect.stringContaining("<uncoercible cause>") }
    ])
  })

  it("keeps shared-step jobs inconclusive under the noop layer without calling scorers", async () => {
    let scorerCalls = 0
    const unavailable = Scorer.make({
      id: "packages/smithers/agent/evals/test/Runner/noop",
      version: "1",
      score: () => {
        scorerCalls += 1
        return Effect.succeed({ score: 1 })
      }
    })
    const suite = await suiteOf("shared-noop", [Binding.make({ scorer: unavailable, appliesTo: target })], [
      { name: "one", input: 1 },
      { name: "two", input: 2 }
    ])
    const result = await Effect.runPromise(
      Runner.run(suite, runOptions).pipe(
        Effect.provide(succeeding),
        Effect.provide(Runner.layerNoop)
      )
    )
    expect(scorerCalls).toBe(0)
    expect(result.observations).toMatchObject([
      {
        case: "one",
        stepKey: "step",
        kind: "inconclusive",
        reason: expect.stringContaining("No scorer batch runner is available")
      },
      {
        case: "two",
        stepKey: "step",
        kind: "inconclusive",
        reason: expect.stringContaining("No scorer batch runner is available")
      }
    ])
  })

  it.each(["targets", "scorers", "inline-default"] as const)(
    "measures active %s jobs and preserves order",
    async (phase) => {
      const limit = phase === "inline-default" ? 1 : 2
      const indexes = [0, 1, 2, 3]
      const started = indexes.map(() => Deferred.makeUnsafe<void>())
      const release = indexes.map(() => Deferred.makeUnsafe<void>())
      const active = new Set<number>()
      const completed: number[] = []
      let maximum = 0
      const work = (index: number) =>
        Effect.gen(function*() {
          active.add(index)
          maximum = Math.max(maximum, active.size)
          yield* Deferred.succeed(started[index]!, void 0)
          yield* Deferred.await(release[index]!)
          active.delete(index)
          completed.push(index)
          return { score: index / 4 }
        })
      const measured = Scorer.make({
        id: `packages/smithers/agent/evals/test/Runner/concurrency-${phase}`,
        version: "1",
        score: ({ input }) => work(input as number)
      })
      const suite = await Effect.runPromise(Suite.make({
        name: "concurrency",
        concurrency: limit,
        bindings: [phase === "targets" ? binding : Binding.make({ scorer: measured, appliesTo: target })],
        cases: indexes.map((index) => ({ name: String(index), input: index }))
      }))
      const executor = executorFor((suiteCase) =>
        (phase === "targets" ? work(suiteCase.input as number) : Effect.void).pipe(
          Effect.as({ output: suiteCase.input, stepKey: suiteCase.name, latencyMs: 0, target })
        )
      )
      const jobs = indexes.map((index) => ({
        identity: String(index),
        observation: { targetStepKey: String(index), scorerKey: measured.scorerKey },
        score: work(index),
        at: 0
      }))
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const effect = phase === "inline-default"
            ? Runner.makeInline().runBatch(jobs).pipe(
              Effect.map((observations) => observations.map((item) => item.targetStepKey))
            )
            : Runner.run(suite, runOptions).pipe(
              Effect.provide(executor),
              Effect.map((run) => {
                expect(run.cases.map((item) => item.case)).toEqual(indexes.map(String))
                if (phase === "scorers") {
                  expect(run.observations).toMatchObject(indexes.map((index) => ({ kind: "score", score: index / 4 })))
                }
                return run.observations.map((item) => item.case)
              })
            )
          const fiber = yield* effect.pipe(Effect.forkChild())
          for (let index = 0; index < limit; index++) yield* Deferred.await(started[index]!)
          yield* Effect.yieldNow
          expect([...active]).toEqual(indexes.slice(0, limit))
          for (let index = limit; index < indexes.length; index++) {
            expect(yield* Deferred.isDone(started[index]!)).toBe(false)
          }
          // With two slots, hold job 0 while jobs 1, 2 and 3 finish in the other slot.
          for (let index = limit - 1; index < indexes.length; index++) {
            yield* Deferred.succeed(release[index]!, void 0)
            if (index + 1 < indexes.length) {
              yield* Deferred.await(started[index + 1]!)
              yield* Effect.yieldNow
              expect(active.size).toBe(limit)
            }
          }
          if (limit === 2) yield* Deferred.succeed(release[0]!, void 0)
          return yield* Fiber.join(fiber)
        }).pipe(Effect.scoped, Effect.timeout("5 seconds"))
      )
      expect(maximum).toBe(limit)
      expect(active.size).toBe(0)
      expect(completed).toEqual(limit === 2 ? [1, 2, 3, 0] : indexes)
      expect(result).toEqual(indexes.map(String))
    }
  )

  // `Runner.run` used to declare the batch-runner service in its requirements
  // while resolving it with `Effect.serviceOption`, so the in-process path was
  // unreachable and every suite had to hand-copy an adapter to satisfy a type.
  it("scores in process when only a case executor is provided", async () => {
    const suite = await suiteOf("inline", [binding])
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]).toMatchObject({ kind: "score", score: 1, reason: "exact", scorerName: "exact" })
  })

  it("preserves a typed scorer failure code in the inline batch result", async () => {
    const result = await Effect.runPromise(
      Runner.makeInline().runBatch([{
        identity: "typed-failure",
        observation: { targetStepKey: "step", scorerKey: scorerFlow.scorerKey },
        score: Effect.fail(new ScorerError({ code: "store", message: "judge storage unavailable" })),
        at: 0
      }])
    )

    expect(result[0]).toMatchObject({
      kind: "inconclusive",
      code: "store",
      reason: expect.stringContaining("judge storage unavailable")
    })
  })

  it("scores through the provided Runner service and through the inline layer", async () => {
    const suite = await suiteOf("layers", [binding])
    const injected = await Effect.runPromise(
      Runner.run(suite, runOptions).pipe(Effect.provide(succeeding), Effect.provide(Runner.layerInline))
    )
    expect(injected.observations[0]?.kind).toBe("score")

    const explicit = await Effect.runPromise(
      Runner.run(suite, { ...runOptions, scorer: Runner.makeInline() }).pipe(Effect.provide(succeeding))
    )
    expect(explicit.observations[0]?.kind).toBe("score")
  })

  it("propagates scorer failures as inconclusive observations", async () => {
    const suite = await suiteOf("failure", [binding])
    const scorer = { runBatch: () => Effect.fail("judge unavailable") }
    const result = await Effect.runPromise(
      Runner.run(suite, { ...runOptions, scorer }).pipe(Effect.provide(succeeding))
    )
    const observation = result.observations[0]
    expect(observation?.kind).toBe("inconclusive")
    expect(observation?.kind === "inconclusive" && observation.reason).toContain("judge unavailable")
  })

  it("reports the unavailable batch runner rather than a target failure", async () => {
    const suite = await suiteOf("unavailable", [binding])
    const result = await Effect.runPromise(
      Runner.run(suite, runOptions).pipe(Effect.provide(succeeding), Effect.provide(Runner.layerNoop))
    )
    const observation = result.observations[0]
    expect(observation?.kind === "inconclusive" && observation.reason).toContain(
      "No scorer batch runner is available"
    )
  })

  it("keeps the noop order-only adapter unavailable", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const scorer = yield* Runner.Runner
        return yield* Effect.flip(scorer.runBatch([]))
      }).pipe(Effect.provide(Runner.layerNoop))
    )
    expect(error).toMatchObject({ code: "scorer_unavailable", message: "No scorer batch runner is available" })
  })

  it("bounds the cause it copies into a public reason", async () => {
    const suite = await suiteOf("bounded", [binding])
    const scorer = { runBatch: () => Effect.fail("x".repeat(5000)) }
    const result = await Effect.runPromise(
      Runner.run(suite, { ...runOptions, scorer }).pipe(Effect.provide(succeeding))
    )
    const observation = result.observations[0]
    expect(observation?.kind === "inconclusive" && observation.reason).toBe(
      `Scorer execution was inconclusive: ${"x".repeat(5000)}`.slice(0, 1024)
    )
    expect(observation?.kind === "inconclusive" && observation.reason.length).toBeLessThan(2100)
  })

  // A scorer that threw a TypeError is a bug in the scorer; an unreachable
  // judge is an outage. Both used to arrive as the same fixed sentence, so a
  // permanently broken scorer read as an unavailable one forever.
  it("names the scorer's own cause in the inconclusive reason", async () => {
    const broken = Scorer.make({
      id: "packages/smithers/agent/evals/test/Runner/broken",
      version: "1",
      name: "broken",
      score: () =>
        Effect.sync(() => {
          throw new TypeError("scorerKey is not a function")
        })
    })
    const suite = await suiteOf("broken-scorer", [Binding.make({ scorer: broken, appliesTo: target })])
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    const observation = result.observations[0]
    expect(observation?.kind).toBe("inconclusive")
    expect(observation?.kind === "inconclusive" && observation.reason).toContain("scorerKey is not a function")
  })

  it("identifies a scorer that named nothing by its key, and reports its id as the name", async () => {
    const anonymous = Scorer.make({
      id: "packages/smithers/agent/evals/test/Runner/anonymous",
      version: "1",
      score: () => Effect.succeed({ score: 1 })
    })
    const suite = await suiteOf("anonymous", [Binding.make({ scorer: anonymous, appliesTo: target })])
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    // The key is the identity a baseline matches on, and it is derived from
    // `id`, `version` and `config` alone. Adopting `id` as the display name
    // therefore leaves the identity where it was.
    expect(result.observations[0]?.scorer).toBe(anonymous.scorerKey)
    expect(result.observations[0]?.scorerName).toBe("packages/smithers/agent/evals/test/Runner/anonymous")
  })

  it("retains a typed target failure with its own code and message, without re-running the target", async () => {
    const suite = await suiteOf("target-failure", [])
    let attempts = 0
    const executor = executorFor(() => {
      attempts += 1
      return Effect.fail(
        new EvalError({
          code: "invalid_suite",
          message: "the fixture is missing its expected column",
          path: "cases[0].expected"
        })
      )
    })
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(executor)))
    expect(result.cases[0]?.error?.code).toBe("invalid_suite")
    expect(result.cases[0]?.error?.message).toBe(
      "Target failed for case 'one': the fixture is missing its expected column"
    )
    expect(result.cases[0]?.error?.path).toBe("cases[0].expected")
    expect(attempts).toBe(1)
  })

  it("names an untyped target failure instead of dropping it", async () => {
    const suite = await suiteOf("untyped-failure", [])
    const executor = Layer.succeed(CaseExecutor.CaseExecutor)({
      run: () => Effect.fail("raw failure" as unknown as EvalError)
    })
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(executor)))
    expect(result.cases[0]?.error?.code).toBe("executor")
    expect(result.cases[0]?.error?.message).toBe("Target failed for case 'one': raw failure")
    expect(result.cases[0]?.error?.path).toBe("cases['one']")
  })

  // `Effect.match` only sees typed failures. A defect from a valid executor,
  // such as a parser throwing inside `Effect.sync`, must stay with its case
  // rather than aborting the run and the sibling cases behind it.
  it("keeps an executor defect on its case and still scores the next case", async () => {
    const suite = await suiteOf("defect", [binding], [{ name: "bad", input: 1 }, { name: "good", input: 2 }])
    const attempted: Array<string> = []
    const executor = executorFor((suiteCase) =>
      Effect.sync(() => {
        attempted.push(suiteCase.name)
        if (suiteCase.name === "bad") throw new TypeError("parser exploded")
        return { output: suiteCase.input, stepKey: suiteCase.name, latencyMs: 0, target }
      })
    )
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(executor)))
    expect(attempted).toEqual(["bad", "good"])
    expect(result.cases.map((entry) => entry.case)).toEqual(["bad", "good"])
    expect(result.cases[0]?.execution).toBeUndefined()
    expect(result.cases[0]?.error?.code).toBe("executor")
    expect(result.cases[0]?.error?.message).toBe("Target failed for case 'bad': TypeError: parser exploded")
    expect(result.cases[0]?.error?.path).toBe("cases['bad']")
    expect(result.cases[0]?.error?.cause).toBeInstanceOf(TypeError)
    expect(result.cases[0]?.observations).toEqual([])
    expect(result.cases[1]?.execution?.output).toBe(2)
    expect(result.cases[1]?.observations.map((observation) => observation.kind)).toEqual(["score"])
    expect(result.observations).toHaveLength(1)
  })

  it("locates a typed target failure that named no path at the case", async () => {
    const suite = await suiteOf("pathless-failure", [])
    const executor = executorFor(() => Effect.fail(new EvalError({ code: "executor", message: "the host is gone" })))
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(executor)))
    expect(result.cases[0]?.error?.code).toBe("executor")
    expect(result.cases[0]?.error?.path).toBe("cases['one']")
  })

  it("applies deterministic scorer sampling before batch execution", async () => {
    const unsampled = Binding.make({ scorer: scorerFlow, appliesTo: target, sampling: "none" })
    const suite = await suiteOf("sampling", [unsampled])
    let batches = 0
    const scorer = {
      runBatch: (_requests: ReadonlyArray<Runner.ScoreJob>) =>
        Effect.sync(() => {
          batches += 1
          return []
        })
    }
    const result = await Effect.runPromise(
      Runner.run(suite, { ...runOptions, scorer }).pipe(Effect.provide(succeeding))
    )
    expect(batches).toBe(0)
    expect(result.observations).toEqual([])
  })

  it("rejects a sampling policy the scorers package cannot decide", async () => {
    const suite = await suiteOf("bad-sampling", [
      Binding.make({ scorer: scorerFlow, appliesTo: target, sampling: { ratio: 2, seed: "s" } as Sampling.Sampling })
    ])
    const error = await failureOf(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(error.code).toBe("invalid_suite")
    expect(error.message).toContain("Invalid sampling policy for scorer exact (")
    expect(error.path).toBe("bindings[0].sampling")
  })

  it("collects every binding's observation under its own case", async () => {
    const second = Scorer.make({
      id: "packages/smithers/agent/evals/test/Runner/second",
      version: "1",
      name: "second",
      score: () => Effect.succeed({ score: 0.5 })
    })
    const suite = await suiteOf(
      "two-bindings",
      [binding, Binding.make({ scorer: second, appliesTo: target })],
      [{ name: "one", input: 1 }, { name: "two", input: 2 }]
    )
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(result.cases.map((caseResult) => caseResult.observations.length)).toEqual([2, 2])
    expect(result.observations).toHaveLength(4)
  })

  it("runs sampled bound scorers and omits unsampled bindings", async () => {
    const unsampled = Binding.make({ scorer: scorerFlow, appliesTo: target, sampling: "none" })
    const suite = await suiteOf("mixed-sampling", [binding, unsampled])
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]?.kind).toBe("score")
  })

  it("keeps a case with no observations beside a case that has them", async () => {
    const suite = await suiteOf("partial", [binding], [{ name: "ok", input: 1 }, { name: "broken", input: 2 }])
    const executor = executorFor((suiteCase) =>
      suiteCase.name === "ok"
        ? Effect.succeed({ output: suiteCase.input, stepKey: "step", latencyMs: 0, target })
        : Effect.fail(new EvalError({ code: "executor", message: "no" }))
    )
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(executor)))
    expect(result.cases.map((caseResult) => caseResult.observations.length)).toEqual([1, 0])
  })

  it("runs the in-process batch runner at concurrency 1 when given no options", async () => {
    const observations = await Effect.runPromise(
      Runner.makeInline().runBatch([{
        identity: "one",
        observation: { targetStepKey: "step", scorerKey: scorerFlow.scorerKey },
        score: Effect.succeed({ score: 1 }),
        at: 0
      }])
    )
    expect(observations).toEqual([{
      targetStepKey: "step",
      scorerKey: scorerFlow.scorerKey,
      kind: "score",
      score: 1,
      at: 0
    }])
  })

  it("names a scorer that named nothing by its id when it misbehaves", async () => {
    const anonymous = Scorer.make({
      id: "packages/smithers/agent/evals/test/Runner/anonymous-liar",
      version: "1",
      score: () => Effect.succeed({ score: 1 })
    })
    const suite = await suiteOf("anonymous-liar", [Binding.make({ scorer: anonymous, appliesTo: target })])
    const result = await Effect.runPromise(
      Runner.run(suite, {
        ...runOptions,
        scorer: {
          runBatch: (jobs) =>
            Effect.succeed(jobs.map((job) => ({ ...job.observation, kind: "score" as const, score: 7, at: job.at })))
        }
      }).pipe(Effect.provide(succeeding))
    )
    const observation = result.observations[0]
    expect(observation?.scorerName).toBe("packages/smithers/agent/evals/test/Runner/anonymous-liar")
    expect(observation?.kind === "inconclusive" && observation.reason).toBe(
      `Scorer packages/smithers/agent/evals/test/Runner/anonymous-liar (${
        anonymous.scorerKey.slice(0, 8)
      }) returned a score outside [0, 1]: 7`
    )
  })

  it("propagates fiber interruption from the target and from the scorer", async () => {
    const suite = await suiteOf("interrupt", [])
    const hangingTarget = await Effect.runPromiseExit(
      Runner.run(suite, runOptions).pipe(
        Effect.provide(executorFor(() => Effect.never)),
        Effect.timeout("10 millis")
      )
    )
    expect(hangingTarget._tag).toBe("Failure")

    const selfInterrupted = await Effect.runPromiseExit(
      Runner.run(suite, runOptions).pipe(Effect.provide(executorFor(() => Effect.interrupt)))
    )
    expect(selfInterrupted._tag).toBe("Failure")

    const scored = await suiteOf("interrupt-scorer", [binding])
    const hangingBatch = await Effect.runPromiseExit(
      Runner.run(scored, { ...runOptions, scorer: { runBatch: () => Effect.never } }).pipe(
        Effect.provide(succeeding),
        Effect.timeout("10 millis")
      )
    )
    expect(hangingBatch._tag).toBe("Failure")
  })

  // An interrupted scorer is not an inconclusive score: recording one would
  // turn a cancelled run into a measured one.
  it("interrupts rather than scoring when a scorer or a batch is interrupted", async () => {
    const interrupted = Scorer.make({
      id: "packages/smithers/agent/evals/test/Runner/interrupted",
      version: "1",
      name: "interrupted",
      score: () => Effect.interrupt
    })
    const inline = await suiteOf("interrupt-inline", [Binding.make({ scorer: interrupted, appliesTo: target })])
    const inlineExit = await Effect.runPromiseExit(
      Runner.run(inline, runOptions).pipe(Effect.provide(succeeding))
    )
    expect(inlineExit._tag).toBe("Failure")

    const batched = await suiteOf("interrupt-batch", [binding])
    const batchExit = await Effect.runPromiseExit(
      Runner.run(batched, { ...runOptions, scorer: { runBatch: () => Effect.interrupt } }).pipe(
        Effect.provide(succeeding)
      )
    )
    expect(batchExit._tag).toBe("Failure")
  })

  it("applies bindings only to their target and forwards ground truth and context", async () => {
    const other = { name: "other" } as const
    let seen: Scorer.Input | undefined
    const inspecting = Scorer.make({
      id: "packages/smithers/agent/evals/test/Runner/inspect",
      version: "1",
      name: "inspect",
      score: (input) =>
        Effect.sync(() => {
          seen = input
          return { score: 1, meta: { seen: true } }
        })
    })
    const suite = await suiteOf(
      "bindings",
      [
        Binding.make({ scorer: inspecting, appliesTo: target, groundTruth: "answer", context: { rubric: "exact" } }),
        Binding.make({ scorer: inspecting, appliesTo: other })
      ],
      [{ name: "one", input: "question" }]
    )
    const executor = executorFor(() => Effect.succeed({ output: "answer", stepKey: "step", latencyMs: 1, target }))
    const result = await Effect.runPromise(
      Runner.run(suite, { ...runOptions, sampleId: "sample" }).pipe(Effect.provide(executor))
    )
    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]).toMatchObject({ kind: "score", meta: { seen: true } })
    expect(seen).toMatchObject({
      input: "question",
      output: "answer",
      groundTruth: "answer",
      context: { rubric: "exact" }
    })
  })

  it("prefers a case's own expected value as ground truth", async () => {
    let seen: Scorer.Input | undefined
    const inspecting = Scorer.make({
      id: "packages/smithers/agent/evals/test/Runner/ground-truth",
      version: "1",
      name: "ground-truth",
      score: (input) =>
        Effect.sync(() => {
          seen = input
          return { score: 1 }
        })
    })
    const suite = await suiteOf(
      "ground-truth",
      [Binding.make({ scorer: inspecting, appliesTo: target, groundTruth: "binding" })],
      [{ name: "one", input: 1, expected: "case" }]
    )
    await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(seen?.groundTruth).toBe("case")
    expect(Object.hasOwn(seen!, "context")).toBe(false)
  })

  // A presence check on `undefined` followed by `??` silently swaps a declared
  // `null` for the binding's value; every falsy value must survive as written.
  it("preserves a declared null, false, zero or empty-string expected value over binding ground truth", async () => {
    for (const expected of [null, false, 0, ""]) {
      let seen: Scorer.Input | undefined
      const inspecting = Scorer.make({
        id: "packages/smithers/agent/evals/test/Runner/falsy-ground-truth",
        version: "1",
        name: "falsy-ground-truth",
        score: (input) =>
          Effect.sync(() => {
            seen = input
            return { score: Object.is(input.groundTruth, input.output) ? 1 : 0 }
          })
      })
      const suite = await suiteOf(
        "falsy-ground-truth",
        [Binding.make({ scorer: inspecting, appliesTo: target, groundTruth: "binding" })],
        [{ name: "one", input: expected, expected }]
      )
      const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
      expect(Object.hasOwn(seen!, "groundTruth")).toBe(true)
      expect(Object.is(seen!.groundTruth, expected)).toBe(true)
      expect(result.observations[0]).toMatchObject({ kind: "score", score: 1 })
    }
  })

  it("offers a declared null expected value when the binding declares no ground truth", async () => {
    let seen: Scorer.Input | undefined
    const inspecting = Scorer.make({
      id: "packages/smithers/agent/evals/test/Runner/null-ground-truth",
      version: "1",
      name: "null-ground-truth",
      score: (input) =>
        Effect.sync(() => {
          seen = input
          return { score: input.groundTruth === null ? 1 : 0 }
        })
    })
    const suite = await suiteOf(
      "null-ground-truth",
      [Binding.make({ scorer: inspecting, appliesTo: target })],
      [{ name: "one", input: 1, expected: null }]
    )
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(Object.hasOwn(seen!, "groundTruth")).toBe(true)
    expect(seen!.groundTruth).toBeNull()
    expect(result.observations[0]).toMatchObject({ kind: "score", score: 1 })
  })

  it("omits ground truth when neither the case nor the binding declares it", async () => {
    let seen: Scorer.Input | undefined
    const inspecting = Scorer.make({
      id: "packages/smithers/agent/evals/test/Runner/no-ground-truth",
      version: "1",
      name: "no-ground-truth",
      score: (input) =>
        Effect.sync(() => {
          seen = input
          return { score: 1 }
        })
    })
    const suite = await suiteOf("bare", [Binding.make({ scorer: inspecting, appliesTo: target })])
    await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(Object.hasOwn(seen!, "groundTruth")).toBe(false)
  })

  // The docs promise that the scorers package's own runner service is a
  // correlated batch runner, so `ambiguous_score_job` never applies to it.
  it("accepts the scorers runner service as a correlated batch runner", () => {
    const adapter: Runner.ScoreBatchRunner = ScorerRunner.makeNoop()
    expect(typeof adapter.runBatchCorrelated).toBe("function")
  })

  it("requires deterministic run identity and a canonical UTC timestamp", async () => {
    const suite = await suiteOf("identity", [])
    const provided = (options: Runner.RunOptions) => Runner.run(suite, options).pipe(Effect.provide(succeeding))

    const blankId = await failureOf(provided({ runId: " ", at: runOptions.at }))
    expect(blankId.code).toBe("invalid_run_options")
    expect(blankId.message).toBe("Deterministic runs require a non-empty runId")
    expect(blankId.path).toBe("options.runId")

    for (const at of ["2026-01-01", "2026-13-01T00:00:00.000Z"]) {
      const badAt = await failureOf(provided({ runId: "run", at }))
      expect(badAt.code).toBe("invalid_run_options")
      expect(badAt.path).toBe("options.at")
      expect(badAt.message).toContain(`got '${at}'`)
    }
  })

  // Correlating batch results by array position attributed one case's score to
  // another the moment an adapter returned them in a different order.
  it("refuses a batch runner that returns results out of order", async () => {
    const suite = await suiteOf("reordered", [binding], [{ name: "a", input: 1 }, { name: "b", input: 2 }])
    const executor = executorFor((suiteCase) =>
      Effect.succeed({ output: suiteCase.input, stepKey: `step-${suiteCase.name}`, latencyMs: 0, target })
    )
    const reversing: Runner.ScoreBatchRunner = {
      runBatch: (jobs) =>
        Effect.succeed(
          [...jobs].reverse().map((job, index) => ({
            ...job.observation,
            kind: "score" as const,
            score: index === 0 ? 0.99 : 0.11,
            at: job.at
          }))
        )
    }
    const error = await failureOf(
      Runner.run(suite, { ...runOptions, scorer: reversing }).pipe(Effect.provide(executor))
    )
    expect(error.code).toBe("scorer_protocol")
    expect(error.message).toContain("results must stay aligned with their jobs")
    expect(error.path).toBe("runBatch[0]")
  })

  it("refuses ambiguous jobs before calling an order-only batch runner", async () => {
    const suite = await suiteOf("ambiguous", [binding], [{ name: "a", input: 1 }, { name: "b", input: 2 }])
    let called = false
    const reversing: Runner.ScoreBatchRunner = {
      runBatch: (jobs) => {
        called = true
        return Effect.succeed(
          [...jobs].reverse().map((job, index) => ({
            ...job.observation,
            kind: "score" as const,
            score: index === 0 ? 0.99 : 0.11,
            at: job.at
          }))
        )
      }
    }
    const error = await failureOf(
      Runner.run(suite, { ...runOptions, scorer: reversing }).pipe(Effect.provide(succeeding))
    )
    expect(called).toBe(false)
    expect(error.code).toBe("ambiguous_score_job")
    expect(error.message).toContain("cases 'a' and 'b'")
    expect(error.message).toContain("step key 'step'")
    expect(error.message).toContain(`scorer exact (${scorerFlow.scorerKey.slice(0, 8)})`)
    expect(error.message).toContain(
      "Give each case its own step key, or provide a batch runner that implements runBatchCorrelated"
    )
    expect(error.path).toBe("runBatch")
  })

  it("scores ambiguous jobs through the correlated inline runner", async () => {
    const suite = await suiteOf("inline-ambiguous", [binding], [
      { name: "a", input: 1 },
      { name: "b", input: 2 }
    ])
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(result.cases.map((caseResult) => caseResult.observations[0]?.kind)).toEqual(["score", "score"])
    expect(result.observations.map((observation) => observation.kind === "score" && observation.score)).toEqual([1, 1])
  })

  it("correlates reversed batch results by job identity", async () => {
    const suite = await suiteOf("correlated", [binding], [{ name: "a", input: 1 }, { name: "b", input: 2 }])
    const scorer: Runner.ScoreBatchRunner = {
      runBatch: () => Effect.die("order-only path used"),
      runBatchCorrelated: (jobs) =>
        Effect.succeed(
          jobs.map((job, index) => ({
            identity: job.identity,
            observation: {
              ...job.observation,
              kind: "score" as const,
              score: index === 0 ? 0.11 : 0.99,
              at: job.at
            }
          })).reverse()
        )
    }
    const result = await Effect.runPromise(
      Runner.run(suite, { ...runOptions, scorer }).pipe(Effect.provide(succeeding))
    )
    expect(result.cases.map((caseResult) => {
      const observation = caseResult.observations[0]
      return observation?.kind === "score" ? observation.score : undefined
    })).toEqual([0.11, 0.99])
  })

  it("rejects duplicate and unknown correlated identities", async () => {
    const suite = await suiteOf("bad-identities", [binding], [{ name: "a", input: 1 }, { name: "b", input: 2 }])
    const observation = (job: Runner.ScoreJob): Runner.ScoreObservation => ({
      ...job.observation,
      kind: "score",
      score: 1,
      at: job.at
    })
    const adapter = (
      runBatchCorrelated: NonNullable<Runner.ScoreBatchRunner["runBatchCorrelated"]>
    ): Runner.ScoreBatchRunner => ({ runBatch: () => Effect.die("order-only path used"), runBatchCorrelated })

    let duplicateIdentity = ""
    const duplicate = await failureOf(
      Runner.run(suite, {
        ...runOptions,
        scorer: adapter((jobs) => {
          duplicateIdentity = jobs[0]!.identity
          return Effect.succeed([
            { identity: jobs[0]!.identity, observation: observation(jobs[0]!) },
            { identity: jobs[0]!.identity, observation: observation(jobs[1]!) }
          ])
        })
      }).pipe(Effect.provide(succeeding))
    )
    expect(duplicate.code).toBe("scorer_protocol")
    expect(duplicate.message).toContain(`duplicate identity '${duplicateIdentity}'`)
    expect(duplicate.message).toContain("result index 1")

    const unknown = await failureOf(
      Runner.run(suite, {
        ...runOptions,
        scorer: adapter((jobs) =>
          Effect.succeed([
            { identity: "not-a-job", observation: observation(jobs[0]!) },
            { identity: jobs[1]!.identity, observation: observation(jobs[1]!) }
          ])
        )
      }).pipe(Effect.provide(succeeding))
    )
    expect(unknown.code).toBe("scorer_protocol")
    expect(unknown.message).toContain("unknown identity 'not-a-job'")
    expect(unknown.message).toContain("result index 0")
  })

  it("rejects correlated arity and echoed identity mismatches", async () => {
    const suite = await suiteOf("bad-correlated-results", [binding], [
      { name: "a", input: 1 },
      { name: "b", input: 2 }
    ])
    const adapter = (
      runBatchCorrelated: NonNullable<Runner.ScoreBatchRunner["runBatchCorrelated"]>
    ): Runner.ScoreBatchRunner => ({ runBatch: () => Effect.die("order-only path used"), runBatchCorrelated })

    const wrongArity = await failureOf(
      Runner.run(suite, {
        ...runOptions,
        scorer: adapter((jobs) =>
          Effect.succeed([{
            identity: jobs[0]!.identity,
            observation: { ...jobs[0]!.observation, kind: "score", score: 1, at: jobs[0]!.at }
          }])
        )
      }).pipe(Effect.provide(succeeding))
    )
    expect(wrongArity.code).toBe("scorer_protocol")
    expect(wrongArity.message).toContain("returned 1 results for 2 jobs")
    expect(wrongArity.path).toBe("runBatchCorrelated")

    const wrongEcho = await failureOf(
      Runner.run(suite, {
        ...runOptions,
        scorer: adapter((jobs) =>
          Effect.succeed(jobs.map((job, index) => ({
            identity: job.identity,
            observation: {
              ...job.observation,
              targetStepKey: index === 0 ? "wrong-step" : job.observation.targetStepKey,
              kind: "score" as const,
              score: 1,
              at: job.at
            }
          })))
        )
      }).pipe(Effect.provide(succeeding))
    )
    expect(wrongEcho.code).toBe("scorer_protocol")
    expect(wrongEcho.message).toContain("where job 0 asked for")
    expect(wrongEcho.message).toContain("at step 'step'")
    expect(wrongEcho.message).toContain("returned step 'wrong-step'")
    expect(wrongEcho.path).toBe("runBatchCorrelated[0]")
  })

  it("turns a correlated batch failure into identity-tagged inconclusive results", async () => {
    const suite = await suiteOf("correlated-failure", [binding], [{ name: "a", input: 1 }, { name: "b", input: 2 }])
    const scorer: Runner.ScoreBatchRunner = {
      runBatch: () => Effect.die("order-only path used"),
      runBatchCorrelated: () => Effect.fail("correlated judge unavailable")
    }
    const result = await Effect.runPromise(
      Runner.run(suite, { ...runOptions, scorer }).pipe(Effect.provide(succeeding))
    )
    expect(result.observations).toHaveLength(2)
    expect(
      result.observations.every((item) =>
        item.kind === "inconclusive" && item.reason.includes("correlated judge unavailable")
      )
    ).toBe(true)
  })

  it("refuses a batch runner that drops or duplicates results", async () => {
    const suite = await suiteOf("arity", [binding], [{ name: "a", input: 1 }, { name: "b", input: 2 }])
    const executor = executorFor((suiteCase) =>
      Effect.succeed({ output: suiteCase.input, stepKey: suiteCase.name, latencyMs: 0, target })
    )
    const observations = (jobs: ReadonlyArray<Runner.ScoreJob>) =>
      jobs.map((job) => ({ ...job.observation, kind: "score" as const, score: 1, at: job.at }))

    const dropping = await failureOf(
      Runner.run(suite, { ...runOptions, scorer: { runBatch: (jobs) => Effect.succeed(observations(jobs).slice(1)) } })
        .pipe(Effect.provide(executor))
    )
    expect(dropping.code).toBe("scorer_protocol")
    expect(dropping.message).toBe(
      "Scorer batch returned 1 observations for 2 jobs; a batch runner must return exactly one observation per job, in order"
    )
    expect(dropping.path).toBe("runBatch")

    const duplicating = await failureOf(
      Runner.run(suite, {
        ...runOptions,
        scorer: { runBatch: (jobs) => Effect.succeed([...observations(jobs), ...observations(jobs)]) }
      }).pipe(Effect.provide(executor))
    )
    expect(duplicating.message).toContain("4 observations for 2 jobs")
  })

  // A lying adapter used to have its out-of-range score copied straight into an
  // observation and relabelled with the identity the run expected.
  it("turns an out-of-range or non-finite score into a named inconclusive observation", async () => {
    const suite = await suiteOf("liar", [binding])
    for (const score of [2, Number.NaN, -1]) {
      const result = await Effect.runPromise(
        Runner.run(suite, {
          ...runOptions,
          scorer: {
            runBatch: (jobs) =>
              Effect.succeed(jobs.map((job) => ({ ...job.observation, kind: "score" as const, score, at: job.at })))
          }
        }).pipe(Effect.provide(succeeding))
      )
      const observation = result.observations[0]
      expect(observation?.kind).toBe("inconclusive")
      expect(observation?.kind === "inconclusive" && observation.reason).toBe(
        `Scorer exact (${scorerFlow.scorerKey.slice(0, 8)}) returned a score outside [0, 1]: ${String(score)}`
      )
    }
  })

  it("carries an inconclusive batch observation through with its own reason", async () => {
    const suite = await suiteOf("inconclusive", [binding])
    const result = await Effect.runPromise(
      Runner.run(suite, {
        ...runOptions,
        scorer: {
          runBatch: (jobs) =>
            Effect.succeed(
              jobs.map((job) => ({
                ...job.observation,
                kind: "inconclusive" as const,
                code: "inconclusive" as const,
                reason: "judge down",
                at: job.at
              }))
            )
        }
      }).pipe(Effect.provide(succeeding))
    )
    expect(result.observations[0]).toMatchObject({ kind: "inconclusive", reason: "judge down", scorerName: "exact" })
  })

  it("replaces an inconclusive observation without a reason and renders it", async () => {
    const suite = await suiteOf("missing-reason", [binding])
    for (const reason of [undefined, ""]) {
      const result = await Effect.runPromise(
        Runner.run(suite, {
          ...runOptions,
          scorer: {
            runBatch: (jobs) =>
              Effect.succeed(jobs.map((job) =>
                ({
                  ...job.observation,
                  kind: "inconclusive",
                  reason,
                  at: job.at
                }) as unknown as Runner.ScoreObservation
              ))
          }
        }).pipe(Effect.provide(succeeding))
      )
      const observation = result.observations[0]
      expect(observation?.kind).toBe("inconclusive")
      expect(observation?.kind === "inconclusive" && observation.reason).toBe(
        `Scorer exact (${scorerFlow.scorerKey.slice(0, 8)}) returned an inconclusive observation with no reason`
      )
      const inconclusive = result.observations.filter((item): item is Extract<Runner.Observation, {
        kind: "inconclusive"
      }> => item.kind === "inconclusive")
      const rendered = Report.markdown({
        suite: result.suite,
        baseline: { version: 1, suite: result.suite, records: [] },
        run: result,
        regressions: [],
        nondeterminism: [],
        missing: [],
        samples: [],
        inconclusive
      })
      expect(rendered).toContain("returned an inconclusive observation with no reason")
    }
  })

  it("bounds the generated reason for an inconclusive observation without one", async () => {
    const named = Scorer.make({
      id: "packages/smithers/agent/evals/test/Runner/long-name",
      version: "1",
      name: "x".repeat(5000),
      score: () => Effect.succeed({ score: 1 })
    })
    const suite = await suiteOf("bounded-missing-reason", [Binding.make({ scorer: named, appliesTo: target })])
    const result = await Effect.runPromise(
      Runner.run(suite, {
        ...runOptions,
        scorer: {
          runBatch: (jobs) =>
            Effect.succeed(jobs.map((job) =>
              ({
                ...job.observation,
                kind: "inconclusive",
                reason: undefined,
                at: job.at
              }) as unknown as Runner.ScoreObservation
            ))
        }
      }).pipe(Effect.provide(succeeding))
    )
    const observation = result.observations[0]
    expect(observation?.kind === "inconclusive" && observation.reason.endsWith("[truncated]")).toBe(true)
    expect(observation?.kind === "inconclusive" && observation.reason.length).toBeLessThan(2100)
  })

  it("turns an unknown observation kind into a named inconclusive observation", async () => {
    const suite = await suiteOf("unknown-kind", [binding])
    const result = await Effect.runPromise(
      Runner.run(suite, {
        ...runOptions,
        scorer: {
          runBatch: (jobs) =>
            Effect.succeed(jobs.map((job) =>
              ({
                ...job.observation,
                kind: "mystery",
                at: job.at
              }) as unknown as Runner.ScoreObservation
            ))
        }
      }).pipe(Effect.provide(succeeding))
    )
    const observation = result.observations[0]
    expect(observation?.kind).toBe("inconclusive")
    expect(observation?.kind === "inconclusive" && observation.reason).toBe(
      `Scorer exact (${scorerFlow.scorerKey.slice(0, 8)}) returned an unusable observation kind 'mystery'`
    )
  })

  it("bounds string reasons and drops a non-string score reason", async () => {
    const suite = await suiteOf("score-reasons", [binding])
    for (const reason of ["x".repeat(5000), 42]) {
      const result = await Effect.runPromise(
        Runner.run(suite, {
          ...runOptions,
          scorer: {
            runBatch: (jobs) =>
              Effect.succeed(jobs.map((job) =>
                ({
                  ...job.observation,
                  kind: "score",
                  score: 0.5,
                  reason,
                  meta: { kept: true },
                  at: job.at
                }) as unknown as Runner.ScoreObservation
              ))
          }
        }).pipe(Effect.provide(succeeding))
      )
      const observation = result.observations[0]
      expect(observation?.kind).toBe("score")
      expect(observation?.meta).toEqual({ kept: true })
      if (typeof reason === "string") {
        expect(observation?.reason?.endsWith("[truncated]")).toBe(true)
        expect(observation?.reason?.length).toBeLessThan(2100)
      } else {
        expect(Object.hasOwn(observation!, "reason")).toBe(false)
      }
    }
  })

  it("builds an injective job identity", async () => {
    const suite = await suiteOf("identity-encoding", [binding])
    let seen: ReadonlyArray<Runner.ScoreJob> = []
    await Effect.runPromise(
      Runner.run(suite, {
        ...runOptions,
        sampleId: "sample",
        scorer: {
          runBatch: (jobs) => {
            seen = jobs
            return Effect.succeed(
              jobs.map((job) => ({ ...job.observation, kind: "score" as const, score: 1, at: job.at }))
            )
          }
        }
      }).pipe(Effect.provide(succeeding))
    )
    expect(JSON.parse(seen[0]!.identity)).toEqual([
      "identity-encoding",
      "run",
      "sample",
      "one",
      "step",
      scorerFlow.scorerKey,
      "0"
    ])
  })
})
