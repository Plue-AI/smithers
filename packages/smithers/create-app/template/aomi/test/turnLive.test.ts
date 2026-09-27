/**
 * The Worker's turn, run for real in Node.
 *
 * `worker/turnImpl.ts` runs `@smthrs/create-app/worker`'s `runTurn` on the
 * host `worker/host.ts` builds, and writes the turn into the session as its
 * frames pass. The seat replays the committed chat fixture, so this reaches no
 * network; everything between the recorded model and the session is the code
 * a deployed Worker runs. There is no mock turn: a host missing a key or the
 * fork endpoint is refused before anything is written.
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { paneNames } from "../routes.gen.ts"
import { type AppCard, type Message, type SessionSummary, TurnFrame } from "../src/api.ts"
import type { Env } from "../worker/env.ts"
import { hostFor } from "../worker/host.ts"
import { runTurn, type TurnSession } from "../worker/turnImpl.ts"
import { fixtures, nodeHost, recordedHost, scriptedSeat } from "./support/recordedHost.ts"

const env = { APP_NAME: "turn-test" } as Env

const memorySession = () => {
  const messages: Array<Message> = []
  const cards: Array<AppCard> = []
  const statuses: Array<SessionSummary["status"]> = []
  const session: TurnSession = {
    appendMessage: (role, text) => {
      const message = { id: `message-${messages.length}`, role, text, at: 1 }
      messages.push(message)
      return message
    },
    appendCard: (card) => void cards.push(card),
    writeFlow: () => ({ files: [] }),
    listFlows: () => [],
    settle: (status) => void statuses.push(status)
  }
  return { session, messages, cards, statuses }
}

const request = { sessionId: "session-1", flowId: "chat", message: "What is vitalik.eth's ETH balance on mainnet?" }

const read = async (body: ReadableStream<Uint8Array>): Promise<Array<TurnFrame>> =>
  (await new Response(body).text()).trim().split("\n").map((line) =>
    Schema.decodeUnknownSync(TurnFrame)(JSON.parse(line))
  )

describe("a live turn", () => {
  it("streams the model's turn, persists its card and answer, and settles ready", async () => {
    const sink = memorySession()
    const body = await runTurn({
      env,
      session: sink.session,
      request,
      signal: new AbortController().signal,
      seams: recordedHost(fixtures.chat)
    })
    if (!(body instanceof ReadableStream)) throw new Error(`refused: ${JSON.stringify(body)}`)
    const frames = await read(body)

    const types = frames.map((frame) => frame.type)
    expect(types).toContain("delta")
    expect(types).toContain("cell")
    expect(types.filter((type) => type === "done" || type === "error")).toEqual(["done"])
    expect(types.at(-1)).toBe("done")

    const painted = frames.flatMap((frame) => frame.type === "card" ? [frame.card] : [])
    expect(painted.length).toBeGreaterThan(0)
    for (const card of painted) {
      if (card.kind === "pane") expect(paneNames).toContain(card.name)
    }
    expect(sink.cards).toEqual(painted)

    const done = frames.at(-1) as Extract<TurnFrame, { type: "done" }>
    const answer = (done.output as { answer: string }).answer
    expect(sink.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", request.message],
      ["assistant", answer]
    ])
    expect(sink.statuses).toEqual(["ready"])
  })

  it("a cancelled turn ends in one error frame and settles idle", async () => {
    const sink = memorySession()
    const controller = new AbortController()
    const body = await runTurn({
      env,
      session: sink.session,
      request,
      signal: controller.signal,
      seams: recordedHost(fixtures.chat)
    })
    if (!(body instanceof ReadableStream)) throw new Error("refused")
    controller.abort()
    const frames = await read(body)
    expect(frames.at(-1)).toEqual({ type: "error", message: "The turn was cancelled." })
    expect(frames.filter((frame) => frame.type === "done" || frame.type === "error")).toHaveLength(1)
    expect(sink.statuses).toEqual(["idle"])
    expect(sink.messages.map((message) => message.role)).toEqual(["user"])
  })

  it("a reader that hangs up interrupts the run and still settles the session once", async () => {
    const sink = memorySession()
    const controller = new AbortController()
    const body = await runTurn({
      env,
      session: sink.session,
      request,
      signal: controller.signal,
      seams: recordedHost(fixtures.chat)
    })
    if (!(body instanceof ReadableStream)) throw new Error("refused")
    controller.abort()
    await body.cancel("client gone")
    expect(sink.statuses).toEqual(["idle"])
  })
})

describe("the session tools a turn binds", () => {
  it("show-script reads the cells this turn ran, and write-flow saves into the session", async () => {
    const saved: Array<[string, string, Record<string, string>]> = []
    const sink = memorySession()
    const session: TurnSession = {
      ...sink.session,
      writeFlow: (id, description, files) => {
        saved.push([id, description, files])
        return { files: Object.keys(files) }
      }
    }
    const cell = `const script = await ctx.call("flows/show-script", {})
const written = await ctx.call("flows/write-flow", {
  id: "vitalik-balance",
  description: "Reads one address's ETH balance",
  flowSource: "export {}",
  testSource: "export {}",
  fixtureJson: "{}"
})
await ctx.done({ answer: String(script.cells.length) + ":" + written.files.length, cards: [] })`
    const body = await runTurn({
      env,
      session,
      request,
      signal: new AbortController().signal,
      seams: nodeHost(scriptedSeat(cell))
    })
    if (!(body instanceof ReadableStream)) throw new Error(`refused: ${JSON.stringify(body)}`)
    const frames = await read(body)
    expect(frames.at(-1)).toMatchObject({ type: "done", output: { answer: "1:3" } })
    expect(saved).toEqual([[
      "vitalik-balance",
      "Reads one address's ETH balance",
      {
        "flows/vitalik-balance/flow.ts": "export {}",
        "flows/vitalik-balance/flow.e2e.ts": "export {}",
        "flows/vitalik-balance/fixtures/vitalik-balance.json": "{}"
      }
    ]])
  })
})

describe("a turn the host cannot run", () => {
  const refused = async (overrides: Partial<Env>, seams: Parameters<typeof recordedHost>[1] = {}, flowId = "chat") => {
    const sink = memorySession()
    const result = await runTurn({
      env: { ...env, ...overrides },
      session: sink.session,
      request: { ...request, flowId },
      signal: new AbortController().signal,
      seams: { ...recordedHost(fixtures.chat), seats: undefined, evaluator: undefined, ...seams }
    })
    if (result instanceof ReadableStream) throw new Error("expected a refusal")
    // Nothing is written for a turn that never ran.
    expect(sink.messages).toEqual([])
    expect(sink.statuses).toEqual([])
    return result
  }

  it("names the seat key it is missing", async () => {
    const result = await refused({})
    expect(result).toMatchObject({ status: 503, error: "host_unconfigured" })
    expect(result.message).toContain("OPENAI_API_KEY")
  })


  it("names the fork endpoint it is missing", async () => {
    const result = await refused({ OPENAI_API_KEY: "key" }, { chain: undefined })
    expect(result).toMatchObject({ status: 503, error: "host_unconfigured" })
    expect(result.message).toContain("TEVM_FORK_RPC_URL")
  })

  it("refuses a pipeline flow and an unrouted one", async () => {
    expect(await refused({}, {}, "build")).toMatchObject({ status: 400, error: "flow_not_chat" })
    expect(await refused({}, {}, "missing")).toMatchObject({ status: 400, error: "flow_not_routed" })
  })
})

describe("the Worker's chain", () => {
  it("binds the real fork over TEVM_FORK_RPC_URL and grants exactly its origin", async () => {
    const host = await hostFor(
      { ...env, TEVM_FORK_RPC_URL: "https://rpc.example:8443/v1" },
      memorySession().session,
      { card: () => undefined, delta: () => undefined, end: () => undefined },
      { ...recordedHost(fixtures.chat), chain: undefined }
    )
    if ("error" in host) throw new Error(host.message)
    const route = host.flows.find((flow) => flow.id === "chat")!
    const tools = host.tools!(route, { emit: () => undefined, update: () => undefined })
    expect(tools.grant).toEqual([{ action: "net:post", resource: "https://rpc.example:8443/*" }])
    const chain = tools.sources.find((source) => source.name === "tevm")!
    for (const binding of await Effect.runPromise(chain.bindings())) {
      expect(binding.descriptor.capabilities).toEqual(["net:post:https://rpc.example:8443/*"])
    }
  })
})
