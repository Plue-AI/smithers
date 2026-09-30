/**
 * The one way this package asks Jev: metered, fail-closed, batched and
 * recorded. Every transport here is scripted and counts what it was asked.
 */
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type * as AgentEvent from "../src/AgentEvent.ts"
import * as EngineLike from "../src/EngineLike.ts"
import type { HarnessError } from "../src/HarnessError.ts"
import * as Judgement from "../src/Judgement.ts"

const one = Classifier.make("test/one", {
  description: "One state, two questions.",
  state: Schema.Struct({ n: Schema.NumberFromString }),
  questions: {
    yes: Classifier.boolean({ instructions: "Is n positive?" }),
    pick: Classifier.choice({ instructions: "Which?", criteria: { a: "the first", b: "the second" } })
  }
})

/** A scripted transport that records every request. */
const scripted = (script: Evaluator.Script) => {
  const asked: Array<Evaluator.Request> = []
  const layer = Evaluator.layerScripted((request) => {
    asked.push(request)
    return script(request)
  })
  return { asked, layer }
}

const answered = () => scripted(() => ({ yes: { probability: 0.8 }, pick: { choice: "a" } }))

const failure = <A, E>(effect: Effect.Effect<A, E>): Promise<E> =>
  Effect.runPromise(Effect.result(effect)).then((result) => {
    if (Result.isSuccess(result)) throw new Error("the reading succeeded")
    return result.failure
  })

describe("read", () => {
  it("fails unconfigured on a host with no evaluator, and asks nothing", async () => {
    expect(await failure(Judgement.read(one, { n: 1 }))).toEqual({
      reason: "unconfigured",
      detail: "No evaluator is installed on this host"
    })
    expect(Judgement.unconfigured.reason).toBe("unconfigured")
  })

  it("fails unreachable with the public sentence, never the transport's text", async () => {
    const unjudged = await failure(Judgement.read(one, { n: 1 }).pipe(Effect.provide(Evaluator.layerUnavailable())))
    expect(unjudged).toEqual({
      reason: "unreachable",
      detail: Evaluator.publicMessage({ code: "unreachable", message: "No evaluator is installed on this host" })
    })
    expect(unjudged.detail).toBe(Evaluator.unreachableMessage)
  })

  it("fails invalid_answer when the transport leaves a question unanswered", async () => {
    const jev = scripted(() => ({ yes: { probability: 0.8 } }))
    const unjudged = await failure(Judgement.read(one, { n: 1 }).pipe(Effect.provide(jev.layer)))
    expect(unjudged.reason).toBe("invalid_answer")
    expect(jev.asked).toHaveLength(1)
  })

  it("answers through the bound evaluator", async () => {
    const jev = answered()
    const reading = await Effect.runPromise(Judgement.read(one, { n: 1 }).pipe(Effect.provide(jev.layer)))
    expect(reading.answers.yes.probability).toBe(0.8)
    expect(reading.answers.pick.value).toBe("a")
    expect(reading.asked).not.toHaveProperty("usage")
  })
})

describe("measured", () => {
  it("keeps the state as sent, the usage, the confidence and the latency", async () => {
    const metered = Layer.succeed(Evaluator.Evaluator)(
      Evaluator.Evaluator.of({
        evaluate: () =>
          Effect.succeed({
            answers: { yes: { type: "boolean", probability: 0.3 }, pick: { type: "choice", choice: "b" } },
            confidence: { pick: 0.7 },
            usage: { inputTokens: 321, outputTokens: 12 },
            latencyMs: 5
          })
      })
    )
    const { answers, asked } = await Effect.runPromise(Judgement.measured(one, { n: 3 }).pipe(Effect.provide(metered)))

    expect(answers.yes.probability).toBe(0.3)
    expect(asked.state).toEqual({ n: "3" })
    expect(asked.usage).toEqual({ inputTokens: 321, outputTokens: 12 })
    expect(asked.answers).toEqual({
      yes: { kind: "boolean", p: 0.3 },
      pick: { kind: "choice", value: "b", probabilities: { a: 0, b: 1 }, confidence: 0.7 }
    })
    expect(asked).toMatchObject({ classifier: "test/one", digest: one.digest, questions: one.questions })
    expect(Number.isInteger(asked.latencyMs)).toBe(true)
    expect(asked.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it("keeps the transport's own failure", async () => {
    const jev = scripted(() => Effect.fail(new Evaluator.EvaluatorError({ code: "refused", message: "no" })))
    const error = await failure(Judgement.measured(one, { n: 1 }).pipe(Effect.provide(jev.layer)))
    expect(error).toMatchObject({ code: "refused", message: "no" })
  })
})

describe("perItem", () => {
  const declare = (options: { readonly maxStateBytes?: number; readonly concurrency?: number } = {}) =>
    Judgement.perItem({
      id: "test/items",
      description: "Per item.",
      context: Schema.String,
      item: Schema.String,
      questions: {
        remove: (index) => Classifier.boolean({ instructions: `Remove items[${index}]?` }),
        keep: (index) => Classifier.boolean({ instructions: `Keep items[${index}]?` })
      },
      ...options
    })

  /** Answers `remove_i` with the item's own number over ten, `keep_i` with its complement. */
  const byItem = (fail?: (items: ReadonlyArray<string>) => boolean) =>
    scripted((request) => {
      const { items } = request.state as { readonly items: ReadonlyArray<string> }
      if (fail?.(items) === true) {
        return Effect.fail(new Evaluator.EvaluatorError({ code: "timeout", message: "late" }))
      }
      return Object.fromEntries(items.flatMap((item, index) => {
        const p = Number(item.slice(2)) / 10
        return [[`remove_${index}`, { probability: p }], [`keep_${index}`, { probability: 1 - p }]]
      }))
    })

  const items = ["it00", "it01", "it02", "it03", "it04"]
  // `{"context":"c","items":[]}` is 26 bytes and each item 6 more, plus a
  // comma after the first: two items fit in 40 bytes and three do not.
  const small = 40

  it("packs items into requests under the byte ceiling, each numbered from 0, answered in order", async () => {
    const perItem = declare({ maxStateBytes: small, concurrency: 1 })
    const jev = byItem()
    const reading = await Effect.runPromise(perItem.read("c", items).pipe(Effect.provide(jev.layer)))

    expect(jev.asked.map((request) => (request.state as { readonly items: unknown }).items)).toEqual([
      ["it00", "it01"],
      ["it02", "it03"],
      ["it04"]
    ])
    expect(Object.keys(jev.asked[0]!.questions)).toEqual(["remove_0", "keep_0", "remove_1", "keep_1"])
    expect(Object.keys(jev.asked[2]!.questions)).toEqual(["remove_0", "keep_0"])
    for (const request of jev.asked) {
      expect(new TextEncoder().encode(JSON.stringify(request.state)).byteLength).toBeLessThanOrEqual(small)
    }
    expect(reading.answers.map((answer) => answer.remove.probability)).toEqual([0, 0.1, 0.2, 0.3, 0.4])
    expect(reading.answers.map((answer) => answer.keep.probability)).toEqual([1, 0.9, 0.8, 0.7, 0.6])
    expect(reading.asked.map((asked) => asked.digest)).toEqual([
      perItem.classifierFor(2).digest,
      perItem.classifierFor(2).digest,
      perItem.classifierFor(1).digest
    ])
  })

  it("sends every item in one request when they fit", async () => {
    const jev = byItem()
    const reading = await Effect.runPromise(declare().read("c", items).pipe(Effect.provide(jev.layer)))
    expect(jev.asked).toHaveLength(1)
    expect(reading.answers).toHaveLength(5)
  })

  it("fails the whole reading when one request fails, with no partial answers", async () => {
    const jev = byItem((batch) => batch[0] === "it02")
    const unjudged = await failure(
      declare({ maxStateBytes: small, concurrency: 1 }).read("c", items).pipe(Effect.provide(jev.layer))
    )
    expect(unjudged).toEqual({ reason: "timeout", detail: "late" })
  })

  it("asks nothing about no items", async () => {
    const jev = byItem()
    const reading = await Effect.runPromise(declare().read("c", []).pipe(Effect.provide(jev.layer)))
    expect(reading).toEqual({ answers: [], asked: [] })
    expect(jev.asked).toEqual([])
  })

  it("fails invalid_question on an item too large to send alone", async () => {
    const jev = byItem()
    const unjudged = await failure(
      declare({ maxStateBytes: small }).read("c", ["it00", "x".repeat(64)]).pipe(Effect.provide(jev.layer))
    )
    expect(unjudged.reason).toBe("invalid_question")
    expect(unjudged.detail).toContain("Item 1")
    expect(jev.asked).toEqual([])
  })

  it("fails invalid_question when the context or an item does not encode", async () => {
    const positive = Schema.Number.check(Schema.isGreaterThan(0))
    const perItem = Judgement.perItem({
      id: "test/encode",
      description: "Encodes.",
      context: positive,
      item: positive,
      questions: { keep: (index) => Classifier.boolean({ instructions: `Keep items[${index}]?` }) }
    })
    const jev = byItem()
    expect((await failure(perItem.read(-1, [1]).pipe(Effect.provide(jev.layer)))).reason).toBe("invalid_question")
    expect((await failure(perItem.read(1, [-1]).pipe(Effect.provide(jev.layer)))).reason).toBe("invalid_question")
    expect(jev.asked).toEqual([])
  })

  it("declares one classifier per request size", () => {
    const perItem = declare()
    expect(perItem.classifierFor(3)).toBe(perItem.classifierFor(3))
    expect(perItem.classifierFor(3).digest).not.toBe(perItem.classifierFor(4).digest)
    expect(perItem.classifierFor(3).id).toBe("test/items")
  })
})

describe("events", () => {
  const asked: Judgement.Asked = {
    classifier: "test/one",
    digest: one.digest,
    questions: one.questions,
    state: { n: "1" },
    answers: { yes: { kind: "boolean", p: 0.8 } },
    latencyMs: 4
  }

  it("builds decision-settled rows decided by jev, with usage only when reported", () => {
    const row = Judgement.decision(asked, { scope: "s", frame: 2, acted: true })
    expect(row).toMatchObject({ _tag: "decision-settled", scope: "s", frame: 2, acted: true, decidedBy: "jev" })
    expect(row).not.toHaveProperty("usage")
    const usage = { inputTokens: 3, outputTokens: 1 }
    expect(Judgement.decision({ ...asked, usage }, { scope: "s", frame: 2, acted: false }).usage).toEqual(usage)
  })

  it("builds decision-unjudged rows", () => {
    expect(
      Judgement.unjudgedEvent(Judgement.unconfigured, { scope: "s", frame: 1, classifier: "test/one", items: 3 })
    ).toMatchObject({
      _tag: "decision-unjudged",
      reason: "unconfigured",
      detail: "No evaluator is installed on this host",
      classifier: "test/one",
      items: 3
    })
  })
})

describe("recorded", () => {
  /** An engine that runs a boundary once and serves its JSON round trip after. */
  const recording = () => {
    const store = new Map<string, unknown>()
    const engine = EngineLike.makeNoop({
      record: <A>(boundary: EngineLike.RecordBoundary<A>) =>
        Effect.gen(function*() {
          const key = JSON.stringify([boundary.name, boundary.identity])
          if (store.has(key)) return yield* Effect.orDie(Schema.decodeUnknownEffect(boundary.success)(store.get(key)))
          const value = yield* boundary.execute
          const encoded = yield* Effect.orDie(Schema.encodeEffect(boundary.success)(value))
          store.set(key, JSON.parse(JSON.stringify(encoded)))
          return value
          // A durable schema encodes and decodes without services.
        }) as Effect.Effect<A, HarnessError>
    })
    return { engine, store }
  }

  const boundary = {
    name: "test",
    identity: { session: "s", frame: 3, boundary: "test:1" },
    classifier: "test/one",
    value: Schema.Boolean,
    items: 2
  }

  const execute = Effect.gen(function*() {
    const reading = yield* Judgement.read(one, { n: 1 })
    return { value: reading.answers.yes.probability > 0.5, asked: [reading.asked], acted: true }
  })

  it("asks once and serves the record to a replay", async () => {
    const { engine } = recording()
    const jev = answered()
    const first = await Effect.runPromise(
      Judgement.recorded(engine, boundary, execute).pipe(Effect.provide(jev.layer))
    )
    const replayed = await Effect.runPromise(
      Judgement.recorded(engine, boundary, execute).pipe(Effect.provide(jev.layer))
    )

    expect(jev.asked).toHaveLength(1)
    expect(first.value).toBe(true)
    expect(first.unjudged).toBeNull()
    expect(first.decisions).toHaveLength(1)
    expect(first.decisions[0]).toMatchObject({ scope: "s", frame: 3, classifier: "test/one", acted: true })
    expect(replayed).toEqual(first)
  })

  it("records a failed reading as null with its unjudged row, and journals rows in order", async () => {
    const { engine } = recording()
    const failed = await Effect.runPromise(Judgement.recorded(engine, boundary, execute))

    expect(failed.value).toBeNull()
    expect(failed.decisions).toEqual([])
    expect(failed.unjudged).toMatchObject({ reason: "unconfigured", scope: "s", frame: 3, items: 2 })

    const emitted: Array<AgentEvent.AgentEvent> = []
    const emit = (event: AgentEvent.AgentEvent) => Effect.sync(() => void emitted.push(event))
    const row = Judgement.decision({
      classifier: "test/one",
      digest: one.digest,
      questions: one.questions,
      state: null,
      answers: {},
      latencyMs: 0
    }, { scope: "s", frame: 3, acted: false })
    await Effect.runPromise(Judgement.emitRecorded(emit, { ...failed, decisions: [row, row] }))
    expect(emitted.map((event) => event._tag)).toEqual(["decision-settled", "decision-settled", "decision-unjudged"])

    emitted.length = 0
    await Effect.runPromise(Judgement.emitRecorded(emit, { value: true, decisions: [row], unjudged: null }))
    expect(emitted.map((event) => event._tag)).toEqual(["decision-settled"])
  })

  it("names the usage its readings were metered for, off the recorded value (#2681)", async () => {
    const paid: Array<unknown> = []
    const engine = EngineLike.makeNoop({
      record: <A>(boundary: EngineLike.RecordBoundary<A>) =>
        Effect.tap(boundary.execute, (value) => Effect.sync(() => void paid.push(boundary.usage?.(value))))
    })
    const metered = Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
      evaluate: () =>
        Effect.succeed({
          answers: { yes: { type: "boolean", probability: 0.8 }, pick: { type: "choice", choice: "a" } },
          latencyMs: 0,
          usage: { inputTokens: 40, outputTokens: 2 }
        })
    }))
    const twice = Effect.gen(function*() {
      const first = yield* Judgement.read(one, { n: 1 })
      const second = yield* Judgement.read(one, { n: 2 })
      return { value: true, asked: [first.asked, second.asked], acted: false }
    })
    await Effect.runPromise(Judgement.recorded(engine, boundary, twice).pipe(Effect.provide(metered)))
    // Unmetered, and a reading that never happened, name no spend at all.
    await Effect.runPromise(Judgement.recorded(engine, boundary, execute).pipe(Effect.provide(answered().layer)))
    await Effect.runPromise(Judgement.recorded(engine, boundary, execute))
    expect(paid).toEqual([[{ usage: { inputTokens: 80, outputTokens: 4 } }], undefined, undefined])
  })
})

describe("task", () => {
  it("keeps both ends of a long task, bounded", () => {
    expect(Judgement.task("  short  ")).toBe("short")
    const long = `${"a".repeat(Judgement.taskBytes)}${"z".repeat(Judgement.taskBytes)}`
    const kept = Judgement.task(long)
    expect(kept.length).toBeLessThan(long.length)
    expect(kept).toContain("the run record has the whole task")
    expect(kept.startsWith("a")).toBe(true)
    expect(kept.endsWith("z")).toBe(true)
  })
})
