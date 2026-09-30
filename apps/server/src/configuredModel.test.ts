import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { TestClock } from "effect/testing"
import { CLOUD_ROLE_MAX_TOKENS, CLOUD_ROLE_REASONING_EFFORT, CLOUD_ROLE_TIMEOUT_MS } from "./cloudRoleTurn"
import { planDecisionModel } from "./configuredModel"
import { testConfig, testConfigLayer } from "./Config"
import type { ServerConfigShape } from "./Config"
import { memoryStorage } from "./DurableStorage"
import type { NativeNamespace } from "./DurableStorage"
import { ExecutionContext, executionContextFrom } from "./Environment"
import { transportLayer } from "./Http"
import type { ValidatedIdentity } from "./identity"
import { recommendLogLayer } from "./recommend"
import { handleTurn, TurnCancelRegistry, turnCancelsLayer } from "./turns"

/*
 * The `explainer` seat on the Worker: a sealed turn that binds a model is
 * answered on that model through the Worker's one Cerebras client, or it is
 * refused. These tests drive the turn route itself, with every outbound call
 * recorded, so "never the upstream, never another model" is held by the
 * double rather than asserted once.
 */

const SECRET = "csk-test-value"
const CHAT_URL = "https://upstream.test/chat"

const CEREBRAS_BINDING = {
  protocol: "openai-chat",
  baseUrl: "https://api.cerebras.ai",
  modelId: "qwen-3-coder-480b",
  credential: "CEREBRAS_API_KEY"
}

const explainBody = (overrides: Record<string, unknown> = {}) => ({
  runId: "explain-1",
  messages: [{ role: "user", content: "Why did the build fail?" }],
  instructions: "You are the Explainer.",
  purpose: "explain",
  role: "explainer",
  model: CEREBRAS_BINDING,
  ...overrides
})

const post = (body: unknown): Request =>
  new Request("https://mvp.test/api/agent/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

const completion = (content: string): Response => Response.json({ model: "served", choices: [{ message: { content } }] })

const memoryCancels = (): NativeNamespace => {
  const registries = new Map<string, TurnCancelRegistry>()
  return {
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let registry = registries.get(name)
      if (registry === undefined) {
        registry = new TurnCancelRegistry({ storage: memoryStorage() })
        registries.set(name, registry)
      }
      const object = registry
      return { fetch: (request) => object.fetch(request) }
    }
  }
}

const METERED_CEREBRAS_URL = "https://cloud.test/api/model/cerebras/v1/chat/completions"
const SESSION: ValidatedIdentity = { login: "alice", admin: false, scopes: [] }
/** A deployment with sign-in, the Cerebras key and the gateway key. */
const SIGNED_IN_DEPLOYMENT: Partial<ServerConfigShape> = {
  identityUpstreamUrl: "https://identity.test",
  identityServiceToken: Redacted.make("service-token"),
  cloudApiBaseUrl: "https://cloud.test",
  cerebrasApiKey: Redacted.make(SECRET),
  aiGatewayApiKey: Redacted.make("vck-test-value")
}

interface Served {
  readonly response: Response
  /** Every outbound request, by URL. */
  readonly calls: Array<Request>
}

const layers = (
  calls: Array<Request>,
  provider: ((request: Request) => Response | Promise<Response>) | undefined,
  config: Partial<ServerConfigShape>
) =>
  Layer.mergeAll(
    transportLayer(async (input, init) => {
      const request = new Request(input as string, init)
      // The signed-in login's Cloud token: its model calls are metered through the Cloud proxy (modelPayer.ts).
      if (request.url === "https://identity.test/api/identity/cloud-token") return Response.json({ found: true, token: "cloud-token-alice" })
      calls.push(request)
      if (request.url !== METERED_CEREBRAS_URL) throw new Error(`a bound turn must never fetch ${request.url}`)
      if (request.headers.get("authorization") !== "Bearer cloud-token-alice") throw new Error("a signed-in turn must pay with the login's Cloud token")
      if (provider === undefined) throw new Error("the provider must not be asked")
      return provider(request)
    }),
    testConfigLayer({ chatUrl: CHAT_URL, upstreamTimeoutMs: 5_000, ...SIGNED_IN_DEPLOYMENT, ...config }),
    turnCancelsLayer(memoryCancels()),
    recommendLogLayer(undefined),
    Layer.succeed(ExecutionContext, executionContextFrom(undefined))
  )

const serve = async (
  body: unknown,
  options: {
    readonly provider?: (request: Request) => Response | Promise<Response>
    readonly config?: Partial<ServerConfigShape>
    readonly session?: ValidatedIdentity | undefined
  } = {}
): Promise<Served> => {
  const calls: Array<Request> = []
  const session = "session" in options ? options.session : SESSION
  const response = await Effect.runPromise(
    handleTurn(post(body), session).pipe(Effect.provide(layers(calls, options.provider, options.config ?? {})))
  )
  return { response, calls }
}

const refusalOf = async (served: Served) => {
  const text = await served.response.text()
  // No refusal, whatever it says, may carry the key it would have spent.
  expect(text).not.toContain(SECRET)
  const body = JSON.parse(text) as { status: string; code: string; message: string }
  expect(body.status).toBe("error")
  return { status: served.response.status, code: body.code, message: body.message }
}

describe("a sealed turn that binds a model", () => {
  test("refuses a cross-origin redirect without fetching the second host", async () => {
    let redirectedCalls = 0
    const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
      redirectedCalls += 1
      return completion("redirect followed")
    } })
    const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () =>
      new Response(null, { status: 307, headers: { location: destination.url.href } }) })
    try {
      const served = await serve(explainBody(), { provider: async (request) => fetch(provider.url, {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
        redirect: request.redirect
      }) })
      expect(redirectedCalls).toBe(0)
      expect(served.calls[0]!.redirect).toBe("manual")
      const refused = await refusalOf(served)
      expect([refused.status, refused.code]).toEqual([502, "upstream_refused"])
      expect(refused.message).toContain("307")
      expect(served.calls).toHaveLength(1)
    } finally {
      provider.stop(true)
      destination.stop(true)
    }
  })

  test("cuts echoed credentials from a successful answer before building any frame", async () => {
    const joined = `${SECRET.slice(0, 5)}${SECRET}${SECRET.slice(5)}`
    const served = await serve(explainBody(), { provider: () => completion(`Before ${joined} after.`) })
    expect(served.response.status).toBe(200)
    const frames = (await served.response.text()).trim().split("\n").map((line) => JSON.parse(line) as unknown)
    expect(frames).toEqual([
      { runId: "explain-1", type: "delta", kind: "text", text: "Before  after." },
      { runId: "explain-1", type: "done", reason: "stop" }
    ])
  })

  test("an answer containing only an echoed credential is empty after sanitizing", async () => {
    const served = await serve(explainBody(), { provider: () => completion(SECRET) })
    expect((await served.response.text()).trim().split("\n").map((line) => JSON.parse(line) as unknown)).toEqual([
      { runId: "explain-1", type: "done", reason: "stop", error: "The configured model answered with no text." }
    ])
  })

  test("is answered on the bound model id through Cerebras, as one delta and one done", async () => {
    let sent: Record<string, unknown> = {}
    const served = await serve(explainBody(), {
      provider: async (request) => {
        sent = (await request.json()) as Record<string, unknown>
        return completion("The lockfile drifted.")
      }
    })
    expect(served.response.status).toBe(200)
    expect(served.response.headers.get("content-type")).toBe("application/x-ndjson")
    expect((await served.response.text()).trim().split("\n").map((line) => JSON.parse(line) as unknown)).toEqual([
      { runId: "explain-1", type: "delta", kind: "text", text: "The lockfile drifted." },
      { runId: "explain-1", type: "done", reason: "stop" }
    ])
    expect(served.calls.map((request) => request.url)).toEqual([METERED_CEREBRAS_URL])
    expect(served.calls[0]!.headers.get("authorization")).toBe("Bearer cloud-token-alice")
    expect(sent.model).toBe("qwen-3-coder-480b")
    expect(sent.max_tokens).toBe(CLOUD_ROLE_MAX_TOKENS)
    // Never the provider's own default, which on Cerebras is `high`.
    expect(sent.reasoning_effort).toBe(CLOUD_ROLE_REASONING_EFFORT)
    expect(sent.messages).toEqual([
      { role: "system", content: "You are the Explainer." },
      { role: "user", content: "Why did the build fail?" }
    ])
  })

  test("without a binding the same turn goes to the chat upstream, exactly as before seats existed", async () => {
    const calls: Array<Request> = []
    const { model: _unbound, ...body } = explainBody()
    const response = await Effect.runPromise(
      handleTurn(post(body), SESSION).pipe(
        Effect.provide(Layer.mergeAll(
          transportLayer(async (input, init) => {
            calls.push(new Request(input as string, init))
            return new Response(`${JSON.stringify({ type: "done", reason: "stop" })}\n`, {
              status: 200,
              headers: { "content-type": "application/x-ndjson" }
            })
          }),
          testConfigLayer({ chatUrl: CHAT_URL, upstreamTimeoutMs: 5_000, ...SIGNED_IN_DEPLOYMENT }),
          turnCancelsLayer(memoryCancels()),
          recommendLogLayer(undefined),
          Layer.succeed(ExecutionContext, executionContextFrom(undefined))
        ))
      )
    )
    await response.text()
    expect(calls.map((request) => request.url)).toEqual([CHAT_URL])
    const sent = (await calls[0]!.json()) as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual(["instructions", "messages", "purpose", "role"])
  })

  test("with tools is tools_not_supported: it is never handed to the upstream that could run them", async () => {
    const tools = [{ type: "function", name: "commands", description: "Run a command", parameters: {} }]
    const refused = await refusalOf(await serve(explainBody({ tools })))
    expect([refused.status, refused.code]).toEqual([400, "tools_not_supported"])
  })

  test("continuing a tool call is tools_not_supported", async () => {
    const refused = await refusalOf(await serve(explainBody({
      messages: [
        { role: "user", content: "run it" },
        { type: "function_call", call_id: "c1", name: "commands", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "done" }
      ]
    })))
    expect([refused.status, refused.code]).toEqual([400, "tools_not_supported"])
  })

  test("signed out is sign_in_required: a bound turn spends a deployment key", async () => {
    const refused = await refusalOf(await serve(explainBody(), { session: undefined }))
    expect([refused.status, refused.code]).toEqual([401, "sign_in_required"])
  })

  test("on a deployment without the key is seam_not_configured, naming the key", async () => {
    const refused = await refusalOf(await serve(explainBody(), { config: { cerebrasApiKey: undefined } }))
    expect([refused.status, refused.code]).toEqual([503, "seam_not_configured"])
    expect(refused.message).toContain("CEREBRAS_API_KEY")
  })

  test("the key goes only where its name is pinned: every other binding is request_invalid and nothing is fetched", async () => {
    for (const model of [
      // The exfiltration shape: a deployment key's name beside somebody else's address.
      { ...CEREBRAS_BINDING, baseUrl: "https://attacker.test" },
      { ...CEREBRAS_BINDING, baseUrl: "http://api.cerebras.ai" },
      // Pinned, but not the address this Worker's client posts to.
      { ...CEREBRAS_BINDING, baseUrl: "https://api.cerebras.ai/elsewhere" },
      { ...CEREBRAS_BINDING, path: "/v1/completions" },
      // A name this host does not hold, a decision model, and protocols this host does not speak.
      { ...CEREBRAS_BINDING, credential: "GITHUB_TOKEN" },
      { protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY" },
      { protocol: "openai-chat", baseUrl: "https://ai-gateway.vercel.sh", modelId: "openai/gpt-x", credential: "AI_GATEWAY_API_KEY" }
    ]) {
      const served = await serve(explainBody({ model }))
      const refused = await refusalOf(served)
      expect([model, refused.status, refused.code]).toEqual([model, 400, "request_invalid"])
      expect(served.calls).toEqual([])
    }
  })

  test("a binding that is not one is request_invalid at the body, and an extra key cannot ride it", async () => {
    for (const model of [null, "qwen-3-coder-480b", { ...CEREBRAS_BINDING, apiKey: "csk-smuggled" }]) {
      const served = await serve(explainBody({ model }))
      const refused = await refusalOf(served)
      expect([refused.status, refused.code]).toEqual([400, "request_invalid"])
      expect(refused.message).not.toContain("csk-smuggled")
      expect(served.calls).toEqual([])
    }
  })

  test("a provider that fails is a typed refusal, never an answer from somewhere else", async () => {
    const cases: ReadonlyArray<readonly [Response, number, string]> = [
      [new Response("slow down", { status: 429 }), 429, "model_rate_limited"],
      [new Response(`no such model ${SECRET}`, { status: 404 }), 502, "upstream_refused"],
      [Response.json({ choices: [] }), 502, "model_no_answer"],
      // Smithers Cloud refused the login's metered call: its credit is spent.
      [Response.json({ code: "out_of_credit", message: "out of credit", details: { balance_cents: 0, required_cents: 1, upgrade: "/billing" } }, { status: 402 }), 402, "out_of_credit"]
    ]
    for (const [answer, status, code] of cases) {
      const served = await serve(explainBody(), { provider: () => answer })
      const refused = await refusalOf(served)
      expect([refused.status, refused.code]).toEqual([status, code])
      expect(served.calls.map((request) => request.url)).toEqual([METERED_CEREBRAS_URL])
    }
  })

  test("an unreachable provider is upstream_unreachable, and the failure's own text stays here", async () => {
    const refused = await refusalOf(await serve(explainBody(), {
      provider: () => {
        throw new Error(`connect failed for Bearer ${SECRET}`)
      }
    }))
    expect([refused.status, refused.code]).toEqual([502, "upstream_unreachable"])
  })

  test("a provider that misses the deadline is upstream_timeout, stating the deadline that was armed", async () => {
    const calls: Array<Request> = []
    const response = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(handleTurn(post(explainBody()), SESSION))
        yield* TestClock.adjust(CLOUD_ROLE_TIMEOUT_MS)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(Layer.mergeAll(layers(calls, () => new Promise<Response>(() => {}), {}), TestClock.layer())))
    )
    const refused = await refusalOf({ response, calls })
    expect([refused.status, refused.code]).toEqual([504, "upstream_timeout"])
    expect(refused.message).toContain(`${CLOUD_ROLE_TIMEOUT_MS}ms`)
  })

  test("an answer with no text ends the turn with an error, not an empty success", async () => {
    const served = await serve(explainBody(), { provider: () => completion("  ") })
    expect((await served.response.text()).trim().split("\n").map((line) => JSON.parse(line) as unknown)).toEqual([
      { runId: "explain-1", type: "done", reason: "stop", error: "The configured model answered with no text." }
    ])
  })
})

describe("the decision model a seat arms", () => {
  const config = testConfig({ aiGatewayApiKey: Redacted.make("vck-test-value") })
  const JEV = { protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY" } as const

  test("no binding is the deployment's default, and an allowed binding is its own id", () => {
    expect(planDecisionModel(undefined, config)).toEqual({ ok: true, modelId: "typesafe-ai/jev" })
    expect(planDecisionModel(JEV, config)).toEqual({ ok: true, modelId: "typesafe-ai/jev" })
  })

  test("an id off the allowlist is model_not_allowed, judged before the key's presence", () => {
    expect(planDecisionModel({ ...JEV, modelId: "openai/gpt-x" }, testConfig())).toEqual({
      ok: false,
      failure: { code: "model_not_allowed" }
    })
  })

  test("an allowed binding without the key is credential_missing, naming the credential", () => {
    expect(planDecisionModel(JEV, testConfig())).toEqual({
      ok: false,
      failure: { code: "credential_missing", credential: "AI_GATEWAY_API_KEY" }
    })
  })
})
