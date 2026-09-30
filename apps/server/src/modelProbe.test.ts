import { afterEach, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { TestClock } from "effect/testing"
import { MODEL_CATALOG_PATH, MODEL_TEST_PATH } from "@smthrs/rpc/AgentApiRoutes"
import {
  MODEL_CALL_MAX_TOKENS_MAX,
  MODEL_CALL_TEXT_MAX,
  MODEL_TEST_BODY_MAX_BYTES,
  MODEL_TEST_DEADLINE_MS,
  MODEL_TEST_MAX_TOKENS,
  MODEL_TEST_PROMPT,
  ModelCatalogSchema,
  ModelTestResultSchema,
  bindingOf,
  modelSeatsOf,
  planModelBinding
} from "@smthrs/rpc/ConfiguredModel"
import type { ConfiguredModel, ModelCallInput, ModelTestResult } from "@smthrs/rpc/ConfiguredModel"
import { testConfigLayer } from "./Config"
import type { ServerConfigShape } from "./Config"
import { memoryStorage } from "./DurableStorage"
import type { NativeNamespace } from "./DurableStorage"
import { transportLayer } from "./Http"
import worker from "./index"
import type { WorkerEnv } from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"
import { handleModelCatalog, handleModelTest } from "./modelProbe"
import { LOGIN_ALL_KEY, loginDailyKey, TURN_WINDOW_MAX, TurnRateLimiter } from "./turnLimit"

/*
 * The Worker's half of the Models surface. These tests hold it to the
 * contract: a credential is a name pinned to origins, so the deployment's key
 * rides only to the origin its name allows; one Test is one request, never
 * redirected; every outcome is a typed result; and the key's value appears in
 * no response, whatever the provider echoes. The transport double records
 * every request, so "nothing was asked" is a count.
 */

const CEREBRAS_SECRET = "csk-test-REDACTME-123"
const GATEWAY_SECRET = "vck-test-REDACTME-456"
const KEYS = { cerebrasApiKey: Redacted.make(CEREBRAS_SECRET), aiGatewayApiKey: Redacted.make(GATEWAY_SECRET) }

const recording = (answer?: (request: Request) => Promise<Response>) => {
  const calls: Array<Request> = []
  return {
    calls,
    layer: transportLayer(async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      if (answer === undefined) throw new Error("no provider must be asked")
      return answer(request)
    })
  }
}

const chat: ConfiguredModel = {
  id: "fast",
  protocol: "openai-chat",
  baseUrl: "https://api.cerebras.ai",
  modelId: "gpt-oss-120b",
  credential: "CEREBRAS_API_KEY"
}

const decision: ConfiguredModel = {
  id: "judge",
  protocol: "evaluation",
  modelId: "typesafe-ai/jev",
  credential: "AI_GATEWAY_API_KEY"
}

const post = (body: unknown): Request =>
  new Request(`https://mvp.test${MODEL_TEST_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  })

const completion = (content: unknown): Response =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })

const answered = (answers: unknown): Response =>
  new Response(JSON.stringify({ answers }), { status: 200, headers: { "content-type": "application/json" } })

interface Deps {
  readonly answer?: (request: Request) => Promise<Response>
  readonly config?: Partial<ServerConfigShape>
}

/** One Test, answered: the raw response text (what a reader could ever see), the typed result, and the requests made. */
const run = async (body: unknown, deps: Deps = {}) => {
  const net = recording(deps.answer)
  const response = await Effect.runPromise(
    handleModelTest(post(body), undefined).pipe(Effect.provide(Layer.mergeAll(net.layer, testConfigLayer({ ...KEYS, ...deps.config }))))
  )
  const text = await response.text()
  return { response, text, calls: net.calls }
}

const resultOf = (text: string): ModelTestResult => ModelTestResultSchema.parse(JSON.parse(text))

const failureOf = (text: string) => {
  const result = resultOf(text)
  if (result.ok) throw new Error("the test passed")
  return { failure: result.failure, fault: result.fault }
}

describe("GET /api/model/catalog", () => {
  const catalog = async (config: Partial<ServerConfigShape>) => {
    const response = await Effect.runPromise(handleModelCatalog().pipe(Effect.provide(testConfigLayer(config))))
    const text = await response.text()
    return { response, text, body: ModelCatalogSchema.parse(JSON.parse(text)) }
  }

  test("lists exactly the two deployment keys by name, pinned to their origins, and never a value", async () => {
    const { response, text, body } = await catalog(KEYS)
    expect(response.status).toBe(200)
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin")
    expect(body.credentials).toEqual([
      { name: "CEREBRAS_API_KEY", present: true, origins: ["https://api.cerebras.ai"] },
      { name: "AI_GATEWAY_API_KEY", present: true, origins: ["https://ai-gateway.vercel.sh"] }
    ])
    expect(body.seats).toEqual(["explainer", "front-door", "recommend"])
    expect(text).not.toContain(CEREBRAS_SECRET)
    expect(text).not.toContain(GATEWAY_SECRET)
  })

  test("every listed model is builtin and is one this host's Test would serve", async () => {
    const { body } = await catalog(KEYS)
    expect(body.models.map((model) => model.protocol).sort()).toContain("evaluation")
    expect(body.models.some((model) => model.protocol === "openai-chat")).toBe(true)
    expect(new Set(body.models.map((model) => model.id)).size).toBe(body.models.length)
    for (const model of body.models) {
      expect(model.builtin).toBe(true)
      expect(planModelBinding(bindingOf(model), body.credentials).ok).toBe(true)
    }
  })

  test("an unset key is listed absent and its models are not offered", async () => {
    const { body } = await catalog({ aiGatewayApiKey: KEYS.aiGatewayApiKey })
    expect(body.credentials.find((row) => row.name === "CEREBRAS_API_KEY")?.present).toBe(false)
    expect(body.models.length).toBeGreaterThan(0)
    expect(body.models.every((model) => model.credential === "AI_GATEWAY_API_KEY")).toBe(true)
    expect((await catalog({})).body.models).toEqual([])
  })

  test("a configured cloud-role model id is the row offered", async () => {
    const { body } = await catalog({ ...KEYS, cerebrasModelLibrarian: "llama-4-scout" })
    expect(body.models.map((model) => model.modelId)).toContain("llama-4-scout")
  })
})

describe("POST /api/model/test, a generation model", () => {
  test("is one non-streaming chat completion to the pinned origin, never redirected", async () => {
    const { response, text, calls } = await run({ model: chat }, { answer: async () => completion("  ok\n") })
    expect(response.status).toBe(200)
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp")
    const result = resultOf(text)
    // The words are kept whole for the composer; the row's sample is trimmed and bounded.
    expect(result).toEqual({ ok: true, latencyMs: result.latencyMs, sample: "ok", output: { kind: "generation", text: "  ok\n" } })

    expect(calls.length).toBe(1)
    const sent = calls[0]!
    expect(sent.url).toBe("https://api.cerebras.ai/v1/chat/completions")
    expect(sent.method).toBe("POST")
    expect(sent.redirect).toBe("manual")
    expect(sent.headers.get("authorization")).toBe(`Bearer ${CEREBRAS_SECRET}`)
    expect(sent.headers.get("content-type")).toBe("application/json")
    // `reasoning_effort` is stated, never left out: the Cerebras default is
    // `high`, and a Test that spent its whole budget reasoning would report a
    // latency and an empty answer for a key that is perfectly good.
    expect(await sent.json()).toEqual({
      model: "gpt-oss-120b",
      stream: false,
      max_tokens: MODEL_TEST_MAX_TOKENS,
      reasoning_effort: "low",
      messages: [{ role: "user", content: MODEL_TEST_PROMPT }]
    })
  })

  test("the fixed Test carries its text, and a composed prompt rides with its system prompt and parameters", async () => {
    const fixed = await run({ model: chat }, { answer: async () => completion("ok") })
    expect(resultOf(fixed.text)).toMatchObject({ ok: true, sample: "ok", output: { kind: "generation", text: "ok" } })
    const input: ModelCallInput = { kind: "generation", system: "Answer tersely.", prompt: "ping?", maxTokens: 64, temperature: 0.2 }
    const { text, calls } = await run({ model: chat, input }, { answer: async () => completion("pong") })
    expect(resultOf(text)).toMatchObject({ ok: true, sample: "pong", output: { kind: "generation", text: "pong" } })
    expect(calls.length).toBe(1)
    expect(await calls[0]!.json()).toEqual({
      model: "gpt-oss-120b",
      stream: false,
      max_tokens: 64,
      reasoning_effort: "low",
      temperature: 0.2,
      messages: [{ role: "system", content: "Answer tersely." }, { role: "user", content: "ping?" }]
    })
  })

  test("honours the record's own path on the pinned origin", async () => {
    const { calls } = await run({ model: { ...chat, path: "/v2/chat/completions" } }, { answer: async () => completion("ok") })
    expect(calls.map((call) => call.url)).toEqual(["https://api.cerebras.ai/v2/chat/completions"])
  })

  test("an empty completion is distinct from an invalid protocol", async () => {
    const { text } = await run({ model: chat }, { answer: async () => completion("") })
    expect(resultOf(text)).toMatchObject({ ok: false, failure: { code: "empty_output" }, fault: "dependency" })
  })

  test("a foreign origin is endpoint_forbidden and the key goes nowhere, set or unset", async () => {
    for (const config of [{}, { cerebrasApiKey: undefined }]) {
      for (const baseUrl of ["https://attacker.example", "https://ai-gateway.vercel.sh", "http://127.0.0.1:11434", "https://api.cerebras.ai.attacker.example"]) {
        const { response, text, calls } = await run({ model: { ...chat, baseUrl } }, { config })
        expect(response.status).toBe(200)
        expect(failureOf(text)).toEqual({ failure: { code: "endpoint_forbidden" }, fault: "user" })
        expect(calls.length).toBe(0)
      }
    }
  })

  test("a name this host does not resolve is credential_unknown, and nothing is asked", async () => {
    for (const credential of ["OPENAI_API_KEY", "GITHUB_TOKEN", "IDENTITY_SERVICE_TOKEN"]) {
      const { text, calls } = await run({ model: { ...chat, credential } }, { config: { githubToken: Redacted.make("ghp-test") } })
      expect(failureOf(text).failure).toEqual({ code: "credential_unknown", credential })
      expect(calls.length).toBe(0)
    }
  })

  test("an unset key is credential_missing naming the credential, the deployment's fault", async () => {
    const { response, text, calls } = await run({ model: chat }, { config: { cerebrasApiKey: undefined } })
    expect(response.status).toBe(200)
    expect(failureOf(text)).toEqual({ failure: { code: "credential_missing", credential: "CEREBRAS_API_KEY" }, fault: "infra" })
    expect(calls.length).toBe(0)
  })

  test("a refusal carries the provider's status and the fault it earns", async () => {
    const limited = await run({ model: chat }, { answer: async () => new Response("slow down", { status: 429 }) })
    expect(failureOf(limited.text)).toEqual({ failure: { code: "refused", status: 429 }, fault: "wait" })
    expect(limited.calls.length).toBe(1)
    const denied = await run({ model: chat }, { answer: async () => new Response("bad key", { status: 401 }) })
    expect(failureOf(denied.text)).toEqual({ failure: { code: "refused", status: 401 }, fault: "user" })
    const down = await run({ model: chat }, { answer: async () => new Response("", { status: 503 }) })
    expect(failureOf(down.text)).toEqual({ failure: { code: "refused", status: 503 }, fault: "dependency" })
    // One Test is one request: a retryable status is not retried.
    expect(down.calls.length).toBe(1)
  })

  test("a redirect is refused and its target is never requested", async () => {
    const { text, calls } = await run({ model: chat }, {
      answer: async () => new Response(null, { status: 307, headers: { location: "https://attacker.example/v1/chat/completions" } })
    })
    expect(failureOf(text).failure).toEqual({ code: "refused", status: 307 })
    expect(calls.map((call) => call.url)).toEqual(["https://api.cerebras.ai/v1/chat/completions"])
  })

  test("a provider that cannot be reached is unreachable", async () => {
    const { text } = await run({ model: chat }, {
      answer: async () => {
        throw new Error("connection reset")
      }
    })
    expect(failureOf(text)).toEqual({ failure: { code: "unreachable" }, fault: "dependency" })
  })

  test("a 200 that is not a chat completion is invalid, naming the protocol", async () => {
    for (const body of ["<html>gateway</html>", JSON.stringify({ choices: [] }), JSON.stringify({ choices: [{ message: { content: 7 } }] })]) {
      const { text } = await run({ model: chat }, { answer: async () => new Response(body, { status: 200 }) })
      expect(failureOf(text)).toEqual({ failure: { code: "invalid", field: "protocol" }, fault: "user" })
    }
  })

  test("an input of the other kind than the record's is invalid at the protocol, and no provider is asked", async () => {
    const generation: ModelCallInput = { kind: "generation", system: "", prompt: "hi", maxTokens: 8 }
    const composed: ModelCallInput = { kind: "decision", state: [{ key: "text", kind: "text", value: "hi" }], questions: { ok: { type: "boolean", instructions: "?" } } }
    for (const body of [{ model: decision, input: generation }, { model: chat, input: composed }]) {
      const { response, text, calls } = await run(body)
      expect(response.status).toBe(200)
      expect(failureOf(text)).toEqual({ failure: { code: "invalid", field: "protocol" }, fault: "user" })
      expect(calls.length).toBe(0)
    }
  })

  test("the words are cut at the wire's bound, so a long answer is a pass that parses", async () => {
    const { text } = await run(
      { model: chat, input: { kind: "generation", system: "", prompt: "go", maxTokens: MODEL_CALL_MAX_TOKENS_MAX } },
      { answer: async () => completion("x".repeat(MODEL_CALL_TEXT_MAX + 1)) }
    )
    // resultOf parses with ModelTestResultSchema: an uncut answer fails there, as it would in the client.
    const result = resultOf(text)
    expect(result.ok && result.output?.kind === "generation" ? result.output.text.length : undefined).toBe(MODEL_CALL_TEXT_MAX)
  })

  test("a provider that never answers is a timeout carrying the deadline that armed it, and the call is aborted", async () => {
    let aborted = false
    const net = recording((request) =>
      new Promise<Response>((_, reject) => {
        request.signal.addEventListener("abort", () => {
          aborted = true
          reject(new DOMException("aborted", "AbortError"))
        })
      })
    )
    const response = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(handleModelTest(post({ model: chat }), undefined))
        while (net.calls.length === 0) yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
        yield* TestClock.adjust(MODEL_TEST_DEADLINE_MS)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(Layer.mergeAll(net.layer, testConfigLayer(KEYS), TestClock.layer())))
    )
    expect(response.status).toBe(200)
    expect(resultOf(await response.text())).toEqual({
      ok: false,
      latencyMs: MODEL_TEST_DEADLINE_MS,
      failure: { code: "timeout", deadlineMs: MODEL_TEST_DEADLINE_MS },
      fault: "dependency"
    })
    expect(aborted).toBe(true)
  })

  test("the gateway key is not spent on a chat completion, whatever the path", async () => {
    const gateway = { ...chat, baseUrl: "https://ai-gateway.vercel.sh", modelId: "openai/gpt-5-pro", credential: "AI_GATEWAY_API_KEY" }
    for (const model of [gateway, { ...gateway, path: "/v1/responses" }]) {
      const { text, calls } = await run({ model }, { answer: async () => completion("ok") })
      expect(failureOf(text)).toEqual({ failure: { code: "model_not_allowed" }, fault: "user" })
      expect(calls.length).toBe(0)
      expect(text).not.toContain(GATEWAY_SECRET)
    }
  })

  test("the protocols no key here speaks are invalid, naming the protocol, and nothing is asked", async () => {
    for (const protocol of ["anthropic-messages", "openai-responses"] as const) {
      const { response, text, calls } = await run({ model: { ...chat, protocol } })
      expect(response.status).toBe(200)
      expect(failureOf(text)).toEqual({ failure: { code: "invalid", field: "protocol" }, fault: "user" })
      expect(calls.length).toBe(0)
    }
  })
})

describe("POST /api/model/test, a decision model", () => {
  test("asks the gateway's evaluation endpoint once and samples the probability", async () => {
    const { text, calls } = await run({ model: decision }, { answer: async () => answered({ ok: { type: "boolean", probability: 0.974 } }) })
    expect(resultOf(text)).toMatchObject({ ok: true, sample: "true 0.97" })
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model")
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${GATEWAY_SECRET}`)
    expect(calls[0]!.headers.get("ai-model-id")).toBe("typesafe-ai/jev")
  })

  test("a no is a pass too", async () => {
    const { text } = await run({ model: decision }, { answer: async () => answered({ ok: { type: "boolean", probability: 0.2 } }) })
    expect(resultOf(text)).toMatchObject({ ok: true, sample: "false 0.20" })
  })

  test("the fixed Test carries its typed answer, and a composed request carries its own state and questions", async () => {
    const fixed = await run({ model: decision }, { answer: async () => answered({ ok: { type: "boolean", probability: 0.974 } }) })
    expect(resultOf(fixed.text)).toMatchObject({ ok: true, output: { kind: "decision", answers: { ok: { type: "boolean", value: true, probability: 0.974 } } } })
    const input: ModelCallInput = {
      kind: "decision",
      state: [{ key: "path", kind: "path", value: "src/a.ts" }, { key: "passed", kind: "boolean", value: "false" }],
      questions: {
        ok: { type: "boolean", instructions: "Did it pass?" },
        which: { type: "choice", instructions: "Which?", criteria: { a: "src/a.ts", b: "src/b.ts" } },
        risk: { type: "score", instructions: "How risky?", criteria: ["low", "high"] }
      }
    }
    const { text, calls } = await run({ model: decision, input }, {
      answer: async () => answered({ ok: { type: "boolean", probability: 0.2 }, which: { type: "choice", choice: "b", probabilities: { b: 0.9 } }, risk: { type: "score", score: 1 } })
    })
    expect(resultOf(text)).toMatchObject({
      ok: true,
      sample: "false 0.20",
      output: { kind: "decision", answers: {
        ok: { type: "boolean", value: false, probability: 0.2 },
        which: { type: "choice", value: "b", probabilities: { a: 0, b: 0.9 }, confidence: 0.9 },
        risk: { type: "score", value: 1, label: "high", probabilities: { low: 0, high: 1 }, confidence: 1 }
      } }
    })
    expect(calls.length).toBe(1)
    const body = await calls[0]!.json() as { state: unknown; questions: Record<string, unknown> }
    expect(body.state).toEqual({ path: "src/a.ts", passed: false })
    expect(Object.keys(body.questions)).toEqual(["ok", "which", "risk"])
    // An answer that does not fit its question is the protocol's failure, never a guessed answer.
    const wrong = await run({ model: decision, input }, { answer: async () => answered({ ok: { type: "boolean", probability: 0.2 }, which: { type: "choice", choice: "z" }, risk: { type: "score", score: 1 } }) })
    expect(failureOf(wrong.text).failure).toEqual({ code: "invalid", field: "protocol" })
  })

  test("a model off the decision allowlist is model_not_allowed", async () => {
    const { text, calls } = await run({ model: { ...decision, modelId: "openai/gpt-5" } })
    expect(failureOf(text).failure).toEqual({ code: "model_not_allowed" })
    expect(calls.length).toBe(0)
  })

  test("an address that is not the evaluation endpoint is invalid, and the gateway key is not spent on it", async () => {
    const moved = await run({ model: { ...decision, baseUrl: "https://ai-gateway.vercel.sh/elsewhere" } })
    expect(failureOf(moved.text).failure).toEqual({ code: "invalid", field: "baseUrl" })
    expect(moved.calls.length).toBe(0)
    const wrongKey = await run({ model: { ...decision, credential: "CEREBRAS_API_KEY", baseUrl: "https://api.cerebras.ai" } })
    expect(failureOf(wrongKey.text).failure).toEqual({ code: "invalid", field: "baseUrl" })
    expect(wrongKey.calls.length).toBe(0)
    const foreign = await run({ model: { ...decision, baseUrl: "https://attacker.example" } })
    expect(failureOf(foreign.text).failure).toEqual({ code: "endpoint_forbidden" })
    expect(foreign.calls.length).toBe(0)
  })

  test("each gateway outcome is its typed failure", async () => {
    const refused = await run({ model: decision }, { answer: async () => new Response("no", { status: 401 }) })
    expect(failureOf(refused.text).failure).toEqual({ code: "refused", status: 401 })
    const unreadable = await run({ model: decision }, { answer: async () => answered("not a map") })
    expect(failureOf(unreadable.text).failure).toEqual({ code: "invalid", field: "protocol" })
    const other = await run({ model: decision }, { answer: async () => answered({ ok: { type: "choice", choice: "yes" } }) })
    expect(failureOf(other.text).failure).toEqual({ code: "invalid", field: "protocol" })
    const dead = await run({ model: decision }, {
      answer: async () => {
        throw new Error("connection reset")
      }
    })
    expect(failureOf(dead.text).failure).toEqual({ code: "unreachable" })
    const unset = await run({ model: decision }, { config: { aiGatewayApiKey: undefined } })
    expect(failureOf(unset.text).failure).toEqual({ code: "credential_missing", credential: "AI_GATEWAY_API_KEY" })
    expect(unset.calls.length).toBe(0)
  })
})

describe("the key's value reaches no response", () => {
  const leaks: ReadonlyArray<{ readonly name: string; readonly answer: (request: Request) => Promise<Response> }> = [
    { name: "a completion that echoes the bearer", answer: async (request) => completion(`you sent ${request.headers.get("authorization")}`) },
    {
      name: "a completion that splits the key around itself",
      answer: async () => completion(`${CEREBRAS_SECRET.slice(0, 4)}${CEREBRAS_SECRET}${CEREBRAS_SECRET.slice(4)}`)
    },
    { name: "a refusal whose body quotes the key", answer: async () => new Response(JSON.stringify({ error: `bad key ${CEREBRAS_SECRET}` }), { status: 401 }) },
    { name: "a redirect that carries the key", answer: async () => new Response(null, { status: 302, headers: { location: `https://attacker.example/?k=${CEREBRAS_SECRET}` } }) },
    {
      name: "a connection error that names the key",
      answer: async () => {
        throw new Error(`connect failed for ${CEREBRAS_SECRET}`)
      }
    },
    { name: "an undecodable 200 that quotes the key", answer: async () => new Response(`<html>${CEREBRAS_SECRET}</html>`, { status: 200 }) }
  ]

  for (const leak of leaks) {
    test(leak.name, async () => {
      const { response, text } = await run({ model: chat }, { answer: leak.answer })
      expect(response.status).toBe(200)
      expect(text).not.toContain(CEREBRAS_SECRET)
      expect([...response.headers.values()].join("\n")).not.toContain(CEREBRAS_SECRET)
      // Strict on both branches: no free-text field exists for a value to ride in.
      resultOf(text)
    })
  }
})

describe("POST /api/model/test refuses a body it will not run", () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly body: unknown; readonly status: number; readonly code: string }> = [
    { name: "a body that is not JSON", body: "{ nope", status: 400, code: "request_body_not_json" },
    { name: "a body with no model", body: {}, status: 400, code: "request_invalid" },
    { name: "a record carrying a key", body: { model: { ...chat, apiKey: CEREBRAS_SECRET } }, status: 400, code: "request_invalid" },
    { name: "an app-only field left on the record", body: { model: { ...chat, lastTest: { id: "t", testedAt: 1 } } }, status: 400, code: "request_invalid" },
    { name: "an extra top-level key", body: { model: chat, credentials: [] }, status: 400, code: "request_invalid" },
    { name: "an unknown protocol", body: { model: { ...chat, protocol: "gemini" } }, status: 400, code: "request_invalid" },
    { name: "a body past the cap", body: { model: chat, pad: "x".repeat(MODEL_TEST_BODY_MAX_BYTES) }, status: 413, code: "request_body_too_large" },
    { name: "a composed request with no question", body: { model: decision, input: { kind: "decision", state: [], questions: {} } }, status: 400, code: "request_invalid" },
    { name: "a composed choice with one option", body: { model: decision, input: { kind: "decision", state: [], questions: { q: { type: "choice", instructions: "?", criteria: { a: "" } } } } }, status: 400, code: "request_invalid" },
    { name: "a composed prompt with no words", body: { model: chat, input: { kind: "generation", system: "", prompt: " ", maxTokens: 8 } }, status: 400, code: "request_invalid" },
    { name: "a composed temperature that is text", body: { model: chat, input: { kind: "generation", system: "", prompt: "hi", maxTokens: 8, temperature: "0.2" } }, status: 400, code: "request_invalid" },
    // Assigned into a plain object, this name sets a prototype and the rung's probability is lost; both hosts refuse it rather than disagree.
    { name: "a composed score with a rung named __proto__", body: { model: decision, input: { kind: "decision", state: [], questions: { q: { type: "score", instructions: "?", criteria: ["__proto__", "other"] } } } }, status: 400, code: "request_invalid" },
    { name: "a composed choice with an option named __proto__", body: { model: decision, input: { kind: "decision", state: [], questions: { q: { type: "choice", instructions: "?", criteria: { ["__proto__"]: "", a: "", b: "" } } } } }, status: 400, code: "request_invalid" },
    // A record parse drops this id without a word; the request is refused whole, never run with a question missing.
    { name: "a composed question whose id is __proto__", body: { model: decision, input: { kind: "decision", state: [], questions: { ok: { type: "boolean", instructions: "?" }, ["__proto__"]: { type: "boolean", instructions: "?" } } } }, status: 400, code: "request_invalid" }
  ]

  for (const example of cases) {
    test(`${example.name} is ${example.status} ${example.code}`, async () => {
      const { response, text, calls } = await run(example.body)
      expect(response.status).toBe(example.status)
      expect((JSON.parse(text) as { status: string; code: string }).code).toBe(example.code)
      expect(text).not.toContain(CEREBRAS_SECRET)
      expect(calls.length).toBe(0)
    })
  }
})

/*
 * The two routes through the Worker's real fetch handler, with the platform
 * fetch patched: identity decides the session, and anything else is the
 * provider. The catalog is public; the Test is what the session and the
 * login's budget gate.
 */
describe("the model routes, the public catalog and the gated Test", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const seams = (identity: () => Response): { readonly provider: Array<Request> } => {
    const provider: Array<Request> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input as Request | string, init)
      if (request.url === "https://identity.test/api/identity/cloud-token") return Response.json({ found: true, token: "cloud-token-will" })
      if (new URL(request.url).hostname === "identity.test") return identity()
      provider.push(request)
      return completion("ok")
    }) as typeof fetch
    return { provider }
  }

  const session = (login: string) => (): Response =>
    new Response(JSON.stringify({ login }), { status: 200, headers: { "content-type": "application/json" } })

  const countingLimits = (count = 0): NativeNamespace & { readonly spent: Array<string> } => {
    const spent: Array<string> = []
    const limiter = new TurnRateLimiter({ storage: memoryStorage({ window: { start: Date.now(), count } }) })
    return {
      spent,
      idFromName: (name) => name,
      get: (id) => ({
        fetch: (request) => {
          spent.push(String(id))
          return limiter.fetch(request)
        }
      })
    }
  }

  const gatedEnv = (limits?: NativeNamespace): WorkerEnv => ({
    ...memoryDurableObjects(),
    ASSETS: { fetch: async () => new Response("not-found", { status: 404 }) },
    IDENTITY_UPSTREAM_URL: "https://identity.test",
    CEREBRAS_API_KEY: CEREBRAS_SECRET,
    IDENTITY_SERVICE_TOKEN: "service-token",
    SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test",
    ...(limits === undefined ? {} : { TURN_LIMITS: limits })
  })

  const catalogRequest = (headers: Record<string, string> = {}): Request =>
    new Request(`https://mvp.test${MODEL_CATALOG_PATH}`, { headers })
  const testRequest = (headers: Record<string, string> = {}): Request =>
    new Request(`https://mvp.test${MODEL_TEST_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: chat })
    })
  const SIGNED_IN = { cookie: "smithers_session=abc" }
  const codeOf = async (response: Response): Promise<string> => ((await response.json()) as { code: string }).code

  test("there is no account credential enrollment: the credential routes are gone and nothing is forwarded", async () => {
    const { provider } = seams(session("alice"))
    const env = gatedEnv()
    for (const path of ["/api/model/credential", "/api/model/credential/receipt?id=some-request"]) {
      const response = await worker.fetch(new Request(`https://mvp.test${path}`, {
        method: path.includes("receipt") ? "GET" : "POST", headers: SIGNED_IN,
        ...(path.includes("receipt") ? {} : { body: JSON.stringify({ value: "private-provider-fixture" }) })
      }), env)
      expect(response.status).toBe(404)
    }
    const catalog = ModelCatalogSchema.parse(await (await worker.fetch(catalogRequest(SIGNED_IN), env)).json())
    expect(catalog.enrollment).toBeUndefined()
    expect(provider).toHaveLength(0)
  })

  /*
   * Naming what this deployment already holds spends nothing, so the catalog
   * is public: a signed-out visitor sees the free seat rather than a refusal
   * that reads as "no models". Only the Test spends, and it keeps the gate.
   */
  test("the catalog is public: a signed-out caller reads the rows and seats, and no value is in the body", async () => {
    const { provider } = seams(() => new Response("{}", { status: 401 }))
    const response = await worker.fetch(catalogRequest(), gatedEnv())
    expect(response.status).toBe(200)
    const text = await response.text()
    const body = ModelCatalogSchema.parse(JSON.parse(text))
    expect(body.models.length).toBeGreaterThan(0)
    expect(body.models.every((model) => model.builtin === true && model.credential === "CEREBRAS_API_KEY")).toBe(true)
    expect(body.seats).toEqual([...modelSeatsOf("cloud")])
    expect(body.credentials.map((row) => [row.name, row.present])).toEqual([
      ["CEREBRAS_API_KEY", true],
      ["AI_GATEWAY_API_KEY", false]
    ])
    expect(text).not.toContain(CEREBRAS_SECRET)
    expect(provider.length).toBe(0)
  })

  test("a signed-out caller is sign_in_required on the Test, and no key is spent", async () => {
    const { provider } = seams(() => new Response("{}", { status: 401 }))
    const response = await worker.fetch(testRequest(), gatedEnv())
    expect(response.status).toBe(401)
    expect(await codeOf(response)).toBe("sign_in_required")
    expect(provider.length).toBe(0)
  })

  test("each route answers its own method only", async () => {
    seams(session("will"))
    const posted = await worker.fetch(new Request(`https://mvp.test${MODEL_CATALOG_PATH}`, { method: "POST" }), gatedEnv())
    expect(await codeOf(posted)).toBe("method_not_allowed")
    const got = await worker.fetch(new Request(`https://mvp.test${MODEL_TEST_PATH}`, { headers: SIGNED_IN }), gatedEnv())
    expect(await codeOf(got)).toBe("method_not_allowed")
  })

  test("a foreign origin is blocked before the session is read", async () => {
    const { provider } = seams(session("will"))
    const response = await worker.fetch(testRequest({ ...SIGNED_IN, origin: "https://attacker.example" }), gatedEnv())
    expect(await codeOf(response)).toBe("cross_origin_blocked")
    expect(provider.length).toBe(0)
  })

  test("the catalog is free and a Test spends one turn of the login's budget", async () => {
    const { provider } = seams(session("will"))
    const limits = countingLimits()
    const listed = await worker.fetch(catalogRequest(SIGNED_IN), gatedEnv(limits))
    expect(listed.status).toBe(200)
    const text = await listed.text()
    expect(ModelCatalogSchema.parse(JSON.parse(text)).credentials.map((row) => [row.name, row.present])).toEqual([
      ["CEREBRAS_API_KEY", true],
      ["AI_GATEWAY_API_KEY", false]
    ])
    expect(text).not.toContain(CEREBRAS_SECRET)
    expect(limits.spent).toEqual([])

    const tested = await worker.fetch(testRequest(SIGNED_IN), gatedEnv(limits))
    expect(tested.status).toBe(200)
    expect(resultOf(await tested.text())).toMatchObject({ ok: true, sample: "ok" })
    // One turn of each signed-in ceiling: hourly, daily and all logins together.
    expect(limits.spent).toEqual(["will", loginDailyKey("will"), LOGIN_ALL_KEY])
    expect(provider.length).toBe(1)
    // The login's Test is metered through the Cloud model proxy on its own token, never the platform key.
    expect(provider[0]!.url).toBe("https://cloud.test/api/model/cerebras/v1/chat/completions")
    expect(provider[0]!.headers.get("authorization")).toBe("Bearer cloud-token-will")
  })

  test("a spent budget refuses the Test with 429 before the key is spent", async () => {
    const { provider } = seams(session("will"))
    const response = await worker.fetch(testRequest(SIGNED_IN), gatedEnv(countingLimits(TURN_WINDOW_MAX)))
    expect(response.status).toBe(429)
    expect(await codeOf(response)).toBe("turn_rate_limited")
    expect(provider.length).toBe(0)
  })
})
