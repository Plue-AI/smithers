import { digestSync } from "@smthrs/crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import { describe, expect, it } from "vitest"
import * as CanonicalJson from "../src/CanonicalJson.ts"
import * as Classifier from "../src/Classifier.ts"
import * as Evaluator from "../src/Evaluator.ts"

const Relevance = Classifier.make("triage/relevance", {
  description: "Whether a file must change for the task, and its role.",
  state: Schema.Struct({ task: Schema.String, file: Schema.String, excerpt: Schema.String }),
  questions: {
    relevant: Classifier.boolean({
      instructions: "Does this file need to change for the task?",
      criteria: { true: "the fix or its test lives here", false: "unrelated or only imported" }
    }),
    role: Classifier.choice({
      instructions: "What is this file's role?",
      criteria: {
        implementation: "code under test",
        fixture: "test data or setup",
        unrelated: "nothing to do with the task"
      }
    }),
    risk: Classifier.score({
      instructions: "How risky is editing this file?",
      criteria: ["none", "low", "medium", "high"]
    })
  }
})

type RelevanceAnswer = Classifier.AnswersOf<typeof Relevance.questions>

const state = { task: "fix the parser", file: "src/Parser.ts", excerpt: "export const parse = ..." }

const scripted = (answers: Readonly<Record<string, Evaluator.ScriptedAnswer>>): Layer.Layer<Evaluator.Evaluator> =>
  Evaluator.layerScripted(() => answers)

const good = {
  relevant: { probability: 0.91 },
  role: { choice: "implementation", probabilities: { implementation: 0.8, fixture: 0.15, unrelated: 0.05 } },
  risk: { score: 1.2, probabilities: { "0": 0.1, "1": 0.65, "2": 0.2, "3": 0.05 } }
} as const

const run = <A, E>(
  effect: Effect.Effect<A, E, Evaluator.Evaluator>,
  layer: Layer.Layer<Evaluator.Evaluator>
): Promise<Result.Result<A, E>> => Effect.runPromise(effect.pipe(Effect.result, Effect.provide(layer)))

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) throw new Error(`Expected a failure, got ${JSON.stringify(result.success)}`)
  return result.failure
}

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`Expected a success, got ${JSON.stringify(result.failure)}`)
  return result.success
}

const formatIssue = SchemaIssue.makeFormatterDefault()

/**
 * The schema message behind a construction a field's check refused. A class
 * constructor throws a plain `Error` reading "Schema validation failed" and
 * carries the issue in `cause`, so the limit's own words live there.
 */
const refusal = (build: () => unknown): string => {
  try {
    build()
  } catch (error) {
    const cause = (error as { readonly cause?: unknown }).cause
    return SchemaIssue.isIssue(cause) ? formatIssue(cause) : String(error)
  }
  throw new Error("Expected the construction to fail")
}

describe("Classifier question constructors", () => {
  it("builds a boolean with or without criteria", () => {
    expect(Classifier.boolean({ instructions: "Is it?" })).toEqual({ type: "boolean", instructions: "Is it?" })
    expect(Classifier.boolean({ instructions: "Is it?", criteria: { true: "yes", false: "no" } })).toEqual({
      type: "boolean",
      instructions: "Is it?",
      criteria: { true: "yes", false: "no" }
    })
    // `criteria` is an optional key, so an omitted one is absent rather than
    // present and undefined: canonical JSON rejects an undefined member, and a
    // digest is taken over exactly these keys.
    expect(Object.keys(Classifier.boolean({ instructions: "Is it?" }))).toEqual(["type", "instructions"])
  })

  it("accepts a choice of 2 and of 255 options and refuses 1 and 256", () => {
    const options = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, "d"]))
    expect(Object.keys(Classifier.choice({ instructions: "?", criteria: options(2) }).criteria)).toHaveLength(2)
    expect(Object.keys(Classifier.choice({ instructions: "?", criteria: options(255) }).criteria)).toHaveLength(255)
    expect(refusal(() => Classifier.choice({ instructions: "?", criteria: options(1) }))).toContain(
      "A choice question offers between 2 and 255 options, not 1"
    )
    expect(refusal(() => Classifier.choice({ instructions: "?", criteria: options(256) }))).toContain(
      "A choice question offers between 2 and 255 options, not 256"
    )
  })

  it("accepts a score of 2 distinct rungs and refuses 1 rung or a repeated one", () => {
    expect(Classifier.score({ instructions: "?", criteria: ["low", "high"] })).toEqual({
      type: "score",
      instructions: "?",
      criteria: ["low", "high"]
    })
    expect(refusal(() => Classifier.score({ instructions: "?", criteria: ["only"] }))).toContain(
      "A score question orders at least 2 rungs, not 1"
    )
    expect(refusal(() => Classifier.score({ instructions: "?", criteria: ["low", "low"] }))).toContain(
      "A score question's rungs are distinct"
    )
  })

  it("builds instances of the one class per shape the evaluator declares", () => {
    expect(Classifier.BooleanQuestion).toBe(Evaluator.BooleanQuestion)
    expect(Classifier.ChoiceQuestion).toBe(Evaluator.ChoiceQuestion)
    expect(Classifier.ScoreQuestion).toBe(Evaluator.ScoreQuestion)
    expect(Relevance.questions.relevant).toBeInstanceOf(Evaluator.BooleanQuestion)
    expect(Relevance.questions.role).toBeInstanceOf(Evaluator.ChoiceQuestion)
    expect(Relevance.questions.risk).toBeInstanceOf(Evaluator.ScoreQuestion)
    // `new` needs no `type`: the discriminant field carries a constructor
    // default, and it is still a plain `type` on the wire, not a `_tag`.
    expect(new Evaluator.ChoiceQuestion({ instructions: "?", criteria: { a: "A", b: "B" } }).type).toBe("choice")
  })

  it("shares the wire question schema with the evaluator", () => {
    expect(Classifier.Question).toBe(Evaluator.Question)
  })
})

describe("Classifier question inference", () => {
  it("keeps the literal option keys and rung labels through the class factories", () => {
    const role = Classifier.choice({
      instructions: "?",
      criteria: { implementation: "i", fixture: "f", unrelated: "u" }
    })
    const risk = Classifier.score({ instructions: "?", criteria: ["none", "low", "medium", "high"] })

    // Assigned both ways, so a collapse to `string` fails to compile whichever
    // direction it collapsed in. This is the inference a `Schema.Class`
    // instance type cannot carry on its own.
    type Role = Classifier.AnswerOf<typeof role>["value"]
    type Rung = Classifier.AnswerOf<typeof risk>["label"]
    const widened: "implementation" | "fixture" | "unrelated" = null as unknown as Role
    const narrowed: Role = "fixture"
    const widenedRung: "none" | "low" | "medium" | "high" = null as unknown as Rung
    const narrowedRung: Rung = "medium"
    // @ts-expect-error "reviewer" is not one of the declared options
    const notAnOption: Role = "reviewer"
    // @ts-expect-error "critical" is not one of the declared rungs
    const notARung: Rung = "critical"
    const yesNo: Classifier.AnswerOf<typeof Relevance.questions.relevant> = { value: true, probability: 1 }
    const questions: Classifier.Questions = { role, risk, relevant: Relevance.questions.relevant }

    expect([widened, narrowed, widenedRung, narrowedRung, notAnOption, notARung]).toHaveLength(6)
    expect(yesNo.value).toBe(true)
    expect(Object.keys(questions).sort()).toEqual(["relevant", "risk", "role"])
  })

  it("reads the same shapes off a question written as an object literal", () => {
    // A host that declared its questions before the classes landed still holds
    // structurally valid ones, and they still infer and still evaluate.
    const literal = {
      type: "choice",
      instructions: "Which?",
      criteria: { a: "A", b: "B" }
    } as const satisfies Classifier.ChoiceQuestion
    const value: Classifier.AnswerOf<typeof literal>["value"] = "b"

    expect(value).toBe("b")
    expect(Evaluator.encodeQuestions({ literal })).toEqual({ literal })
  })
})

describe("Classifier.make", () => {
  it("keeps the declaration and digests the id and questions canonically", () => {
    expect(Relevance.id).toBe("triage/relevance")
    expect(Relevance.description).toBe("Whether a file must change for the task, and its role.")
    expect(Object.keys(Relevance.questions)).toEqual(["relevant", "role", "risk"])
    expect(Relevance.digest).toBe(
      digestSync(
        CanonicalJson.stringify({
          id: "triage/relevance",
          questions: Evaluator.encodeQuestions(Relevance.questions)
        })
      )
    )
    expect(Relevance.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it("digests to the value it digested to before the question shapes became classes", () => {
    // Pinned, not derived: a digest feeds durable call keys and the harness's
    // sealed-key preimage, so a moved one silently invalidates journaled
    // replays. Both values were read off main before this refactor - the
    // three-shape declaration above, and a boolean whose optional `criteria`
    // is absent.
    const noCriteria = Classifier.make("minimal", {
      description: "d",
      state: Schema.Struct({ a: Schema.String }),
      questions: { ok: Classifier.boolean({ instructions: "Is it?" }) }
    })

    expect(Relevance.digest).toBe("c4e6361b9c49993f905ccb5dc1131683eab50c1c8dc88d567e728b40b9bb3c71")
    expect(noCriteria.digest).toBe("f05c15d970fb96731ff7261652c597ea0784b39a30638d0f0fe7417177ca9615")
  })

  it("digests the same declaration in another key order to the same value, and a changed question to another", () => {
    const reordered = Classifier.make("triage/relevance", {
      description: "Another description does not change the digest.",
      state: Relevance.state,
      questions: {
        risk: Relevance.questions.risk,
        role: Relevance.questions.role,
        relevant: Relevance.questions.relevant
      }
    })
    const changed = Classifier.make("triage/relevance", {
      description: Relevance.description,
      state: Relevance.state,
      questions: { ...Relevance.questions, relevant: Classifier.boolean({ instructions: "Does it matter?" }) }
    })

    expect(reordered.digest).toBe(Relevance.digest)
    expect(changed.digest).not.toBe(Relevance.digest)
  })
})

describe("Classifier.evaluate", () => {
  it("decodes the raw answers into typed ones", async () => {
    const answer: RelevanceAnswer = success(await run(Relevance.evaluate(state), scripted(good)))

    expect(answer).toEqual({
      relevant: { value: true, probability: 0.91 },
      role: {
        value: "implementation",
        probabilities: { implementation: 0.8, fixture: 0.15, unrelated: 0.05 },
        confidence: 0.8
      },
      risk: {
        value: 1.2,
        label: "low",
        probabilities: { none: 0.1, low: 0.65, medium: 0.2, high: 0.05 },
        confidence: 0.65
      }
    })
    // The inferred literal unions narrow the way the declaration reads.
    const role: "implementation" | "fixture" | "unrelated" = answer.role.value
    const label: "none" | "low" | "medium" | "high" = answer.risk.label
    expect([role, label]).toEqual(["implementation", "low"])
  })

  it("answers no below even odds, and one-hot distributions when the transport sends none", async () => {
    const answer = success(
      await run(
        Relevance.evaluate(state),
        scripted({ relevant: { probability: 0.49 }, role: { choice: "fixture" }, risk: { score: 3 } })
      )
    )

    expect(answer.relevant).toEqual({ value: false, probability: 0.49 })
    expect(answer.role).toEqual({
      value: "fixture",
      probabilities: { implementation: 0, fixture: 1, unrelated: 0 },
      confidence: 1
    })
    expect(answer.risk).toEqual({
      value: 3,
      label: "high",
      probabilities: { none: 0, low: 0, medium: 0, high: 1 },
      confidence: 1
    })
  })

  it("reads a score distribution keyed by label, fills a missing entry with 0, and rounds to the nearest rung", async () => {
    const answer = success(
      await run(
        Relevance.evaluate(state),
        scripted({ ...good, risk: { score: 1.5, probabilities: { low: 0.4, medium: 0.6 } } })
      )
    )

    expect(answer.risk).toEqual({
      value: 1.5,
      label: "medium",
      probabilities: { none: 0, low: 0.4, medium: 0.6, high: 0 },
      confidence: 0.6
    })
  })

  it.each<{
    readonly name: string
    readonly criteria: ReadonlyArray<string>
    readonly probabilities: Readonly<Record<string, number>>
    readonly expected: Readonly<Record<string, number>>
  }>([
    {
      name: "indexed probabilities with numeric labels",
      criteria: ["1", "2"],
      probabilities: { "0": 0.9, "1": 0.1 },
      expected: { "1": 0.9, "2": 0.1 }
    },
    {
      name: "label probabilities with numeric labels outside the index range",
      criteria: ["1", "2"],
      probabilities: { "1": 0.9, "2": 0.1 },
      expected: { "1": 0.9, "2": 0.1 }
    },
    {
      name: "index precedence when labels overlap every index",
      criteria: ["1", "0"],
      probabilities: { "0": 0.9, "1": 0.1 },
      expected: { "1": 0.9, "0": 0.1 }
    }
  ])("uses one score dictionary format for $name", async ({ criteria, probabilities, expected }) => {
    const answers = await Effect.runPromise(Classifier.decodeAnswers({
      rating: Classifier.score({ instructions: "Rate this state", criteria })
    }, {
      rating: { type: "score", score: 0.1, probabilities }
    }))

    expect(answers.rating).toEqual({
      value: 0.1,
      label: criteria[0],
      probabilities: expected,
      confidence: 0.9
    })
  })

  it("refuses a score dictionary mixing indexes and labels", async () => {
    const error = failure(
      await run(
        Relevance.evaluate(state),
        scripted({ ...good, risk: { score: 1.5, probabilities: { low: 0.4, "2": 0.6 } } })
      )
    )

    expect(error).toBeInstanceOf(Classifier.ClassifierError)
    expect(error.code).toBe("invalid_answer")
    expect(error.message).toContain("score probabilities must use either rung indexes or rung labels")
  })

  it("encodes the state through its schema before sending it", async () => {
    const seen: Array<Evaluator.Request> = []
    const Dated = Classifier.make("dated", {
      description: "A state with a Date, which the wire cannot carry.",
      state: Schema.Struct({ at: Schema.DateFromString }),
      questions: { fresh: Classifier.boolean({ instructions: "Is it fresh?" }) }
    })
    const layer = Evaluator.layerScripted((request) => {
      seen.push(request)
      return { fresh: { probability: 1 } }
    })

    const answer = success(await run(Dated.evaluate({ at: new Date("2026-09-17T00:00:00Z") }), layer))

    expect(answer.fresh).toEqual({ value: true, probability: 1 })
    expect(seen).toEqual([{ state: { at: "2026-09-17T00:00:00.000Z" }, questions: Dated.questions }])
  })

  it("fails a state its schema does not encode as invalid_question", async () => {
    const Bounded = Classifier.make("bounded", {
      description: "A state with a check.",
      state: Schema.Struct({ n: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))) }),
      questions: { fresh: Classifier.boolean({ instructions: "Is it fresh?" }) }
    })

    const error = failure(await run(Bounded.evaluate({ n: 7 }), scripted({ fresh: { probability: 1 } })))

    expect(error).toBeInstanceOf(Classifier.ClassifierError)
    expect(error.code).toBe("invalid_question")
  })

  it("carries a transport failure across as a ClassifierError, with and without a status", async () => {
    const refused = failure(
      await run(
        Relevance.evaluate(state),
        Evaluator.layerScripted(() =>
          Effect.fail(
            new Evaluator.EvaluatorError({
              code: "refused",
              status: 429,
              resetAtEpochMillis: Date.UTC(2026, 8, 30, 21),
              message: "rate limited"
            })
          )
        )
      )
    )
    const unreachable = failure(await run(Relevance.evaluate(state), Evaluator.layerUnavailable()))

    expect(refused).toBeInstanceOf(Classifier.ClassifierError)
    expect(refused).toMatchObject({
      code: "refused",
      status: 429,
      resetAtEpochMillis: Date.UTC(2026, 8, 30, 21),
      message: "rate limited"
    })
    expect(unreachable).toMatchObject({ code: "unreachable", message: "No evaluator is installed on this host" })
    expect(unreachable.status).toBeUndefined()
  })

  const invalid: ReadonlyArray<[string, Readonly<Record<string, Evaluator.ScriptedAnswer>>, string]> = [
    ["a missing answer", { relevant: good.relevant, role: good.role }, "the transport answered nothing"],
    [
      "an answer of another type",
      { ...good, relevant: { type: "choice", choice: "implementation" } },
      "expected a boolean answer, got choice"
    ],
    ["a boolean probability above 1", { ...good, relevant: { probability: 1.5 } }, "probability is 1.5"],
    [
      "a boolean probability that is not a number",
      { ...good, relevant: { probability: Number.NaN } },
      "probability is NaN"
    ],
    ["a choice that is not an option", { ...good, role: { choice: "test" } }, "\"test\" is not an option"],
    [
      "a choice probability below 0",
      { ...good, role: { choice: "fixture", probabilities: { fixture: -0.2 } } },
      "probability of \"fixture\" is -0.2"
    ],
    ["a score above the last rung", { ...good, risk: { score: 3.2 } }, "score 3.2 is outside the 4 rungs"],
    ["a negative score", { ...good, risk: { score: -1 } }, "score -1 is outside the 4 rungs"],
    ["an infinite score", { ...good, risk: { score: Number.POSITIVE_INFINITY } }, "is outside the 4 rungs"],
    [
      "a score probability above 1",
      { ...good, risk: { score: 2, probabilities: { "2": 1.2 } } },
      "probability of \"medium\" is 1.2"
    ]
  ]

  it.each(invalid)("fails %s as invalid_answer", async (_, answers, message) => {
    const error = failure(await run(Relevance.evaluate(state), scripted(answers)))

    expect(error).toBeInstanceOf(Classifier.ClassifierError)
    expect(error.code).toBe("invalid_answer")
    expect(error.message).toContain(message)
    expect(error.usage).toBeUndefined()
  })

  const paid = { inputTokens: 40, outputTokens: 3, modelId: "judge" }

  it("keeps what a transport failure paid (#3010)", async () => {
    const error = failure(
      await run(
        Relevance.evaluate(state),
        Evaluator.layerScripted(() =>
          Effect.fail(new Evaluator.EvaluatorError({ code: "timeout", message: "late", usage: paid }))
        )
      )
    )
    expect(error).toMatchObject({ code: "timeout", message: "late", usage: paid })
  })

  it("keeps what an answer it cannot decode paid (#3010)", async () => {
    const layer = Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
      evaluate: () =>
        Effect.succeed({ answers: { relevant: { type: "boolean", probability: 2 } }, latencyMs: 0, usage: paid })
    }))
    const error = failure(await run(Relevance.evaluate(state), layer))
    expect(error).toMatchObject({ code: "invalid_answer", usage: paid })
    expect(error.message).toContain("probability is 2")
  })
})

describe("Classifier.evaluateAll", () => {
  it("keeps the states' order and each state's own failure", async () => {
    const states = [
      { ...state, file: "a.ts" },
      { ...state, file: "b.ts" },
      { ...state, file: "c.ts" }
    ]
    const layer = Evaluator.layerScripted((request) =>
      (request.state as { file: string }).file === "b.ts"
        ? Effect.fail(new Evaluator.EvaluatorError({ code: "timeout", message: "slow" }))
        : { ...good, role: { choice: (request.state as { file: string }).file === "a.ts" ? "fixture" : "unrelated" } }
    )

    const results = success(await run(Relevance.evaluateAll(states, { concurrency: 2 }), layer))

    expect(results).toHaveLength(3)
    expect(success(results[0]!).role.value).toBe("fixture")
    expect(failure(results[1]!)).toMatchObject({ code: "timeout", message: "slow" })
    expect(success(results[2]!).role.value).toBe("unrelated")
  })

  it("holds at most `concurrency` requests in flight, and answers an empty batch at once", async () => {
    let inFlight = 0
    let peak = 0
    const layer = Evaluator.layerScripted(() =>
      Effect.gen(function*() {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        yield* Effect.sleep(5)
        inFlight -= 1
        return good
      })
    )
    const states = Array.from({ length: 6 }, (_, i) => ({ ...state, file: `${i}.ts` }))

    const bounded = success(await run(Relevance.evaluateAll(states, { concurrency: 2 }), layer))
    expect(bounded).toHaveLength(6)
    expect(peak).toBe(2)

    peak = 0
    const defaulted = success(await run(Relevance.evaluateAll(states), layer))
    expect(defaulted.every(Result.isSuccess)).toBe(true)
    expect(peak).toBe(6)
    expect(Classifier.defaultConcurrency).toBe(8)

    expect(success(await run(Relevance.evaluateAll([]), layer))).toEqual([])
  })
})

describe("Classifier.confidence and confident", () => {
  const relevant: Classifier.BooleanAnswer = { value: true, probability: 0.9 }
  const role: Classifier.ChoiceAnswer<"implementation" | "fixture"> = {
    value: "implementation",
    probabilities: { implementation: 0.7, fixture: 0.3 },
    confidence: 0.7
  }
  const risk: Classifier.ScoreAnswer<"low" | "high"> = {
    value: 0.4,
    label: "low",
    probabilities: { low: 0.6, high: 0.4 },
    confidence: 0.6
  }

  it("doubles a boolean's distance from even odds and reads the others' confidence", () => {
    expect(Classifier.confidence(relevant)).toBeCloseTo(0.8)
    expect(Classifier.confidence({ value: false, probability: 0.5 })).toBe(0)
    expect(Classifier.confidence(role)).toBe(0.7)
    expect(Classifier.confidence(risk)).toBe(0.6)
  })

  it("answers the value at or above the floor and none below it", () => {
    const value: Option.Option<"implementation" | "fixture"> = Classifier.confident(role, 0.7)
    expect(value).toEqual(Option.some("implementation"))
    expect(Classifier.confident(role, 0.71)).toEqual(Option.none())
    expect(Classifier.confident(relevant, 0.8)).toEqual(Option.some(true))
    expect(Classifier.confident(relevant, 0.81)).toEqual(Option.none())
    expect(Classifier.confident(risk, 0.5)).toEqual(Option.some(0.4))
    expect(Classifier.confident(risk as Classifier.Answer, 0.9)).toEqual(Option.none())
  })
})

describe("Classifier.decodeAnswers and Answer", () => {
  it("keeps every question id as an own answer property", async () => {
    const questions = Object.fromEntries(
      ["__proto__", "constructor", "toString"].map((id) => [id, Classifier.boolean({ instructions: "Is it ok?" })])
    )
    const raw = Object.fromEntries(
      Object.keys(questions).map((id) => [id, { type: "boolean" as const, probability: 0.9 }])
    )

    const answers = await Effect.runPromise(Classifier.decodeAnswers(questions, raw))

    expect(Object.keys(answers)).toEqual(Object.keys(questions))
    expect(JSON.parse(JSON.stringify(answers))).toEqual(
      Object.fromEntries(Object.keys(questions).map((id) => [id, { value: true, probability: 0.9 }]))
    )
  })

  it("keeps choice options as own probabilities and never reads inherited probabilities", async () => {
    const criteria = Object.fromEntries(["__proto__", "constructor", "toString"].map((key) => [key, key]))
    const questions = { kind: Classifier.choice({ instructions: "Which?", criteria }) }
    const answers = await Effect.runPromise(Classifier.decodeAnswers(questions, {
      kind: { type: "choice", choice: "__proto__", probabilities: Object.fromEntries([["__proto__", 1]]) }
    }))

    expect(answers.kind).toEqual({
      value: "__proto__",
      probabilities: Object.fromEntries([["__proto__", 1], ["constructor", 0], ["toString", 0]]),
      confidence: 1
    })
    expect(Object.keys(answers.kind.probabilities)).toEqual(Object.keys(criteria))
  })

  it("decodes raw answers against ad-hoc questions", async () => {
    const questions = {
      ok: { type: "boolean", instructions: "Is it ok?" },
      kind: { type: "choice", instructions: "Which?", criteria: { a: "A", b: "B" } }
    } as const
    const raw: Evaluator.RawAnswers = {
      ok: { type: "boolean", probability: 0.25 },
      kind: { type: "choice", choice: "b", probabilities: { a: 0.3, b: 0.7 } }
    }

    const answers = await Effect.runPromise(Classifier.decodeAnswers(questions, raw))

    expect(answers).toEqual({
      ok: { value: false, probability: 0.25 },
      kind: { value: "b", probabilities: { a: 0.3, b: 0.7 }, confidence: 0.7 }
    })
    for (const answer of Object.values(answers)) {
      expect(Result.isSuccess(Schema.decodeUnknownResult(Classifier.Answer)(answer))).toBe(true)
    }
  })

  it("accepts each decoded shape and rejects a probability outside [0, 1]", () => {
    const decode = Schema.decodeUnknownResult(Classifier.Answer)

    expect(Result.isSuccess(decode({ value: 1.2, label: "low", probabilities: { low: 1 }, confidence: 1 }))).toBe(true)
    expect(Result.isSuccess(decode({ value: true, probability: 0.5 }))).toBe(true)
    expect(Result.isSuccess(decode({ value: "a", probabilities: { a: 1 }, confidence: 1 }))).toBe(true)
    expect(Result.isFailure(decode({ value: true, probability: 1.5 }))).toBe(true)
    expect(Result.isFailure(decode({ value: "a", probabilities: { a: 1 }, confidence: -1 }))).toBe(true)
  })
})
