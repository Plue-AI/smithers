/**
 * The turn host a Worker serves `POST /api/turn` with, driven in Node.
 *
 * The chat turn replays the default template's recorded fixture on the Node
 * QuickJS build with a scripted judge, so it reaches no network. What it holds
 * is the wire: text as `delta` frames, the pane card on the stream, one
 * terminal frame, one close; and every refusal decided before a stream opens.
 */
import { describe, expect, it } from "@effect/vitest"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import { make as makeModel } from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import { Fixture } from "@smthrs/testing/Fixture"
import * as RecordedModel from "@smthrs/testing/RecordedModel"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { readFileSync } from "node:fs"
import { defineFlow } from "../src/app.ts"
import { authorized } from "../src/http.ts"
import type { SeatProvider } from "../src/runtime.ts"
import { preparedRequest, replayModelError } from "../src/testing.ts"
import type { TurnFrame } from "../src/ui.ts"
import {
  layerCryptoWeb,
  resolveChatFlow,
  resolvePipelineFlow,
  runFlow,
  runTurn,
  seatsFromEnv,
  type TurnEndpoint,
  type TurnHost,
  turnResponse,
  type TurnRoute
} from "../src/worker.ts"
import { flows as routed, paneNames } from "../template/default/routes.gen.ts"
import { turnSource, ui } from "../template/default/tools/ui.ts"
import { type Env, handle } from "../template/default/worker/handle.ts"

const flows = routed as unknown as ReadonlyArray<TurnRoute>

const recorded = async (): Promise<SeatProvider> => {
  const url = new URL("../template/default/flows/chat/fixtures/answer.json", import.meta.url)
  const fixture = Schema.decodeUnknownSync(Fixture)(JSON.parse(readFileSync(url, "utf8")))
  const replay = await Effect.runPromise(RecordedModel.make(fixture))
  const model = makeModel({
    stream: (request) =>
      replay.model.stream(request).pipe(
        Stream.mapError(replayModelError),
        Stream.map((event): ModelEvent.ModelEvent => event)
      )
  })
  return { resolve: () => Effect.succeed({ model, route: { prepare: () => Effect.succeed(preparedRequest) } }) }
}

const host = async (overrides: Partial<TurnHost> = {}): Promise<TurnHost> => ({
  flows,
  env: {},
  sandboxVariant: QuickJSSandbox.layerVariantLive,
  seats: await recorded(),
  evaluator: ScriptedJudge.layer,
  tools: (route, cards) => ({
    ...route.tools,
    sources: route.tools.sources.map((source) => source === ui ? turnSource(cards, paneNames) : source)
  }),
  ...overrides
})

const read = async (stream: ReadableStream<Uint8Array>): Promise<ReadonlyArray<TurnFrame>> => {
  const text = await new Response(stream).text()
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as TurnFrame)
}

const question = { flow: "chat", payload: { message: "What does durable execution buy me?" } }

describe("runTurn", () => {
  it("streams deltas, cells, calls, the pane card, and one done frame", async () => {
    const stream = await runTurn(await host(), question)
    if (!(stream instanceof ReadableStream)) throw new Error(`refused: ${JSON.stringify(stream)}`)
    const frames = await read(stream)
    const types = frames.map((frame) => frame.type)
    expect(types).toContain("delta")
    expect(types).toContain("cell")
    expect(types).toContain("call")
    expect(frames.filter((frame) => frame.type === "card" && frame.card.kind === "pane")).toHaveLength(1)
    const last = frames.at(-1)!
    expect(last.type).toBe("done")
    expect(types.filter((type) => type === "done" || type === "error")).toHaveLength(1)
    const output = (last as Extract<TurnFrame, { type: "done" }>).output as { answer: string }
    expect(output.answer.trim().length).toBeGreaterThan(0)
    const call = frames.find((frame) => frame.type === "call") as Extract<TurnFrame, { type: "call" }>
    expect(call.flow).toBe("ui/pane")
    expect(call.input).toMatchObject({ name: "message" })
  })

  it("runs the route's own tools when the host rebinds none", async () => {
    const stream = await runTurn(await host({ tools: undefined }), question)
    if (!(stream instanceof ReadableStream)) throw new Error("refused")
    const frames = await read(stream)
    expect(frames.some((frame) => frame.type === "card")).toBe(false)
    expect(frames.at(-1)!.type).toBe("done")
  })

  it("ends an aborted turn with one error frame and closes", async () => {
    const controller = new AbortController()
    controller.abort()
    const stream = await runTurn(await host(), question, controller.signal)
    if (!(stream instanceof ReadableStream)) throw new Error("refused")
    const frames = await read(stream)
    expect(frames).toEqual([{ type: "error", message: "The turn was cancelled." }])
  })

  it("ends a turn aborted mid-run with one error frame", async () => {
    const controller = new AbortController()
    const stream = await runTurn(await host(), question, controller.signal)
    if (!(stream instanceof ReadableStream)) throw new Error("refused")
    controller.abort()
    const frames = await read(stream)
    expect(frames.at(-1)).toEqual({ type: "error", message: "The turn was cancelled." })
    expect(frames.filter((frame) => frame.type === "done" || frame.type === "error")).toHaveLength(1)
  })

  it("delivers cards a tool paints while the host composes, ahead of the run", async () => {
    const card = { kind: "html" as const, id: "c1", html: "<p>hi</p>" }
    const stream = await runTurn(
      await host({
        tools: (route, cards) => {
          cards.emit(card)
          cards.update({ ...card, html: "<p>bye</p>" })
          return route.tools
        }
      }),
      question
    )
    if (!(stream instanceof ReadableStream)) throw new Error("refused")
    const frames = await read(stream)
    expect(frames.slice(0, 2)).toEqual([
      { type: "card", card },
      { type: "card.update", card: { ...card, html: "<p>bye</p>" } }
    ])
  })

  it("interrupts the run when the reader cancels", async () => {
    const stream = await runTurn(await host(), question)
    if (!(stream instanceof ReadableStream)) throw new Error("refused")
    await stream.cancel()
  })

  it("ends a turn whose payload the flow rejects with an error frame", async () => {
    const stream = await runTurn(await host(), { flow: "chat", payload: { message: 42 } })
    if (!(stream instanceof ReadableStream)) throw new Error("refused")
    const frames = await read(stream)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.type).toBe("error")
  })

  it("carries a refused call's message on its call frame", async () => {
    const stream = await runTurn(
      await host({
        tools: (route, cards) => ({
          ...route.tools,
          sources: route.tools.sources.map((source) => source === ui ? turnSource(cards, []) : source)
        })
      }),
      question
    )
    if (!(stream instanceof ReadableStream)) throw new Error("refused")
    const frames = await read(stream)
    const call = frames.find((frame) => frame.type === "call") as Extract<TurnFrame, { type: "call" }>
    expect(call.outcome).toBe("failure")
    expect(call.message).toContain("ui/pane")
    expect(frames.filter((frame) => frame.type === "done" || frame.type === "error")).toHaveLength(1)
  })

  it("hands every frame to the observer, the terminal one included, before the reader", async () => {
    const seen: Array<TurnFrame["type"]> = []
    const stream = await runTurn(await host({ observe: (frame) => void seen.push(frame.type) }), question)
    if (!(stream instanceof ReadableStream)) throw new Error("refused")
    const frames = await read(stream)
    expect(seen).toEqual(frames.map((frame) => frame.type))
    expect(seen.at(-1)).toBe("done")
  })

  it("observes the terminal frame of a run whose reader hung up", async () => {
    const seen: Array<TurnFrame> = []
    const stream = await runTurn(await host({ observe: (frame) => void seen.push(frame) }), question)
    if (!(stream instanceof ReadableStream)) throw new Error("refused")
    await stream.cancel()
    const terminal = () => seen.filter((frame) => frame.type === "done" || frame.type === "error")
    for (let tries = 0; terminal().length === 0 && tries < 500; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(seen.filter((frame) => frame.type === "done" || frame.type === "error")).toEqual([
      { type: "error", message: "The turn was cancelled." }
    ])
  })

  it("ends with the observer's failure when observing the terminal frame throws", async () => {
    const stream = await runTurn(
      await host({
        observe: (frame) => {
          if (frame.type === "done") throw new Error("could not persist the answer")
        }
      }),
      question
    )
    if (!(stream instanceof ReadableStream)) throw new Error("refused")
    const frames = await read(stream)
    // The observer is host code, so its text stays on the server.
    expect(frames.at(-1)).toEqual({ type: "error", message: "Something went wrong on our side. Not your fault." })
    expect(frames.filter((frame) => frame.type === "done" || frame.type === "error")).toHaveLength(1)
  })

  it("refuses a host whose tools cannot be composed before opening a stream", async () => {
    const refused = await runTurn(
      await host({
        tools: () => {
          throw "no tools"
        }
      }),
      question
    )
    expect(refused).toEqual({
      status: 503,
      error: "host_unconfigured",
      message: "Something went wrong on our side. Not your fault."
    })
  })

  it("keeps a thrown host error's text off the wire and shows a typed error's message", async () => {
    const secret = new Error("postgres://admin:hunter2@10.0.0.4/app refused the connection")
    const refused = await runTurn(
      await host({
        tools: () => {
          throw secret
        }
      }),
      question
    )
    expect(JSON.stringify(refused)).not.toContain("hunter2")
    const stream = await runTurn(await host(), { flow: "chat", payload: { message: 42 } })
    if (!(stream instanceof ReadableStream)) throw new Error("refused")
    const frames = await read(stream)
    expect(frames).toEqual([{ type: "error", message: "Expected string\n  at [\"message\"]" }])
  })

  it("refuses a seat with no credential before opening a stream", async () => {
    const refused = await runTurn(await host({ seats: undefined }), question)
    expect(refused).toMatchObject({ status: 503, error: "host_unconfigured" })
    expect((refused as { message: string }).message).toContain("ANTHROPIC_API_KEY")
  })

  it("uses the configured seat for judgment and rejects an invalid recorded verdict", async () => {
    const stream = await runTurn(await host({ evaluator: undefined }), question)
    expect(stream).toBeInstanceOf(ReadableStream)
    const frames = await read(stream as ReadableStream<Uint8Array>)
    expect(frames.at(-1)?.type).toBe("error")
    expect(frames.some((frame) => frame.type === "done")).toBe(false)
  })
})

describe("resolveChatFlow", () => {
  const build = defineFlow({
    description: "Not a chat flow.",
    payload: { topic: Schema.String },
    output: Schema.Struct({ answer: Schema.String }),
    prompt: ({ topic }) => topic
  })
  const table: ReadonlyArray<TurnRoute> = [...flows, { ...flows[0]!, id: "build", spec: build }]

  it("names the known flows for an unrouted id", () => {
    expect(resolveChatFlow(table, "nope")).toEqual({
      status: 400,
      error: "flow_not_routed",
      message: "No flow is routed as \"nope\"",
      known: ["chat", "build"]
    })
  })

  it("refuses a routed flow that is not a chat flow", () => {
    expect(resolveChatFlow(table, "build")).toEqual({
      status: 400,
      error: "flow_not_chat",
      message: "\"build\" is not a chat flow"
    })
  })
})

describe("runFlow", () => {
  // The chat route with `chat` off: the same prompt, so the same fixture replays.
  const pipeline: TurnRoute = { ...flows[0]!, id: "answer", spec: { ...flows[0]!.spec, chat: false } }

  it("runs a pipeline flow to one done frame with the same frames a turn streams", async () => {
    const stream = await runFlow(await host({ flows: [...flows, pipeline] }), { ...question, flow: "answer" })
    if (!(stream instanceof ReadableStream)) throw new Error(`refused: ${JSON.stringify(stream)}`)
    const frames = await read(stream)
    expect(frames.some((frame) => frame.type === "card")).toBe(true)
    expect(frames.at(-1)!.type).toBe("done")
    expect(frames.filter((frame) => frame.type === "done" || frame.type === "error")).toHaveLength(1)
  })

  it("refuses a chat flow and an unrouted one before opening a stream", async () => {
    expect(await runFlow(await host(), question)).toEqual({
      status: 400,
      error: "flow_not_pipeline",
      message: "\"chat\" is a chat flow; run it as a turn"
    })
    expect(await runFlow(await host(), { flow: "nope", payload: {} })).toMatchObject({
      status: 400,
      error: "flow_not_routed",
      known: ["chat"]
    })
  })

  it("resolves a pipeline route by id", () => {
    expect(resolvePipelineFlow([...flows, pipeline], "answer")).toBe(pipeline)
  })
})

describe("turnResponse", () => {
  const post = (body: string, method = "POST", headers: Record<string, string> = {}) =>
    new Request("https://app.test/api/turn", {
      method,
      ...(method === "POST" ? { body } : {}),
      headers: { "content-type": "application/json", authorization: "Bearer s3cret", ...headers }
    })
  const endpoint = async (overrides: Partial<TurnEndpoint> = {}): Promise<TurnEndpoint> => ({
    ...await host(),
    authorize: (request) => authorized(request, "s3cret"),
    ...overrides
  })

  it("refuses an unauthorized request before reading its body or resolving a seat", async () => {
    let resolved = 0
    const seats: SeatProvider = {
      resolve: () =>
        Effect.sync(() => {
          resolved += 1
        }).pipe(Effect.andThen(Effect.never))
    }
    const request = post(JSON.stringify(question), "POST", { authorization: "Bearer wrong" })
    const response = await turnResponse(request, await endpoint({ seats }))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: "unauthorized" })
    expect(request.bodyUsed).toBe(false)
    expect(resolved).toBe(0)
  })

  it("refuses a body past the cap with 413 and a non-JSON media type with 415", async () => {
    const big = JSON.stringify({ flow: "chat", payload: { message: "x".repeat(64 * 1024) } })
    expect((await turnResponse(post(big), await endpoint())).status).toBe(413)
    const small = await turnResponse(post(JSON.stringify(question)), await endpoint({ maxBodyBytes: 16 }))
    expect(small.status).toBe(413)
    expect(await small.json()).toMatchObject({ error: "invalid_request" })
    const text = await turnResponse(
      post(JSON.stringify(question), "POST", { "content-type": "text/plain" }),
      await endpoint()
    )
    expect(text.status).toBe(415)
  })

  it("serves the turn as NDJSON", async () => {
    const response = await turnResponse(post(JSON.stringify(question)), await endpoint())
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/x-ndjson")
    const frames = await read(response.body!)
    expect(frames.at(-1)!.type).toBe("done")
  })

  it("refuses a non-chat or unrouted flow with a typed 400", async () => {
    const response = await turnResponse(post(JSON.stringify({ flow: "nope", payload: {} })), await endpoint())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "flow_not_routed",
      message: "No flow is routed as \"nope\"",
      known: ["chat"]
    })
  })

  it("refuses a body that is not a turn request", async () => {
    for (const body of ["not json", JSON.stringify({ payload: {} })]) {
      const response = await turnResponse(post(body), await endpoint())
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: "invalid_request" })
    }
  })

  it("refuses a method other than POST", async () => {
    const response = await turnResponse(post("", "GET"), await endpoint())
    expect(response.status).toBe(405)
  })
})

describe("the default template's Worker", () => {
  const env: Env = {
    APP_NAME: "ledger",
    APP_API_TOKEN: "s3cret",
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) }
  }
  const turn = new Request("https://app.test/api/turn", {
    method: "POST",
    body: JSON.stringify(question),
    headers: { "content-type": "application/json", authorization: "Bearer s3cret" }
  })

  it("refuses a turn without the token before it resolves a seat", async () => {
    const anonymous = new Request(turn.clone(), { headers: { "content-type": "application/json" } })
    expect((await handle(anonymous, env, QuickJSSandbox.layerVariantLive)).status).toBe(401)
    const { APP_API_TOKEN: _, ...unset } = env
    expect((await handle(turn.clone(), unset, QuickJSSandbox.layerVariantLive)).status).toBe(401)
  })

  it("runs the chat flow at /api/turn and streams the pane card back", async () => {
    const { seats } = await host()
    const response = await handle(turn.clone(), env, QuickJSSandbox.layerVariantLive, {
      seats,
      evaluator: ScriptedJudge.layer
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/x-ndjson")
    const frames = await read(response.body!)
    expect(frames.some((frame) => frame.type === "delta")).toBe(true)
    expect(frames.filter((frame) => frame.type === "card" && frame.card.kind === "pane")).toHaveLength(1)
    expect(frames.at(-1)!.type).toBe("done")
  })

  it("answers 503 host_unconfigured, not a stub, when no secret is set", async () => {
    const response = await handle(turn.clone(), env, QuickJSSandbox.layerVariantLive)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "host_unconfigured" })
  })
})

describe("seatsFromEnv", () => {
  const resolve = (env: Record<string, string>, seat: string) =>
    Effect.runPromise(Effect.result(seatsFromEnv(env).resolve(seat)))

  it("resolves an anthropic seat, prefixed or not, and an openai seat from their keys", async () => {
    expect((await resolve({ ANTHROPIC_API_KEY: "k" }, "anthropic:claude-sonnet-4-5"))._tag).toBe("Success")
    expect((await resolve({ ANTHROPIC_API_KEY: "k" }, "claude-sonnet-4-5"))._tag).toBe("Success")
    expect((await resolve({ OPENAI_API_KEY: "k" }, "openai:gpt-5.5"))._tag).toBe("Success")
  })

  it("names the binding to set, and refuses an unknown provider", async () => {
    const missing = await resolve({ ANTHROPIC_API_KEY: "" }, "anthropic:claude-sonnet-4-5")
    expect(missing._tag === "Failure" && missing.failure.message).toContain("Set the ANTHROPIC_API_KEY secret")
    const unknown = await resolve({}, "mistral:large")
    expect(unknown._tag === "Failure" && unknown.failure.message).toContain("\"mistral\" has no route here")
  })
})

describe("layerCryptoWeb", () => {
  it("returns fresh random bytes and digests, and fails an unknown algorithm", async () => {
    const program = Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const a = yield* crypto.randomUUIDv4
      const b = yield* crypto.randomUUIDv4
      expect(a).not.toBe(b)
      const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode("x"))
      expect(digest.length).toBe(32)
      const failed = yield* Effect.flip(crypto.digest("NOPE" as "SHA-256", new Uint8Array()))
      expect(failed._tag).toBe("PlatformError")
    })
    await Effect.runPromise(program.pipe(Effect.provide(layerCryptoWeb)))
  })
})
