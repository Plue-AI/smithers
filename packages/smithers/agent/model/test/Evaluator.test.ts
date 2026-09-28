import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import type { TestContext } from "vitest"
import { describe, expect, it } from "vitest"
import * as Evaluator from "../src/Evaluator.ts"

describe("public evaluator failures", () => {
  it("replaces unreachable transport details with the public sentence", () => {
    expect(Evaluator.publicMessage({
      code: "unreachable",
      message: "ECONNREFUSED https://private.invalid:9443?token=fixture-secret"
    })).toBe("Jev was unavailable: the judge this host binds did not answer.")
  })

  it("preserves the judge's explanation when it answered with a refusal", () => {
    expect(Evaluator.publicMessage({ code: "refused", message: "This model does not support choice questions." }))
      .toBe("This model does not support choice questions.")
  })
})

/**
 * The Vercel AI Gateway's answer to one evaluation, as recorded on 2026-09-17
 * against `typesafe-ai/jev`. Probabilities round to two decimals on the wire.
 */
const recorded = {
  answers: {
    relevant: { type: "boolean", probability: 0.91 },
    role: {
      type: "choice",
      choice: "implementation",
      probabilities: { implementation: 0.8, fixture: 0.15, unrelated: 0.05 }
    },
    risk: { type: "score", score: 1.2, probabilities: { "0": 0.1, "1": 0.65, "2": 0.2, "3": 0.05 } }
  }
} as const

const questions: Readonly<Record<string, Evaluator.Question>> = {
  relevant: {
    type: "boolean",
    instructions: "Does this file need to change for the task?",
    criteria: { true: "the fix or its test lives here", false: "unrelated or only imported" }
  },
  role: {
    type: "choice",
    instructions: "What is this file's role?",
    criteria: {
      implementation: "code under test",
      fixture: "test data or setup",
      unrelated: "nothing to do with the task"
    }
  },
  risk: { type: "score", instructions: "How risky is editing this file?", criteria: ["none", "low", "medium", "high"] }
}

const state = { task: "fix the parser", file: "src/Parser.ts", excerpt: "export const parse = ..." }

interface Sent {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly body: string
  readonly modelCall: string | undefined
}

/** A kernel HTTP client that answers one recorded response and remembers what it was sent. */
const httpLayer = (
  sent: Array<Sent>,
  respond: (request: HttpClientRequest.HttpClientRequest) => Response
): Layer.Layer<KernelHttpClient.HttpClient> =>
  Layer.succeed(KernelHttpClient.HttpClient)(
    HttpClient.make((request) =>
      Effect.gen(function*() {
        const modelCall = yield* KernelHttpClient.ModelCall
        const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
        sent.push({ request, body, modelCall })
        return HttpClientResponse.fromWeb(request, respond(request))
      })
    )
  )

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const evaluate = <E>(
  layer: Layer.Layer<Evaluator.Evaluator, E>,
  request: Evaluator.Request = { state, questions }
): Promise<Result.Result<Evaluator.Response, Evaluator.EvaluatorError | E>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const evaluator = yield* Evaluator.Evaluator
      return yield* evaluator.evaluate(request)
    }).pipe(
      Effect.provide(layer),
      Effect.result,
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
    )
  )

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) throw new Error(`Expected a failure, got ${JSON.stringify(result.success)}`)
  return result.failure
}

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`Expected a success, got ${JSON.stringify(result.failure)}`)
  return result.success
}

describe("Evaluator.layerVercelGateway", () => {
  it("speaks the recorded wire protocol and answers the recorded body", async () => {
    const sent: Array<Sent> = []
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("vck_test") }).pipe(
      Layer.provide(httpLayer(sent, () => json(recorded)))
    )

    const response = success(await evaluate(layer))

    expect(response.answers).toEqual(recorded.answers)
    expect(response.usage).toBeUndefined()
    expect(typeof response.latencyMs).toBe("number")
    expect(sent).toHaveLength(1)
    const [{ body, modelCall, request }] = sent as [Sent]
    expect(request.method).toBe("POST")
    expect(request.url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model")
    expect(request.headers).toMatchObject({
      "authorization": "Bearer vck_test",
      "ai-gateway-protocol-version": "0.0.1",
      "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": "4",
      "ai-model-id": "typesafe-ai/jev",
      "content-type": "application/json"
    })
    expect(JSON.parse(body)).toEqual({
      state,
      questions,
      providerOptions: { gateway: { zeroDataRetention: true } }
    })
    expect(modelCall).toBe("typesafe-ai/jev")
  })

  it.each([0, 2, -1, 1.5, true, false, null])(
    "wraps the JSON primitive %j without changing its meaning",
    async (state) => {
      const sent: Array<Sent> = []
      const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("vck_test") }).pipe(
        Layer.provide(httpLayer(sent, () => json(recorded)))
      )
      const originalQuestions = JSON.stringify(questions)

      success(await evaluate(layer, { state, questions }))

      const body = JSON.parse(sent[0]!.body)
      expect(body.state).toEqual({ state })
      for (const [id, question] of Object.entries(questions)) {
        expect(body.questions[id]).toEqual({
          ...question,
          instructions:
            "The original JSON state is wrapped in the object's state property. Answer about that original value, not the wrapper.\n\n" +
            question.instructions
        })
      }
      expect(JSON.stringify(questions)).toBe(originalQuestions)
    }
  )

  it.each<[string, unknown]>([
    ["string", "hello"],
    ["array", [0, true, null]],
    ["object", { state: null }]
  ])("preserves an already accepted %s state and its questions", async (_, state) => {
    const sent: Array<Sent> = []
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("vck_test") }).pipe(
      Layer.provide(httpLayer(sent, () => json(recorded)))
    )

    success(await evaluate(layer, { state, questions }))

    expect(JSON.parse(sent[0]!.body)).toEqual({
      state,
      questions,
      providerOptions: { gateway: { zeroDataRetention: true } }
    })
  })

  /**
   * The exact body main sent for this three-question classifier before the
   * question shapes became classes, read off `JSON.stringify` over the objects
   * the smart constructors returned. The gateway reads this body and a durable
   * call key is taken over it, so a class must not move one byte of it: not
   * the key order inside a question, not the order of the questions, and not
   * the absence of an optional `criteria`.
   */
  const recordedBody =
    `{"state":{"task":"fix the parser","file":"src/Parser.ts","excerpt":"export const parse = ..."},` +
    `"questions":{"relevant":{"type":"boolean","instructions":"Does this file need to change for the task?",` +
    `"criteria":{"true":"the fix or its test lives here","false":"unrelated or only imported"}},` +
    `"role":{"type":"choice","instructions":"What is this file's role?","criteria":{"implementation":"code under test",` +
    `"fixture":"test data or setup","unrelated":"nothing to do with the task"}},` +
    `"risk":{"type":"score","instructions":"How risky is editing this file?",` +
    `"criteria":["none","low","medium","high"]}},"providerOptions":{"gateway":{"zeroDataRetention":true}}}`

  it.each([
    ["questions written as object literals", questions],
    ["questions built as class instances", {
      relevant: Evaluator.BooleanQuestion.of({
        instructions: "Does this file need to change for the task?",
        criteria: { true: "the fix or its test lives here", false: "unrelated or only imported" }
      }),
      role: Evaluator.ChoiceQuestion.of({
        instructions: "What is this file's role?",
        criteria: {
          implementation: "code under test",
          fixture: "test data or setup",
          unrelated: "nothing to do with the task"
        }
      }),
      risk: Evaluator.ScoreQuestion.of({
        instructions: "How risky is editing this file?",
        criteria: ["none", "low", "medium", "high"]
      })
    }]
  ])("sends the byte-identical recorded body for %s", async (_, asked) => {
    const sent: Array<Sent> = []
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("vck_test") }).pipe(
      Layer.provide(httpLayer(sent, () => json(recorded)))
    )

    success(await evaluate(layer, { state, questions: asked }))

    expect(sent).toHaveLength(1)
    expect(sent[0]!.body).toBe(recordedBody)
  })

  it("fails a question no shape accepts as invalid_question, without reaching the network", async () => {
    const sent: Array<Sent> = []
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("vck_test") }).pipe(
      Layer.provide(httpLayer(sent, () => json(recorded)))
    )

    const error = failure(
      await evaluate(layer, {
        state,
        questions: { rank: { type: "rank", instructions: "?" } as unknown as Evaluator.Question }
      })
    )

    expect(error.code).toBe("invalid_question")
    expect(sent).toHaveLength(0)
  })

  it.each([
    ["a bigint", () => ({ count: 1n })],
    ["a cycle", () => {
      const value: Record<string, unknown> = {}
      value["self"] = value
      return value
    }],
    ["a missing state", () => undefined],
    ["an undefined field", () => ({ count: undefined })],
    ["a non-finite number", () => ({ count: Number.NaN })],
    ["a Map", () => new Map([["count", 1]])]
  ])("fails a state that is not JSON as invalid_question: %s", async (_, makeState) => {
    const sent: Array<Sent> = []
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k") }).pipe(
      Layer.provide(httpLayer(sent, () => json(recorded)))
    )

    const error = failure(await evaluate(layer, { state: makeState(), questions }))

    expect(error).toBeInstanceOf(Evaluator.EvaluatorError)
    expect(error.code).toBe("invalid_question")
    expect(sent).toHaveLength(0)
  })

  it("carries the provider's own per-question confidence", async () => {
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k") }).pipe(
      Layer.provide(
        httpLayer([], () =>
          json({
            ...recorded,
            providerMetadata: { typesafe: { confidence: { role: 0.8, risk: 0.65, relevant: "high" } } }
          }))
      )
    )

    const response = success(await evaluate(layer))

    // Only numbers survive. Jev reports no confidence for a boolean, and a
    // value that is not a number is dropped rather than coerced to one.
    expect(response.confidence).toEqual({ role: 0.8, risk: 0.65 })
  })

  it.each([
    ["no metadata", {}],
    ["metadata that is not an object", { providerMetadata: "none" }],
    ["no typesafe block", { providerMetadata: { other: { confidence: { role: 0.8 } } } }],
    ["a typesafe block that is not an object", { providerMetadata: { typesafe: 7 } }],
    ["no confidence block", { providerMetadata: { typesafe: {} } }],
    ["a confidence block that is not an object", { providerMetadata: { typesafe: { confidence: 0.8 } } }],
    ["a confidence block holding no numbers", { providerMetadata: { typesafe: { confidence: { role: "high" } } } }]
  ])("reports no confidence for %s", async (_, extra) => {
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k") }).pipe(
      Layer.provide(httpLayer([], () => json({ ...recorded, ...extra })))
    )

    expect(success(await evaluate(layer)).confidence).toBeUndefined()
  })

  it("honours every option and reads the key from Config", async () => {
    const sent: Array<Sent> = []
    const layer = Evaluator.layerVercelGateway({
      apiKey: Config.Redacted("AI_GATEWAY_API_KEY"),
      model: "typesafe-ai/jev-next",
      baseUrl: "https://gateway.example.test/evaluate",
      zeroDataRetention: false,
      timeoutMs: 250
    }).pipe(
      Layer.provide(httpLayer(sent, () => json({ ...recorded, usage: { inputTokens: 120, outputTokens: 3 } }))),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ AI_GATEWAY_API_KEY: "vck_from_config" })))
    )

    const response = success(await evaluate(layer))

    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 3 })
    const [{ body, modelCall, request }] = sent as [Sent]
    expect(request.url).toBe("https://gateway.example.test/evaluate")
    expect(request.headers).toMatchObject({
      "authorization": "Bearer vck_from_config",
      "ai-model-id": "typesafe-ai/jev-next"
    })
    expect(JSON.parse(body).providerOptions).toEqual({ gateway: { zeroDataRetention: false } })
    expect(modelCall).toBe("typesafe-ai/jev-next")
  })

  it("fails at construction when the Config cannot be read", async () => {
    const layer = Evaluator.layerVercelGateway({ apiKey: Config.Redacted("AI_GATEWAY_API_KEY") }).pipe(
      Layer.provide(httpLayer([], () => json(recorded))),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))
    )

    const error = failure(await Effect.runPromise(Layer.build(layer).pipe(Effect.result, Effect.scoped)))

    expect(error).toMatchObject({ _tag: "ConfigError" })
  })

  it("ignores usage that is not a pair of numbers", async () => {
    const layer = (usage: unknown) =>
      Evaluator.layerVercelGateway({ apiKey: Redacted.make("k") }).pipe(
        Layer.provide(httpLayer([], () => json({ ...recorded, usage })))
      )

    expect(success(await evaluate(layer("lots"))).usage).toBeUndefined()
    expect(success(await evaluate(layer({ inputTokens: "12", outputTokens: 3 }))).usage).toBeUndefined()
  })

  it.each(
    [
      [401, "refused"],
      [529, "refused"],
      [400, "invalid_question"],
      [422, "invalid_question"]
    ] as const
  )("maps status %s to %s with the status kept", async (status, code) => {
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k") }).pipe(
      Layer.provide(httpLayer([], () => json({ error: "no" }, status)))
    )

    const error = failure(await evaluate(layer))

    expect(error).toBeInstanceOf(Evaluator.EvaluatorError)
    expect(error).toMatchObject({ code, status, message: `The gateway answered ${status}` })
  })

  it.each([401, 500, 529])("asks once when the gateway answers %s", async (status) => {
    const sent: Array<Sent> = []
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k") }).pipe(
      Layer.provide(httpLayer(sent, () => json({ error: "no" }, status)))
    )

    expect(failure(await evaluate(layer))).toMatchObject({ code: "refused", status })
    expect(sent).toHaveLength(1)
  })

  /**
   * The body `typesafe-ai/jev` answered on 2026-09-23 to one request in about
   * seven over the gateway, whatever the concurrency: the provider shed the
   * request in about 125 ms and the gateway had no fallback to route to.
   */
  const shed = {
    error: {
      message: "Service temporarily unavailable. Please try again shortly.",
      type: "service_unavailable_error"
    }
  }

  it.each([503, 429, 502, 504])("asks again after a %s and answers what the next attempt answers", async (status) => {
    const sent: Array<Sent> = []
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k") }).pipe(
      Layer.provide(httpLayer(sent, () => sent.length === 1 ? json(shed, status) : json(recorded)))
    )

    const response = success(await evaluate(layer))

    expect(response.answers).toEqual(recorded.answers)
    expect(sent).toHaveLength(2)
    expect(sent[1]!.body).toBe(sent[0]!.body)
  })

  it("fails a gateway that sheds every attempt as refused, after the last attempt and before the deadline", async () => {
    const sent: Array<Sent> = []
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k"), timeoutMs: 3000 }).pipe(
      Layer.provide(httpLayer(sent, () => json(shed, 503)))
    )

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const evaluator = yield* Evaluator.Evaluator
        const fiber = yield* evaluator.evaluate({ state, questions }).pipe(Effect.result, Effect.forkChild)
        yield* Effect.yieldNow
        expect(sent).toHaveLength(1)
        yield* TestClock.adjust(Evaluator.retryBackoffMs - 1)
        expect(sent).toHaveLength(1)
        yield* TestClock.adjust(1)
        expect(sent).toHaveLength(2)
        yield* TestClock.adjust(2 * Evaluator.retryBackoffMs)
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(layer),
        Effect.provide(TestClock.layer()),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
      )
    )

    expect(sent).toHaveLength(Evaluator.defaultAttempts)
    expect(failure(result)).toMatchObject({
      code: "refused",
      status: 503,
      message: `The gateway answered 503 on all ${Evaluator.defaultAttempts} attempts`
    })
  })

  it("never waits past its deadline for another attempt", async () => {
    const sent: Array<Sent> = []
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k"), timeoutMs: 150, attempts: 5 }).pipe(
      Layer.provide(httpLayer(sent, () => json(shed, 503)))
    )

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const evaluator = yield* Evaluator.Evaluator
        const fiber = yield* evaluator.evaluate({ state, questions }).pipe(Effect.result, Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust(150)
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(layer),
        Effect.provide(TestClock.layer()),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
      )
    )

    expect(failure(result)).toMatchObject({ code: "timeout" })
    expect(sent).toHaveLength(2)
  })

  it("asks exactly once when told to make one attempt", async () => {
    const sent: Array<Sent> = []
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k"), attempts: 1 }).pipe(
      Layer.provide(httpLayer(sent, () => json(shed, 503)))
    )

    expect(failure(await evaluate(layer))).toMatchObject({
      code: "refused",
      status: 503,
      message: "The gateway answered 503"
    })
    expect(sent).toHaveLength(1)
  })

  it.each([
    ["not json", "Unreadable body"],
    [JSON.stringify([1, 2]), "carried no answers"],
    [JSON.stringify({ answers: "none" }), "carried no answers"],
    [JSON.stringify({}), "carried no answers"]
  ])("fails a 200 without answers as empty: %s", async (body, message) => {
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k") }).pipe(
      Layer.provide(httpLayer([], () => new Response(body, { status: 200 })))
    )

    const error = failure(await evaluate(layer))

    expect(error).toMatchObject({ code: "empty", status: 200 })
    expect(error.message).toContain(message)
  })

  it("stops reading a 200 body past maxResponseBytes instead of buffering it", async () => {
    let pulled = 0
    const chunk = new Uint8Array(64 * 1024).fill(0x20)
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulled += chunk.byteLength
        controller.enqueue(chunk)
      }
    })
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k") }).pipe(
      Layer.provide(httpLayer([], () => new Response(endless, { status: 200 })))
    )

    const error = failure(await evaluate(layer))

    expect(error).toMatchObject({ code: "empty", status: 200 })
    expect(error.message).toContain(`exceeds ${Evaluator.maxResponseBytes} bytes`)
    expect(pulled).toBeLessThan(Evaluator.maxResponseBytes + 4 * chunk.byteLength)
  })

  it("fails a 200 whose body stream breaks as empty", async () => {
    const broken = new ReadableStream<Uint8Array>({ pull: (controller) => controller.error(new Error("reset")) })
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k") }).pipe(
      Layer.provide(httpLayer([], () => new Response(broken, { status: 200 })))
    )

    const error = failure(await evaluate(layer))

    expect(error).toMatchObject({ code: "empty", status: 200 })
    expect(error.message).toContain("Unreadable body")
  })

  it.each([
    ["embedded credentials", "https://user:pass@gateway.example.test/evaluate"],
    ["a credential query parameter", "https://gateway.example.test/evaluate?api_key=x"],
    ["a non-http scheme", "file:///etc/passwd"]
  ])("never signs the key onto a baseUrl with %s", async (_, baseUrl) => {
    const sent: Array<Sent> = []
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("vck_secret"), baseUrl }).pipe(
      Layer.provide(httpLayer(sent, () => json(recorded)))
    )

    const error = failure(await evaluate(layer))

    expect(error.code).toBe("unreachable")
    expect(error.message).toContain("Invalid baseUrl")
    expect(sent).toHaveLength(0)
  })

  it("fails an answer the raw schema rejects as invalid_answer", async () => {
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k") }).pipe(
      Layer.provide(httpLayer([], () => json({ answers: { relevant: { type: "boolean", probability: "high" } } })))
    )

    const error = failure(await evaluate(layer))

    expect(error).toMatchObject({ code: "invalid_answer", status: 200 })
    expect(error.message).toContain("Expected number")
  })

  it("asks again after a connection failure and answers what the next attempt answers", async () => {
    const sent: Array<Sent> = []
    const recordedLayer = httpLayer(sent, () => json(recorded))
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k") }).pipe(
      Layer.provide(
        Layer.effect(KernelHttpClient.HttpClient)(Effect.gen(function*() {
          const real = yield* KernelHttpClient.HttpClient
          let calls = 0
          return HttpClient.make((request) =>
            ++calls === 1
              ? Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ request, description: "ECONNRESET" })
                })
              )
              : real.execute(request)
          )
        })).pipe(Layer.provide(recordedLayer))
      )
    )

    const response = success(await evaluate(layer))

    expect(response.answers).toEqual(recorded.answers)
    expect(sent).toHaveLength(1)
  })

  it("fails a transport that answers nothing as unreachable", async () => {
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k") }).pipe(
      Layer.provide(
        Layer.succeed(KernelHttpClient.HttpClient)(
          HttpClient.make((request) =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, description: "socket hung up" })
              })
            )
          )
        )
      )
    )

    const error = failure(await evaluate(layer))

    expect(error).toBeInstanceOf(Evaluator.EvaluatorError)
    expect(error).toMatchObject({ code: "unreachable" })
    expect((error as Evaluator.EvaluatorError).status).toBeUndefined()
    expect(error.message).toContain("socket hung up")
    expect(error.message).toContain(`on all ${Evaluator.defaultAttempts} attempts`)
  })

  it("fails a single-attempt transport that answers nothing as unreachable, without retry wording", async () => {
    let calls = 0
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k"), attempts: 1 }).pipe(
      Layer.provide(
        Layer.succeed(KernelHttpClient.HttpClient)(
          HttpClient.make((request) => {
            calls++
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, description: "socket hung up" })
              })
            )
          })
        )
      )
    )

    const error = failure(await evaluate(layer))

    expect(error).toMatchObject({ code: "unreachable" })
    expect(error.message).not.toContain("attempts")
    expect(calls).toBe(1)
  })

  it("fails on its own deadline as timeout and interrupts the request", async () => {
    let interrupted = false
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make("k"), timeoutMs: 1500 }).pipe(
      Layer.provide(
        Layer.succeed(KernelHttpClient.HttpClient)(
          HttpClient.make(() =>
            Effect.never.pipe(Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true
              })
            ))
          )
        )
      )
    )

    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const evaluator = yield* Evaluator.Evaluator
        const fiber = yield* evaluator.evaluate({ state, questions }).pipe(Effect.result, Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust(1499)
        yield* Effect.yieldNow
        expect(interrupted).toBe(false)
        yield* TestClock.adjust(1)
        return failure(yield* Fiber.join(fiber))
      }).pipe(
        Effect.provide(layer),
        Effect.provide(TestClock.layer()),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
      )
    )

    expect(error).toMatchObject({ code: "timeout", message: "The gateway did not answer within 1500 ms" })
    expect(interrupted).toBe(true)
  })
})

describe("Evaluator.layerScripted", () => {
  it("fills the type from the question and decodes the script's answers", async () => {
    const seen: Array<Evaluator.Request> = []
    const layer = Evaluator.layerScripted((request) => {
      seen.push(request)
      return { relevant: { probability: 0.9 }, role: { choice: "implementation" }, risk: { score: 1 } }
    })

    const response = success(await evaluate(layer))

    expect(response).toEqual({
      answers: {
        relevant: { type: "boolean", probability: 0.9 },
        role: { type: "choice", choice: "implementation" },
        risk: { type: "score", score: 1 }
      },
      latencyMs: 0
    })
    expect(seen).toEqual([{ state, questions }])
  })

  it("keeps an explicit type and passes an effectful script through", async () => {
    const layer = Evaluator.layerScripted(() =>
      Effect.succeed({ relevant: { type: "boolean" as const, probability: 0.2 } })
    )

    const response = success(await evaluate(layer))

    expect(response.answers).toEqual({ relevant: { type: "boolean", probability: 0.2 } })
  })

  it("fails the way the script fails", async () => {
    const layer = Evaluator.layerScripted(() =>
      Effect.fail(new Evaluator.EvaluatorError({ code: "refused", status: 429, message: "scripted" }))
    )

    expect(failure(await evaluate(layer))).toMatchObject({ code: "refused", status: 429, message: "scripted" })
  })

  it("fails an answer to no question, which has no type to fill, as invalid_answer", async () => {
    const layer = Evaluator.layerScripted(() => ({ stray: { probability: 0.5 } }))

    const error = failure(await evaluate(layer))

    expect(error).toMatchObject({ code: "invalid_answer" })
    expect(error.status).toBeUndefined()
  })
})

describe("Evaluator.layerUnavailable", () => {
  it("fails every request as unreachable", async () => {
    const error = failure(await evaluate(Evaluator.layerUnavailable()))

    expect(error).toBeInstanceOf(Evaluator.EvaluatorError)
    expect(error).toMatchObject({ code: "unreachable", message: "No evaluator is installed on this host" })
  })
})

describe("Evaluator.Question", () => {
  const decode = Schema.decodeUnknownResult(Evaluator.Question)

  it("accepts each shape", () => {
    for (const question of Object.values(questions)) expect(success(decode(question))).toEqual(question)
    expect(success(decode({ type: "boolean", instructions: "Is it?" }))).toEqual({
      type: "boolean",
      instructions: "Is it?"
    })
  })

  it.each([
    ["one option", { type: "choice", instructions: "?", criteria: { a: "only" } }, "between 2 and 255"],
    [
      "256 options",
      {
        type: "choice",
        instructions: "?",
        criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`k${i}`, "d"]))
      },
      "between 2 and 255"
    ],
    ["one rung", { type: "score", instructions: "?", criteria: ["only"] }, "orders at least 2 rungs, not 1"],
    ["repeated rungs", { type: "score", instructions: "?", criteria: ["low", "low"] }, "rungs are distinct"],
    ["an unknown type", { type: "rank", instructions: "?" }, "Expected"]
  ])("rejects %s", (_, question, message) => {
    expect(failure(decode(question)).message).toContain(message)
  })

  it("accepts 255 options and the raw answer shapes", () => {
    const criteria = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`k${i}`, "d"]))
    expect(Result.isSuccess(decode({ type: "choice", instructions: "?", criteria }))).toBe(true)
    const decodeAnswers = Schema.decodeUnknownResult(Evaluator.RawAnswers)
    expect(success(decodeAnswers(recorded.answers))).toEqual(recorded.answers)
    expect(failure(decodeAnswers({ risk: { type: "score", probabilities: {} } })).message).toContain("score")
  })
})

describe("Evaluator over the live gateway", () => {
  const apiKey = process.env["AI_GATEWAY_API_KEY"]

  /** Skips with the missing credential named, never with a bare skipped count. */
  const requireKey = (ctx: TestContext): void => {
    if (apiKey === undefined || apiKey === "") ctx.skip("AI_GATEWAY_API_KEY is unset")
  }

  it("answers the three question shapes", async (ctx) => {
    requireKey(ctx)
    const layer = Evaluator.layerVercelGateway({ apiKey: Redacted.make(apiKey ?? ""), timeoutMs: 10_000 }).pipe(
      Layer.provide(FetchHttpClient.layer)
    )

    const response = success(await evaluate(layer))

    expect(Object.keys(response.answers).sort()).toEqual(["relevant", "risk", "role"])
    expect(response.answers["relevant"]?.type).toBe("boolean")
    expect(response.answers["role"]?.type).toBe("choice")
    expect(response.answers["risk"]?.type).toBe("score")
  }, 20_000)
})
