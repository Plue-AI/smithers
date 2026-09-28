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
