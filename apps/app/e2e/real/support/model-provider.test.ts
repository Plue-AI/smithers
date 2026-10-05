import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { createServer, type AddressInfo } from "node:net"
import { resolve } from "node:path"
import { Effect, Layer, Redacted, Result, Stream } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as AnthropicMessages from "@smthrs/model/AnthropicMessages"
import * as Auth from "@smthrs/model/Auth"
import * as Endpoint from "@smthrs/model/Endpoint"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Framing from "@smthrs/model/Framing"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as OpenAIChatCompletions from "@smthrs/model/OpenAIChatCompletions"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import {
  INSTALL_MODEL, PROVIDER_CONFIDENCE, PROVIDER_ECHO_LEAD, PROVIDER_MODEL, PROVIDER_PATHS, PROVIDER_READ_LEAD, PROVIDER_REPLY, PROVIDER_RETRY_AFTER_SECONDS,
  type ProviderProtocol
} from "./model-provider-behaviors"
import { launchModelProvider, type ModelProvider } from "./model-provider-process"

// The provider is judged by the REAL client: every answer below is read by an
// @smthrs/model Route or Evaluator, so a frame the product cannot decode fails here.
const KEY = "sk-loopback-unit-0123456789abcdef"
const WRONG = "sk-loopback-unit-revoked-0123456789"
const SLOW_MS = 400
const sha = (value: string): string => createHash("sha256").update(value).digest("hex")

let provider: ModelProvider
beforeAll(async () => { provider = await launchModelProvider({ key: KEY, slowMs: SLOW_MS }) })
afterAll(async () => { await provider.close() })

const executor = Layer.provide(RequestExecutor.layer, FetchHttpClient.layer)
const chatRoute = (key: string) => Route.openaiChatCompatible({ id: "loopback-chat", providerName: "openai", baseUrl: provider.origin, apiKey: Redacted.make(key) })
const anthropicRoute = (key: string) =>
  Result.map(Endpoint.make({ url: provider.origin, path: PROVIDER_PATHS.anthropic }), (endpoint) =>
    Route.make({
      id: "loopback-anthropic",
      providerName: "anthropic",
      protocol: AnthropicMessages.protocol,
      endpoint,
      auth: Auth.apiKeyHeader("x-api-key", Redacted.make(key)),
      framing: Framing.sse,
      headers: { "anthropic-version": "2023-06-01" }
    }))
const routes = { "openai-chat": chatRoute, "anthropic-messages": anthropicRoute } as const
type Generation = keyof typeof routes

const stream = (protocol: Generation, modelId: string, key = KEY) =>
  Effect.gen(function*() {
    // The two routes differ only in their type parameters, which toModel erases.
    const model = yield* Route.toModel(yield* Effect.fromResult(routes[protocol](key) as ReturnType<typeof chatRoute>))
    return yield* Stream.runCollect(model.stream(ModelRequest.ModelRequest.make({
      modelId,
      system: [],
      messages: [ModelRequest.Message.user("ping")],
      tools: [],
      params: ModelRequest.GenerationParams.make({ maxTokens: 16 })
    })))
  }).pipe(Effect.provide(executor))

const questions = {
  yes: Evaluator.BooleanQuestion.make({ instructions: "Is it a ping?" }),
  kind: Evaluator.ChoiceQuestion.make({ instructions: "Which?", criteria: { ping: "a ping", other: "anything else" } }),
  grade: Evaluator.ScoreQuestion.make({ instructions: "How much?", criteria: ["none", "some", "all"] })
}
const evaluate = (modelId: string, options: { readonly key?: string; readonly timeoutMs?: number } = {}) =>
  Effect.gen(function*() {
    return yield* (yield* Evaluator.Evaluator).evaluate({ state: { text: "ping" }, questions })
  }).pipe(Effect.provide(Layer.provide(Evaluator.layerVercelGateway({
    apiKey: Redacted.make(options.key ?? KEY),
    baseUrl: provider.evaluationUrl,
    model: modelId,
    timeoutMs: options.timeoutMs ?? 10_000
  }), FetchHttpClient.layer)))

const post = (protocol: ProviderProtocol, modelId: string, credential: string | null = KEY, drop: ReadonlyArray<string> = []) => {
  const headers = new Headers({ "content-type": "application/json" })
  if (credential !== null) protocol === "anthropic-messages" ? headers.set("x-api-key", credential) : headers.set("authorization", `Bearer ${credential}`)
  if (protocol === "evaluation") {
    headers.set("ai-gateway-protocol-version", Evaluator.protocolVersion)
    headers.set("ai-evaluation-model-specification-version", Evaluator.specificationVersion)
    headers.set("ai-model-id", modelId)
  }
  for (const name of drop) headers.delete(name)
  const path = protocol === "evaluation" ? PROVIDER_PATHS.evaluation : protocol === "anthropic-messages" ? PROVIDER_PATHS.anthropic : PROVIDER_PATHS.openaiChat
  const body = protocol === "evaluation"
    ? { state: {}, questions: Evaluator.encodeQuestions(questions) }
    : { model: modelId, stream: true, messages: [{ role: "user", content: "ping" }] }
  return fetch(`${provider.origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) })
}
const last = async () => (await provider.journal()).at(-1)!

describe("a streamed answer reaches the real client", () => {
  for (const protocol of ["openai-chat", "anthropic-messages"] as const) {
    test(protocol, async () => {
      const events = await Effect.runPromise(stream(protocol, PROVIDER_MODEL.answers))
      const deltas = events.filter((event): event is ModelEvent.TextDelta => event.type === "text-delta")
      expect(deltas.map((delta) => delta.text)).toEqual([...PROVIDER_REPLY])
      const settled = ModelEvent.settledMessage(events)
      expect(settled.message.content).toEqual([{ type: "text", text: PROVIDER_REPLY.join("") }])
      expect(settled.message.stopReason).toBe("stop")
      expect(settled.usage.outputTokens).toBe(2)
      expect(await last()).toMatchObject({ protocol, modelId: PROVIDER_MODEL.answers, status: 200, authorized: true, credentialSha256: sha(KEY) })
    })
  }

  test("anthropic-messages journals the version header the route signed", async () => {
    await Effect.runPromise(stream("anthropic-messages", PROVIDER_MODEL.answers))
    expect((await last()).headers).toEqual({ "anthropic-version": "2023-06-01" })
  })

  test("evaluation", async () => {
    const response = await Effect.runPromise(evaluate(PROVIDER_MODEL.answers))
    expect(response.answers).toEqual({
      yes: { type: "boolean", probability: PROVIDER_CONFIDENCE },
      kind: { type: "choice", choice: "ping", probabilities: { ping: PROVIDER_CONFIDENCE } },
      grade: { type: "score", score: 2 }
    })
    expect(response.confidence).toEqual({ yes: PROVIDER_CONFIDENCE, kind: PROVIDER_CONFIDENCE, grade: PROVIDER_CONFIDENCE })
    expect(response.usage).toEqual({ modelId: PROVIDER_MODEL.answers, inputTokens: 7, outputTokens: 1 })
    expect((await last()).headers).toEqual({
      "ai-gateway-protocol-version": Evaluator.protocolVersion,
      "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": Evaluator.specificationVersion,
      "ai-model-id": PROVIDER_MODEL.answers
    })
  })
})

describe("the credential is compared, never switched", () => {
  test("a wrong key is the client's authentication failure, journaled by hash", async () => {
    for (const protocol of ["openai-chat", "anthropic-messages"] as const) {
      const failure = await Effect.runPromise(Effect.flip(stream(protocol, PROVIDER_MODEL.answers, WRONG)))
      expect(failure).toMatchObject({ code: "authentication", httpStatus: 401 })
      expect(await last()).toMatchObject({ protocol, status: 401, authorized: false, credentialSha256: sha(WRONG) })
    }
    expect(await Effect.runPromise(Effect.flip(evaluate(PROVIDER_MODEL.answers, { key: WRONG })))).toMatchObject({ code: "refused", status: 401 })
    expect(await last()).toMatchObject({ protocol: "evaluation", status: 401, authorized: false, credentialSha256: sha(WRONG) })
  })

  test("a key of the right length and the wrong bytes is refused", async () => {
    const response = await post("openai-chat", PROVIDER_MODEL.answers, `${KEY.slice(0, -1)}0`)
    expect(response.status).toBe(401)
  })

  test("no credential is 401 with a null hash", async () => {
    for (const protocol of ["openai-chat", "anthropic-messages", "evaluation"] as const) {
      expect((await post(protocol, PROVIDER_MODEL.answers, null)).status).toBe(401)
      expect(await last()).toMatchObject({ protocol, status: 401, authorized: false, credentialSha256: null })
    }
  })

  test("a bearer token does not open the x-api-key protocol", async () => {
    const response = await fetch(`${provider.origin}${PROVIDER_PATHS.anthropic}`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: PROVIDER_MODEL.answers })
    })
    expect(response.status).toBe(401)
  })

  test("the journal and every refusal carry no credential value", async () => {
    const refusal = await (await post("openai-chat", PROVIDER_MODEL.answers, WRONG)).text()
    const journal = await (await fetch(`${provider.origin}${PROVIDER_PATHS.journal}`)).text()
    for (const text of [refusal, journal]) {
      expect(text).not.toContain(KEY)
      expect(text).not.toContain(WRONG)
    }
    expect(journal).toContain(provider.acceptedKeySha256)
  })
})

describe("behaviour is keyed by model id", () => {
  test("rate-limited is 429 with retry-after, which the real classifiers read as rate_limited", async () => {
    for (const protocol of ["openai-chat", "anthropic-messages", "evaluation"] as const) {
      const response = await post(protocol, PROVIDER_MODEL.rateLimited)
      expect(response.status).toBe(429)
      expect(response.headers.get("retry-after")).toBe(String(PROVIDER_RETRY_AFTER_SECONDS))
      const body = await response.text()
      if (protocol === "openai-chat") expect(OpenAIChatCompletions.protocol.classifyError(429, body).code).toBe("rate_limited")
      if (protocol === "anthropic-messages") expect(AnthropicMessages.protocol.classifyError(429, body).code).toBe("rate_limited")
    }
    expect(await Effect.runPromise(Effect.flip(evaluate(PROVIDER_MODEL.rateLimited)))).toMatchObject({ code: "refused", status: 429 })
  })

  test("garbled is output the real client refuses to decode", async () => {
    for (const protocol of ["openai-chat", "anthropic-messages"] as const) {
      expect(await Effect.runPromise(Effect.flip(stream(protocol, PROVIDER_MODEL.garbled)))).toMatchObject({ code: "invalid_provider_output" })
    }
    expect(await Effect.runPromise(Effect.flip(evaluate(PROVIDER_MODEL.garbled)))).toMatchObject({ code: "invalid_answer", status: 200 })
  })

  test("echoes answers with nested credential fragments whose cuts join across three deltas", async () => {
    for (const protocol of ["openai-chat", "anthropic-messages"] as const) {
      const events = await Effect.runPromise(stream(protocol, PROVIDER_MODEL.echoes))
      const deltas = events.flatMap((event) => event.type === "text-delta" ? [event.text] : [])
      const at = Math.ceil(KEY.length / 2)
      expect(deltas).toEqual([`${PROVIDER_ECHO_LEAD}${KEY.slice(0, at).repeat(2)}`, KEY.slice(at), KEY.slice(at)])
      // Neither delta holds the whole value, so a reader that scrubs delta by delta misses it.
      expect(deltas.some((text) => text.includes(KEY))).toBe(false)
      expect(deltas[0]!.startsWith(PROVIDER_ECHO_LEAD) && deltas[0]!.length > PROVIDER_ECHO_LEAD.length).toBe(true)
    }
    expect(JSON.stringify(await provider.journal())).not.toContain(KEY)
  })

  test("an unknown id is 404", async () => {
    for (const protocol of ["openai-chat", "anthropic-messages"] as const) {
      expect(await Effect.runPromise(Effect.flip(stream(protocol, "e2e-unlisted")))).toMatchObject({ code: "invalid_request", httpStatus: 404 })
    }
    expect(await Effect.runPromise(Effect.flip(evaluate("e2e-unlisted")))).toMatchObject({ code: "refused", status: 404 })
    expect(await last()).toMatchObject({ modelId: "e2e-unlisted", status: 404, authorized: true })
  })

  test("slow answers after the configured delay, and is journaled before it waits", async () => {
    const before = (await provider.journal()).length
    expect(await Effect.runPromise(Effect.flip(evaluate(PROVIDER_MODEL.slow, { timeoutMs: 100 })))).toMatchObject({ code: "timeout" })
    expect((await provider.journal()).length).toBe(before + 1)
    const started = performance.now()
    const events = await Effect.runPromise(stream("openai-chat", PROVIDER_MODEL.slow))
    expect(performance.now() - started).toBeGreaterThanOrEqual(SLOW_MS)
    expect(ModelEvent.settledMessage(events).message.stopReason).toBe("stop")
  })
})

describe("reads: the app agent asked about a file", () => {
  const commands = ModelRequest.ToolDefinition.make({ name: "commands", description: "The app agent's one tool.", parameters: { type: "object" } })
  const question = ModelRequest.Message.user("What is in README.md? Show the file.")
  const read = (messages: ReadonlyArray<ModelRequest.Message>, tools: ReadonlyArray<ModelRequest.ToolDefinition>) =>
    Effect.gen(function*() {
      const model = yield* Route.toModel(yield* Effect.fromResult(chatRoute(KEY)))
      return yield* Stream.runCollect(model.stream(ModelRequest.ModelRequest.make({
        modelId: PROVIDER_MODEL.reads, system: [], messages, tools, params: ModelRequest.GenerationParams.make({ maxTokens: 16 })
      })))
    }).pipe(Effect.provide(executor))
  const texts = (events: ReadonlyArray<ModelEvent.ModelEvent>) => events.flatMap((event) => event.type === "text-delta" ? [event.text] : [])

  test("offered commands and asked about a path, it calls files.read on that path", async () => {
    const settled = ModelEvent.settledMessage(await Effect.runPromise(read([question], [commands])))
    expect(settled.message.content).toEqual([{
      type: "tool-call", id: "call_loopback_read", name: "commands", arguments: JSON.stringify({ action: "execute", name: "files.read", args: "README.md" })
    }])
    expect(settled.message.stopReason).toBe("tool-calls")
    expect(await last()).toMatchObject({ protocol: "openai-chat", modelId: PROVIDER_MODEL.reads, status: 200, authorized: true })
  })

  test("handed the tool result, it answers by quoting it", async () => {
    const call = ModelRequest.ToolCallPart.make({ id: "call_loopback_read", name: "commands", arguments: "{}" })
    const result = ModelRequest.ToolResultPart.make({ toolCallId: call.id, content: "README.md in local-owner/demo:\n# demo\n" })
    const events = await Effect.runPromise(read([question, ModelRequest.Message.assistant(call, { stopReason: "tool-calls" }), ModelRequest.Message.tool(result)], [commands]))
    expect(texts(events)).toEqual([PROVIDER_READ_LEAD, "README.md in local-owner/demo:\n# demo\n"])
  })

  test("without the commands tool, or without a path, it streams the ordinary reply", async () => {
    expect(texts(await Effect.runPromise(read([question], [])))).toEqual([...PROVIDER_REPLY])
    expect(texts(await Effect.runPromise(read([ModelRequest.Message.user("hello there")], [commands])))).toEqual([...PROVIDER_REPLY])
  })

  test("on Anthropic Messages it is the ordinary reply", async () => {
    expect(texts(await Effect.runPromise(stream("anthropic-messages", PROVIDER_MODEL.reads)))).toEqual([...PROVIDER_REPLY])
  })
})

describe("the install's role models", () => {
  test("the fast model is the app agent that reads", async () => {
    const commands = ModelRequest.ToolDefinition.make({ name: "commands", description: "The app agent's one tool.", parameters: { type: "object" } })
    const settled = ModelEvent.settledMessage(await Effect.runPromise(Effect.gen(function*() {
      const model = yield* Route.toModel(yield* Effect.fromResult(chatRoute(KEY)))
      return yield* Stream.runCollect(model.stream(ModelRequest.ModelRequest.make({
        modelId: INSTALL_MODEL.fast, system: [], messages: [ModelRequest.Message.user("What is in README.md?")], tools: [commands],
        params: ModelRequest.GenerationParams.make({ maxTokens: 16 })
      })))
    }).pipe(Effect.provide(executor))))
    expect(settled.message.content).toEqual([{
      type: "tool-call", id: "call_loopback_read", name: "commands", arguments: JSON.stringify({ action: "execute", name: "files.read", args: "README.md" })
    }])
    expect(await last()).toMatchObject({ protocol: "openai-chat", modelId: INSTALL_MODEL.fast, status: 200, authorized: true })
  })

  test("the review seat answers the stack's review", async () => {
    const events = await Effect.runPromise(stream("openai-chat", INSTALL_MODEL.review))
    expect(events.length).toBeGreaterThan(0)
    expect(await last()).toMatchObject({ protocol: "openai-chat", modelId: INSTALL_MODEL.review, status: 200, authorized: true })
  })

  test("Decisions evaluates", async () => {
    const response = await Effect.runPromise(evaluate(INSTALL_MODEL.decisions))
    expect(response.answers.yes).toEqual({ type: "boolean", probability: PROVIDER_CONFIDENCE })
    expect(await last()).toMatchObject({ protocol: "evaluation", modelId: INSTALL_MODEL.decisions, status: 200, authorized: true })
  })
})

describe("a TODO's coding run, scripted by distribution/fake-todo-turns.mjs", () => {
  // Each step's system teaching opens as the coding flow writes it (flows/coding planning.ts, atoms.ts, vibe-cleanup.ts);
  // an agent action appends its task. The answer is a cell: run here against a recording ctx, as the coding host runs it.
  const task = (payload: unknown) => `\n\nThe task for this run: ${JSON.stringify(payload)}`
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (ctx: unknown) => Promise<void>
  const step = async (system: string) => {
    const events = await Effect.runPromise(Effect.gen(function*() {
      const model = yield* Route.toModel(yield* Effect.fromResult(chatRoute(KEY)))
      return yield* Stream.runCollect(model.stream(ModelRequest.ModelRequest.make({
        modelId: PROVIDER_MODEL.answers, system: [ModelRequest.SystemPart.make({ text: system })],
        messages: [ModelRequest.Message.user("Begin.")], tools: [], params: ModelRequest.GenerationParams.make({ maxTokens: 4096 })
      })))
    }).pipe(Effect.provide(executor)))
    const settled = ModelEvent.settledMessage(events)
    const [part] = settled.message.content
    const source = /^```cell\n([\s\S]*)\n```$/.exec(part?.type === "text" ? part.text : "")?.[1]
    if (source === undefined) throw new Error(`not one cell: ${JSON.stringify(settled.message.content)}`)
    const files = new Map([["JOURNEY.md", "Add a greeting to JOURNEY.md\n"]])
    const calls: Array<[string, unknown]> = []
    let result: unknown
    await new AsyncFunction("ctx", source)({
      call: async (name: string, args: { readonly path: string; readonly content?: string }) => {
        calls.push([name, args])
        if (name === "write") files.set(args.path, args.content ?? "")
        return name === "read" ? { ok: true, content: files.get(args.path) } : { ok: true }
      },
      done: (value: unknown) => { result = value }
    })
    return { result, calls, files, stopReason: settled.message.stopReason }
  }

  test("review-request finds the request sufficient", async () => {
    const answered = await step("Review a coding request against supplied repository memory and native history before planning changes.")
    expect(answered.result).toEqual({ explanation: "The request names one file and one edit; the evidence is sufficient.", clarification: "" })
    expect(answered.stopReason).toBe("stop")
    expect(await last()).toMatchObject({ protocol: "openai-chat", modelId: PROVIDER_MODEL.answers, status: 200, step: "coding/review-request" })
  })

  test("draft-plan plans one change on the task's head that runs every required check", async () => {
    const context = { head: { changeId: "kqzvtmnp" }, checks: [{ id: "test", required: true }, { id: "lint", required: true }, { id: "docs", required: false }] }
    const answered = await step(`Plan one linear mythical coding progression as small understandable product Changes containing atomic emoji conventional commits.${task({ context })}`)
    expect(answered.result).toEqual({
      rationale: "Append one documentation change on the current head.",
      baseChangeId: "kqzvtmnp",
      changes: [{
        id: "greeting", title: "Add a greeting", intent: "JOURNEY.md carries a greeting.",
        atoms: [{ changeId: null, message: "📝 docs: add a greeting to JOURNEY.md", intent: "Append a greeting line to JOURNEY.md.", reads: ["JOURNEY.md"], writes: ["JOURNEY.md"] }],
        checks: ["test", "lint"]
      }]
    })
    expect((await last()).step).toBe("coding/draft-plan")
  })

  test("edit-atom appends the greeting to JOURNEY.md through the host's read and write", async () => {
    const answered = await step("Implement the single atomic change in the owning workspace using the provided filesystem tools.")
    expect(answered.calls.map(([name]) => name)).toEqual(["read", "write"])
    expect(answered.files.get("JOURNEY.md")).toBe("Add a greeting to JOURNEY.md\nHello from Smithers!\n")
    expect(answered.result).toEqual({ summary: "Appended a greeting to JOURNEY.md.", reads: ["JOURNEY.md"], writes: ["JOURNEY.md"] })
    expect((await last()).step).toBe("coding/edit-atom")
  })

  test("review-final-history describes every atom the request recorded with the one subject", async () => {
    const request = { outcome: { result: { changes: [{ implementation: { atoms: [{ changeId: "a1" }, { changeId: "a2" }] } }] } } }
    const answered = await step(`Clean the descriptions of the validated request's native JJ atoms. Return each existing changeId exactly once, in the recorded order.${task({ request })}`)
    expect(answered.result).toEqual({
      summary: "📝 docs: add a greeting to JOURNEY.md",
      atoms: [{ changeId: "a1", description: "📝 docs: add a greeting to JOURNEY.md" }, { changeId: "a2", description: "📝 docs: add a greeting to JOURNEY.md" }]
    })
    expect((await last()).step).toBe("coding/review-final-history")
  })

  test("Jev routes the TODO to implement and judges the result complete, not overclaimed, invented or unnecessary", async () => {
    const response = await Effect.runPromise(Effect.gen(function*() {
      return yield* (yield* Evaluator.Evaluator).evaluate({ state: { text: "Add a greeting" }, questions: {
        route: Evaluator.ChoiceQuestion.make({ instructions: "Which route?", criteria: { answer: "answer in chat", implement: "change the code" } }),
        needed_0: Evaluator.BooleanQuestion.make({ instructions: "Is a clarification needed?" }),
        complete: Evaluator.BooleanQuestion.make({ instructions: "Is it complete?" }),
        overclaims: Evaluator.BooleanQuestion.make({ instructions: "Does it overclaim?" }),
        unnecessary_0: Evaluator.BooleanQuestion.make({ instructions: "Is this file unnecessary?" }),
        confident: Evaluator.ScoreQuestion.make({ instructions: "How sure?", criteria: ["low", "medium", "high"] })
      } })
    }).pipe(Effect.provide(Layer.provide(Evaluator.layerVercelGateway({
      apiKey: Redacted.make(KEY), baseUrl: provider.evaluationUrl, model: INSTALL_MODEL.decisions, timeoutMs: 10_000
    }), FetchHttpClient.layer))))
    expect(response.answers).toEqual({
      route: { type: "choice", choice: "implement" },
      needed_0: { type: "boolean", probability: 0.01 },
      complete: { type: "boolean", probability: 0.99 },
      overclaims: { type: "boolean", probability: 0.01 },
      unnecessary_0: { type: "boolean", probability: 0.01 },
      confident: { type: "score", score: 2 }
    })
    expect(await last()).toMatchObject({ protocol: "evaluation", modelId: INSTALL_MODEL.decisions, status: 200, step: "todo/judge" })
  })

  test("a route it cannot take is 400; a turn or evaluation outside the run keeps the ordinary answer", async () => {
    const headers = { "content-type": "application/json", authorization: `Bearer ${KEY}`, "ai-gateway-protocol-version": Evaluator.protocolVersion,
      "ai-evaluation-model-specification-version": Evaluator.specificationVersion, "ai-model-id": INSTALL_MODEL.decisions }
    const refused = await fetch(provider.evaluationUrl, { method: "POST", headers, body: JSON.stringify({ state: {}, questions: { route: { type: "choice", criteria: { left: "l", right: "r" } } } }) })
    expect(refused.status).toBe(400)
    expect(await last()).toMatchObject({ protocol: "evaluation", status: 400, step: "todo/judge" })
    const settled = ModelEvent.settledMessage(await Effect.runPromise(Effect.gen(function*() {
      const model = yield* Route.toModel(yield* Effect.fromResult(chatRoute(KEY)))
      return yield* Stream.runCollect(model.stream(ModelRequest.ModelRequest.make({
        modelId: PROVIDER_MODEL.answers, system: [ModelRequest.SystemPart.make({ text: "Answer the member's question about the repository." })],
        messages: [ModelRequest.Message.user("ping")], tools: [], params: ModelRequest.GenerationParams.make({ maxTokens: 16 })
      })))
    }).pipe(Effect.provide(executor))))
    expect(settled.message.content).toEqual([{ type: "text", text: PROVIDER_REPLY.join("") }])
    expect((await last()).step).toBeUndefined()
    expect((await Effect.runPromise(evaluate(INSTALL_MODEL.decisions))).answers.yes).toEqual({ type: "boolean", probability: PROVIDER_CONFIDENCE })
  })
})

describe("requests outside the protocols are refused", () => {
  test("an evaluation without its protocol headers is 400", async () => {
    for (const name of ["ai-gateway-protocol-version", "ai-evaluation-model-specification-version"]) {
      expect((await post("evaluation", PROVIDER_MODEL.answers, KEY, [name])).status).toBe(400)
    }
  })

  test("a body that is not JSON is 400", async () => {
    const response = await fetch(`${provider.origin}${PROVIDER_PATHS.openaiChat}`, { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: "{" })
    expect(response.status).toBe(400)
  })

  test("any other path or method is 404 and leaves no journal entry", async () => {
    const before = (await provider.journal()).length
    expect((await fetch(`${provider.origin}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(404)
    expect((await fetch(`${provider.origin}${PROVIDER_PATHS.journal}`, { method: "DELETE" })).status).toBe(404)
    expect((await provider.journal()).length).toBe(before)
  })
})

describe("the owned process", () => {
  test("stop makes the origin unreachable and start restores the same origin", async () => {
    const origin = provider.origin
    await provider.stop()
    try {
      expect(await Effect.runPromise(Effect.flip(evaluate(PROVIDER_MODEL.answers)))).toMatchObject({ code: "unreachable" })
    } finally {
      await provider.start()
    }
    expect(provider.origin).toBe(origin)
    expect((await fetch(`${origin}${PROVIDER_PATHS.ready}`)).status).toBe(204)
    expect((await Effect.runPromise(evaluate(PROVIDER_MODEL.answers))).answers.yes).toEqual({ type: "boolean", probability: PROVIDER_CONFIDENCE })
  })

  test("a fixed port is the origin, and stop is prompt with a slow answer in flight", async () => {
    // The host under test is told the origin before the provider exists, so the port is the caller's to choose.
    const listener = createServer().listen(0, "127.0.0.1")
    await once(listener, "listening")
    const { port } = listener.address() as AddressInfo
    listener.close()
    await once(listener, "close")
    const held = await launchModelProvider({ key: KEY, port, slowMs: 30_000 })
    try {
      expect(held.origin).toBe(`http://127.0.0.1:${port}`)
      const before = (await held.journal()).length
      const waiting = fetch(`${held.origin}${PROVIDER_PATHS.openaiChat}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: PROVIDER_MODEL.slow, messages: [] })
      }).then((response) => response.status, () => "unreachable")
      // Journaled before it waits: the request is inside the provider when the signal lands.
      while ((await held.journal()).length === before) await Bun.sleep(10)
      const started = performance.now()
      await held.stop()
      expect(performance.now() - started).toBeLessThan(2_000)
      expect(await waiting).toBe("unreachable")
    } finally {
      await held.close()
    }
  })

  test("a [HOLD key] edit turn waits for its release, and its journal entry names the turn's markers", async () => {
    const provider = await launchModelProvider({ key: KEY })
    try {
      const edit = (marker: string) => fetch(`${provider.origin}${PROVIDER_PATHS.openaiChat}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: PROVIDER_MODEL.answers, stream: true, messages: [
          { role: "system", content: `Implement the single atomic change.\n\nThe task for this run: ${JSON.stringify({ atom: { changeId: "c1", intent: "Append a greeting line to JOURNEY.md. [HOLD k1]" } })}` },
          { role: "user", content: `Begin. ${marker}` }
        ] })
      })
      const held = () => fetch(`${provider.origin}${PROVIDER_PATHS.held}`).then((response) => response.json())
      let answered = false
      const first = edit("[STEER-E2E] say hello in French").then(async (response) => { answered = true; return [response.status, await response.text()] as const })
      while ((await held()).length === 0) await Bun.sleep(10)
      expect(await held()).toEqual(["k1"])
      await Bun.sleep(100)
      expect(answered).toBe(false)
      // An abandoned turn stops waiting and leaves /__held.
      const abandon = new AbortController()
      const second = fetch(`${provider.origin}${PROVIDER_PATHS.openaiChat}`, { method: "POST", signal: abandon.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: PROVIDER_MODEL.answers, stream: true, messages: [
          { role: "system", content: `Implement the single atomic change.\n\nThe task for this run: ${JSON.stringify({ atom: { changeId: "c2", intent: "[HOLD k1]" } })}` }] })
      }).catch(() => "abandoned")
      while ((await held()).length < 2) await Bun.sleep(10)
      abandon.abort()
      expect(await second).toBe("abandoned")
      while ((await held()).length > 1) await Bun.sleep(10)
      expect((await fetch(`${provider.origin}${PROVIDER_PATHS.release}not/a key`, { method: "POST" })).status).toBe(404)
      expect((await fetch(`${provider.origin}${PROVIDER_PATHS.release}k1`, { method: "POST" })).status).toBe(204)
      const [status, text] = await first
      expect(status).toBe(200)
      expect(text).toContain("cell")
      expect(await held()).toEqual([])
      // Released keys stay released: a later turn on k1 answers at once.
      expect((await edit("again")).status).toBe(200)
      const entries = (await provider.journal()).filter((entry) => entry.step === "coding/edit-atom")
      expect(entries).toHaveLength(3)
      expect(entries[0]!.markers).toEqual(expect.arrayContaining(["HOLD", "STEER-E2E"]))
      expect(entries[2]!.markers).not.toContain("STEER-E2E")
    } finally {
      await provider.close()
    }
  })

  test("a short key refuses to boot without echoing it", async () => {
    const short = "sk-short"
    const child = Bun.spawn(["bun", resolve(import.meta.dir, "model-provider.ts")], {
      env: { ...process.env, SMITHERS_MODEL_PROVIDER_KEY: short, SMITHERS_MODEL_PROVIDER_PORT: "0" },
      stdout: "pipe",
      stderr: "pipe"
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code).not.toBe(0)
    expect(`${stdout}${stderr}`).toContain("SMITHERS_MODEL_PROVIDER_KEY")
    expect(`${stdout}${stderr}`).not.toContain(short)
  })
})
