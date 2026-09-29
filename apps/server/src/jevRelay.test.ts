import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { testConfigLayer } from "./Config"
import type { ServerConfigShape } from "./Config"
import { memoryStorage } from "./DurableStorage"
import type { NativeNamespace } from "./DurableStorage"
import { transportLayer } from "./Http"
import {
  handleJev,
  JEV_OPTIONS_MAX,
  JEV_QUESTIONS_MAX,
  JEV_STATE_MAX_CHARS,
  JEV_TIMEOUT_MS
} from "./jevRelay"
import { RECOMMEND_ADDRESS_MAX, RECOMMEND_ALL_KEY, RECOMMEND_ALL_MAX } from "./recommend"
import { turnLimitsLayer, TurnRateLimiter } from "./turnLimit"

/*
 * POST /api/jev, the browser's one door to the decision model. These tests
 * hold it to its contract: the deployment's key is the only key, the request
 * and its answers pass through unchanged, the bounds refuse before anything
 * is spent, and a Jev that does not answer is a typed refusal — never an
 * invented answer and never another model. The transport double refuses every
 * host but the AI Gateway, so a route that reached anywhere else throws.
 */

const memoryLimits = (
  spent: ReadonlyArray<{ readonly key: string; readonly count: number }> = []
): NativeNamespace & { readonly keys: () => Array<string> } => {
  const buckets = new Map<string, TurnRateLimiter>()
  return {
    keys: () => [...buckets.keys()],
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let bucket = buckets.get(name)
      if (bucket === undefined) {
        const seeded = spent.find((entry) => entry.key === name)
        bucket = new TurnRateLimiter({
          storage: seeded === undefined
            ? memoryStorage()
            : memoryStorage({ window: { start: Date.now(), count: seeded.count } })
        })
        buckets.set(name, bucket)
      }
      const limiter = bucket
      return { fetch: (request) => limiter.fetch(request) }
    }
  }
}

const network = (jev?: (request: Request) => Promise<Response>) => {
  const calls: Array<Request> = []
  return {
    calls,
    layer: transportLayer(async (input, init) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input, init)
      // A login's Cloud token: its Jev call is metered through the Cloud model proxy (modelPayer.ts).
      if (request.url === "https://identity.test/api/identity/cloud-token") return Response.json({ found: true, token: "cloud-token-login" })
      calls.push(request)
      if (new URL(request.url).hostname !== "ai-gateway.vercel.sh" && request.url !== METERED_JEV_URL) {
        throw new Error(`the relay must never fetch ${request.url}`)
      }
      if (jev === undefined) throw new Error("Jev must not be asked")
      return jev(request)
    })
  }
}

const HEADERS = { "x-isolation": "1" }
const METERED_JEV_URL = "https://cloud.test/api/model/vercel/v4/ai/evaluation-model"
const JEV_KEY = {
  aiGatewayApiKey: Redacted.make("vck-test"),
  identityUpstreamUrl: "https://identity.test",
  identityServiceToken: Redacted.make("service-token"),
  cloudApiBaseUrl: "https://cloud.test"
}
const JEV_MODEL = "typesafe-ai/jev"

const post = (body: unknown, headers: Record<string, string> = {}): Request =>
  new Request("https://mvp.test/api/jev", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  })

interface Deps {
  readonly jev?: (request: Request) => Promise<Response>
  readonly config?: Partial<ServerConfigShape>
  readonly limits?: NativeNamespace
  readonly login?: string
}

const relay = (request: Request, deps: Deps = {}): Promise<{ readonly response: Response; readonly calls: Array<Request> }> => {
  const net = network(deps.jev)
  return Effect.runPromise(
    handleJev(request, deps.login, HEADERS).pipe(
      Effect.provide(Layer.mergeAll(net.layer, testConfigLayer({ ...JEV_KEY, ...deps.config }), turnLimitsLayer(deps.limits))),
      Effect.map((response) => ({ response, calls: net.calls }))
    )
  )
}

const goodBody = {
  state: { query: "how do I deploy", documents: [{ id: "a", title: "Deploy" }] },
  questions: {
    pick: { type: "choice", instructions: "Which document best answers the query?", criteria: { a: "Deploy — ship on Tuesdays" } },
    covered: { type: "boolean", instructions: "Does any of these documents answer the query?" }
  }
}

const answered = (answers: unknown): Response =>
  new Response(JSON.stringify({ answers }), { status: 200, headers: { "content-type": "application/json" } })

const refusalBody = (response: Response) => response.json() as Promise<{ status: string; code: string; message: string }>

describe("POST /api/jev relays one evaluation", () => {
  test("the state and questions reach the gateway unchanged and the typed answers come back with the model", async () => {
    const { response, calls } = await relay(post(goodBody), {
      jev: async () =>
        answered({
          pick: { type: "choice", choice: "a", probabilities: { a: 0.8 } },
          covered: { type: "boolean", probability: 0.9 }
        })
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("x-isolation")).toBe("1")
    const body = (await response.json()) as { answers: Record<string, unknown>; model: string }
    expect(body.answers).toEqual({
      pick: { type: "choice", choice: "a", probabilities: { a: 0.8 } },
      covered: { type: "boolean", probability: 0.9 }
    })
    expect(body.model).toBe(JEV_MODEL)

    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model")
    // The browser never holds the key: the deployment's rides on the relayed call.
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer vck-test")
    expect(calls[0]!.headers.get("ai-model-id")).toBe(JEV_MODEL)
    const sent = (await calls[0]!.json()) as {
      model?: unknown
      state: unknown
      questions: unknown
      providerOptions: { gateway: { zeroDataRetention: boolean } }
    }
    expect(sent.model).toBeUndefined()
    expect(sent.state).toEqual(goodBody.state)
    expect(sent.questions).toEqual(goodBody.questions)
    expect(sent.providerOptions.gateway.zeroDataRetention).toBe(true)
  })

  test("an unset AI_GATEWAY_API_KEY is seam_not_configured without naming the variable, and nothing is asked", async () => {
    const { response, calls } = await relay(post(goodBody), { config: { aiGatewayApiKey: undefined } })
    expect(response.status).toBe(503)
    const body = await refusalBody(response)
    expect(body.code).toBe("seam_not_configured")
    expect(body.message).toBe("Decisions aren't available on this deployment.")
    expect(calls.length).toBe(0)
  })

  test("a gateway that refuses is service_temporarily_unavailable in plain words, never an invented answer", async () => {
    const { response } = await relay(post(goodBody), { jev: async () => new Response("no", { status: 502 }) })
    expect(response.status).toBe(503)
    const body = await refusalBody(response)
    expect(body.code).toBe("service_temporarily_unavailable")
    expect(body.message).toBe("Smithers' decision model refused that just now. Try again in a moment.")

    const unreadable = await relay(post(goodBody), { jev: async () => answered("not a map") })
    expect(unreadable.response.status).toBe(503)
    expect((await refusalBody(unreadable.response)).message).toBe("Smithers' decision model sent no decision. Try again.")

    const dead = await relay(post(goodBody), {
      jev: async () => {
        throw new Error("connection reset")
      }
    })
    expect(dead.response.status).toBe(503)
    expect((await refusalBody(dead.response)).message).toBe("Smithers' decision model can't be reached right now. Try again in a moment.")
  })

  test("a redirect is a refusal: the deployment's key never follows a Location to another host", async () => {
    const { response, calls } = await relay(post(goodBody), {
      jev: async () => new Response(null, { status: 302, headers: { location: "https://attacker.test/collect" } })
    })
    expect(calls.map((call) => [new URL(call.url).hostname, call.redirect])).toEqual([["ai-gateway.vercel.sh", "manual"]])
    expect(response.status).toBe(503)
    expect((await refusalBody(response)).message).toBe("Smithers' decision model refused that just now. Try again in a moment.")
  })

  test("the deadline is the recommender's", () => {
    expect(JEV_TIMEOUT_MS).toBe(1500)
  })
})

describe("the relay's bounds refuse before Jev is asked", () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly body: unknown; readonly status: number; readonly code: string }> = [
    { name: "a body that is not an object", body: [1, 2], status: 400, code: "request_invalid" },
    { name: "a body that is not JSON", body: "{ nope", status: 400, code: "request_body_not_json" },
    { name: "no state", body: { questions: goodBody.questions }, status: 400, code: "request_invalid" },
    { name: "no questions", body: { state: {} }, status: 400, code: "request_invalid" },
    { name: "an empty question map", body: { state: {}, questions: {} }, status: 400, code: "request_invalid" },
    {
      name: "a question of an unknown type",
      body: { state: {}, questions: { q: { type: "essay", instructions: "Write." } } },
      status: 400,
      code: "request_invalid"
    },
    {
      name: "a choice with no options",
      body: { state: {}, questions: { q: { type: "choice", instructions: "Pick.", criteria: {} } } },
      status: 400,
      code: "request_invalid"
    },
    {
      name: "a score rubric of one level",
      body: { state: {}, questions: { q: { type: "score", instructions: "Rate.", criteria: ["only"] } } },
      status: 400,
      code: "request_invalid"
    },
    {
      name: "more questions than one evaluation may ask",
      body: {
        state: {},
        questions: Object.fromEntries(
          Array.from({ length: JEV_QUESTIONS_MAX + 1 }, (_, index) => [`q${index}`, { type: "boolean", instructions: "Yes?" }])
        )
      },
      status: 413,
      code: "request_body_too_large"
    },
    {
      name: "more options than one choice may offer",
      body: {
        state: {},
        questions: {
          q: {
            type: "choice",
            instructions: "Pick.",
            criteria: Object.fromEntries(Array.from({ length: JEV_OPTIONS_MAX + 1 }, (_, index) => [`o${index}`, "an option"]))
          }
        }
      },
      status: 413,
      code: "request_body_too_large"
    },
    {
      name: "a state past the read cap",
      body: { state: { text: "x".repeat(JEV_STATE_MAX_CHARS + 1) }, questions: { q: { type: "boolean", instructions: "Yes?" } } },
      status: 413,
      code: "request_body_too_large"
    }
  ]

  for (const example of cases) {
    test(`${example.name} is ${example.status} ${example.code}`, async () => {
      const limits = memoryLimits()
      const { response, calls } = await relay(post(example.body), { limits })
      expect(response.status).toBe(example.status)
      expect((await refusalBody(response)).code).toBe(example.code)
      expect(calls.length).toBe(0)
      // A refused body costs the caller nothing.
      expect(limits.keys()).toEqual([])
    })
  }

  test("exactly the caps are allowed through", async () => {
    const { response, calls } = await relay(
      post({
        state: { text: "x".repeat(JEV_STATE_MAX_CHARS - 12) },
        questions: {
          q: {
            type: "choice",
            instructions: "Pick.",
            criteria: Object.fromEntries(Array.from({ length: JEV_OPTIONS_MAX }, (_, index) => [`o${index}`, null]))
          }
        }
      }),
      { jev: async () => answered({ q: { type: "choice", choice: "o0" } }) }
    )
    expect(response.status).toBe(200)
    expect(calls.length).toBe(1)
  })
})

describe("the relay spends the recommender's ceilings", () => {
  const jev = async () => answered({ pick: { type: "choice", choice: "a" }, covered: { type: "boolean", probability: 0.9 } })

  test("a visitor spends the address bucket and the deployment bucket, and a spent bucket is a 429 before Jev", async () => {
    const limits = memoryLimits()
    expect((await relay(post(goodBody), { jev, limits })).response.status).toBe(200)
    const keys = limits.keys()
    expect(keys).toContain(RECOMMEND_ALL_KEY)
    const address = keys.find((key) => key.startsWith("recommend:anonymous:"))
    expect(address).toBeDefined()
    expect(address).not.toContain("203.0.113.7")

    const spentAddress = memoryLimits([{ key: address!, count: RECOMMEND_ADDRESS_MAX }])
    const refused = await relay(post(goodBody), { limits: spentAddress })
    expect(refused.response.status).toBe(429)
    expect(refused.calls.length).toBe(0)
    expect((await refusalBody(refused.response)).code).toBe("turn_rate_limited")
    expect(refused.response.headers.get("retry-after")).not.toBeNull()
    // The address refusal never draws down everyone's bucket.
    expect(spentAddress.keys()).not.toContain(RECOMMEND_ALL_KEY)

    const spentAll = memoryLimits([{ key: RECOMMEND_ALL_KEY, count: RECOMMEND_ALL_MAX }])
    const everyone = await relay(post(goodBody), { limits: spentAll })
    expect(everyone.response.status).toBe(429)
    expect(everyone.calls.length).toBe(0)
  })

  test("a login spends its own bucket, the same one the recommender spends", async () => {
    const limits = memoryLimits()
    const { response, calls } = await relay(post(goodBody), { jev, limits, login: "octocat" })
    expect(response.status).toBe(200)
    expect(limits.keys()).toContain("recommend:login:octocat")
    // The login's evaluation is metered through the Cloud model proxy on its own token, never the platform key.
    expect(calls.map((call) => call.url)).toEqual([METERED_JEV_URL])
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer cloud-token-login")
  })

  test("a login out of credit is the out_of_credit refusal", async () => {
    const spent = async () => Response.json({ code: "out_of_credit", message: "out of credit", details: { balance_cents: 0, required_cents: 1, upgrade: "/billing" } }, { status: 402 })
    const { response } = await relay(post(goodBody), { jev: spent, limits: memoryLimits(), login: "octocat" })
    expect(response.status).toBe(402)
    expect(((await response.json()) as { code: string }).code).toBe("out_of_credit")
  })
})
