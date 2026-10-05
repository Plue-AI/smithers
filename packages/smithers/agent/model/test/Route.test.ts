import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import { Effect, Layer, Redacted, Result, Schema, Stream, Tracer } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Auth from "../src/Auth.ts"
import * as Endpoint from "../src/Endpoint.ts"
import * as Framing from "../src/Framing.ts"
import * as Model from "../src/Model.ts"
import { ModelError } from "../src/ModelError.ts"
import * as ModelEvent from "../src/ModelEvent.ts"
import * as ModelRequest from "../src/ModelRequest.ts"
import * as Protocol from "../src/Protocol.ts"
import * as RequestExecutor from "../src/RequestExecutor.ts"
import * as Route from "../src/Route.ts"

const request = ModelRequest.ModelRequest.make({
  modelId: "test-model",
  system: [],
  messages: [],
  tools: [],
  params: ModelRequest.GenerationParams.make()
})

const endpoint = (options: Endpoint.MakeOptions): Endpoint.Endpoint => Result.getOrThrow(Endpoint.make(options))

const TestBody = Schema.Struct({
  z: Schema.Finite,
  a: Schema.Array(Schema.String)
})
const TestEvent = Schema.Record(Schema.String, Schema.Unknown)

const kernelHttpClientLayer = (
  client: HttpClient.HttpClient
): Layer.Layer<KernelHttpClient.HttpClient> => Layer.succeed(KernelHttpClient.HttpClient)(client)

const protocol = Protocol.make({
  id: "test",
  supportsDeferred: () => false,
  body: {
    schema: TestBody,
    from: () => Effect.succeed({ z: 1, a: ["body"] })
  },
  stream: {
    event: Schema.fromJsonString(TestEvent),
    initial: () => 0,
    step: (state) => Effect.succeed([state, []] as const),
    onHalt: () => []
  },
  classifyError: (status, body) => new ModelError({ code: "transport", message: `${status}: ${body}` })
})

describe("Route.prepare", () => {
  it("encodes a transforming body codec and round-trips the wire value", async () => {
    // Regression for correctness-6.ts: body.from returns the codec's decoded
    // number, while the provider expects its encoded string representation.
    const bodySchema = Schema.Struct({ limit: Schema.NumberFromString })
    const body = { limit: 8 }
    const route = Route.make({
      providerName: "openai",
      id: "codec-probe",
      protocol: Protocol.make({
        ...protocol,
        body: { schema: bodySchema, from: () => Effect.succeed(body) }
      }),
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("secret")),
      framing: Framing.sse
    })

    expect(Schema.encodeSync(bodySchema)(body)).toEqual({ limit: "8" })
    const prepared = await Effect.runPromise(Route.prepare(route, request))

    expect(prepared.bodyText).toBe("{\"limit\":\"8\"}")
    expect(prepared.body).toEqual(new TextEncoder().encode(prepared.bodyText))
    expect(Schema.decodeUnknownSync(bodySchema)(JSON.parse(prepared.bodyText))).toEqual(body)
  })

  it("reports an encoded-side body constraint failure as invalid_request", async () => {
    const bodySchema = Schema.Struct({
      limit: Schema.String.pipe(
        Schema.check(Schema.isPattern(/^[0-9]$/)),
        Schema.decodeTo(Schema.NumberFromString)
      )
    })
    const route = Route.make({
      providerName: "openai",
      id: "codec-constraint",
      protocol: Protocol.make({
        ...protocol,
        body: { schema: bodySchema, from: () => Effect.succeed({ limit: 12 }) }
      }),
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("secret")),
      framing: Framing.sse
    })

    const error = await Effect.runPromise(Route.prepare(route, request).pipe(Effect.flip))

    expect(error).toMatchObject({
      code: "invalid_request",
      message: "test produced an invalid provider request body",
      path: "limit"
    })
    expect(JSON.stringify(error)).not.toContain("12")
  })

  it("is deterministic and excludes credentials from the sealed-step view", async () => {
    const key = "test-secret-api-key"
    const route = Route.make({
      providerName: "openai",
      id: "test-route",
      protocol,
      endpoint: endpoint({ url: "https://example.test", path: "/v1/responses" }),
      auth: Auth.bearer(Redacted.make(key)),
      framing: Framing.sse,
      headers: { "x-public": "yes" }
    })

    const first = await Effect.runPromise(Route.prepare(route, request))
    const second = await Effect.runPromise(Route.prepare(route, request))

    expect(first.body).toEqual(second.body)
    expect(first.bodyText).toBe("{\"a\":[\"body\"],\"z\":1}")
    expect(first.publicHeaders).toEqual({ "content-type": "application/json", "x-public": "yes" })
    expect(JSON.stringify(first)).not.toContain(key)
    expect(JSON.stringify(new ModelError({ code: "transport", message: "safe" }))).not.toContain(key)
  })

  it("supplies JSON content type when the route declares no public headers", async () => {
    const prepared = await Effect.runPromise(Route.prepare({
      id: "default-headers",
      providerName: "test",
      protocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("test-key")),
      framing: Framing.sse
    }, request))
    expect(prepared.publicHeaders).toEqual({ "content-type": "application/json" })
  })

  it("canonicalizes public headers independently of caller insertion order", async () => {
    const headers = { "x-z": "last", "x-a": "first", "x-m": "middle" }
    const prepare = (headers: Readonly<Record<string, string>>) =>
      Effect.runPromise(Route.prepare(
        Route.make({
          providerName: "openai",
          id: "header-order",
          protocol,
          endpoint: endpoint({ url: "https://example.test" }),
          auth: Auth.bearer(Redacted.make("test-key")),
          framing: Framing.sse,
          headers
        }),
        request
      ))
    const first = await prepare(headers)
    const second = await prepare(Object.fromEntries(Object.entries(headers).reverse()))
    expect(JSON.stringify(first.publicHeaders)).toBe(JSON.stringify(second.publicHeaders))
    expect(Object.keys(first.publicHeaders)).toEqual(["content-type", "x-a", "x-m", "x-z"])
  })

  it("rejects credential-bearing headers before they can enter the prepared view", async () => {
    const route = Route.make({
      providerName: "openai",
      id: "unsafe",
      protocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("auth-secret")),
      framing: Framing.sse,
      headers: { "x-api-key": "step-key-secret" }
    })

    const error = await Effect.runPromise(Route.prepare(route, request).pipe(Effect.flip))
    expect(error).toMatchObject({ code: "invalid_request" })
    expect(JSON.stringify(error)).not.toContain("step-key-secret")
  })

  it("rejects password headers before they can enter the prepared view", async () => {
    const route = Route.make({
      providerName: "openai",
      id: "unsafe-password",
      protocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("auth-secret")),
      framing: Framing.sse,
      headers: { "x-password": "step-key-password" }
    })

    const error = await Effect.runPromise(Route.prepare(route, request).pipe(Effect.flip))
    expect(error).toMatchObject({ code: "invalid_request" })
    expect(JSON.stringify(error)).not.toContain("step-key-password")
  })

  it("rejects invalid request and protocol body values before canonical encoding", async () => {
    const invalidProtocol = Protocol.make({
      ...protocol,
      body: {
        schema: TestBody,
        from: () => Effect.succeed({ z: Number.NaN, a: ["body"] })
      }
    })
    const route = Route.make({
      providerName: "openai",
      id: "invalid-body",
      protocol: invalidProtocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("secret")),
      framing: Framing.sse
    })

    const invalidBody = await Effect.runPromise(Route.prepare(route, request).pipe(Effect.flip))
    expect(invalidBody).toMatchObject({
      code: "invalid_request",
      message: "test produced an invalid provider request body",
      path: "z"
    })

    const invalidRequest = {
      ...request,
      params: { temperature: Number.NaN }
    } as unknown as ModelRequest.ModelRequest
    const invalidParams = await Effect.runPromise(
      Route.prepare(
        Result.getOrThrow(Route.openai({
          apiKey: Redacted.make("secret")
        })),
        invalidRequest
      ).pipe(Effect.flip)
    )
    expect(invalidParams).toMatchObject({ code: "invalid_request", path: "params.temperature" })
  })

  it("reports only the key path of the first invalid request member", async () => {
    const offendingValue = "private-invalid-message-value"
    const invalidRequest = {
      ...request,
      messages: [
        ModelRequest.Message.user("valid"),
        { role: "user", content: [{ type: "text", text: { offendingValue } }] }
      ]
    } as unknown as ModelRequest.ModelRequest

    const error = await Effect.runPromise(
      Route.prepare(
        Result.getOrThrow(Route.openai({ apiKey: Redacted.make("secret") })),
        invalidRequest
      ).pipe(Effect.flip)
    )

    expect(error).toMatchObject({
      code: "invalid_request",
      message: "Model request failed Schema validation",
      path: "messages[1].content[0].text"
    })
    expect(JSON.stringify(error)).not.toContain(offendingValue)
  })

  it("omits the path when the failure has no member to name", async () => {
    // A request that is not a struct at all, and a body encoder that throws
    // something other than the canonical encoder's TypeError, both fail with
    // the same message and no `path`, rather than with an invented one.
    const notARequest = await Effect.runPromise(
      Route.prepare(
        Result.getOrThrow(Route.openai({ apiKey: Redacted.make("secret") })),
        "not a request" as unknown as ModelRequest.ModelRequest
      ).pipe(Effect.flip)
    )
    expect(notARequest).toMatchObject({ code: "invalid_request", message: "Model request failed Schema validation" })
    expect(notARequest.path).toBeUndefined()

    const throwing = Protocol.make({
      ...protocol,
      body: {
        schema: Schema.Unknown,
        from: () =>
          Effect.succeed({
            get boom() {
              throw "not an Error"
            }
          })
      }
    })
    const encoded = await Effect.runPromise(
      Route.prepare(
        Route.make({
          providerName: "openai",
          id: "throwing",
          protocol: throwing,
          endpoint: endpoint({ url: "https://example.test" }),
          auth: Auth.bearer(Redacted.make("secret")),
          framing: Framing.sse
        }),
        request
      ).pipe(Effect.flip)
    )
    expect(encoded).toMatchObject({
      code: "invalid_request",
      message: "Model request could not be encoded as canonical JSON"
    })
    expect(encoded.path).toBeUndefined()
  })

  it("rejects a provider body array which JSON.stringify would reshape", async () => {
    const prepareBody = (body: unknown) =>
      Effect.runPromise(
        Route.prepare(
          Route.make({
            providerName: "openai",
            id: "reshaped-array",
            protocol: Protocol.make({
              ...protocol,
              body: { schema: Schema.Unknown, from: () => Effect.succeed(body) }
            }),
            endpoint: endpoint({ url: "https://example.test" }),
            auth: Auth.bearer(Redacted.make("secret")),
            framing: Framing.sse
          }),
          request
        ).pipe(Effect.flip)
      )

    await expect(prepareBody({ items: Array(1) })).resolves.toMatchObject({
      code: "invalid_request",
      message: "Model request could not be encoded as canonical JSON",
      path: "$.items[0]"
    })
    await expect(prepareBody({ items: Object.assign([1], { [Symbol("hidden")]: 2 }) })).resolves.toMatchObject({
      code: "invalid_request",
      path: "$.items"
    })
    await expect(prepareBody({ items: Object.assign([1], { extra: 2 }) })).resolves.toMatchObject({
      code: "invalid_request",
      path: "$.items"
    })
  })

  it("omits the path when schema encoding fails without an issue", async () => {
    const schemaWithoutIssue = Schema.declareConstructor<unknown>()(
      [],
      () => () => Effect.fail(undefined as never)
    )
    const malformedProtocol = Protocol.make({
      ...protocol,
      body: {
        schema: schemaWithoutIssue,
        from: () => Effect.succeed({})
      }
    })
    const error = await Effect.runPromise(
      Route.prepare(
        Route.make({
          providerName: "openai",
          id: "missing-schema-issue",
          protocol: malformedProtocol,
          endpoint: endpoint({ url: "https://example.test" }),
          auth: Auth.bearer(Redacted.make("secret")),
          framing: Framing.sse
        }),
        request
      ).pipe(Effect.flip)
    )

    expect(error).toMatchObject({
      code: "invalid_request",
      message: "test produced an invalid provider request body"
    })
    expect(error.path).toBeUndefined()
  })

  it("pins the exact canonical body bytes of every built-in route", async () => {
    // A sealed model step keys on these bytes. A lowering change that alters
    // them invalidates every cached step for that route, so the change has to
    // be deliberate and recorded rather than noticed later.
    const golden = ModelRequest.ModelRequest.make({
      modelId: "golden-model",
      system: [ModelRequest.SystemPart.make({ text: "Be terse." })],
      messages: [
        ModelRequest.Message.user("What is the weather in Paris?"),
        ModelRequest.Message.assistant(
          ModelRequest.ToolCallPart.make({ id: "call_1", name: "weather", arguments: "{\"city\":\"Paris\"}" }),
          { stopReason: "tool-calls" }
        ),
        ModelRequest.Message.tool(ModelRequest.ToolResultPart.make({ toolCallId: "call_1", content: "Sunny" }))
      ],
      tools: [
        ModelRequest.ToolDefinition.make({
          name: "weather",
          description: "Current weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } } }
        })
      ],
      params: ModelRequest.GenerationParams.make({
        maxTokens: 2048,
        temperature: 0.2,
        topP: 0.9,
        topK: 40,
        stopSequences: ["STOP"],
        thinkingBudget: 1024,
        reasoningEffort: "medium"
      })
    })
    const key = Redacted.make("golden-secret")
    const prepared: ReadonlyArray<readonly [string, Route.PreparedRequest]> = [
      [
        "anthropic",
        await Effect.runPromise(
          Route.prepare(Result.getOrThrow(Route.anthropic({ apiKey: key })), golden)
        )
      ],
      [
        "openai",
        await Effect.runPromise(
          Route.prepare(Result.getOrThrow(Route.openai({ apiKey: key })), golden)
        )
      ],
      [
        "openai-chat",
        await Effect.runPromise(
          Route.prepare(
            Result.getOrThrow(
              Route.openaiChatCompatible({
                providerName: "openai",
                id: "golden-chat",
                baseUrl: "https://compatible.test",
                apiKey: key
              })
            ),
            golden
          )
        )
      ]
    ]

    for (const [name, request] of prepared) {
      const expected = readFileSync(new URL(`./fixtures/${name}/prepared-body.json`, import.meta.url), "utf8").trim()

      expect(request.bodyText, `${name} canonical body changed`).toBe(expected)
      expect(new TextDecoder().decode(request.body)).toBe(expected)
    }
  })

  it("keeps OpenAI-compatible routes on the portable protocol surface", async () => {
    const compatible = Result.getOrThrow(Route.openaiResponsesCompatible({
      providerName: "openai",
      id: "groq",
      baseUrl: "https://api.groq.com/openai",
      apiKey: Redacted.make("compatible-secret")
    }))

    expect(compatible.protocol.id).toBe("openai-responses")
    expect(compatible.protocol.supportsDeferred("gpt-5.4")).toBe(false)
    expect(compatible.headers).toBeUndefined()
    await expect(Route.prepare(compatible, request).pipe(Effect.runPromise)).resolves.toMatchObject({ routeId: "groq" })
  })

  it("constructs explicitly named compatible routes from one provider origin", () => {
    const origin = "https://openrouter.ai/api"
    const trailingOrigin = `${origin}/`
    const key = Redacted.make("compatible-secret")

    for (const baseUrl of [origin, trailingOrigin]) {
      expect(
        Result.getOrThrow(Route.openaiResponsesCompatible({
          providerName: "openai",
          id: "openrouter-responses",
          baseUrl,
          apiKey: key
        })).endpoint.url
      ).toBe("https://openrouter.ai/api/v1/responses")
      expect(
        Result.getOrThrow(Route.openaiChatCompatible({
          providerName: "openai",
          id: "openrouter-chat",
          baseUrl,
          apiKey: key
        })).endpoint.url
      ).toBe("https://openrouter.ai/api/v1/chat/completions")
    }
  })

  it("keeps the explicitly named compatible routes on their documented surfaces", async () => {
    const key = Redacted.make("compatible-secret")
    const responses = Result.getOrThrow(Route.openaiResponsesCompatible({
      providerName: "openai",
      id: "responses-compatible",
      baseUrl: "https://compatible.test",
      apiKey: key,
      headers: { "x-provider": "compatible" }
    }))
    // A compatible deployment does not implement OpenAI's native deferred-tool
    // extension, whatever the model is called.
    expect(responses.protocol.supportsDeferred("gpt-5.6-sol")).toBe(false)
    expect(responses.headers).toEqual({ "x-provider": "compatible" })

    const chat = Result.getOrThrow(Route.openaiChatCompatible({
      providerName: "openai",
      id: "chat-compatible",
      baseUrl: "https://compatible.test",
      apiKey: key,
      structuredOutput: { name: "capital", schema: { type: "object" } }
    }))
    const prepared = await Effect.runPromise(Route.prepare(chat, request))
    expect(JSON.parse(prepared.bodyText)).toMatchObject({
      response_format: { type: "json_schema", json_schema: { name: "capital", strict: true } }
    })

    const plainChat = Result.getOrThrow(Route.openaiChatCompatible({
      providerName: "openai",
      id: "chat-compatible-plain",
      baseUrl: "https://compatible.test",
      apiKey: key
    }))
    expect(JSON.parse((await Effect.runPromise(Route.prepare(plainChat, request))).bodyText))
      .not.toHaveProperty("response_format")

    expect(
      Route.openaiResponsesCompatible({
        providerName: "openai",
        id: "bad",
        baseUrl: "ftp://compatible.test",
        apiKey: key
      })
    )
      .toMatchObject({ _tag: "Failure" })
  })

  it("mounts the live Chat Completions route on compatible provider base paths", async () => {
    const groq = Result.getOrThrow(Route.openaiChatCompatible({
      providerName: "openai",
      id: "groq-chat",
      baseUrl: "https://api.groq.com/openai",
      apiKey: Redacted.make("compatible-secret")
    }))

    expect(groq.protocol.id).toBe("openai-chat-completions")
    expect(groq.protocol.supportsDeferred("gpt-5.4")).toBe(false)
    expect(groq.endpoint.url).toBe("https://api.groq.com/openai/v1/chat/completions")

    const gemini = Result.getOrThrow(Route.openaiChatCompatible({
      providerName: "openai",
      id: "gemini-chat",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: Redacted.make("compatible-secret")
    }))
    expect(gemini.endpoint.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/v1/chat/completions"
    )
    await expect(Route.prepare(gemini, request).pipe(Effect.runPromise)).resolves.toMatchObject({
      protocolId: "openai-chat-completions"
    })
  })

  it("carries an OpenAI-compatible deployment's own headers and rejects an unusable base URL", async () => {
    const withHeaders = Result.getOrThrow(Route.openaiResponsesCompatible({
      providerName: "openai",
      id: "vllm",
      baseUrl: "https://vllm.test/",
      apiKey: Redacted.make("compatible-secret"),
      headers: { "x-tenant": "acme" }
    }))

    expect(withHeaders.headers).toEqual({ "x-tenant": "acme" })
    expect(withHeaders.endpoint.url).toBe("https://vllm.test/v1/responses")
    const prepared = await Effect.runPromise(Route.prepare(withHeaders, request))
    expect(prepared.publicHeaders).toEqual({ "content-type": "application/json", "x-tenant": "acme" })

    const invalid = Route.openaiResponsesCompatible({
      providerName: "openai",
      id: "broken",
      baseUrl: "not a url",
      apiKey: Redacted.make("compatible-secret")
    })
    expect(Result.isFailure(invalid)).toBe(true)
  })

  it("composes the built-in provider deployments and their credential-free views", async () => {
    const anthropic = Result.getOrThrow(Route.anthropic({ apiKey: Redacted.make("anthropic-secret") }))

    expect(anthropic.id).toBe("anthropic")
    expect(anthropic.protocol.id).toBe("anthropic-messages")
    expect(anthropic.framing.id).toBe("sse")
    expect(anthropic.endpoint).toEqual({
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      query: []
    })
    expect(anthropic.headers).toEqual({ "anthropic-version": "2023-06-01" })

    const prepared = await Effect.runPromise(Route.prepare(anthropic, request))
    expect(prepared).toMatchObject({
      routeId: "anthropic",
      protocolId: "anthropic-messages",
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      publicHeaders: { "anthropic-version": "2023-06-01", "content-type": "application/json" },
      bodyText: "{\"max_tokens\":4096,\"messages\":[],\"model\":\"test-model\",\"stream\":true}"
    })
    expect(JSON.stringify(prepared)).not.toContain("anthropic-secret")

    const signed = await Effect.runPromise(anthropic.auth.sign({ "content-type": "application/json" }))
    expect(signed).toEqual({ "content-type": "application/json", "x-api-key": "anthropic-secret" })

    const openai = Result.getOrThrow(Route.openai({ apiKey: Redacted.make("openai-secret") }))
    expect(openai.endpoint.url).toBe("https://api.openai.com/v1/responses")
    expect(openai.headers).toBeUndefined()
    expect(await Effect.runPromise(openai.auth.sign({}))).toEqual({ Authorization: "Bearer openai-secret" })
  })

  it.each(
    [
      ["empty", { apiKey: Redacted.make("") }],
      ["missing", {}]
    ] as const
  )("fails a route whose credential is %s rather than sending an unauthenticated request", async (_, input) => {
    const route = Result.getOrThrow(Route.anthropic(input))
    const executor = RequestExecutor.RequestExecutor.of({
      execute: () => Effect.die(new Error("the request must never be sent"))
    })

    const error = await Effect.runPromise(
      Effect.scoped(
        Route.toModel(route).pipe(
          Effect.flatMap((model) => model.stream(request).pipe(Stream.runDrain, Effect.flip)),
          Effect.provideService(RequestExecutor.RequestExecutor, executor)
        )
      )
    )

    expect(error).toMatchObject({ code: "authentication", message: "API key must not be empty" })
  })

  it("fails a route given no credential at all the same way as an empty one", async () => {
    const route = Result.getOrThrow(Route.anthropic({}))
    const executor = RequestExecutor.RequestExecutor.of({
      execute: () => Effect.die(new Error("the request must never be sent"))
    })

    const error = await Effect.runPromise(
      Effect.scoped(
        Route.toModel(route).pipe(
          Effect.flatMap((model) => model.stream(request).pipe(Stream.runDrain, Effect.flip)),
          Effect.provideService(RequestExecutor.RequestExecutor, executor)
        )
      )
    )

    expect(route.headers).toEqual({ "anthropic-version": "2023-06-01" })
    expect(error).toMatchObject({ code: "authentication", message: "API key must not be empty" })
  })

  it("rejects a provider body that cannot be canonically encoded", async () => {
    const uncanonical = Protocol.make({
      ...protocol,
      body: {
        schema: Schema.Unknown,
        from: () => Effect.succeed({ generatedAt: new Date(0) })
      }
    })
    const route = Route.make({
      providerName: "openai",
      id: "uncanonical",
      protocol: uncanonical,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("secret")),
      framing: Framing.sse
    })

    const error = await Effect.runPromise(Route.prepare(route, request).pipe(Effect.flip))
    expect(error).toMatchObject({
      code: "invalid_request",
      message: "Model request could not be encoded as canonical JSON",
      path: "$.generatedAt"
    })
  })

  it("preserves a nested canonical-encoding key path without exposing its value", async () => {
    const uncanonical = Protocol.make({
      ...protocol,
      body: {
        schema: Schema.Unknown,
        from: () => Effect.succeed({ thinking: { budget_tokens: undefined } })
      }
    })
    const route = Route.make({
      providerName: "openai",
      id: "uncanonical-nested",
      protocol: uncanonical,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("secret")),
      framing: Framing.sse
    })

    const error = await Effect.runPromise(Route.prepare(route, request).pipe(Effect.flip))

    expect(error).toMatchObject({
      code: "invalid_request",
      message: "Model request could not be encoded as canonical JSON",
      path: "$.thinking.budget_tokens"
    })
    expect(JSON.stringify(error)).not.toContain("undefined")
  })

  it("wires route, auth, executor, framing, protocol, and settlement over a fake HTTP client", async () => {
    let sent: HttpClientRequest.HttpClientRequest | undefined
    const sse = [
      "event: response.output_text.delta",
      "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"delta\":\"wired\"}",
      "",
      "event: response.output_text.done",
      "data: {\"type\":\"response.output_text.done\",\"item_id\":\"msg_1\"}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\"}}",
      "",
      ""
    ].join("\n")
    const client = HttpClient.make((httpRequest) =>
      Effect.sync(() => {
        sent = httpRequest
        return HttpClientResponse.fromWeb(
          httpRequest,
          new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
        )
      })
    )

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const model = yield* Model.Model
          return yield* model.stream(request).pipe(Stream.runCollect)
        }).pipe(
          Effect.provide(Route.layer(Result.getOrThrow(Route.openai({ apiKey: Redacted.make("openai-secret") })))),
          Effect.provide(RequestExecutor.layer),
          Effect.provide(kernelHttpClientLayer(client)),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(Array.from(events)).toEqual([
      { type: "text-start", id: "msg_1" },
      { type: "text-delta", id: "msg_1", text: "wired" },
      { type: "text-end", id: "msg_1" },
      {
        type: "settle",
        stopReason: "stop",
        responseId: "resp_1"
      }
    ])
    expect(sent?.headers.authorization).toBe("Bearer openai-secret")
    expect(sent?.body._tag).toBe("Uint8Array")
    const settled = ModelEvent.settledMessage(events)
    expect(settled.message).toMatchObject({
      responseId: "resp_1",
      content: [{ type: "text", text: "wired" }]
    })
    if (sent?.body._tag === "Uint8Array") {
      expect(new TextDecoder().decode(sent.body.body)).toContain("\"stream\":true")
    }
  })

  it("uses the route protocol classifier for HTTP failures", async () => {
    const classifiedProtocol = Protocol.make({
      ...protocol,
      classifyError: (status: number) =>
        new ModelError({
          code: "content_policy",
          message: "protocol-specific refusal",
          providerCode: "policy_violation",
          httpStatus: status
        })
    })
    const route = Route.make({
      providerName: "openai",
      id: "classified",
      protocol: classifiedProtocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("secret")),
      framing: Framing.sse
    })
    const client = HttpClient.make((httpRequest) =>
      Effect.succeed(HttpClientResponse.fromWeb(httpRequest, new Response("provider body", { status: 418 })))
    )

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const model = yield* Model.Model
          return yield* model.stream(request).pipe(Stream.runDrain, Effect.flip)
        }).pipe(
          Effect.provide(Route.layer(route)),
          Effect.provide(RequestExecutor.layer),
          Effect.provide(kernelHttpClientLayer(client)),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(error).toMatchObject({
      code: "content_policy",
      message: "protocol-specific refusal",
      providerCode: "policy_violation",
      httpStatus: 418
    })
  })

  it("keeps protocol parser failures in the typed stream error channel", async () => {
    const expected = new ModelError({
      code: "invalid_provider_output",
      message: "fixture parser failure"
    })
    const failingProtocol = Protocol.make({
      ...protocol,
      stream: {
        ...protocol.stream,
        step: () => Effect.fail(expected)
      }
    })
    const config = Route.make({
      providerName: "openai",
      id: "failing",
      protocol: failingProtocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("secret")),
      framing: Framing.sse
    })
    const executor = RequestExecutor.RequestExecutor.of({
      execute: (httpRequest) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            httpRequest,
            new Response("data: {}\n\n", {
              status: 200,
              headers: { "content-type": "text/event-stream" }
            })
          )
        )
    })
    const model = await Effect.runPromise(
      Route.toModel(config).pipe(Effect.provideService(RequestExecutor.RequestExecutor, executor))
    )
    const error = await Effect.runPromise(
      Effect.scoped(model.stream(request).pipe(Stream.runDrain, Effect.flip))
    )

    expect(error).toBe(expected)
  })
})

const executorOf = (
  respond: (httpRequest: HttpClientRequest.HttpClientRequest) => Response
): RequestExecutor.RequestExecutor =>
  RequestExecutor.RequestExecutor.of({
    execute: (httpRequest) => Effect.succeed(HttpClientResponse.fromWeb(httpRequest, respond(httpRequest)))
  })

const sseResponse = (frames: ReadonlyArray<string>): Response =>
  new Response(frames.map((frame) => `data: ${frame}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  })

const collect = <Body, Frame, Event, State>(
  config: Route.Config<Body, Frame, Event, State>,
  executor: RequestExecutor.RequestExecutor
): Promise<ReadonlyArray<ModelEvent.ModelEvent>> =>
  Effect.runPromise(
    Effect.scoped(
      Route.toModel(config).pipe(
        Effect.flatMap((model) => model.stream(request).pipe(Stream.runCollect)),
        Effect.provideService(RequestExecutor.RequestExecutor, executor)
      )
    )
  ).then((events) => Array.from(events))

const drainError = <Body, Frame, Event, State>(
  config: Route.Config<Body, Frame, Event, State>,
  executor: RequestExecutor.RequestExecutor
): Promise<Model.ModelFailure> =>
  Effect.runPromise(
    Effect.scoped(
      Route.toModel(config).pipe(
        Effect.flatMap((model) => model.stream(request).pipe(Stream.runDrain, Effect.flip)),
        Effect.provideService(RequestExecutor.RequestExecutor, executor)
      )
    )
  )

const routeOf = <Body, Frame, Event, State>(
  input: {
    readonly protocol: Protocol.Protocol<Body, Frame, Event, State>
    readonly framing: Framing.Framing<Frame>
  }
): Route.Route<Body, Frame, Event, State> =>
  Route.make({
    providerName: "openai",
    id: "streamed",
    protocol: input.protocol,
    endpoint: endpoint({ url: "https://example.test" }),
    auth: Auth.bearer(Redacted.make("secret")),
    framing: input.framing
  })

describe("Route.stream", () => {
  it("reports a response body that dies mid-stream as a transport failure", async () => {
    const executor = executorOf(() =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: {\"text\":\"partial\"}\n\n"))
            controller.error(new Error("socket reset"))
          }
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    )

    const error = await drainError(routeOf({ protocol, framing: Framing.sse }), executor)
    expect(error).toMatchObject({ code: "transport", message: "Model response stream failed" })
    expect(JSON.stringify(error)).not.toContain("socket reset")
  })

  it("reports built-in framing budget failures as non-retryable invalid provider output", async () => {
    const error = await drainError(
      routeOf({ protocol, framing: Framing.makeSse({ maxRecordBytes: 8 }) }),
      executorOf(() => sseResponse(["private-response-text"]))
    )
    expect(error).toMatchObject({
      code: "invalid_provider_output",
      message: "Model stream record exceeds 8 bytes",
      retryable: false
    })
    expect(JSON.stringify(error)).not.toContain("private-response-text")
  })

  it("reports an oversized SSE event as a transport failure", async () => {
    const framing: Framing.Framing<string> = {
      id: "sse-too-large",
      frame: () => Stream.fail(new Sse.SseError({ reason: new Sse.EventTooLarge({ maxEventSize: 8 }) }))
    }

    const error = await drainError(routeOf({ protocol, framing }), executorOf(() => sseResponse(["{}"])))
    expect(error).toMatchObject({ code: "transport", message: "Model response stream failed" })
  })

  it("rejects a frame the protocol cannot decode", async () => {
    const invalidStreamValue = "private-invalid-stream-value"
    const nestedEvent = Schema.Struct({
      choices: Schema.Array(Schema.Struct({ delta: Schema.Struct({ text: Schema.String }) }))
    })
    const nestedProtocol = Protocol.make({
      ...protocol,
      stream: { ...protocol.stream, event: Protocol.jsonEvent(nestedEvent) }
    })
    const error = await drainError(
      routeOf({ protocol: nestedProtocol, framing: Framing.sse }),
      executorOf(() =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { text: invalidStreamValue } }] }).replace(
            JSON.stringify(invalidStreamValue),
            JSON.stringify({ secret: invalidStreamValue })
          )
        ])
      )
    )

    expect(error).toMatchObject({
      code: "invalid_provider_output",
      message: "test emitted an invalid stream event",
      path: "choices[0].delta.text"
    })
    expect(JSON.stringify(error)).not.toContain(invalidStreamValue)
  })

  it("runs the halt hook of a protocol that also declares a terminal event", async () => {
    // `takeUntil` ends the stream at the terminal frame, and the halt hook must
    // still settle whatever the protocol left open.
    const halting = Protocol.make({
      ...protocol,
      stream: {
        ...protocol.stream,
        terminal: (event: Record<string, unknown>) => event["done"] === true,
        onHalt: () => [ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })]
      }
    })

    const events = await collect(
      routeOf({ protocol: halting, framing: Framing.sse }),
      executorOf(() => sseResponse(["{\"done\":true}", "{\"unreached\":true}"]))
    )

    expect(events).toEqual([{ type: "settle", stopReason: "stop" }])
  })

  it("reads one validated snapshot, not the caller's object, after signing begins", async () => {
    // The caller owns the request. Before the snapshot, a mutation landing
    // while `Auth.sign` was pending left the body saying one model id while the
    // capability check and the protocol state saw another.
    const mutable = {
      modelId: "before",
      system: [],
      messages: [],
      tools: [],
      params: ModelRequest.GenerationParams.make()
    } as unknown as ModelRequest.ModelRequest
    const seenByProtocol: Array<string> = []
    const seenByExecutor: Array<string> = []
    const observing = Protocol.make({
      ...protocol,
      body: { schema: Schema.Unknown, from: (request) => Effect.succeed({ model: request.modelId }) },
      stream: {
        ...protocol.stream,
        initial: (request: ModelRequest.ModelRequest) => {
          seenByProtocol.push(request.modelId)
          return 0
        }
      }
    })
    const mutatingAuth: Auth.Auth = {
      sign: (headers) =>
        Effect.sync(() => {
          ;(mutable as { modelId: string }).modelId = "after"
          return { ...headers, Authorization: "Bearer static" }
        })
    }
    const executor = RequestExecutor.RequestExecutor.of({
      execute: (httpRequest, options) => {
        seenByExecutor.push(options.modelId)
        return Effect.succeed(HttpClientResponse.fromWeb(httpRequest, sseResponse([])))
      }
    })

    const bodies: Array<string> = []
    await Effect.runPromise(
      Effect.scoped(
        Route.toModel(
          Route.make({
            providerName: "openai",
            id: "snapshot",
            protocol: observing,
            endpoint: endpoint({ url: "https://example.test" }),
            auth: {
              sign: (headers) =>
                mutatingAuth.sign(headers).pipe(Effect.tap(() => Effect.sync(() => bodies.push(mutable.modelId))))
            },
            framing: Framing.sse
          })
        ).pipe(
          Effect.flatMap((model) => model.stream(mutable).pipe(Stream.runDrain)),
          Effect.provideService(RequestExecutor.RequestExecutor, executor)
        )
      )
    )

    // The mutation did land, and nothing downstream saw it.
    expect(mutable.modelId).toBe("after")
    expect(bodies).toEqual(["after"])
    expect(seenByExecutor).toEqual(["before"])
    expect(seenByProtocol).toEqual(["before"])
  })

  it("stops at the protocol's terminal event and needs no halt handler", async () => {
    const terminal = Protocol.make({
      id: "terminal",
      supportsDeferred: () => false,
      body: protocol.body,
      stream: {
        event: Schema.fromJsonString(TestEvent),
        initial: () => 0,
        step: (state: number, event: { readonly [key: string]: unknown }) =>
          Effect.succeed(
            [
              state + 1,
              [ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: `f${state}`, text: String(event["text"]) })]
            ] as const
          ),
        terminal: (event: { readonly [key: string]: unknown }) => event["stop"] === true
      },
      classifyError: protocol.classifyError
    })

    const events = await collect(
      routeOf({ protocol: terminal, framing: Framing.sse }),
      executorOf(() =>
        sseResponse([
          "{\"text\":\"one\"}",
          "{\"text\":\"two\",\"stop\":true}",
          "{\"text\":\"three\"}"
        ])
      )
    )

    expect(events).toEqual([
      { type: "text-delta", id: "f0", text: "one" },
      { type: "text-delta", id: "f1", text: "two" }
    ])
  })

  it("streams zero events when the provider settles without sending any", async () => {
    const events = await collect(routeOf({ protocol, framing: Framing.sse }), executorOf(() => sseResponse(["[DONE]"])))
    expect(events).toEqual([])
  })
})

describe("Route.stream terminal events", () => {
  // A proxy that sends its terminal frame and then leaves the body open is a
  // transport edge, but every built-in protocol used to pull until HTTP EOF
  // after it, so the run never completed without an outside interrupt.
  const neverClosing = (frames: ReadonlyArray<string>, onCancel: () => void): Response =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frames.map((frame) => `data: ${frame}\n\n`).join("")))
        },
        cancel() {
          onCancel()
        }
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )

  const key = Redacted.make("secret")
  it.each([
    [
      "anthropic",
      () => Result.getOrThrow(Route.anthropic({ apiKey: key })),
      [
        "{\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}",
        "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}",
        "{\"type\":\"message_stop\"}"
      ],
      { type: "settle", stopReason: "stop", responseId: "msg_1" }
    ],
    [
      "openai-responses",
      () => Result.getOrThrow(Route.openai({ apiKey: key })),
      ["{\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\"}}"],
      { type: "settle", stopReason: "stop", responseId: "resp_1" }
    ],
    [
      "openai-chat-completions",
      () =>
        Result.getOrThrow(
          Route.openaiChatCompatible({
            providerName: "openai",
            id: "compat",
            baseUrl: "https://compat.test",
            apiKey: key
          })
        ),
      [
        "{\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}",
        "{\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}",
        "[DONE]"
      ],
      { type: "usage", inputTokens: 3, outputTokens: 1, totalTokens: 4 }
    ]
  ])("completes a %s stream at its terminal frame without waiting for EOF", async (_, route, frames, last) => {
    let cancelled = false
    const events = await Effect.runPromise(
      Effect.scoped(
        Route.toModel(route() as Route.Config<unknown, string, unknown, unknown>).pipe(
          Effect.flatMap((model) => model.stream(request).pipe(Stream.runCollect)),
          Effect.provideService(
            RequestExecutor.RequestExecutor,
            executorOf(() =>
              neverClosing(frames, () => {
                cancelled = true
              })
            )
          )
        )
      ).pipe(Effect.timeout("2 seconds"))
    ).then((chunk) => Array.from(chunk))

    expect(events.at(-1)).toEqual(last)
    expect(events.filter((event) => event.type === "settle")).toHaveLength(1)
    expect(cancelled).toBe(true)
  })
})

describe("Route.stream credential safety", () => {
  // A successful call is enough to leak a key: the HTTP client writes every
  // request header onto its client span, and its default redaction policy
  // names `authorization` and `x-api-key` alone.
  it.each([
    ["api-key", "a name the shared matcher recognizes"],
    ["chatgpt-account-id", "an account identity the ChatGPT route must not trace"],
    ["Ocp-Apim-Subscription-Key", "a name only the auth itself knows is a credential"]
  ])("keeps %s out of the request span (%s)", async (headerName) => {
    const key = "traced-secret-value"
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const client = HttpClient.make((httpRequest) =>
      Effect.succeed(HttpClientResponse.fromWeb(httpRequest, sseResponse(["[DONE]"])))
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const executor = yield* RequestExecutor.makeWith(RequestExecutor.fixed(client))
          const model = yield* Route.toModel(
            Route.make({
              providerName: "openai",
              id: "traced",
              protocol,
              endpoint: endpoint({ url: "https://example.test" }),
              auth: Auth.apiKeyHeader(headerName, Redacted.make(key)),
              framing: Framing.sse,
              headers: { "x-public": "yes" }
            })
          ).pipe(Effect.provideService(RequestExecutor.RequestExecutor, executor))
          yield* model.stream(request).pipe(Stream.runDrain)
        }).pipe(Effect.provideService(Tracer.Tracer, tracer))
      )
    )

    const attribute = (name: string): ReadonlyArray<unknown> =>
      spans.map((span) => span.attributes.get(`http.request.header.${name}`)).filter((value) => value !== undefined)

    expect(attribute(headerName.toLowerCase())).toEqual(["<redacted>"])
    expect(attribute("x-public")).toEqual(["yes"])
    expect(JSON.stringify(spans.map((span) => Array.from(span.attributes)))).not.toContain(key)
  })
  const credential = "sk-inline-stream-credential-0123456789"

  // Every built-in family reports a mid-stream failure over HTTP 200, so the
  // executor's status branch never sees it. A compatibility gateway that
  // echoes the key it rejected is the whole exposure.
  const encodedCredential = btoa(credential)

  const rejection = (status = 200): Response => {
    const body = JSON.stringify({
      type: "error",
      error: {
        type: "authentication_error",
        code: "invalid_api_key",
        message: `Rejected key ${credential} ${encodedCredential}`
      }
    })
    return new Response(status === 200 ? `data: ${body}\n\n` : body, {
      status,
      headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" }
    })
  }

  const drainOverHttp = <Body, Frame, Event, State>(
    route: Route.Route<Body, Frame, Event, State>,
    respond: () => Response
  ): Promise<Model.ModelFailure> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const model = yield* Model.Model
          return yield* model.stream(request).pipe(Stream.runDrain, Effect.flip)
        }).pipe(
          Effect.provide(Route.layer(route)),
          Effect.provide(RequestExecutor.layer),
          Effect.provide(
            kernelHttpClientLayer(
              HttpClient.make((httpRequest) => Effect.succeed(HttpClientResponse.fromWeb(httpRequest, respond())))
            )
          ),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

  it.each([200, 401])("redacts Anthropic credential echoes over HTTP %s", async (status) => {
    const error = await drainOverHttp(
      Result.getOrThrow(Route.anthropic({ apiKey: Redacted.make(credential) })),
      () => rejection(status)
    )

    expect(error).toMatchObject({ code: "authentication" })
    expect((error as ModelError).message).toContain("<redacted>")
    expect(JSON.stringify(error)).not.toContain(credential)
    expect(JSON.stringify(error)).not.toContain(encodedCredential)
  })

  it.each([200, 401])("redacts Responses credential echoes over HTTP %s", async (status) => {
    const error = await drainOverHttp(
      Result.getOrThrow(Route.openai({ apiKey: Redacted.make(credential) })),
      () => rejection(status)
    )

    expect(error).toMatchObject({ code: "authentication" })
    expect((error as ModelError).message).toContain("<redacted>")
    expect(JSON.stringify(error)).not.toContain(credential)
    expect(JSON.stringify(error)).not.toContain(encodedCredential)
  })

  it.each([200, 401])("redacts chat credential echoes over HTTP %s", async (status) => {
    const error = await drainOverHttp(
      Result.getOrThrow(
        Route.openaiChatCompatible({
          providerName: "openai",
          id: "compatible",
          baseUrl: "https://provider.test/v1",
          apiKey: Redacted.make(credential)
        })
      ),
      () => rejection(status)
    )

    expect(error).toMatchObject({ code: "authentication" })
    expect((error as ModelError).message).toContain("<redacted>")
    expect(JSON.stringify(error)).not.toContain(credential)
    expect(JSON.stringify(error)).not.toContain(encodedCredential)
  })

  it.each([200, 401])("redacts custom Auth header echoes over HTTP %s", async (status) => {
    const route = Route.make({
      ...Result.getOrThrow(Route.openai({ apiKey: Redacted.make(credential) })),
      auth: Auth.apiKeyHeader("Ocp-Apim-Subscription-Key", Redacted.make(credential))
    })
    const error = await drainOverHttp(route, () => rejection(status))
    expect(error).toMatchObject({ code: "authentication" })
    expect((error as ModelError).message).toContain("<redacted>")
    expect(JSON.stringify(error)).not.toContain(credential)
    expect(JSON.stringify(error)).not.toContain(encodedCredential)
  })

  it("redacts every diagnostic field a protocol copies off the wire", async () => {
    const leaked = new ModelError({
      code: "provider_internal",
      message: `rejected ${credential}`,
      path: `choices[0].${credential} ${encodedCredential}`,
      resetSource: `header ${credential} ${encodedCredential}`,
      providerCode: `code-${credential} ${encodedCredential}`,
      requestId: `req-${credential} ${encodedCredential}`
    })
    Object.defineProperties(leaked, {
      body: { value: `{"error":"${credential}"}`, enumerable: false },
      bodyTruncated: { value: false, enumerable: false }
    })
    const leaking = Protocol.make({
      ...protocol,
      stream: { ...protocol.stream, step: () => Effect.fail(leaked) }
    })
    const route = Route.make({
      providerName: "openai",
      id: "leaking",
      protocol: leaking,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make(credential)),
      framing: Framing.sse
    })

    const error = await drainError(route, executorOf(() => sseResponse(["{}"])))

    expect(error).not.toBe(leaked)
    expect(error).toMatchObject({
      code: "provider_internal",
      message: "rejected <redacted>",
      path: "choices[0].<redacted> <redacted>",
      resetSource: "header <redacted> <redacted>",
      providerCode: "code-<redacted> <redacted>",
      requestId: "req-<redacted> <redacted>"
    })
    expect((error as ModelError).body).toBe("{\"error\":\"<redacted>\"}")
    expect((error as ModelError).bodyTruncated).toBe(false)
    expect(JSON.stringify(error)).not.toContain(credential)
    expect(JSON.stringify(error)).not.toContain(encodedCredential)
    expect((error as ModelError).body).not.toContain(credential)
  })

  it("applies the HTTP diagnostic caps to an oversized protocol failure", async () => {
    const oversized = new ModelError({
      code: "provider_internal",
      message: "m".repeat(20_000),
      path: "p".repeat(20_000),
      resetSource: "s".repeat(20_000),
      providerCode: "c".repeat(20_000),
      requestId: "r".repeat(20_000)
    })
    Object.defineProperty(oversized, "body", { value: "b".repeat(20_000), enumerable: false })
    const verbose = Protocol.make({
      ...protocol,
      stream: { ...protocol.stream, step: () => Effect.fail(oversized) }
    })

    const error = await drainError(
      routeOf({ protocol: verbose, framing: Framing.sse }),
      executorOf(() => sseResponse(["{}"]))
    ) as ModelError

    expect(error.message).toHaveLength(16_384)
    expect(error.path).toHaveLength(16_384)
    expect(error.resetSource).toHaveLength(16_384)
    expect(error.providerCode).toHaveLength(16_384)
    expect(error.requestId).toHaveLength(16_384)
    expect(error.body).toHaveLength(16_384)
    expect(error.bodyTruncated).toBe(true)
  })
})

describe("Route.stream refresh", () => {
  const refusal = () => new ModelError({ code: "authentication", message: "expired", httpStatus: 401 })

  const countingExecutor = (
    respond: (attempt: number, httpRequest: HttpClientRequest.HttpClientRequest) => Effect.Effect<Response, ModelError>
  ) => {
    const seen: Array<HttpClientRequest.HttpClientRequest> = []
    const executor = RequestExecutor.RequestExecutor.of({
      execute: (httpRequest) => {
        seen.push(httpRequest)
        return respond(seen.length, httpRequest).pipe(
          Effect.map((response) => HttpClientResponse.fromWeb(httpRequest, response))
        )
      }
    })
    return { executor, seen }
  }

  const refreshingAuth = () => {
    let token = "stale-token"
    let refreshes = 0
    const auth: Auth.Auth = {
      sign: (headers) => Effect.sync(() => ({ ...headers, Authorization: `Bearer ${token}` })),
      refresh: Effect.sync(() => {
        refreshes += 1
        token = "fresh-token"
      })
    }
    return { auth, count: () => refreshes }
  }

  const withAuth = (auth: Auth.Auth) =>
    Route.make({
      providerName: "openai",
      id: "refreshing",
      protocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth,
      framing: Framing.sse
    })

  it("refreshes and re-signs exactly once after an authentication failure", async () => {
    const { auth, count } = refreshingAuth()
    const { executor, seen } = countingExecutor((attempt) =>
      attempt === 1 ? Effect.fail(refusal()) : Effect.succeed(sseResponse(["[DONE]"]))
    )

    const events = await collect(withAuth(auth), executor)

    expect(events).toEqual([])
    expect(count()).toBe(1)
    expect(seen.map((request) => request.headers.authorization)).toEqual([
      "Bearer stale-token",
      "Bearer fresh-token"
    ])
  })

  it("scrubs stream failures with the refreshed signed credential", async () => {
    const { auth, count } = refreshingAuth()
    const { executor } = countingExecutor((attempt) =>
      attempt === 1 ? Effect.fail(refusal()) : Effect.succeed(sseResponse(["{}"]))
    )
    const route = Route.make({
      ...withAuth(auth),
      protocol: Protocol.make({
        ...protocol,
        stream: {
          ...protocol.stream,
          step: () =>
            Effect.fail(
              new ModelError({
                code: "authentication",
                message: `Rejected fresh-token ${btoa("fresh-token")}`
              })
            )
        }
      })
    })
    const error = await drainError(route, executor)
    expect(error).toMatchObject({ code: "authentication", message: "Rejected <redacted> <redacted>" })
    expect(count()).toBe(1)
  })

  it("surfaces the second authentication failure rather than retrying again", async () => {
    const { auth, count } = refreshingAuth()
    const { executor, seen } = countingExecutor(() => Effect.fail(refusal()))

    const error = await drainError(withAuth(auth), executor)

    expect(error).toMatchObject({ code: "authentication", httpStatus: 401 })
    expect(count()).toBe(1)
    expect(seen).toHaveLength(2)
  })

  it("keeps a static credential terminal: no refresh, one attempt", async () => {
    const { executor, seen } = countingExecutor(() => Effect.fail(refusal()))

    const error = await drainError(withAuth(Auth.bearer(Redacted.make("static-key"))), executor)

    expect(error).toMatchObject({ code: "authentication" })
    expect(seen).toHaveLength(1)
  })

  it("surfaces a refresh that fails on its own terms and stops there", async () => {
    // A refresh that cannot repair the credential is the end of the ladder:
    // its typed failure reaches the caller and the request is not re-signed.
    let attempts = 0
    const auth: Auth.Auth = {
      sign: (headers) => Effect.sync(() => ({ ...headers, Authorization: "Bearer stale-token" })),
      refresh: Effect.fail(new ModelError({ code: "authentication", message: "refresh token revoked" }))
    }
    const { executor, seen } = countingExecutor(() => {
      attempts += 1
      return Effect.fail(refusal())
    })

    const error = await drainError(withAuth(auth), executor)

    expect(error).toMatchObject({ code: "authentication", message: "refresh token revoked" })
    expect(seen).toHaveLength(1)
    expect(attempts).toBe(1)
  })

  it("does not treat other failures as refreshable", async () => {
    const { auth, count } = refreshingAuth()
    const { executor, seen } = countingExecutor(() =>
      Effect.fail(new ModelError({ code: "rate_limited", message: "slow down", httpStatus: 429 }))
    )

    const error = await drainError(withAuth(auth), executor)

    expect(error).toMatchObject({ code: "rate_limited" })
    expect(count()).toBe(0)
    expect(seen).toHaveLength(1)
  })
})

describe("Endpoint.providerOrigin", () => {
  it.each(
    [
      ["anthropic", "https://api.anthropic.com"],
      ["openai", "https://api.openai.com"],
      ["cerebras", "https://api.cerebras.ai"],
      ["openrouter", "https://openrouter.ai/api"],
      ["vercel", "https://ai-gateway.vercel.sh"]
    ] as const
  )("maps %s to its own origin with no proxy, or under the proxy", (provider, origin) => {
    expect(Endpoint.providerOrigin(provider, {})).toBe(origin)
    expect(Endpoint.providerOrigin(provider, { SMITHERS_MODEL_PROXY_URL: "" })).toBe(origin)
    expect(Endpoint.providerOrigin(provider, { SMITHERS_MODEL_PROXY_URL: "http://p.test/m/" })).toBe(
      `http://p.test/m/${provider}`
    )
    expect(
      Endpoint.providerOrigin(provider, {
        SMITHERS_MODEL_PROXY_URL: "http://p.test/m/",
        SMITHERS_MODEL_PROXY_PROVIDERS: ` ${provider} , other`
      })
    ).toBe(`http://p.test/m/${provider}`)
    expect(
      Endpoint.providerOrigin(provider, {
        SMITHERS_MODEL_PROXY_URL: "http://p.test/m/",
        SMITHERS_MODEL_PROXY_PROVIDERS: "other"
      })
    ).toBe(origin)
  })

  it("proxies only the providers SMITHERS_MODEL_PROXY_PROVIDERS names", () => {
    const environment = {
      SMITHERS_MODEL_PROXY_URL: "http://p.test/m",
      SMITHERS_MODEL_PROXY_PROVIDERS: "openai, anthropic"
    }
    expect(Endpoint.proxyOrigin("anthropic", environment)).toBe("http://p.test/m/anthropic")
    expect(Endpoint.proxyOrigin("cerebras", environment)).toBeUndefined()
    expect(Endpoint.providerOrigin("cerebras", environment)).toBe("https://api.cerebras.ai")
  })

  it("routes Route.anthropic and Route.openai to a supplied origin", () => {
    const key = Redacted.make("k")
    expect(Result.getOrThrow(Route.anthropic({ apiKey: key, baseUrl: "http://p.test/m/anthropic" })).endpoint.url)
      .toBe("http://p.test/m/anthropic/v1/messages")
    expect(Result.getOrThrow(Route.openai({ apiKey: key, baseUrl: "http://p.test/m/openai" })).endpoint.url)
      .toBe("http://p.test/m/openai/v1/responses")
    expect(Result.getOrThrow(Route.anthropic({ apiKey: key })).endpoint.url).toBe(
      "https://api.anthropic.com/v1/messages"
    )
  })
})


describe("native step correlation", () => {
 it("scopes headers to the action and leaves the wire body unchanged", async () => {
  const route = Route.make({id:"proxy",protocol,endpoint:endpoint({url:"https://example.test"}),auth:Auth.bearer(Redacted.make("secret")),framing:Framing.sse})
  const plain = await Effect.runPromise(Route.prepare(route,request))
  const coordinates={executionId:"native-run",stepId:"a".repeat(64)}
  const scoped=await Effect.runPromise(Route.prepare(route,request).pipe(Effect.provideService(Route.StepCorrelation,coordinates)))
  expect(scoped.publicHeaders["X-Smithers-Execution-Id"] ?? scoped.publicHeaders["x-smithers-execution-id"]).toBe("native-run")
  expect(scoped.publicHeaders["X-Smithers-Step-Id"] ?? scoped.publicHeaders["x-smithers-step-id"]).toBe(coordinates.stepId)
  expect(scoped.bodyText).toBe(plain.bodyText)
  expect(await Effect.runPromise(Route.prepare(route,request))).toEqual(plain)
 })
})
