import { ModelError } from "@smthrs/model/ModelError"
import { Effect } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import * as ConfiguredModelRoute from "../src/ConfiguredModelRoute.ts"
import type { DurableChatGrant } from "../src/DurableChatProducer.ts"
import { environmentModelResolver } from "../src/EnvironmentResolver.ts"
import { runModelTurn } from "../src/ModelTurnHost.ts"

const binding = {
  protocol: "openai-chat",
  baseUrl: "https://fixture.test",
  modelId: "fixture",
  credential: "FIXTURE"
} as const
const env = { SMITHERS_MODEL_KEY_FIXTURE: " fixture-key ", SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: "https://fixture.test" }
const grant: DurableChatGrant = {
  turnId: "turn",
  ownerId: 1,
  runId: "run",
  legId: "leg",
  generation: 1,
  token: "fixture-token",
  cursor: { version: 1, runId: "run", legId: "leg", batch: 0, position: 0, hash: "a".repeat(64) },
  expiresAt: "2100-01-01",
  producerBaseUrl: "https://callback.test",
  request: { runId: "run", instructions: "answer", messages: [{ role: "user", content: "hi" }] }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const contextInput = {
  prompt: "Where do we retry?",
  author: "ben",
  branch: "main",
  state: "ready",
  recent: [{ title: "Earlier", text: "Earlier answer" }],
  candidates: [{
    item: { kind: "file", label: "retry.ts", ref: "src/webhooks/retry.ts", revision: "abc123" },
    text: "export const retries = 3"
  }],
  tokenBudget: 24000,
  wikiOnly: false
}
const sharedGrant = { ...grant, request: { ...grant.request, sharedConversation: true } }

test.each([false, true])("resolves shared context from the authenticated host callback (%s)", async (global) => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(contextInput))
  vi.stubGlobal("fetch", fetchImpl)
  const resolved = await Effect.runPromise(
    environmentModelResolver({ binding, env, ...(global ? {} : { fetchImpl }) })(sharedGrant)
  )
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  const [url, init] = fetchImpl.mock.calls[0]!
  expect(String(url)).toBe("https://callback.test/internal/chat/context")
  expect(init).toMatchObject({
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", authorization: "Bearer fixture-token" },
    body: "{\"turnId\":\"turn\",\"generation\":1}"
  })
  expect(init?.signal).toBeInstanceOf(AbortSignal)
  expect(resolved.preflight?.input).toEqual(contextInput)
  expect(resolved.preflight?.model).toBe(resolved.model)
  expect(resolved.preflight?.options).toEqual({ modelId: "fixture", credential: "fixture-key" })
})

test.each([
  () => new Response("private failure", { status: 503 }),
  () => new Response(null, { status: 403 }),
  () => new Response(null, { status: 307, headers: { location: "https://attacker.test" } }),
  () => Response.json({ ...contextInput, candidates: [{ item: { kind: "file", ref: "outside" }, text: "secret" }] }),
  () => Response.json({ ...contextInput, recent: [{ title: "private", text: "secret", private: true }] }),
  () => Response.json({ ...contextInput, tokenBudget: -1 }),
  () => new Response("not json"),
  () => new Response(null),
  () => new Response(" ".repeat(2 * 1024 * 1024 + 1)),
  () => new Response("{}", { headers: { "content-length": "2097153" } })
])("refuses unavailable, malformed or oversized context before invoking a model", async (response) => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response())
  await expect(Effect.runPromise(environmentModelResolver({ binding, env, fetchImpl })(sharedGrant))).rejects.toThrow(
    "configured model route is unavailable"
  )
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://callback.test/internal/chat/context")
})

test("interrupting context resolution aborts its outstanding read", async () => {
  let observed: AbortSignal | undefined
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) =>
    new Promise((_resolve, reject) => {
      observed = init?.signal as AbortSignal
      observed.addEventListener("abort", () => reject(new Error("interrupted")))
      entered()
    })
  )
  const abort = new AbortController()
  const result = Effect.runPromiseExit(environmentModelResolver({ binding, env, fetchImpl })(sharedGrant), {
    signal: abort.signal
  })
  await started
  abort.abort()
  expect((await result)._tag).toBe("Failure")
  expect(observed?.aborted).toBe(true)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test.each([false, true])(
  "routes the chosen model using the configured fetch and token budget (%s)",
  async (override) => {
    const fetchImpl = vi.fn<typeof fetch>(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://fixture.test/v1/chat/completions")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key")
      expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))).toMatchObject({
        model: override ? "override" : "fixture"
      })
      return new Response(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } }
      )
    }, { preconnect() {} }))
    vi.stubGlobal("fetch", fetchImpl)
    const chosenGrant = override
      ? { ...grant, request: { ...grant.request, model: { ...binding, modelId: "override" } } }
      : grant
    const resolved = await Effect.runPromise(
      environmentModelResolver({
        binding,
        env,
        ...(override ? { fetchImpl, maxTokens: 123 } : {})
      })(chosenGrant)
    )
    expect(resolved.options).toEqual({
      modelId: override ? "override" : "fixture",
      credential: "fixture-key",
      ...(override ? { maxTokens: 123 } : {})
    })
    const frames: unknown[] = []
    await Effect.runPromise(
      runModelTurn(resolved.model, chosenGrant.request, resolved.options, (frame) =>
        Effect.sync(() => {
          frames.push(frame)
        }))
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(frames).toContainEqual({ runId: "run", type: "delta", kind: "text", text: "hello" })
    expect(frames.at(-1)).toEqual({ runId: "run", type: "done", reason: "stop" })
  }
)

test("refuses unavailable and foreign-origin models before invoking transport", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
  for (
    const options of [{ binding: {}, env }, { binding, env: {} }, {
      binding: { ...binding, baseUrl: "https://other.test" },
      env
    }]
  ) {
    await expect(Effect.runPromise(environmentModelResolver({ ...options, fetchImpl })(grant))).rejects.toThrow(
      "configured model is unavailable"
    )
  }
  expect(fetchImpl).not.toHaveBeenCalled()
})

test.each([undefined, " "])("refuses a credential removed between planning and retrieval (%s)", async (removed) => {
  let reads = 0
  const changingEnv = {
    ...env,
    get SMITHERS_MODEL_KEY_FIXTURE() {
      return ++reads === 1 ? "fixture-key" : removed
    }
  }
  await expect(Effect.runPromise(environmentModelResolver({ binding, env: changingEnv })(grant))).rejects.toThrow(
    "credential is unavailable"
  )
})

test("replaces a route failure with a credential-safe diagnostic", async () => {
  vi.spyOn(ConfiguredModelRoute, "toModel").mockReturnValueOnce(
    Effect.fail(new ModelError({ code: "no_route", message: "private route diagnostic" }))
  )
  await expect(Effect.runPromise(environmentModelResolver({ binding, env })(grant))).rejects.toThrow(
    /^configured model route is unavailable$/
  )
})

test("refuses a provider redirect instead of following it with the key header", async () => {
  const completion =
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"stolen\"},\"finish_reason\":null}]}\n\n" +
    "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
  const redirectModes: Array<RequestRedirect | undefined> = []
  const attackerHeaders: Array<Headers> = []
  const attacker = "https://attacker.test/v1/chat/completions"
  // Behaves like real fetch: without redirect: "manual" it follows the
  // Location and resends the request headers to the redirect target.
  const provider = (url: string, headers: Headers): Response => {
    if (url === attacker) {
      attackerHeaders.push(headers)
      return new Response(completion, { headers: { "content-type": "text/event-stream" } })
    }
    return new Response(null, { status: 307, headers: { location: attacker } })
  }
  const fetchImpl = vi.fn<typeof fetch>(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    redirectModes.push(init?.redirect)
    const headers = new Headers(init?.headers)
    const first = provider(String(input), headers)
    if (init?.redirect === "manual" || first.status < 300 || first.status >= 400) return first
    return provider(first.headers.get("location")!, headers)
  }, { preconnect() {} }))
  const resolved = await Effect.runPromise(environmentModelResolver({ binding, env, fetchImpl })(grant))
  const frames: unknown[] = []
  const outcome = await Effect.runPromise(Effect.exit(
    runModelTurn(resolved.model, grant.request, resolved.options, (frame) =>
      Effect.sync(() => {
        frames.push(frame)
      }))
  ))
  expect(outcome._tag).toBe("Failure")
  expect(redirectModes.length).toBeGreaterThan(0)
  expect(redirectModes.every((mode) => mode === "manual")).toBe(true)
  expect(attackerHeaders).toEqual([])
  for (const [input] of fetchImpl.mock.calls) expect(String(input)).toBe("https://fixture.test/v1/chat/completions")
  expect(frames).not.toContainEqual(expect.objectContaining({ kind: "text", text: "stolen" }))
})

test("refuses a request model on another credential or origin than the configured one", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
  const twoKeys = {
    ...env,
    SMITHERS_MODEL_KEY_OTHER: "other-key",
    SMITHERS_MODEL_KEY_OTHER_ORIGIN: "https://other.test"
  }
  for (
    const model of [
      { ...binding, baseUrl: "https://other.test", credential: "OTHER" },
      { ...binding, credential: "OTHER" }
    ]
  ) {
    const chosen = { ...grant, request: { ...grant.request, model } } as DurableChatGrant
    await expect(Effect.runPromise(environmentModelResolver({ binding, env: twoKeys, fetchImpl })(chosen))).rejects
      .toThrow("configured model is unavailable")
  }
  const nullModel = { ...grant, request: { ...grant.request, model: null } } as unknown as DurableChatGrant
  const resolved = await Effect.runPromise(environmentModelResolver({ binding, env: twoKeys, fetchImpl })(nullModel))
  expect(resolved.options.modelId).toBe("fixture")
  expect(fetchImpl).not.toHaveBeenCalled()
})

test.each(["declared", "streamed"])("cancels oversized context bodies (%s)", async (mode) => {
  const cancelled = vi.fn()
  const response = new Response(
    new ReadableStream({
      start(controller) {
        if (mode === "streamed") controller.enqueue(new Uint8Array(2097153))
      },
      cancel: cancelled
    }),
    mode === "declared" ? { headers: { "content-length": "2097153" } } : {}
  )
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
  await expect(Effect.runPromise(environmentModelResolver({ binding, env, fetchImpl })(sharedGrant))).rejects.toThrow()
  expect(cancelled).toHaveBeenCalledTimes(1)
})

const fastBinding = { ...binding, baseUrl: "https://fast.test", modelId: "owner-fast", credential: "FAST" }
const fastEnv = { ...env, SMITHERS_MODEL_KEY_FAST: "fast-key", SMITHERS_MODEL_KEY_FAST_ORIGIN: "https://fast.test" }

test("the owner fast role uses its own credential and origin independently of the answer model", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url) === "https://callback.test/internal/chat/context") return Response.json(contextInput)
    expect(String(url)).toBe("https://fast.test/v1/chat/completions")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fast-key")
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toContain("\"model\":\"owner-fast\"")
    return new Response(
      "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"fast answer\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
    )
  })
  const resolved = await Effect.runPromise(
    environmentModelResolver({ binding, preflightBinding: fastBinding, env: fastEnv, fetchImpl })(sharedGrant)
  )
  expect(resolved.options).toEqual({ modelId: "fixture", credential: "fixture-key" })
  expect(resolved.preflight?.options).toEqual({ modelId: "owner-fast", credential: "fast-key" })
  expect(resolved.preflight?.input).toEqual(contextInput)
  const frames: unknown[] = []
  await Effect.runPromise(
    runModelTurn(resolved.preflight!.model, grant.request, resolved.preflight!.options, (frame) =>
      Effect.sync(() => {
        frames.push(frame)
      }))
  )
  expect(frames).toContainEqual({ runId: "run", type: "delta", kind: "text", text: "fast answer" })
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})

test.each([{}, null, { ...fastBinding, baseUrl: "https://attacker.test" }, {
  ...fastBinding,
  credential: "UNENROLLED"
}])(
  "an invalid owner fast role refuses without falling back to an answer call",
  async (preflightBinding) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(contextInput))
    await expect(
      Effect.runPromise(environmentModelResolver({ binding, preflightBinding, env: fastEnv, fetchImpl })(sharedGrant))
    ).rejects.toThrow("configured model route is unavailable")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  }
)

test.each([undefined, " "])("fast credentials removed during resolution refuse (%s)", async (removed) => {
  let reads = 0
  const changingEnv = {
    ...fastEnv,
    get SMITHERS_MODEL_KEY_FAST() {
      return ++reads === 1 ? "fast-key" : removed
    }
  }
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(contextInput))
  await expect(
    Effect.runPromise(
      environmentModelResolver({ binding, preflightBinding: fastBinding, env: changingEnv, fetchImpl })(sharedGrant)
    )
  ).rejects.toThrow("configured model route is unavailable")
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})
