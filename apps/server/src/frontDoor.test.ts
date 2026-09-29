import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import { testConfigLayer } from "./Config"
import type { ServerConfigShape } from "./Config"
import { memoryStorage } from "./DurableStorage"
import type { NativeNamespace } from "./DurableStorage"
import { ExecutionContext, executionContextFrom } from "./Environment"
import {
  askFrontDoor,
  FRONT_DOOR_CALL_PREFIX,
  FRONT_DOOR_CONFIDENCE_FLOOR,
  FRONT_DOOR_IS_COMMAND_FLOOR,
  FRONT_DOOR_JEV_COMMANDS_MAX
} from "./frontDoor"
import { transportLayer } from "./Http"
import {
  memoryRecommendStorage,
  readRecommendLog,
  RECOMMEND_JEV_TIMEOUT_MS,
  RecommendLog,
  recommendLogLayer
} from "./recommend"
import type { RecommendLogRow } from "./recommend"
import { handleTurn, TurnCancelRegistry, turnCancelsLayer } from "./turns"

/*
 * The front door: Jev decides the turn before the chat upstream is paid for
 * it. These tests hold the route to the contract the client already speaks —
 * a routed turn is the tool_call / done pair the concierge would have emitted
 * — and to the three that keep it honest: the upstream is untouched when Jev
 * routes, the hidden runtime context never leaves this Worker, and a Jev that
 * FAILS refuses the turn rather than quietly spending the upstream. Only
 * Jev's own answer — `none`, or a command under the floor — hands the turn to
 * the concierge.
 */

const COMMANDS = [
  { name: "runs.list", summary: "See your runs" },
  { name: "repo.open", summary: "Open a repository" },
  { name: "flow.create", summary: "Create a workflow" }
]

const CONTEXT: AgentRuntimeContext = {
  version: 1,
  product: "smithers",
  capturedAt: 1786223000000,
  revision: 9,
  surface: "chat",
  theme: "dark",
  selectedWorldDocument: null,
  connectors: [],
  activeRepository: "smithersai/smithers",
  github: { connected: true, login: "octocat", repositories: 3 },
  worldState: { documentCount: 0, documents: [] },
  capabilities: ["Hold a streaming conversation in this chat and read its visible transcript."],
  limitations: ["Cannot see or control the host environment beyond what this context block states."]
}

const GATEWAY_KEY = { aiGatewayApiKey: Redacted.make("vck-test") }

const turnBody = (overrides: Record<string, unknown> = {}) => ({
  runId: "run-front-door",
  messages: [{ role: "user", content: "show me my runs" }],
  instructions: "Be brief.",
  commands: COMMANDS,
  context: CONTEXT,
  ...overrides
})

const post = (body: unknown): Request =>
  new Request("https://mvp.test/api/agent/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

const ndjsonText = (...frames: ReadonlyArray<unknown>): string =>
  frames.map((frame) => `${JSON.stringify(frame)}\n`).join("")

/** A gateway evaluation: one command choice with its probabilities, and the impossible class. */
const evaluation = (
  choice: string,
  confidence: number,
  impossible = "none"
): Response =>
  new Response(
    JSON.stringify({
      answers: {
        command: { type: "choice", choice, probabilities: { [choice]: confidence } },
        impossible: { type: "choice", choice: impossible }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )

/** A catalog of `count` commands, as the client posts one. */
const catalog = (count: number): ReadonlyArray<{ name: string; summary: string }> =>
  Array.from({ length: count }, (_, index) => ({ name: `c${index}`, summary: `does ${index}` }))

/** A gateway evaluation carrying exactly these answers. */
const answered = (answers: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ answers }), { status: 200, headers: { "content-type": "application/json" } })

/** One choice answer: the option that won, and the probability it won by. */
const chose = (choice: string, probability: number) => ({ type: "choice", choice, probabilities: { [choice]: probability } })

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

const memoryLog = (): NativeNamespace => {
  const logs = new Map<string, RecommendLog>()
  return {
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let log = logs.get(name)
      if (log === undefined) {
        log = new RecommendLog({ storage: memoryRecommendStorage() })
        logs.set(name, log)
      }
      const object = log
      return { fetch: (request) => object.fetch(request) }
    }
  }
}

interface Calls {
  readonly gateway: Array<Request>
  readonly upstream: Array<Request>
}

/**
 * The turn route with its two outbound seams recorded: the AI Gateway (Jev)
 * and the chat upstream. A seam a test does not name must not be reached.
 */
const turn = async (
  body: unknown,
  options: {
    readonly jev?: (request: Request) => Response | Promise<Response>
    readonly config?: Partial<ServerConfigShape>
    readonly logs?: NativeNamespace
  } = {}
): Promise<{ readonly response: Response; readonly calls: Calls }> => {
  const calls: Calls = { gateway: [], upstream: [] }
  const transport = transportLayer(async (input, init) => {
    const request = new Request(input as string, init)
    if (new URL(request.url).hostname === "ai-gateway.vercel.sh") {
      calls.gateway.push(request)
      if (options.jev === undefined) throw new Error("Jev must not be asked")
      return options.jev(request)
    }
    calls.upstream.push(request)
    return new Response(ndjsonText({ type: "delta", kind: "text", text: "upstream" }, { type: "done", reason: "stop" }), {
      status: 200,
      headers: { "content-type": "application/x-ndjson" }
    })
  })
  const response = await Effect.runPromise(
    handleTurn(post(body)).pipe(
      Effect.provide(Layer.mergeAll(
        transport,
        testConfigLayer({ chatUrl: "https://upstream.test/chat", upstreamTimeoutMs: 5_000, ...GATEWAY_KEY, ...options.config }),
        turnCancelsLayer(memoryCancels()),
        recommendLogLayer(options.logs),
        Layer.succeed(ExecutionContext, executionContextFrom(undefined))
      ))
    )
  )
  return { response, calls }
}

const frames = async (response: Response): Promise<Array<Record<string, unknown>>> =>
  (await response.text()).split("\n").filter((line) => line.trim() !== "").map((line) =>
    JSON.parse(line) as Record<string, unknown>
  )

const rowsOf = (logs: NativeNamespace): Promise<ReadonlyArray<RecommendLogRow>> =>
  Effect.runPromise(readRecommendLog().pipe(Effect.provide(recommendLogLayer(logs))))

describe("the Jev front door on POST /api/agent/turn", () => {
  test("a confident command answers the turn with the concierge's own tool-call frames, and the upstream is never called", async () => {
    const logs = memoryLog()
    const { response, calls } = await turn(turnBody(), { jev: () => evaluation("runs.list", 0.97), logs })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/x-ndjson")
    expect(calls.upstream).toEqual([])
    expect(calls.gateway.length).toBe(1)

    const emitted = await frames(response)
    expect(emitted.length).toBe(2)
    expect(emitted[0]).toMatchObject({
      runId: "run-front-door",
      type: "tool_call",
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "runs.list" })
    })
    expect(String(emitted[0]!.call_id)).toStartWith(FRONT_DOOR_CALL_PREFIX)
    expect(emitted[1]).toEqual({ runId: "run-front-door", type: "done", reason: "tool_call" })

    const rows = await rowsOf(logs)
    expect(rows.length).toBe(1)
    expect(rows[0]!.model).toBe("typesafe-ai/jev")
    expect(rows[0]!.commands).toEqual(["runs.list"])
    expect(rows[0]!.commandCount).toBe(COMMANDS.length)
    expect(rows[0]!.frontDoor).toEqual({ confidence: 0.97, impossible: "none", routed: true })
    expect(rows[0]!.outcome).toBeNull()
  })

  test("the outbound Jev request carries the repository name and the tail, and never the hidden context", async () => {
    let sent: Record<string, unknown> = {}
    await turn(
      turnBody({
        messages: [
          { role: "user", content: "what does this repo do?" },
          { role: "assistant", content: "It is a control plane." },
          { role: "user", content: "show me my runs" }
        ]
      }),
      {
        jev: (request) => {
          void request.json().then((body) => {
            sent = body as Record<string, unknown>
          })
          return evaluation("runs.list", 0.97)
        }
      }
    )
    // The body is read on the same microtask queue as the response above.
    await Promise.resolve()
    const state = sent.state as { repository: string; conversation: string; message: string }
    expect(Object.keys(state).sort()).toEqual(["conversation", "message", "repository"])
    expect(state.repository).toBe("smithersai/smithers")
    // The decision is about the message the user just sent; everything before
    // it is context, and it is not repeated inside that context.
    expect(state.message).toBe("show me my runs")
    expect(state.conversation).toBe("user: what does this repo do?\nassistant: It is a control plane.")
    const serialized = JSON.stringify(sent)
    expect(serialized).not.toContain("octocat")
    expect(serialized).not.toContain("github")
    expect((sent.providerOptions as { gateway: { zeroDataRetention: boolean } }).gateway.zeroDataRetention).toBe(true)
  })

  test("an earlier command-shaped message stays in `conversation`: the question the user just asked is the one decided", async () => {
    /*
     * The live regression this pins: "run a flow" earlier in the transcript
     * with no assistant reply under it, then a plain question. Jev read the
     * whole tail as one blob and kept re-deciding the older sentence, so the
     * question was routed and the same command fired turn after turn. The
     * decision now reads `message`, and the older sentence can only be
     * context.
     */
    let sent: Record<string, unknown> = {}
    await turn(
      turnBody({
        messages: [
          { role: "user", content: "run a flow" },
          { role: "user", content: "In one sentence, what is a durable flow?" }
        ]
      }),
      {
        jev: (request) => {
          void request.json().then((body) => {
            sent = body as Record<string, unknown>
          })
          return evaluation("none", 0.99)
        }
      }
    )
    await Promise.resolve()
    const state = sent.state as { conversation: string; message: string }
    expect(state.message).toBe("In one sentence, what is a durable flow?")
    expect(state.conversation).toBe("user: run a flow")
    expect(state.conversation).not.toContain("durable flow")
  })

  test("a first message has no earlier conversation, and says so rather than repeating itself", async () => {
    let sent: Record<string, unknown> = {}
    await turn(turnBody(), {
      jev: (request) => {
        void request.json().then((body) => {
          sent = body as Record<string, unknown>
        })
        return evaluation("runs.list", 0.97)
      }
    })
    await Promise.resolve()
    const state = sent.state as { conversation: string; message: string }
    expect(state.message).toBe("show me my runs")
    expect(state.conversation).toBe("(no earlier messages)")
  })

  test("`none` spends the upstream exactly as before, and the fall-through is logged", async () => {
    const logs = memoryLog()
    const { response, calls } = await turn(turnBody(), { jev: () => evaluation("none", 0.99, "email"), logs })

    expect(response.status).toBe(200)
    expect(calls.upstream.length).toBe(1)
    const rows = await rowsOf(logs)
    expect(rows[0]!.commands).toEqual([])
    expect(rows[0]!.frontDoor).toEqual({ confidence: 0.99, impossible: "email", routed: false })
  })

  test("a command under the confidence floor goes upstream", async () => {
    const logs = memoryLog()
    const { calls } = await turn(turnBody(), { jev: () => evaluation("runs.list", 0.6), logs })

    expect(0.6).toBeLessThan(FRONT_DOOR_CONFIDENCE_FLOOR)
    expect(calls.upstream.length).toBe(1)
    const rows = await rowsOf(logs)
    expect(rows[0]!.frontDoor).toEqual({ confidence: 0.6, impossible: "none", routed: false })
  })

  test("a choice with no probabilities is an unmeasured lean, so the turn goes upstream", async () => {
    const { calls } = await turn(turnBody(), {
      jev: () =>
        new Response(JSON.stringify({ answers: { command: { type: "choice", choice: "runs.list" } } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    })
    expect(calls.upstream.length).toBe(1)
  })

  test("a body without commands goes upstream and Jev is never asked", async () => {
    const { calls } = await turn(turnBody({ commands: undefined }))
    expect(calls.gateway).toEqual([])
    expect(calls.upstream.length).toBe(1)
  })

  test("a malformed command list is dropped, never refused: the turn goes upstream and Jev is never asked", async () => {
    const { response, calls } = await turn(turnBody({ commands: [{ name: "", summary: 7 }] }))
    expect(response.status).toBe(200)
    expect(calls.gateway).toEqual([])
    expect(calls.upstream.length).toBe(1)
  })

  test("a tool-loop continuation is never read by Jev", async () => {
    const { calls } = await turn(turnBody({
      messages: [
        { role: "user", content: "show me my runs" },
        { type: "function_call", call_id: "call_1", name: "commands", arguments: "{\"action\":\"list\"}" },
        { type: "function_call_output", call_id: "call_1", output: "{}" }
      ]
    }))
    expect(calls.gateway).toEqual([])
    expect(calls.upstream.length).toBe(1)
  })

  test("a turn whose last message is the assistant's is not a front-door turn", async () => {
    const { calls } = await turn(turnBody({
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]
    }))
    expect(calls.gateway).toEqual([])
    expect(calls.upstream.length).toBe(1)
  })

  test("the leg answering this Worker's own tool call ends the turn on `done` alone, with no text of its own", async () => {
    const callId = `${FRONT_DOOR_CALL_PREFIX}b0a1`
    const { response, calls } = await turn(turnBody({
      messages: [
        { role: "user", content: "show me my runs" },
        { type: "function_call", call_id: callId, name: "commands", arguments: JSON.stringify({ action: "execute", name: "runs.list" }) },
        { type: "function_call_output", call_id: callId, output: "executed /runs.list" }
      ]
    }))

    expect(calls.gateway).toEqual([])
    expect(calls.upstream).toEqual([])
    /*
     * The act the client already rendered from the registry's own result IS
     * the answer, and the client keeps it as the turn's assistant words. A
     * delta here echoed the command name under that line as a second,
     * wordless bubble which read as success even when the act had failed.
     */
    expect(await frames(response)).toEqual([{ runId: "run-front-door", type: "done", reason: "stop" }])
  })

  test("a forged front-door call id whose pair names no command is not answered here", async () => {
    const callId = `${FRONT_DOOR_CALL_PREFIX}forged`
    const { calls } = await turn(turnBody({
      messages: [
        { role: "user", content: "show me my runs" },
        { type: "function_call", call_id: callId, name: "commands", arguments: "{\"action\":\"execute\"}" },
        { type: "function_call_output", call_id: callId, output: "executed" }
      ]
    }))

    expect(calls.upstream.length).toBe(1)
  })
})

/*
 * The rule: Jev is the main model, and when it is unavailable the turn FAILS.
 * There is no fallback to the chat upstream, because an LLM answering in
 * Jev's place is the outage nobody sees. Every refusal below is the same
 * typed failure a cloud role turn answers with for its own unavailable model
 * (cloudRoleTurn.ts), so one client vocabulary covers both.
 */
describe("a Jev that does not answer refuses the turn", () => {
  const refused = async (
    jev: (request: Request) => Response | Promise<Response>
  ): Promise<{ readonly status: number; readonly code: string; readonly message: string; readonly calls: Calls }> => {
    const logs = memoryLog()
    const { response, calls } = await turn(turnBody(), { jev, logs })
    const body = (await response.json()) as { status: string; code: string; message: string }
    expect(body.status).toBe("error")
    // A turn nobody decided leaves no row: the log holds decisions only.
    expect(await rowsOf(logs)).toEqual([])
    return { status: response.status, code: body.code, message: body.message, calls }
  }

  test("a refused gateway is upstream_refused, and the chat upstream is never asked instead", async () => {
    const { status, code, message, calls } = await refused(() => new Response("no", { status: 403 }))
    expect(status).toBe(502)
    expect(code).toBe("upstream_refused")
    expect(message).toBe("Smithers' decision model refused that just now. Try again in a moment.")
    expect(calls.gateway.length).toBe(1)
    expect(calls.upstream).toEqual([])
  })

  test("the gateway's own rate limit is model_rate_limited, not a reason to spend the upstream", async () => {
    const { status, code, calls } = await refused(() => new Response("slow down", { status: 429 }))
    expect(status).toBe(429)
    expect(code).toBe("model_rate_limited")
    expect(calls.upstream).toEqual([])
  })

  test("a 200 whose decision this client cannot read is model_no_answer", async () => {
    const cases = [
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ answers: { command: { type: "score", score: 4 } } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    ]
    for (const answer of cases) {
      const { status, code, calls } = await refused(() => answer.clone())
      expect(status).toBe(502)
      expect(code).toBe("model_no_answer")
      expect(calls.upstream).toEqual([])
    }
  })

  test("a gateway that misses the deadline is upstream_timeout", async () => {
    const slow = new Promise<Response>((resolve) => {
      setTimeout(() => resolve(evaluation("runs.list", 0.99)), RECOMMEND_JEV_TIMEOUT_MS * 3)
    })
    const { status, code, message, calls } = await refused(() => slow)
    expect(status).toBe(504)
    expect(code).toBe("upstream_timeout")
    expect(message).toBe("Smithers' decision model took too long to answer. Try again in a moment.")
    expect(calls.gateway.length).toBe(1)
    expect(calls.upstream).toEqual([])
  }, 10_000)

  test("an unreachable gateway is upstream_unreachable", async () => {
    const { status, code, message, calls } = await refused(() => {
      throw new TypeError("fetch failed")
    })
    expect(status).toBe(502)
    expect(code).toBe("upstream_unreachable")
    expect(message).toBe("Smithers' decision model can't be reached right now. Try again in a moment.")
    expect(calls.upstream).toEqual([])
  })

  test("with no AI_GATEWAY_API_KEY the turn is seam_not_configured without naming the key, and the upstream is never asked", async () => {
    const { response, calls } = await turn(turnBody(), { config: { aiGatewayApiKey: undefined } })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { code: string; message: string }
    expect(body.code).toBe("seam_not_configured")
    expect(body.message).toBe("Smithers can't read this turn on this deployment.")
    expect(calls.gateway).toEqual([])
    expect(calls.upstream).toEqual([])
  })

  test("a Jev that fails a split catalog refuses the turn too, with the same typed failure", async () => {
    const { response, calls } = await turn(turnBody({ commands: catalog(300) }), { jev: () => new Response("no", { status: 403 }) })
    expect(response.status).toBe(502)
    expect((await response.json() as { code: string }).code).toBe("upstream_refused")
    expect(calls.gateway.length).toBe(1)
    expect(calls.upstream).toEqual([])
  })
})

/*
 * A catalog of any size is still Jev's decision. One request carries the
 * commands as several `choice` questions — each at most
 * FRONT_DOOR_JEV_COMMANDS_MAX commands plus its own `none` — and one
 * `boolean` question asking whether the message is a request to run a command
 * at all. Probabilities from different questions are never compared: the turn
 * is routed only when the boolean clears its floor, exactly one question
 * names a command, and that command clears the confidence floor.
 */
describe("a catalog too long for one choice question", () => {
  /** What the live client offers today: below the cap, so the live path must not move. */
  const LIVE_COMMANDS = 194

  const questionsOf = async (calls: Calls): Promise<Record<string, { type: string; criteria?: Record<string, string> }>> =>
    ((await calls.gateway[0]!.json()) as {
      questions: Record<string, { type: string; criteria?: Record<string, string> }>
    }).questions

  test("today's catalog asks exactly what it asked before: one `command` question, and no boolean gate", async () => {
    const commands = catalog(LIVE_COMMANDS)
    expect(commands.length).toBeLessThanOrEqual(FRONT_DOOR_JEV_COMMANDS_MAX)
    const { response, calls } = await turn(turnBody({ commands }), {
      jev: () => answered({ command: chose("c7", 0.97), impossible: { type: "choice", choice: "none" } })
    })

    const questions = await questionsOf(calls)
    expect(Object.keys(questions)).toEqual(["command", "impossible"])
    expect(Object.keys(questions["command"]!.criteria!)).toEqual([...commands.map((command) => command.name), "none"])
    expect(questions["command"]!.criteria!["c0"]).toBe("does 0")
    // Unchanged routing: the same tool-call pair, on the same one question.
    expect(calls.upstream).toEqual([])
    expect((await frames(response))[0]).toMatchObject({
      type: "tool_call",
      arguments: JSON.stringify({ action: "execute", name: "c7" })
    })
  })

  test("three hundred commands ride two choice questions and one boolean in ONE request", async () => {
    const commands = catalog(300)
    const { calls } = await turn(turnBody({ commands }), {
      jev: () =>
        answered({
          command1: chose("none", 0.98),
          command2: chose("none", 0.98),
          isCommand: { type: "boolean", probability: 0.1 },
          impossible: { type: "choice", choice: "none" }
        })
    })

    expect(calls.gateway.length).toBe(1)
    const questions = await questionsOf(calls)
    expect(Object.keys(questions)).toEqual(["command1", "command2", "isCommand", "impossible"])
    expect(questions["isCommand"]!.type).toBe("boolean")
    expect(Object.keys(questions["command1"]!.criteria!).length).toBe(FRONT_DOOR_JEV_COMMANDS_MAX + 1)
    expect(Object.keys(questions["command2"]!.criteria!).length).toBe(300 - FRONT_DOOR_JEV_COMMANDS_MAX + 1)
    // Every command is offered exactly once, and every question offers `none`.
    const offered = [questions["command1"]!, questions["command2"]!].flatMap((question) =>
      Object.keys(question.criteria!).filter((name) => name !== "none")
    )
    expect(offered).toEqual(commands.map((command) => command.name))
    expect(questions["command1"]!.criteria!["none"]).toBe(questions["command2"]!.criteria!["none"])
  })

  test("one confident command in the second question, `none` in the first, routes the turn", async () => {
    const logs = memoryLog()
    const { response, calls } = await turn(turnBody({ commands: catalog(300) }), {
      logs,
      jev: () =>
        answered({
          command1: chose("none", 0.99),
          command2: chose("c260", 0.96),
          isCommand: { type: "boolean", probability: 0.98 },
          impossible: { type: "choice", choice: "none" }
        })
    })

    expect(calls.upstream).toEqual([])
    const emitted = await frames(response)
    expect(emitted[0]).toMatchObject({ type: "tool_call", name: "commands", arguments: JSON.stringify({ action: "execute", name: "c260" }) })
    expect(emitted[1]).toEqual({ runId: "run-front-door", type: "done", reason: "tool_call" })
    const rows = await rowsOf(logs)
    expect(rows[0]!.commands).toEqual(["c260"])
    expect(rows[0]!.commandCount).toBe(300)
    expect(rows[0]!.frontDoor).toEqual({ confidence: 0.96, impossible: "none", routed: true })
  })

  test("`none` in every question is Jev choosing the concierge, and the row is as sure as the least sure question", async () => {
    const logs = memoryLog()
    const { calls } = await turn(turnBody({ commands: catalog(300) }), {
      logs,
      jev: () =>
        answered({
          command1: chose("none", 0.97),
          command2: chose("none", 0.99),
          isCommand: { type: "boolean", probability: 0.05 },
          impossible: { type: "choice", choice: "none" }
        })
    })

    expect(calls.upstream.length).toBe(1)
    const rows = await rowsOf(logs)
    expect(rows[0]!.commands).toEqual([])
    expect(rows[0]!.frontDoor).toEqual({ confidence: 0.97, impossible: "none", routed: false })
  })

  test("two questions both naming a command is ambiguity, not a decision: the concierge answers", async () => {
    const logs = memoryLog()
    const { response, calls } = await turn(turnBody({ commands: catalog(300) }), {
      logs,
      jev: () =>
        answered({
          command1: chose("c3", 0.96),
          command2: chose("c260", 0.97),
          isCommand: { type: "boolean", probability: 0.99 },
          impossible: { type: "choice", choice: "none" }
        })
    })

    // Both clear the floor, and no probability from one question can be
    // compared with one from the other, so neither command is the answer.
    expect(calls.upstream.length).toBe(1)
    // The concierge's own answer, streamed through this turn.
    expect((await frames(response))[0]).toMatchObject({ type: "delta", text: "upstream" })
    const rows = await rowsOf(logs)
    expect(rows[0]!.commands).toEqual([])
    expect(rows[0]!.frontDoor).toEqual({ confidence: 0, impossible: "none", routed: false })
  })

  test("a command under the floor in one question and `none` in the other still goes to the concierge", async () => {
    const { calls } = await turn(turnBody({ commands: catalog(300) }), {
      jev: () =>
        answered({
          command1: chose("none", 0.99),
          command2: chose("c260", 0.6),
          isCommand: { type: "boolean", probability: 0.99 },
          impossible: { type: "choice", choice: "none" }
        })
    })
    expect(0.6).toBeLessThan(FRONT_DOOR_CONFIDENCE_FLOOR)
    expect(calls.upstream.length).toBe(1)
  })

  test("a sure command under an unsure `isCommand` is not routed", async () => {
    const logs = memoryLog()
    const { calls } = await turn(turnBody({ commands: catalog(300) }), {
      logs,
      jev: () =>
        answered({
          command1: chose("none", 0.99),
          command2: chose("c260", 0.97),
          isCommand: { type: "boolean", probability: 0.3 },
          impossible: { type: "choice", choice: "none" }
        })
    })

    expect(0.3).toBeLessThan(FRONT_DOOR_IS_COMMAND_FLOOR)
    expect(calls.upstream.length).toBe(1)
    const rows = await rowsOf(logs)
    expect(rows[0]!.frontDoor).toEqual({ confidence: 0.97, impossible: "none", routed: false })
  })

  test("a split answer missing the boolean gate is model_no_answer, not a route and not an upstream", async () => {
    const logs = memoryLog()
    const { response, calls } = await turn(turnBody({ commands: catalog(300) }), {
      logs,
      jev: () => answered({ command1: chose("none", 0.99), command2: chose("c260", 0.97) })
    })

    expect(response.status).toBe(502)
    expect((await response.json() as { code: string }).code).toBe("model_no_answer")
    expect(calls.upstream).toEqual([])
    expect(await rowsOf(logs)).toEqual([])
  })

  test("a split answer missing one command question is model_no_answer: a decision this client cannot read is not a decision", async () => {
    const { response, calls } = await turn(turnBody({ commands: catalog(300) }), {
      jev: () => answered({ command2: chose("c260", 0.97), isCommand: { type: "boolean", probability: 0.99 } })
    })

    expect(response.status).toBe(502)
    expect((await response.json() as { code: string }).code).toBe("model_no_answer")
    expect(calls.upstream).toEqual([])
  })
})

describe("the front-door seat: the decision model a turn arms", () => {
  const JEV_BINDING = { protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY" }

  const refusedBinding = async (decisionModel: unknown, config?: Partial<ServerConfigShape>) => {
    const logs = memoryLog()
    const { response, calls } = await turn(turnBody({ decisionModel }), { logs, ...(config === undefined ? {} : { config }) })
    const body = (await response.json()) as { status: string; code: string; message: string }
    // Refused before anything is spent: no Jev, no concierge, no row.
    expect(calls.gateway).toEqual([])
    expect(calls.upstream).toEqual([])
    expect(await rowsOf(logs)).toEqual([])
    return { status: response.status, code: body.code, message: body.message }
  }

  test("an allowed binding is the id Jev is asked by, and the id the row records", async () => {
    const logs = memoryLog()
    const { response, calls } = await turn(turnBody({ decisionModel: JEV_BINDING }), { jev: () => evaluation("runs.list", 0.97), logs })
    expect(response.status).toBe(200)
    expect(calls.gateway.map((request) => request.headers.get("ai-model-id"))).toEqual(["typesafe-ai/jev"])
    expect(calls.upstream).toEqual([])
    expect((await rowsOf(logs)).map((row) => row.model)).toEqual(["typesafe-ai/jev"])
  })

  test("the id on the wire is the one handed in, not a constant", async () => {
    const asked: Array<string | null> = []
    const transport = transportLayer(async (input, init) => {
      asked.push(new Request(input as string, init).headers.get("ai-model-id"))
      return evaluation("runs.list", 0.97)
    })
    const body = turnBody()
    await Effect.runPromise(
      askFrontDoor({ ...body, messages: [{ role: "user", content: "show me my runs" }] }, COMMANDS, "typesafe-ai/next").pipe(
        Effect.provide(Layer.mergeAll(transport, testConfigLayer(GATEWAY_KEY)))
      )
    )
    expect(asked).toEqual(["typesafe-ai/next"])
  })

  test("an id off the allowlist is request_invalid, never the default Jev and never the concierge", async () => {
    const refused = await refusedBinding({ ...JEV_BINDING, modelId: "openai/gpt-x" })
    expect(refused.status).toBe(400)
    expect(refused.code).toBe("request_invalid")
    expect(refused.message).not.toContain("openai/gpt-x")
  })

  test("a generation binding, an unpinned address and an unknown credential are each request_invalid", async () => {
    for (const decisionModel of [
      { protocol: "openai-chat", baseUrl: "https://api.cerebras.ai", modelId: "gpt-oss-120b", credential: "CEREBRAS_API_KEY" },
      { ...JEV_BINDING, baseUrl: "https://attacker.test" },
      { ...JEV_BINDING, baseUrl: "https://ai-gateway.vercel.sh/elsewhere" },
      { ...JEV_BINDING, credential: "GITHUB_TOKEN" }
    ]) {
      const refused = await refusedBinding(decisionModel)
      expect([decisionModel, refused.status, refused.code]).toEqual([decisionModel, 400, "request_invalid"])
    }
  })

  test("a binding that is not one is request_invalid at the body, and an extra key cannot ride it", async () => {
    for (const decisionModel of [null, "typesafe-ai/jev", { ...JEV_BINDING, apiKey: "vck-smuggled" }]) {
      const refused = await refusedBinding(decisionModel)
      expect([refused.status, refused.code]).toEqual([400, "request_invalid"])
      expect(refused.message).not.toContain("vck-smuggled")
    }
  })

  test("an allowed binding on a deployment without the key is seam_not_configured, naming the key", async () => {
    const refused = await refusedBinding(JEV_BINDING, { aiGatewayApiKey: undefined })
    expect(refused.status).toBe(503)
    expect(refused.code).toBe("seam_not_configured")
    expect(refused.message).toContain("AI_GATEWAY_API_KEY")
  })

  test("a bad binding refuses even a turn the front door would not read", async () => {
    const { response, calls } = await turn(turnBody({ commands: undefined, decisionModel: { ...JEV_BINDING, modelId: "openai/gpt-x" } }))
    expect(response.status).toBe(400)
    expect(calls.upstream).toEqual([])
  })
})
