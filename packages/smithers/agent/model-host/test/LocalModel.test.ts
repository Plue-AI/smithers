import * as Evaluator from "@smthrs/model/Evaluator"
import { ModelError } from "@smthrs/model/ModelError"
import type { ModelCredentialListing } from "@smthrs/rpc/ConfiguredModel"
import { Effect, Redacted } from "effect"
import { HttpClient } from "effect/unstable/http/HttpClient"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  localModelCatalog,
  localModelCredential,
  manualRedirects,
  type ModelCredentials,
  modelFailureOf,
  planOnLocal
} from "../src/LocalModel.ts"

type Fetch = typeof globalThis.fetch
const fetchOf = (impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): Fetch =>
  Object.assign(impl, { preconnect() {} })

const ORIGIN = "http://127.0.0.1:9"
const binding = { protocol: "openai-chat", baseUrl: ORIGIN, modelId: "lab", credential: "LAB" } as const
const env = { SMITHERS_MODEL_KEY_LAB: " lab-key ", SMITHERS_MODEL_KEY_LAB_ORIGIN: ORIGIN }

const stored = (value: string | undefined): ModelCredentials => {
  const rows: ReadonlyArray<ModelCredentialListing> = [{ name: "LAB", origins: [ORIGIN], present: true, managed: true }]
  return {
    refresh: async () => {},
    list: () => rows,
    read: (name) => name === "LAB" && value !== undefined ? Redacted.make(value) : undefined
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("local credentials", () => {
  test("reads a named value, trimmed and redacted, and nothing when unset or blank", () => {
    expect(Redacted.value(localModelCredential(env, "LAB")!)).toBe("lab-key")
    expect(localModelCredential({}, "LAB")).toBeUndefined()
    expect(localModelCredential({ SMITHERS_MODEL_KEY_LAB: "  " }, "LAB")).toBeUndefined()
  })
})

describe("planOnLocal", () => {
  test("plans against the environment and reads the planned secret", () => {
    const planned = planOnLocal(binding, env)
    if (!planned.ok) throw new Error(planned.failure.code)
    expect(planned.plan.credential).toBe("LAB")
    expect(Redacted.value(planned.apiKey)).toBe("lab-key")
  })

  test("refuses a binding the planner refuses", () => {
    expect(planOnLocal({ protocol: "nope" }, env).ok).toBe(false)
  })

  test("names the credential the plan needs when it holds no value", () => {
    expect(planOnLocal(binding, { SMITHERS_MODEL_KEY_LAB_ORIGIN: ORIGIN })).toEqual({
      ok: false,
      failure: { code: "credential_missing", credential: "LAB" }
    })
  })

  test("reads through stored credentials when the host has them", () => {
    const planned = planOnLocal(binding, {}, {}, stored("vault-key"))
    if (!planned.ok) throw new Error(planned.failure.code)
    expect(Redacted.value(planned.apiKey)).toBe("vault-key")
    expect(planOnLocal(binding, env, {}, stored(undefined))).toMatchObject({
      ok: false,
      failure: { code: "credential_missing" }
    })
  })
})

describe("localModelCatalog", () => {
  test("lists presence and origins, never a value, and no chat seat", () => {
    const catalog = localModelCatalog({ CEREBRAS_API_KEY: "c", AI_GATEWAY_API_KEY: "g" })
    expect(catalog.models.map((model) => model.id)).toEqual(["cerebras", "jev"])
    expect(JSON.stringify(catalog)).not.toMatch(/"c"|"g"/)
    expect(catalog.seats).not.toContain("chat")
    expect(catalog.credentials.find((row) => row.name === "CEREBRAS_API_KEY")?.present).toBe(true)
  })

  test("an offline host lists no remote row", () => {
    expect(localModelCatalog({ CEREBRAS_API_KEY: "c", AI_GATEWAY_API_KEY: "g" }, { egress: false }).models).toEqual([])
  })

  test("lists stored credentials when the host has them", () => {
    expect(localModelCatalog({}, {}, stored("v")).credentials).toEqual([{
      name: "LAB",
      origins: [ORIGIN],
      present: true,
      managed: true
    }])
  })
})

describe("manualRedirects", () => {
  const get = (layer: ReturnType<typeof manualRedirects>["layer"]) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* HttpClient
        return (yield* client.get("https://fixture.test/")).status
      }).pipe(Effect.provide(layer))
    )

  test("never follows a redirect and remembers the status", async () => {
    const seen: Array<RequestRedirect | undefined> = []
    const http = manualRedirects(fetchOf(async (_input, init) => {
      seen.push(init?.redirect)
      return new Response(null, { status: 302 })
    }))
    expect(http.redirected()).toBeUndefined()
    expect(await get(http.layer)).toBe(302)
    expect(seen).toEqual(["manual"])
    expect(http.redirected()).toBe(302)
  })

  test("defaults to the global fetch and records no answer outside 3xx", async () => {
    for (const status of [200, 404]) {
      vi.stubGlobal("fetch", async () => new Response(null, { status }))
      const http = manualRedirects()
      expect(await get(http.layer)).toBe(status)
      expect(http.redirected()).toBeUndefined()
    }
  })
})

describe("modelFailureOf", () => {
  const model = (code: ModelError["code"], httpStatus?: number) =>
    new ModelError({ code, message: "provider words", ...(httpStatus === undefined ? {} : { httpStatus }) })
  const evaluator = (code: Evaluator.EvaluatorError["code"], status?: number) =>
    new Evaluator.EvaluatorError({ code, message: "provider words", ...(status === undefined ? {} : { status }) })

  test.each(
    [
      [model("transport", 503), 10, { code: "refused", status: 503 }],
      [model("transport", 299), 10, { code: "unreachable" }],
      [model("transport", 600), 10, { code: "unreachable" }],
      [model("transport", 301.5), 10, { code: "unreachable" }],
      [model("call_timeout"), 10, { code: "timeout", deadlineMs: 10 }],
      [model("call_timeout"), undefined, { code: "unreachable" }],
      [model("invalid_provider_output"), 10, { code: "invalid", field: "protocol" }],
      // OpenAI Responses streams HTTP 200, then response.failed credit_balance_exhausted.
      [model("quota_exceeded"), 10, { code: "refused", status: 429 }],
      [model("rate_limited"), 10, { code: "refused", status: 429 }],
      [model("out_of_credit"), 10, { code: "refused", status: 402 }],
      [model("authentication"), 10, { code: "refused", status: 401 }],
      [model("quota_exceeded", 402), 10, { code: "refused", status: 402 }],
      [model("provider_internal"), 10, { code: "invalid", field: "protocol" }],
      [evaluator("unreachable", 500), 10, { code: "unreachable" }],
      [evaluator("timeout"), 10, { code: "timeout", deadlineMs: 10 }],
      [evaluator("timeout"), undefined, { code: "unreachable" }],
      [evaluator("refused", 401), 10, { code: "refused", status: 401 }],
      [evaluator("refused"), 10, { code: "invalid", field: "protocol" }],
      [new Error("words"), 10, { code: "unreachable" }]
    ] as const
  )("maps %o", (error, deadlineMs, failure) => {
    expect(modelFailureOf(error, deadlineMs)).toEqual(failure)
  })
})
