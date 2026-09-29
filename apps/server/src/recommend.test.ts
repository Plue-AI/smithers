import { describe, expect, spyOn, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { TestClock } from "effect/testing"
import { testConfigLayer } from "./Config"
import type { ServerConfigShape } from "./Config"
import { memoryStorage } from "./DurableStorage"
import type { NativeNamespace } from "./DurableStorage"
import { transportLayer } from "./Http"
import {
  CEREBRAS_CHAT_COMPLETIONS_URL,
  cerebrasChat,
  filterAnswer,
  handleRecommend,
  handleRecommendOutcome,
  memoryRecommendStorage,
  rankJevAnswers,
  readRecommendLog,
  RECOMMEND_ADDRESS_MAX,
  RECOMMEND_ALL_KEY,
  RECOMMEND_ALL_MAX,
  RECOMMEND_ANSWER_MAX,
  RECOMMEND_COMMAND_NAME_MAX_CHARS,
  RECOMMEND_COMMAND_SUMMARY_MAX_CHARS,
  RECOMMEND_COMMANDS_MAX,
  RECOMMEND_JEV_COMMANDS_MAX,
  RECOMMEND_JEV_TIMEOUT_MS,
  RECOMMEND_LOG_LIMIT,
  RECOMMEND_LOG_NAME,
  RECOMMEND_OUTCOME_BODY_MAX_BYTES,
  RECOMMEND_TAIL_MAX_CHARS,
  RECOMMEND_TAIL_MAX_ENTRIES,
  RecommendLog,
  recommendLogLayer,
  recommendQuestionKey,
  recommendQuestions
} from "./recommend"
import type { RecommendLogRow } from "./recommend"
import { turnLimitsLayer, TurnRateLimiter } from "./turnLimit"

/*
 * The command recommender. These tests hold the route to its contract: an
 * ordered, filtered answer from Jev and from nobody else; honest refusals
 * (400, 413, 429, 503) with never an invented list and never a second model;
 * one outcome per recommendation; and a log the scorer can read newest first.
 *
 * The rule the whole file is built on: when Jev fails, the route FAILS. The
 * transport double below refuses every host but the AI Gateway, so a test
 * that even reaches for Cerebras throws rather than quietly passing.
 */

const memoryLog = (): NativeNamespace & { readonly names: () => Array<string> } => {
  const logs = new Map<string, RecommendLog>()
  return {
    names: () => [...logs.keys()],
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let log = logs.get(name)
      if (log === undefined) {
        log = new RecommendLog({ storage: memoryRecommendStorage() })
        logs.set(name, log)
      }
      return { fetch: (request) => log.fetch(request) }
    }
  }
}

/** In-memory buckets; `spent` names buckets seeded at `count` so a test reaches the refusal directly. */
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

const COMMANDS = [
  { name: "repo.open", summary: "Open a repository" },
  { name: "run.start", summary: "Start a workflow run" },
  { name: "keys.list", summary: "List the secrets" },
  { name: "help", summary: "Show every command" }
]

const goodBody = {
  repo: "smithersai/smithers",
  tail: [
    { role: "user", text: "How do I run the tests here?" },
    { role: "assistant", text: "The repo runs bun test from apps/server." }
  ],
  commands: COMMANDS
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`https://mvp.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  })

const HEADERS = { "x-isolation": "1" }

/** A gateway evaluation whose `command1` answer carries `probabilities`. */
const decision = (probabilities: Record<string, number>): Response => {
  const best = Object.entries(probabilities).sort(([, left], [, right]) => right - left)[0]?.[0] ?? ""
  return new Response(
    JSON.stringify({
      answers: { command1: { type: "choice", choice: best, probabilities } },
      usage: { inputTokens: 420, outputTokens: 21 },
      providerMetadata: { typesafe: { confidence: 0.82 } }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )
}

/** A gateway evaluation whose one choice answer names the option and nothing else. */
const chosen = (choice: string): Response =>
  new Response(JSON.stringify({ answers: { command1: { type: "choice", choice } } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })

/**
 * Stand in for the network. Only the AI Gateway may be reached: any other
 * host — the Cerebras completions URL above all — throws, so "the recommender
 * never falls back to an LLM" is enforced by the double rather than asserted
 * once.
 */
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
        throw new Error(`the recommender must never fetch ${request.url}`)
      }
      if (jev === undefined) throw new Error("Jev must not be asked")
      return jev(request)
    })
  }
}

interface Deps {
  readonly jev?: (request: Request) => Promise<Response>
  readonly config?: Partial<ServerConfigShape>
  readonly limits?: NativeNamespace
  readonly logs?: NativeNamespace
  readonly login?: string
}

const METERED_JEV_URL = "https://cloud.test/api/model/vercel/v4/ai/evaluation-model"
const JEV_KEY = {
  aiGatewayApiKey: Redacted.make("vck-test"),
  identityUpstreamUrl: "https://identity.test",
  identityServiceToken: Redacted.make("service-token"),
  cloudApiBaseUrl: "https://cloud.test"
}
const JEV_MODEL = "typesafe-ai/jev"

/** The route with its dependencies injected: the gateway key is set unless `config` says otherwise. */
const recommend = (request: Request, deps: Deps = {}): Promise<{ readonly response: Response; readonly calls: Array<Request> }> => {
  const net = network(deps.jev)
  return Effect.runPromise(
    handleRecommend(request, deps.login, HEADERS).pipe(
      Effect.provide(Layer.mergeAll(
        net.layer,
        testConfigLayer({ ...JEV_KEY, ...deps.config }),
        turnLimitsLayer(deps.limits),
        recommendLogLayer(deps.logs)
      )),
      Effect.map((response) => ({ response, calls: net.calls }))
    )
  )
}

const ranks = async (jev: (request: Request) => Promise<Response>, body: unknown = goodBody) => {
  const { response, calls } = await recommend(post("/api/recommend", body), { jev })
  return { response, calls, body: (await response.json()) as { id: string; commands: Array<string>; model: string } }
}

const outcome = (request: Request, logs?: NativeNamespace): Promise<Response> =>
  Effect.runPromise(handleRecommendOutcome(request, HEADERS).pipe(Effect.provide(recommendLogLayer(logs))))

const readRows = (logs: NativeNamespace | undefined, limit?: number): Promise<ReadonlyArray<RecommendLogRow>> =>
  Effect.runPromise(readRecommendLog(limit).pipe(Effect.provide(recommendLogLayer(logs))))

describe("POST /api/recommend asks Jev, and only Jev", () => {
  test("Jev ranks the offered commands, zero-probability names dropped, hallucinations dropped, and the log names Jev's model", async () => {
    const logs = memoryLog()
    const { response, calls } = await recommend(post("/api/recommend", goodBody), {
      jev: async () =>
        new Response(
          JSON.stringify({
            answers: {
              command1: {
                type: "choice",
                choice: "run.start",
                probabilities: { "run.start": 0.71, "help": 0.17, "repo.open": 0.12, "keys.list": 0, "made.up": 0.9 }
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
      logs
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("x-isolation")).toBe("1")
    const body = (await response.json()) as { id: string; commands: Array<string>; model: string }
    // `made.up` outranked everything and is still dropped: a name the request
    // never offered is never shown.
    expect(body.commands).toEqual(["run.start", "help", "repo.open"])
    expect(body.commands.length).toBeLessThanOrEqual(RECOMMEND_ANSWER_MAX)
    expect(body.model).toBe(JEV_MODEL)
    expect(body.id).not.toBe("")

    // One call, to the gateway's evaluation endpoint, carrying the key, the
    // protocol headers, the state, and one choice question whose options are
    // exactly the offered commands.
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model")
    const headers = calls[0]!.headers
    expect(headers.get("authorization")).toBe("Bearer vck-test")
    expect(headers.get("ai-gateway-protocol-version")).toBe("0.0.1")
    expect(headers.get("ai-gateway-auth-method")).toBe("api-key")
    expect(headers.get("ai-evaluation-model-specification-version")).toBe("4")
    expect(headers.get("ai-model-id")).toBe(JEV_MODEL)
    const sent = (await calls[0]!.json()) as {
      model?: unknown
      state: { repository: string; conversation: string }
      questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }>
      providerOptions: { gateway: { zeroDataRetention: boolean } }
    }
    // The model rides in the header, never in the body.
    expect(sent.model).toBeUndefined()
    expect(sent.providerOptions.gateway.zeroDataRetention).toBe(true)
    expect(sent.state.repository).toBe("smithersai/smithers")
    expect(sent.state.conversation).toContain("How do I run the tests here?")
    expect(Object.keys(sent.questions)).toEqual(["command1"])
    const question = sent.questions["command1"]!
    expect(question.type).toBe("choice")
    expect(question.instructions).toContain("next command")
    expect(question.criteria).toEqual(Object.fromEntries(COMMANDS.map((command) => [command.name, command.summary])))

    const rows = await readRows(logs)
    expect(rows[0]!.model).toBe(JEV_MODEL)
    expect(rows[0]!.commands).toEqual(["run.start", "help", "repo.open"])
  })

  test("a choice answer with no probabilities is the one command Jev chose", async () => {
    const { response, calls, body } = await ranks(async () => chosen("run.start"))
    expect(response.status).toBe(200)
    expect(body.commands).toEqual(["run.start"])
    expect(calls.length).toBe(1)
  })

  test("every name Jev weighted is one the request never offered: an honest empty list, not a 503", async () => {
    const { response, body } = await ranks(async () => decision({ "nothing.real": 0.8, "also.fake": 0.2 }))
    expect(response.status).toBe(200)
    expect(body.commands).toEqual([])
  })

  test("an empty conversation reads as the prompt's own wording, and the answer is capped at five", async () => {
    const commands = Array.from({ length: 7 }, (_, index) => ({ name: `c${index}`, summary: `does ${index}` }))
    const probabilities = Object.fromEntries(commands.map((command, index) => [command.name, (7 - index) / 28]))
    const { response, calls, body } = await ranks(async () => decision(probabilities), { repo: null, tail: [], commands })
    expect(response.status).toBe(200)
    expect(body.commands).toEqual(["c0", "c1", "c2", "c3", "c4"])
    expect(body.commands.length).toBe(RECOMMEND_ANSWER_MAX)
    const sent = (await calls[0]!.json()) as { state: { repository: string; conversation: string } }
    expect(sent.state.conversation).toBe("(no messages yet)")
    expect(sent.state.repository).toBe("(none selected)")
  })
})

describe("a Jev that does not answer is a refusal, never another model", () => {
  test("a refused gateway is a 503 naming the status, and Cerebras is never requested", async () => {
    const { response, calls } = await recommend(post("/api/recommend", goodBody), {
      jev: async () => new Response("forbidden", { status: 403 })
    })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { status: string; code: string; message: string }
    expect(body.status).toBe("error")
    expect(body.code).toBe("service_temporarily_unavailable")
    expect(body.message).toBe("Smithers' decision model refused that just now. Try again in a moment.")
    expect(calls.map((call) => new URL(call.url).hostname)).toEqual(["ai-gateway.vercel.sh"])
    expect(calls.map((call) => call.url)).not.toContain(CEREBRAS_CHAT_COMPLETIONS_URL)
  })

  test("every other gateway failure is the same typed 503, each in plain words", async () => {
    const cases: ReadonlyArray<{ readonly jev: () => Promise<Response>; readonly message: string }> = [
      { jev: async () => new Response("overloaded", { status: 529 }), message: "Smithers' decision model refused that just now. Try again in a moment." },
      { jev: async () => new Response("{}", { status: 200 }), message: "Smithers' decision model sent no decision. Try again." },
      {
        jev: async () =>
          new Response(JSON.stringify({ answers: { command1: { type: "score", score: 2 } } }), {
            status: 200,
            headers: { "content-type": "application/json" }
          }),
        message: "Smithers' decision model sent no decision. Try again."
      },
      {
        jev: async () => {
          throw new TypeError("fetch failed")
        },
        message: "Smithers' decision model can't be reached right now. Try again in a moment."
      }
    ]
    for (const { jev, message } of cases) {
      const { response } = await recommend(post("/api/recommend", goodBody), { jev })
      expect(response.status).toBe(503)
      const body = (await response.json()) as { code: string; message: string }
      expect(body.code).toBe("service_temporarily_unavailable")
      expect(body.message).toBe(message)
    }
  })

  test("a Jev that misses its deadline is a 503, the call is aborted, and nothing else is asked", async () => {
    expect(RECOMMEND_JEV_TIMEOUT_MS).toBe(1500)
    let aborted = false
    const net = network((request) =>
      new Promise<Response>((_, reject) => {
        request.signal.addEventListener("abort", () => {
          aborted = true
          reject(new DOMException("aborted", "AbortError"))
        })
      })
    )
    // The deadline is the Effect clock's, so the test moves the clock instead
    // of waiting: once the gateway call is in flight, the deadline passes, the
    // fetch is aborted, and the route answers.
    const response = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(handleRecommend(post("/api/recommend", goodBody), undefined, HEADERS))
        while (net.calls.length === 0) yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
        yield* TestClock.adjust(RECOMMEND_JEV_TIMEOUT_MS - 1)
        expect(aborted).toBe(false)
        yield* TestClock.adjust(1)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(Layer.mergeAll(
        net.layer,
        testConfigLayer(JEV_KEY),
        turnLimitsLayer(undefined),
        recommendLogLayer(undefined),
        TestClock.layer()
      )))
    )
    expect(response.status).toBe(503)
    const body = (await response.json()) as { code: string; message: string }
    expect(body.code).toBe("service_temporarily_unavailable")
    expect(body.message).toBe("Smithers' decision model took too long to answer. Try again in a moment.")
    expect(aborted).toBe(true)
    expect(net.calls.length).toBe(1)
  })

  test("without AI_GATEWAY_API_KEY the route is seam_not_configured, never names the key, and spends no ceiling", async () => {
    const limits = memoryLimits()
    const { response, calls } = await recommend(post("/api/recommend", goodBody), {
      config: { aiGatewayApiKey: undefined },
      limits
    })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { status: string; code: string; message: string }
    expect(body.status).toBe("error")
    expect(body.code).toBe("seam_not_configured")
    expect(body.message).toBe("Command suggestions aren't available on this deployment.")
    expect(limits.keys()).toEqual([])
    expect(calls.length).toBe(0)
  })

  test("a deployment with a Cerebras key and no gateway key still refuses: the cloud roles' key is not a recommender fallback", async () => {
    const { response, calls } = await recommend(post("/api/recommend", goodBody), {
      config: { aiGatewayApiKey: undefined, cerebrasApiKey: Redacted.make("csk-test") }
    })
    expect(response.status).toBe(503)
    expect(((await response.json()) as { code: string }).code).toBe("seam_not_configured")
    expect(calls.length).toBe(0)
  })
})

describe("a catalog too long for one choice question", () => {
  test("is split across questions in ONE request and merged by probability, never handed to another model", async () => {
    expect(RECOMMEND_JEV_COMMANDS_MAX).toBe(255)
    const commands = Array.from({ length: 300 }, (_, index) => ({ name: `c${index}`, summary: `does ${index}` }))
    expect(commands.length).toBeLessThanOrEqual(RECOMMEND_COMMANDS_MAX)
    const { response, calls } = await recommend(post("/api/recommend", { ...goodBody, commands }), {
      jev: async () =>
        new Response(
          JSON.stringify({
            answers: {
              // The first question saw c0..c254, the second c255..c299.
              command1: { type: "choice", choice: "c3", probabilities: { c3: 0.4, c10: 0.1, c254: 0.05 } },
              command2: { type: "choice", choice: "c260", probabilities: { c260: 0.9, c299: 0.2, c280: 0.3 } }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    })

    expect(response.status).toBe(200)
    // ONE request. The gateway answers a request's questions in parallel, so
    // a catalog of three hundred costs one question's latency.
    expect(calls.length).toBe(1)
    const sent = (await calls[0]!.json()) as {
      questions: Record<string, { type: string; criteria: Record<string, string> }>
    }
    expect(Object.keys(sent.questions)).toEqual(["command1", "command2"])
    expect(Object.keys(sent.questions["command1"]!.criteria).length).toBe(RECOMMEND_JEV_COMMANDS_MAX)
    expect(Object.keys(sent.questions["command2"]!.criteria).length).toBe(300 - RECOMMEND_JEV_COMMANDS_MAX)
    expect(sent.questions["command1"]!.criteria["c0"]).toBe("does 0")
    expect(sent.questions["command2"]!.criteria["c299"]).toBe("does 299")
    // Every offered command is asked about exactly once, across the questions.
    const asked = Object.values(sent.questions).flatMap((question) => Object.keys(question.criteria))
    expect(asked.length).toBe(commands.length)
    expect(new Set(asked).size).toBe(commands.length)

    // Merged by probability across both questions, best first, capped at five.
    const body = (await response.json()) as { commands: Array<string>; model: string }
    expect(body.commands).toEqual(["c260", "c3", "c280", "c299", "c10"])
    expect(body.commands.length).toBe(RECOMMEND_ANSWER_MAX)
    expect(body.model).toBe(JEV_MODEL)
  })

  test("exactly one question's worth of commands is still one question", async () => {
    const commands = Array.from({ length: RECOMMEND_JEV_COMMANDS_MAX }, (_, index) => ({ name: `c${index}`, summary: "s" }))
    const { calls } = await recommend(post("/api/recommend", { ...goodBody, commands }), {
      jev: async () => decision({ c3: 1 })
    })
    const sent = (await calls[0]!.json()) as { questions: Record<string, unknown> }
    expect(Object.keys(sent.questions)).toEqual(["command1"])
  })
})

describe("POST /api/recommend reads its body before it spends anything", () => {
  test("a malformed body is 400 and never reaches Jev", async () => {
    const cases: Array<unknown> = [
      "not json",
      [],
      { repo: 7, tail: [], commands: COMMANDS },
      { repo: null, tail: [{ role: "robot", text: "hi" }], commands: COMMANDS },
      { repo: null, tail: [{ role: "user" }], commands: COMMANDS },
      { repo: null, tail: [], commands: [{ name: "", summary: "x" }] },
      { repo: null, tail: [], commands: "help" }
    ]
    for (const body of cases) {
      const { response, calls } = await recommend(post("/api/recommend", body))
      expect(response.status).toBe(400)
      expect(((await response.json()) as { status: string }).status).toBe("error")
      expect(calls.length).toBe(0)
    }
    const { response } = await recommend(post("/api/recommend", "not json"))
    expect(((await response.json()) as { message: string }).message).toBe("The recommendation request is not JSON.")
  })

  test("an unreadable body is 400 and says so", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket reset"))
      }
    })
    const request = new Request("https://mvp.test/api/recommend", { method: "POST", body, headers: { "cf-connecting-ip": "203.0.113.7" } })
    const { response } = await recommend(request)
    expect(response.status).toBe(400)
    expect(((await response.json()) as { message: string }).message).toBe("The recommendation request could not be read.")
  })

  test("repo is owner/name or null, and a command name or summary past its cap is 400, so the log and the question hold only what the contract names", async () => {
    const badRepos = ["smithers", "a/b/c", "owner/na me", "-owner/name", `${"o".repeat(40)}/name`, `owner/${"n".repeat(101)}`, "x".repeat(4000)]
    for (const repo of badRepos) {
      const { response, calls } = await recommend(post("/api/recommend", { ...goodBody, repo }))
      expect(response.status).toBe(400)
      expect(((await response.json()) as { message: string }).message).toContain("owner/name")
      expect(calls.length).toBe(0)
    }
    const longName = [{ name: "c".repeat(RECOMMEND_COMMAND_NAME_MAX_CHARS + 1), summary: "s" }]
    const longSummary = [{ name: "c", summary: "s".repeat(RECOMMEND_COMMAND_SUMMARY_MAX_CHARS + 1) }]
    for (const commands of [longName, longSummary]) {
      const { response, calls } = await recommend(post("/api/recommend", { ...goodBody, commands }))
      expect(response.status).toBe(400)
      expect(calls.length).toBe(0)
    }
    // The shape admits real repositories at the caps, with dots, underscores and hyphens.
    const jev = async () => decision({ help: 1 })
    for (const repo of ["smithersai/smithers", "my-org/my.repo_v2", `${"o".repeat(39)}/${"n".repeat(100)}`, null]) {
      const { response } = await recommend(post("/api/recommend", { ...goodBody, repo }), { jev })
      expect(response.status).toBe(200)
    }
    const atCaps = [{ name: "c".repeat(RECOMMEND_COMMAND_NAME_MAX_CHARS), summary: "s".repeat(RECOMMEND_COMMAND_SUMMARY_MAX_CHARS) }]
    expect((await recommend(post("/api/recommend", { ...goodBody, commands: atCaps }), { jev })).response.status).toBe(200)
  })

  test("an oversize body is 413: too many tail messages, too much tail text, too many commands", async () => {
    const longTail = Array.from({ length: RECOMMEND_TAIL_MAX_ENTRIES + 1 }, () => ({ role: "user", text: "x" }))
    const bigText = [{ role: "user", text: "x".repeat(RECOMMEND_TAIL_MAX_CHARS + 1) }]
    const manyCommands = Array.from({ length: RECOMMEND_COMMANDS_MAX + 1 }, (_, index) => ({ name: `c${index}`, summary: "s" }))
    for (const body of [{ ...goodBody, tail: longTail }, { ...goodBody, tail: bigText }, { ...goodBody, commands: manyCommands }]) {
      const { response, calls } = await recommend(post("/api/recommend", body))
      expect(response.status).toBe(413)
      expect(calls.length).toBe(0)
    }
    // A declared length past the byte cap is refused before a byte is read.
    const declared = await recommend(post("/api/recommend", goodBody, { "content-length": String(10 * 1024 * 1024) }))
    expect(declared.response.status).toBe(413)
    expect(((await declared.response.json()) as { message: string }).message).toBe("The recommendation request is too large.")
    // So is a chunked body that grows past it.
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 30; index += 1) controller.enqueue(new Uint8Array(10 * 1024))
        controller.close()
      }
    })
    const streamed = await recommend(new Request("https://mvp.test/api/recommend", { method: "POST", body: chunks }))
    expect(streamed.response.status).toBe(413)
    expect(declared.calls.length + streamed.calls.length).toBe(0)
  })
})

describe("the recommendation ceilings", () => {
  const jev = async () => decision({ help: 1 })

  test("a visitor spends an address bucket and the deployment bucket; the spent one is 429 in the turn_rate_limited shape", async () => {
    const limits = memoryLimits()
    const first = await recommend(post("/api/recommend", goodBody), { jev, limits })
    expect(first.response.status).toBe(200)
    const keys = limits.keys()
    expect(keys).toContain(RECOMMEND_ALL_KEY)
    const address = keys.find((key) => key.startsWith("recommend:anonymous:"))
    expect(address).toBeDefined()
    expect(address).not.toContain("203.0.113.7")
    // A second visitor from the same IPv6 /64 shares the address bucket.
    const sibling = memoryLimits()
    const prefixed = (ip: string) => post("/api/recommend", goodBody, { "cf-connecting-ip": ip })
    await recommend(prefixed("2001:db8:1:2::1"), { jev, limits: sibling })
    await recommend(prefixed("2001:db8:1:2:ffff::9"), { jev, limits: sibling })
    expect(sibling.keys().filter((key) => key.startsWith("recommend:anonymous:")).length).toBe(1)

    const spentAddress = memoryLimits([{ key: address!, count: RECOMMEND_ADDRESS_MAX }])
    const refused = await recommend(post("/api/recommend", goodBody), { limits: spentAddress })
    expect(refused.response.status).toBe(429)
    expect(refused.calls.length).toBe(0)
    const body = (await refused.response.json()) as { status: string; code: string; message: string; retryAt: string }
    expect(body.code).toBe("turn_rate_limited")
    expect(body.message).toContain("Chat keeps working")
    expect(new Date(body.retryAt).getTime()).toBeGreaterThan(Date.now())
    expect(refused.response.headers.get("retry-after")).not.toBeNull()
    expect(refused.response.headers.get("x-isolation")).toBe("1")
    // The address refusal never draws down everyone's bucket.
    expect(spentAddress.keys()).not.toContain(RECOMMEND_ALL_KEY)

    const spentAll = memoryLimits([{ key: RECOMMEND_ALL_KEY, count: RECOMMEND_ALL_MAX }])
    const everyone = await recommend(post("/api/recommend", goodBody), { limits: spentAll })
    expect(everyone.response.status).toBe(429)
    expect(everyone.calls.length).toBe(0)
  })

  test("the salt changes the address bucket, so buckets are not linkable across deployments", async () => {
    const a = memoryLimits()
    const b = memoryLimits()
    await recommend(post("/api/recommend", goodBody), { jev, limits: a, config: { anonymousTurnSalt: Redacted.make("salt-a") } })
    await recommend(post("/api/recommend", goodBody), { jev, limits: b, config: { anonymousTurnSalt: Redacted.make("salt-b") } })
    const addressOf = (limits: { keys: () => Array<string> }) => limits.keys().find((key) => key.startsWith("recommend:anonymous:"))
    expect(addressOf(a)).toBeDefined()
    expect(addressOf(a)).not.toBe(addressOf(b))
  })

  test("a signed-in caller is keyed by login, apart from every turn bucket", async () => {
    const limits = memoryLimits()
    const { response, calls } = await recommend(post("/api/recommend", goodBody), { jev, limits, login: "will" })
    expect(response.status).toBe(200)
    expect(limits.keys()).toContain("recommend:login:will")
    expect(limits.keys()).not.toContain("will")
    // The login's Jev call is metered through the Cloud model proxy on its own token, never the platform key.
    expect(calls.map((call) => call.url)).toEqual([METERED_JEV_URL])
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer cloud-token-login")
    expect(calls[0]!.headers.get("ai-model-id")).toBe(JEV_MODEL)
  })

  test("a signed-in caller out of credit is the out_of_credit refusal", async () => {
    const spent = async () => Response.json({ code: "out_of_credit", message: "out of credit", details: { balance_cents: 0, required_cents: 1, upgrade: "/billing" } }, { status: 402 })
    const { response } = await recommend(post("/api/recommend", goodBody), { jev: spent, limits: memoryLimits(), login: "will" })
    expect(response.status).toBe(402)
    expect(((await response.json()) as { code: string }).code).toBe("out_of_credit")
  })

  test("a visitor keeps the platform key and never reaches the metered proxy", async () => {
    const { response, calls } = await recommend(post("/api/recommend", goodBody), { jev, limits: memoryLimits() })
    expect(response.status).toBe(200)
    expect(calls.map((call) => call.url)).toEqual(["https://ai-gateway.vercel.sh/v4/ai/evaluation-model"])
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer vck-test")
  })

  test("a turn limiter that cannot answer is a 503 and Jev is never asked", async () => {
    const limits: NativeNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => { throw new Error("Durable Object is overloaded.") } })
    }
    const logged = spyOn(console, "error").mockImplementation(() => {})
    try {
      const { response, calls } = await recommend(post("/api/recommend", goodBody), { jev, limits })
      expect(response.status).toBe(503)
      expect(calls.length).toBe(0)
      expect(((await response.json()) as { code: string }).code).toBe("service_temporarily_unavailable")
    } finally {
      logged.mockRestore()
    }
  })

  test("with no TURN_LIMITS binding the route still answers", async () => {
    const { response } = await recommend(post("/api/recommend", goodBody), { jev })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { id: string }).id).toMatch(/^unlogged-/)
  })
})

describe("POST /api/recommend/outcome", () => {
  const jev = async () => decision({ "run.start": 0.7, "help": 0.3 })

  test("an outcome is 204 once, 409 the second time, and lands on the row", async () => {
    const logs = memoryLog()
    const recommended = await recommend(post("/api/recommend", goodBody), { jev, logs })
    const { id } = (await recommended.response.json()) as { id: string }
    const first = await outcome(post("/api/recommend/outcome", { id, command: "help" }), logs)
    expect(first.status).toBe(204)
    expect(first.headers.get("x-isolation")).toBe("1")
    const second = await outcome(post("/api/recommend/outcome", { id, command: "run.start" }), logs)
    expect(second.status).toBe(409)
    const rows = await readRows(logs)
    expect(rows[0]!.outcome?.command).toBe("help")
  })

  test("an unknown id is 404, a malformed outcome is 400", async () => {
    const logs = memoryLog()
    const unknown = await outcome(post("/api/recommend/outcome", { id: "zz-0000", command: "help" }), logs)
    expect(unknown.status).toBe(404)
    const garbage = await outcome(post("/api/recommend/outcome", { id: "not a seq!", command: "help" }), logs)
    expect(garbage.status).toBe(404)
    const malformed = await outcome(post("/api/recommend/outcome", { id: 5 }), logs)
    expect(malformed.status).toBe(400)
    const notJson = await outcome(post("/api/recommend/outcome", "not json"), logs)
    expect(notJson.status).toBe(400)
    expect(((await notJson.json()) as { message: string }).message).toBe("An outcome is { id, command }, both strings.")
    const unbound = await outcome(post("/api/recommend/outcome", { id: "1-abc", command: "help" }))
    expect(unbound.status).toBe(404)
    expect(((await unbound.json()) as { message: string }).message).toContain("No recommendation log on this deployment")
  })

  test("an oversize outcome is 413 and a command longer than a name is 400, before the log is touched", async () => {
    const logs = memoryLog()
    let touched = 0
    const counted: NativeNamespace = {
      idFromName: (name) => logs.idFromName(name),
      get: (id) => {
        const stub = logs.get(id)
        return {
          fetch: (request) => {
            touched += 1
            return stub.fetch(request)
          }
        }
      }
    }
    const recommended = await recommend(post("/api/recommend", goodBody), { jev: async () => decision({ help: 1 }), logs: counted })
    const { id } = (await recommended.response.json()) as { id: string }
    expect(touched).toBe(1)
    const huge = { id, command: "h".repeat(RECOMMEND_OUTCOME_BODY_MAX_BYTES + 1) }
    expect((await outcome(post("/api/recommend/outcome", huge), counted)).status).toBe(413)
    const declared = post("/api/recommend/outcome", { id, command: "help" }, { "content-length": String(RECOMMEND_OUTCOME_BODY_MAX_BYTES + 1) })
    expect((await outcome(declared, counted)).status).toBe(413)
    const long = { id, command: "h".repeat(RECOMMEND_COMMAND_NAME_MAX_CHARS + 1) }
    expect((await outcome(post("/api/recommend/outcome", long), counted)).status).toBe(400)
    expect((await outcome(post("/api/recommend/outcome", "null"), counted)).status).toBe(400)
    expect(touched).toBe(1)
    // The row is untouched: the real outcome still lands once.
    const real = await outcome(post("/api/recommend/outcome", { id, command: "help" }), counted)
    expect(real.status).toBe(204)
    expect((await readRows(logs))[0]!.outcome?.command).toBe("help")
  })

  test("an id with the right sequence but the wrong random tail is 404, so ids cannot be guessed", async () => {
    const logs = memoryLog()
    const recommended = await recommend(post("/api/recommend", goodBody), { jev, logs })
    const { id } = (await recommended.response.json()) as { id: string }
    const forged = `${id.split("-")[0]}-0000000000000000`
    const response = await outcome(post("/api/recommend/outcome", { id: forged, command: "help" }), logs)
    expect(response.status).toBe(404)
  })

  test("a log that cannot be reached is a 500 that says the outcome was not recorded", async () => {
    const down: NativeNamespace = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => {
          throw new Error("durable object unavailable")
        }
      })
    }
    const response = await outcome(post("/api/recommend/outcome", { id: "1-abc", command: "help" }), down)
    expect(response.status).toBe(500)
    expect(((await response.json()) as { message: string }).message).toContain("did not record")
  })
})

describe("the recommendation log", () => {
  test("a row holds the contract's fields and a digest of the tail, never the text", async () => {
    const logs = memoryLog()
    await recommend(post("/api/recommend", goodBody), { jev: async () => decision({ "keys.list": 0.6, "help": 0.4 }), logs })
    const [row] = await readRows(logs)
    expect(row).toBeDefined()
    expect(Object.keys(row!).sort()).toEqual(["at", "commandCount", "commands", "id", "model", "outcome", "repo", "tailDigest"])
    expect(row!.repo).toBe("smithersai/smithers")
    expect(row!.commandCount).toBe(COMMANDS.length)
    expect(row!.commands).toEqual(["keys.list", "help"])
    expect(row!.model).toBe(JEV_MODEL)
    expect(row!.outcome).toBeNull()
    expect(row!.tailDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(new Date(row!.at).toISOString()).toBe(row!.at)
    expect(JSON.stringify(row)).not.toContain("How do I run the tests")
    expect(logs.names()).toEqual([RECOMMEND_LOG_NAME])
    expect(RECOMMEND_LOG_NAME).toBe("recommendations")
  })

  test("a refused recommendation writes no row: the log holds only what Jev said", async () => {
    const logs = memoryLog()
    const { response } = await recommend(post("/api/recommend", goodBody), {
      jev: async () => new Response("no", { status: 502 }),
      logs
    })
    expect(response.status).toBe(503)
    expect(await readRows(logs)).toEqual([])
  })

  test("the scorer reads the rows newest first, bounded by limit; an unbound log is empty", async () => {
    const logs = memoryLog()
    let calls = 0
    const jev = async () => decision({ [COMMANDS[calls++ % COMMANDS.length]!.name]: 1 })
    for (let index = 0; index < 3; index += 1) await recommend(post("/api/recommend", goodBody), { jev, logs })
    expect((await readRows(logs)).map((row) => row.commands[0])).toEqual(["keys.list", "run.start", "repo.open"])
    expect((await readRows(logs, 2)).length).toBe(2)
    expect(await readRows(undefined)).toEqual([])
  })

  test("is a ring: past the limit the oldest row goes and the newest stays", async () => {
    const storage = memoryRecommendStorage()
    const log = new RecommendLog({ storage })
    const append = (index: number) =>
      log.fetch(
        new Request("https://recommend-log.internal/append", {
          method: "POST",
          body: JSON.stringify({ at: new Date(index).toISOString(), repo: null, tailDigest: "0", commandCount: 1, commands: [], model: "m", outcome: null })
        })
      )
    const overflow = 3
    for (let index = 0; index < RECOMMEND_LOG_LIMIT + overflow; index += 1) await append(index)
    const all = await storage.list<RecommendLogRow>({ prefix: "row:", reverse: true, limit: RECOMMEND_LOG_LIMIT * 2 })
    expect(all.size).toBe(RECOMMEND_LOG_LIMIT)
    const rows = [...all.values()]
    expect(rows[0]!.at).toBe(new Date(RECOMMEND_LOG_LIMIT + overflow - 1).toISOString())
    expect(rows[rows.length - 1]!.at).toBe(new Date(overflow).toISOString())
  }, 60_000)

  test("concurrent appends keep every row under its own id, and concurrent outcomes record once", async () => {
    // Every read answers its snapshot a macrotask later, which is where a
    // second request can arrive between one append's sequence read and its
    // writes.
    const inner = memoryRecommendStorage()
    const log = new RecommendLog({
      storage: {
        ...inner,
        get: async <T,>(key: string) => {
          const snapshot = await inner.get<T>(key)
          await new Promise((resolve) => setTimeout(resolve, 1))
          return snapshot
        }
      }
    })
    const append = async (index: number): Promise<string> => {
      const response = await log.fetch(
        new Request("https://recommend-log.internal/append", {
          method: "POST",
          body: JSON.stringify({ at: new Date(index).toISOString(), repo: null, tailDigest: "0", commandCount: 1, commands: [], model: "m", outcome: null })
        })
      )
      return ((await response.json()) as { id: string }).id
    }
    const ids = await Promise.all([append(0), append(1), append(2)])
    expect(new Set(ids).size).toBe(3)
    const rows = await inner.list<RecommendLogRow>({ prefix: "row:", reverse: false, limit: 10 })
    expect([...rows.values()].map((row) => row.id).sort()).toEqual([...ids].sort())
    const outcome = (command: string) =>
      log.fetch(
        new Request("https://recommend-log.internal/outcome", {
          method: "POST",
          body: JSON.stringify({ id: ids[0], command, at: "2026-01-01T00:00:00.000Z" })
        })
      ).then((response) => response.status)
    expect((await Promise.all([outcome("run.start"), outcome("repo.open")])).sort()).toEqual([204, 409])
  })

  test("the object refuses a bad row, a bad outcome, and an unknown path in its own words", async () => {
    const log = new RecommendLog({ storage: memoryRecommendStorage() })
    expect((await log.fetch(new Request("https://recommend-log.internal/append", { method: "POST", body: "nope" }))).status).toBe(400)
    expect((await log.fetch(new Request("https://recommend-log.internal/outcome", { method: "POST", body: "{}" }))).status).toBe(400)
    expect((await log.fetch(new Request("https://recommend-log.internal/elsewhere"))).status).toBe(404)
  })

  test("a storage failure is the object's own 500", async () => {
    const log = new RecommendLog({
      storage: {
        ...memoryRecommendStorage(),
        get: async () => {
          throw new Error("storage unavailable")
        }
      }
    })
    const response = await log.fetch(
      new Request("https://recommend-log.internal/append", {
        method: "POST",
        body: JSON.stringify({ at: "2026-01-01T00:00:00.000Z", repo: null, tailDigest: "0", commandCount: 0, commands: [], model: "m", outcome: null })
      })
    )
    expect(response.status).toBe(500)
  })
})

/*
 * The Cerebras client still lives here, and the cloud roles (cloudRoleTurn.ts)
 * are its only caller. These tests hold the client, not the recommender, so
 * they bring their own transport.
 */
describe("the Cerebras client the cloud roles spend", () => {
  const request = { model: "m", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 8, temperature: 0 }
  const completion = (content: string, model = "gpt-oss-120b"): Response =>
    new Response(JSON.stringify({ model, choices: [{ message: { role: "assistant", content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  const cerebrasNetwork = (answer: (request: Request) => Promise<Response>) =>
    transportLayer(async (input, init) => {
      const outbound = input instanceof Request ? new Request(input, init) : new Request(input, init)
      expect(outbound.url).toBe(CEREBRAS_CHAT_COMPLETIONS_URL)
      return answer(outbound)
    })
  const chat = (
    cerebras: (request: Request) => Promise<Response>,
    config: Partial<ServerConfigShape> = { cerebrasApiKey: Redacted.make("csk-test") }
  ) => Effect.runPromise(cerebrasChat(request, 1000).pipe(Effect.provide(Layer.mergeAll(cerebrasNetwork(cerebras), testConfigLayer(config)))))

  test("answers content and the provider's model, and names each failure", async () => {
    expect(await chat(async () => completion("hello", "served-model"))).toEqual({ ok: true, content: "hello", model: "served-model" })
    expect(await chat(async () => new Response("{}", { status: 200 }))).toEqual({ ok: false, reason: "empty" })
    expect(await chat(async () => new Response("slow down", { status: 429 }))).toEqual({ ok: false, reason: "http", status: 429 })
    expect(await chat(async () => {
      throw new TypeError("fetch failed")
    })).toEqual({ ok: false, reason: "unreachable", message: "fetch failed" })
    expect(await chat(async () => completion("x"), { cerebrasApiKey: undefined })).toEqual({ ok: false, reason: "unreachable", message: "CEREBRAS_API_KEY is unset." })
  })

  test("a refused response has its body cancelled", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("oops"))
      },
      cancel() {
        cancelled = true
      }
    })
    expect(await chat(async () => new Response(body, { status: 500 }))).toEqual({ ok: false, reason: "http", status: 500 })
    expect(cancelled).toBe(true)
  })
})

describe("the questions asked and the answers read", () => {
  test("recommendQuestions chunks the catalog, asks about every command once, and is one question for an empty catalog", () => {
    const commands = Array.from({ length: RECOMMEND_JEV_COMMANDS_MAX * 2 + 1 }, (_, index) => ({ name: `c${index}`, summary: `does ${index}` }))
    const questions = recommendQuestions(commands)
    expect(Object.keys(questions)).toEqual(["command1", "command2", "command3"])
    expect(recommendQuestionKey(0)).toBe("command1")
    const sizes = Object.values(questions).map((question) => Object.keys((question as { criteria: object }).criteria).length)
    expect(sizes).toEqual([RECOMMEND_JEV_COMMANDS_MAX, RECOMMEND_JEV_COMMANDS_MAX, 1])
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(commands.length)
    // An empty catalog still asks one question, so the request's shape never
    // depends on what the client had to offer.
    expect(Object.keys(recommendQuestions([]))).toEqual(["command1"])
  })

  test("rankJevAnswers merges by probability, drops zero weight, and puts an unmeasured choice last", () => {
    const merged = rankJevAnswers({
      command1: { type: "choice", choice: "a", probabilities: { a: 0.3, b: 0.9, c: 0 } },
      command2: { type: "choice", choice: "d" },
      command3: { type: "choice", choice: "e", probabilities: { e: 0.5 } }
    }, ["command1", "command2", "command3"])
    expect(merged).toEqual(["b", "e", "a", "d"])
  })

  test("rankJevAnswers is undefined when no question came back as a choice: Jev failed, it did not answer 'nothing'", () => {
    expect(rankJevAnswers({}, ["command1"])).toBeUndefined()
    expect(rankJevAnswers({ command1: { type: "score", score: 3 } }, ["command1"])).toBeUndefined()
    // An answer under a key this request never asked is not this request's answer.
    expect(rankJevAnswers({ other: { type: "choice", choice: "a" } }, ["command1"])).toBeUndefined()
    // A choice whose every option carries zero weight IS an answer: Jev read
    // the options and weighted none of them.
    expect(rankJevAnswers({ command1: { type: "choice", choice: "a", probabilities: { a: 0 } } }, ["command1"])).toEqual([])
  })

  test("filterAnswer keeps offered names in Jev's order, once each, at most five", () => {
    const offered = Array.from({ length: 8 }, (_, index) => ({ name: `c${index}`, summary: "" }))
    expect(filterAnswer(["c3", " c1 ", "nope", "c3", "c0", "c7", "c2", "c5"], offered)).toEqual(["c3", "c1", "c0", "c7", "c2"])
  })
})

describe("the recommend seat: the decision model a request arms", () => {
  const JEV_BINDING = { protocol: "evaluation", modelId: JEV_MODEL, credential: "AI_GATEWAY_API_KEY" }

  const refusedBinding = async (model: unknown, config?: Partial<ServerConfigShape>) => {
    const logs = memoryLog()
    const limits = memoryLimits()
    const { response, calls } = await recommend(post("/api/recommend", { ...goodBody, model }), {
      logs,
      limits,
      ...(config === undefined ? {} : { config })
    })
    const body = (await response.json()) as { status: string; code: string; message: string }
    // Refused before anything is spent: no Jev, no row.
    expect(calls).toEqual([])
    expect(await readRows(logs)).toEqual([])
    return { status: response.status, code: body.code, message: body.message }
  }

  test("an allowed binding is the id Jev is asked by, the id the row records and the id the answer names", async () => {
    const logs = memoryLog()
    const { response, calls } = await recommend(post("/api/recommend", { ...goodBody, model: JEV_BINDING }), {
      logs,
      jev: async () => decision({ "run.start": 0.8, help: 0.2 })
    })
    expect(response.status).toBe(200)
    expect(calls.map((request) => request.headers.get("ai-model-id"))).toEqual([JEV_MODEL])
    expect(((await response.json()) as { model: string }).model).toBe(JEV_MODEL)
    expect((await readRows(logs)).map((row) => row.model)).toEqual([JEV_MODEL])
  })

  test("a request without a binding answers exactly as one that binds the default", async () => {
    const jev = async () => decision({ "run.start": 0.8, help: 0.2 })
    const bare = await ranks(jev)
    const bound = await ranks(jev, { ...goodBody, model: JEV_BINDING })
    expect({ ...bound.body, id: "" }).toEqual({ ...bare.body, id: "" })
    expect(await bound.calls[0]!.text()).toBe(await bare.calls[0]!.text())
  })

  test("an id off the allowlist is request_invalid, never the default Jev", async () => {
    const refused = await refusedBinding({ ...JEV_BINDING, modelId: "openai/gpt-x" })
    expect([refused.status, refused.code]).toEqual([400, "request_invalid"])
    expect(refused.message).not.toContain("openai/gpt-x")
  })

  test("a generation binding, an unpinned address and an unknown credential are each request_invalid", async () => {
    for (const model of [
      { protocol: "openai-chat", baseUrl: "https://api.cerebras.ai", modelId: "gpt-oss-120b", credential: "CEREBRAS_API_KEY" },
      { ...JEV_BINDING, baseUrl: "https://attacker.test" },
      { ...JEV_BINDING, baseUrl: "https://ai-gateway.vercel.sh/elsewhere" },
      { ...JEV_BINDING, credential: "GITHUB_TOKEN" }
    ]) {
      const refused = await refusedBinding(model)
      expect([model, refused.status, refused.code]).toEqual([model, 400, "request_invalid"])
    }
  })

  test("a binding that is not one is request_invalid at the body, and an extra key cannot ride it", async () => {
    for (const model of [null, JEV_MODEL, { ...JEV_BINDING, apiKey: "vck-smuggled" }]) {
      const refused = await refusedBinding(model)
      expect([refused.status, refused.code]).toEqual([400, "request_invalid"])
      expect(refused.message).not.toContain("vck-smuggled")
    }
  })

  test("an allowed binding on a deployment without the key is seam_not_configured, naming the key", async () => {
    const refused = await refusedBinding(JEV_BINDING, { aiGatewayApiKey: undefined })
    expect([refused.status, refused.code]).toEqual([503, "seam_not_configured"])
    expect(refused.message).toContain("AI_GATEWAY_API_KEY")
  })
})
