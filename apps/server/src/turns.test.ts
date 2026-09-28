import { describe, expect, test } from "bun:test"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import { testConfigLayer } from "./Config"
import { memoryStorage } from "./DurableStorage"
import type { NativeNamespace } from "./DurableStorage"
import { ExecutionContext, executionContextFrom } from "./Environment"
import type { NativeExecutionContext } from "./Environment"
import { StorageFailure } from "./Failures"
import { transportLayer } from "./Http"
import { recommendLogLayer } from "./recommend"
import {
  CANCEL_MONITOR_MS,
  CANCEL_POLL_MAX_MS,
  CANCEL_POLL_MS,
  handleCancel,
  handleTurn,
  MONITORING_LIMIT_ERROR,
  readStartTurn,
  taggedTurnFrames,
  TurnCancelRegistry,
  turnCancelsLayer,
  TurnCancels
} from "./turns"
import type { TurnStreamHooks } from "./turns"

/*
 * The turn pump and the kill switch, run as Effects over injected layers: no
 * router, no patched global fetch. The contract under test is the one the
 * router relies on: the done frame settles the registry before the client can
 * re-register the runId; a kill observed between chunks ends the stream with
 * the honest terminal frame and releases the upstream; a client that goes
 * away settles and releases too; and the silent-stream poll backs off and
 * stops at its allowance.
 */

const TURN = { runId: "run-effect", messages: [{ role: "user", content: "hi" }], instructions: "Be brief." }

const post = (body: unknown): Request =>
  new Request("https://mvp.test/api/agent/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

const ndjson = (...frames: ReadonlyArray<unknown>): string => frames.map((frame) => `${JSON.stringify(frame)}\n`).join("")

/** A registry namespace over in-memory objects that also remembers each runId's live generation. */
const memoryCancels = () => {
  const registries = new Map<string, TurnCancelRegistry>()
  const generations = new Map<string, string>()
  const settles: Array<string> = []
  const namespace: NativeNamespace = {
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let registry = registries.get(name)
      if (registry === undefined) {
        registry = new TurnCancelRegistry({ storage: memoryStorage() })
        registries.set(name, registry)
      }
      const object = registry
      return {
        fetch: async (request) => {
          const path = new URL(request.url).pathname
          if (path === "/settle") settles.push(name)
          const response = await object.fetch(request)
          if (path === "/register") {
            const body = (await response.clone().json()) as { generation?: string }
            if (body.generation !== undefined) generations.set(name, body.generation)
          }
          return response
        }
      }
    }
  }
  const stateOf = async (runId: string): Promise<string> => {
    const response = await namespace.get(namespace.idFromName(runId)).fetch(
      new Request("https://turn-cancel.internal/state", { headers: { "x-turn-generation": generations.get(runId) ?? "" } })
    )
    return ((await response.json()) as { state: string }).state
  }
  return { namespace, generations, settles, stateOf }
}

/** One upstream that emits `head` and then stays open until it is cancelled. */
const silentUpstream = (head = "") => {
  let cancelled: unknown = undefined
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const response = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          controller = c
          if (head !== "") c.enqueue(new TextEncoder().encode(head))
        },
        cancel(reason) {
          cancelled = reason
        }
      }),
      { status: 200, headers: { "content-type": "application/x-ndjson" } }
    )
  return { response, wasCancelled: () => cancelled !== undefined, close: () => controller.close() }
}

const layersFor = (
  upstream: (request: Request) => Response | Promise<Response>,
  cancels: NativeNamespace,
  ctx?: NativeExecutionContext
) =>
  Layer.mergeAll(
    transportLayer(async (input, init) => upstream(new Request(input, init))),
    testConfigLayer({ chatUrl: "https://upstream.test/chat", upstreamTimeoutMs: 5_000 }),
    turnCancelsLayer(cancels),
    // The turn route reaches the recommend log for its front-door decisions
    // (frontDoor.ts). No log is bound here, and none of these turns carries a
    // command catalog, so nothing is asked and nothing is appended.
    recommendLogLayer(undefined),
    Layer.succeed(ExecutionContext, executionContextFrom(ctx))
  )

const run = <A>(effect: Effect.Effect<A, never, any>, layers: Layer.Layer<any>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layers)))

/** Reads NDJSON frames one at a time from a response body. */
const frameReader = (response: Response) => {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  return {
    next: async (): Promise<Record<string, unknown> | "end"> => {
      for (;;) {
        const newline = buffer.indexOf("\n")
        if (newline !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (line.trim() !== "") return JSON.parse(line) as Record<string, unknown>
          continue
        }
        const { value, done } = await reader.read()
        if (done) return "end"
        buffer += decoder.decode(value, { stream: true })
      }
    },
    cancel: (reason?: string) => reader.cancel(reason)
  }
}

describe("handleTurn over the registry", () => {
  test("the done frame settles the registry while the frame is still in flight, so the runId can re-register", async () => {
    const cancels = memoryCancels()
    const upstream = silentUpstream(ndjson({ type: "delta", kind: "text", text: "hi" }, { type: "done", reason: "stop" }))
    const layers = layersFor(upstream.response, cancels.namespace)
    const response = await run(handleTurn(post(TURN)), layers)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/x-ndjson")
    const frames = frameReader(response)
    expect(await frames.next()).toEqual({ runId: "run-effect", type: "delta", kind: "text", text: "hi" })
    expect(await frames.next()).toEqual({ runId: "run-effect", type: "done", reason: "stop" })
    // Settled on the frame, not on the end of the body: the upstream is still open.
    expect(await cancels.stateOf("run-effect")).toBe("settled")
    expect(cancels.settles).toEqual(["run-effect"])
    // A continuation leg may claim the runId again at once.
    const next = await run(handleTurn(post(TURN)), layers)
    expect(next.status).toBe(200)
    await frames.cancel()
    await next.body!.cancel()
    // The new leg settles once its client hangs up; the old body's end
    // never settles the new registration (its generation is spent).
    await Bun.sleep(20)
    expect(cancels.settles).toEqual(["run-effect", "run-effect"])
    expect(await cancels.stateOf("run-effect")).toBe("settled")
  })

  test("a cancel between chunks emits the cancelled frame, cancels the upstream reader, and settles", async () => {
    const cancels = memoryCancels()
    const upstream = silentUpstream(ndjson({ type: "delta", kind: "text", text: "working" }))
    const layers = layersFor(upstream.response, cancels.namespace)
    const response = await run(handleTurn(post(TURN)), layers)
    const frames = frameReader(response)
    expect(await frames.next()).toEqual({ runId: "run-effect", type: "delta", kind: "text", text: "working" })
    const killed = await run(handleCancel(post({ runId: "run-effect" }), undefined), layers)
    expect(await killed.json()).toEqual({ status: "cancelled" })
    // The pump observes the kill on its poll tick while the upstream is silent.
    expect(await frames.next()).toEqual({ runId: "run-effect", type: "done", reason: "cancelled" })
    expect(await frames.next()).toBe("end")
    expect(upstream.wasCancelled()).toBe(true)
    expect(await cancels.stateOf("run-effect")).toBe("settled")
    const again = await run(handleCancel(post({ runId: "run-effect" }), undefined), layers)
    expect(await again.json()).toEqual({ status: "not-found" })
  })

  test("a client that cancels the body settles the registry under waitUntil and releases the upstream", async () => {
    const cancels = memoryCancels()
    const upstream = silentUpstream()
    const pending: Array<Promise<unknown>> = []
    const layers = layersFor(upstream.response, cancels.namespace, { waitUntil: (promise) => pending.push(promise) })
    const response = await run(handleTurn(post(TURN)), layers)
    expect(response.status).toBe(200)
    await response.body!.cancel("client disconnected")
    await Promise.all(pending)
    expect(pending.length).toBeGreaterThan(0)
    expect(upstream.wasCancelled()).toBe(true)
    expect(await cancels.stateOf("run-effect")).toBe("settled")
    expect(cancels.settles).toEqual(["run-effect"])
  })

  test("a client that goes away before the upstream answers settles the registration on interruption", async () => {
    const cancels = memoryCancels()
    let aborted = false
    const layers = layersFor(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            aborted = true
            reject(request.signal.reason)
          }, { once: true })
        }),
      cancels.namespace
    )
    const fiber = Effect.runFork(handleTurn(post(TURN)).pipe(Effect.provide(layers)))
    await Bun.sleep(20)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(aborted).toBe(true)
    expect(await cancels.stateOf("run-effect")).toBe("settled")
  })

  test("a registry whose storage fails answers 502, never 409, and spends no model", async () => {
    // The object answers its own storage failure as a 500 with the cause in
    // the body (turnCancelRequest); the route must read that as the registry
    // failing, not as "already-running".
    let upstreamCalls = 0
    const sealed: NativeNamespace = {
      idFromName: (name) => name,
      get: () => new TurnCancelRegistry({ storage: {
        get: () => Promise.reject(new Error("storage is sealed")),
        put: () => Promise.reject(new Error("storage is sealed"))
      } })
    }
    const layers = layersFor(() => {
      upstreamCalls += 1
      return new Response("{}")
    }, sealed)
    const logged: Array<Array<unknown>> = []
    const original = console.error
    console.error = (...args: Array<unknown>) => { logged.push(args) }
    try {
      const response = await run(handleTurn(post(TURN)), layers)
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({
        status: "error",
        code: "upstream_unreachable",
        message:
          "The turn registry is unreachable right now: Registry register returned 500: {\"status\":\"error\",\"code\":\"storage_failed\",\"message\":\"storage is sealed\"}"
      })
      expect(upstreamCalls).toBe(0)
      expect(logged[0]?.[0]).toBe("turn registry register failed:")
    } finally {
      console.error = original
    }
  })

  test("a registry that cannot register answers 502 and never spends the model", async () => {
    let upstreamCalls = 0
    const rejecting: NativeNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: () => Promise.reject(new Error("Durable Object reset")) })
    }
    const layers = layersFor(() => {
      upstreamCalls += 1
      return new Response("{}")
    }, rejecting)
    const original = console.error
    console.error = () => {}
    try {
      const response = await run(handleTurn(post(TURN)), layers)
      expect(response.status).toBe(502)
      expect(((await response.json()) as { message: string }).message).toContain("The turn registry")
      expect(upstreamCalls).toBe(0)
    } finally {
      console.error = original
    }
  })

  test("an anonymous turn is cancellable only from the address bucket that started it", async () => {
    const cancels = memoryCancels()
    const upstream = silentUpstream()
    const layers = layersFor(upstream.response, cancels.namespace)
    const from = (ip: string, body: unknown): Request =>
      new Request("https://mvp.test/api/agent/turn", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify(body)
      })
    const first = await run(handleTurn(from("198.51.100.9", TURN)), layers)
    expect(first.status).toBe(200)
    const stranger = await run(handleCancel(from("203.0.113.7", { runId: "run-effect" }), undefined), layers)
    expect(stranger.status).toBe(403)
    expect(await cancels.stateOf("run-effect")).toBe("active")
    const mine = await run(handleCancel(from("198.51.100.9", { runId: "run-effect" }), undefined), layers)
    expect(await mine.json()).toEqual({ status: "cancelled" })
    await first.body!.cancel()
  })

  test("the registry refuses a duplicate turn and lets only its owner cancel it", async () => {
    const cancels = memoryCancels()
    const upstream = silentUpstream()
    const layers = layersFor(upstream.response, cancels.namespace)
    const session = { login: "alice", allowlisted: true, admin: false, scopes: [] }
    const first = await run(handleTurn(post(TURN), session), layers)
    expect(first.status).toBe(200)
    const second = await run(handleTurn(post(TURN), session), layers)
    expect(second.status).toBe(409)
    const stranger = await run(handleCancel(post({ runId: "run-effect" }), { ...session, login: "bob" }), layers)
    expect(stranger.status).toBe(403)
    const mine = await run(handleCancel(post({ runId: "run-effect" }), session), layers)
    expect(await mine.json()).toEqual({ status: "cancelled" })
    await first.body!.cancel()
  })
})

describe("the tagged pump's silent-stream poll", () => {
  const silent = () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true } })
    return { body, wasCancelled: () => cancelled }
  }

  test("backs off from 500ms to 5000ms, stops at the allowance, aborts the upstream, settles, and says so", async () => {
    const polledAt: Array<number> = []
    const aborts: Array<string> = []
    let settled = 0
    const upstream = silent()
    const hooks: TurnStreamHooks = {
      isCancelled: Effect.map(Clock.currentTimeMillis, (now) => {
        polledAt.push(now)
        return false
      }),
      abort: (reason) => Effect.sync(() => { aborts.push(reason) }),
      settle: Effect.sync(() => { settled += 1 })
    }
    const frames = await Effect.runPromise(
      Effect.gen(function* () {
        const collecting = yield* Effect.forkChild(Stream.runCollect(taggedTurnFrames(upstream.body, "run-poll", hooks)))
        // The schedule the pump keeps while the upstream says nothing, run
        // past the eight-minute monitoring cap.
        const steps = [CANCEL_POLL_MS, 1000, 2000, 4000, CANCEL_POLL_MAX_MS]
        for (let index = 0; (yield* Clock.currentTimeMillis) <= CANCEL_MONITOR_MS; index += 1) {
          yield* TestClock.adjust(steps[Math.min(index, steps.length - 1)]!)
          yield* Effect.yieldNow
        }
        return yield* Fiber.join(collecting)
      }).pipe(Effect.provide(TestClock.layer()))
    )
    const decoded = [...frames].map((bytes) => JSON.parse(new TextDecoder().decode(bytes).trim()))
    expect(decoded).toEqual([{ runId: "run-poll", type: "done", reason: "stop", error: MONITORING_LIMIT_ERROR }])
    // Polls at 0, 500, 1500, 3500, 7500, then every 5000ms up to 477500: 99 polls, then the cap.
    expect(polledAt).toHaveLength(99)
    expect(polledAt.at(-1)).toBeLessThan(CANCEL_MONITOR_MS)
    const intervals = polledAt.slice(1).map((at, index) => at - polledAt[index]!)
    expect(intervals.slice(0, 5)).toEqual([500, 1000, 2000, 4000, 5000])
    expect(Math.max(...intervals)).toBe(CANCEL_POLL_MAX_MS)
    expect(aborts).toEqual(["limit"])
    expect(settled).toBe(1)
    expect(upstream.wasCancelled()).toBe(true)
  })

  test("a stream that never falls silent backs its polls off and outlives the old 48-second wall", async () => {
    // A poll is a subrequest. A chunk every 250ms for two minutes must not cost
    // one poll per 500ms (240 polls, the budget spent at 48 seconds): the
    // interval backs off to CANCEL_POLL_MAX_MS whether or not data flows.
    const polledAt: Array<number> = []
    const aborts: Array<string> = []
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c }, cancel: () => { cancelled = true } })
    const hooks: TurnStreamHooks = {
      isCancelled: Effect.map(Clock.currentTimeMillis, (now) => {
        polledAt.push(now)
        return false
      }),
      abort: (reason) => Effect.sync(() => { aborts.push(reason) }),
      settle: Effect.void
    }
    const chunkMs = 250
    const chunks = 120_000 / chunkMs
    const frames = await Effect.runPromise(
      Effect.gen(function* () {
        const collecting = yield* Effect.forkChild(Stream.runCollect(taggedTurnFrames(body, "run-stream", hooks)))
        for (let index = 0; index < chunks && !cancelled; index += 1) {
          yield* TestClock.adjust(chunkMs)
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "delta", kind: "text", text: `t${index}` })}\n`))
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
        }
        if (!cancelled) {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "done", reason: "stop" })}\n`))
          controller.close()
        }
        return yield* Fiber.join(collecting)
      }).pipe(Effect.provide(TestClock.layer()))
    )
    const decoded = [...frames].map((bytes) => JSON.parse(new TextDecoder().decode(bytes).trim()))
    expect(decoded).toHaveLength(chunks + 1)
    expect(decoded.at(-1)).toEqual({ runId: "run-stream", type: "done", reason: "stop" })
    expect(aborts).toEqual([])
    // 500, 1000, 2000, 4000, then one poll per CANCEL_POLL_MAX_MS.
    expect(polledAt.length).toBeLessThanOrEqual(5 + 120_000 / CANCEL_POLL_MAX_MS)
    expect(polledAt.length).toBeGreaterThan(5)
  })

  test("a registry read that fails ends the stream with the lost-monitoring frame", async () => {
    const upstream = silent()
    const aborts: Array<string> = []
    let settled = 0
    const hooks: TurnStreamHooks = {
      isCancelled: Effect.fail(new StorageFailure({ operation: "state", cause: new Error("registry down") })),
      abort: (reason) => Effect.sync(() => { aborts.push(reason) }),
      settle: Effect.sync(() => { settled += 1 })
    }
    const original = console.error
    const logged: Array<Array<unknown>> = []
    console.error = (...args: Array<unknown>) => { logged.push(args) }
    try {
      const frames = await Effect.runPromise(Stream.runCollect(taggedTurnFrames(upstream.body, "run-lost", hooks)))
      const decoded = [...frames].map((bytes) => JSON.parse(new TextDecoder().decode(bytes).trim()))
      expect(decoded).toEqual([{
        runId: "run-lost", type: "done", reason: "stop", error: "The turn lost cancellation monitoring. Try again."
      }])
    } finally {
      console.error = original
    }
    expect(aborts).toEqual(["unavailable"])
    expect(settled).toBe(1)
    expect(upstream.wasCancelled()).toBe(true)
    expect(logged[0]?.[0]).toBe("turn registry state failed:")
  })

  test("the service's isCancelled treats a replaced or unknown generation as a kill", async () => {
    const cancels = memoryCancels()
    const layers = turnCancelsLayer(cancels.namespace)
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* TurnCancels
        const first = yield* service.register("run-gen")
        if (first.status !== "started") throw new Error("expected a fresh registration")
        const live = yield* service.isCancelled("run-gen", first.generation)
        yield* service.settle("run-gen", first.generation)
        const second = yield* service.register("run-gen")
        if (second.status !== "started") throw new Error("expected a re-registration")
        const stale = yield* service.isCancelled("run-gen", first.generation)
        const current = yield* service.isCancelled("run-gen", second.generation)
        return { live, stale, current }
      }).pipe(Effect.provide(layers))
    )
    expect(outcome).toEqual({ live: false, stale: true, current: false })
  })
})

/* Drives the registry's internal routes the way src/turns.ts does, carrying the generation a register grants. */
const registryGenerations = new WeakMap<TurnCancelRegistry, string>()
const doPost = async (registry: TurnCancelRegistry, path: string, owner?: string): Promise<Response> => {
  const headers = new Headers()
  if (owner !== undefined) headers.set("x-turn-owner", owner)
  const generation = registryGenerations.get(registry)
  if (generation !== undefined) headers.set("x-turn-generation", generation)
  const response = await registry.fetch(new Request(`https://turn-cancel.internal${path}`, { method: "POST", headers }))
  if (path === "/register") {
    const body = await response.clone().json() as { generation?: string }
    if (body.generation !== undefined) registryGenerations.set(registry, body.generation)
  }
  return response
}

describe("the turn-cancel registry (Durable Object state)", () => {
  test("register starts a turn, a duplicate register is refused, cancel kills it", async () => {
    const registry = new TurnCancelRegistry({ storage: memoryStorage() })
    expect(await (await doPost(registry, "/register")).json()).toEqual({ status: "started", generation: expect.any(String) })
    expect(await (await doPost(registry, "/register")).json()).toEqual({ status: "already-running" })
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "cancelled" })
    // The kill is terminal: a second cancel, and the state read, agree.
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "not-found" })
    expect(await (await doPost(registry, "/state")).json()).toEqual({
      state: "cancelled"
    })
  })

  test("a settled turn answers cancel with an honest not-found and may re-register", async () => {
    const registry = new TurnCancelRegistry({ storage: memoryStorage() })
    await doPost(registry, "/register")
    await doPost(registry, "/settle")
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "not-found" })
    // Tool-loop legs reuse the runId: a settled turn registers again.
    expect(await (await doPost(registry, "/register")).json()).toEqual({ status: "started", generation: expect.any(String) })
  })

  test("cancel on a never-registered run is not-found", async () => {
    const registry = new TurnCancelRegistry({ storage: memoryStorage() })
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "not-found" })
  })

  test("a stale active registration no longer holds the runId hostage", async () => {
    const stale = Date.now() - 11 * 60 * 1000
    const registry = new TurnCancelRegistry({
      storage: memoryStorage({ state: { state: "active", at: stale } })
    })
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "not-found" })
    expect(await (await doPost(registry, "/register")).json()).toEqual({ status: "started", generation: expect.any(String) })
  })

  test("only the registering owner may cancel an owned registration", async () => {
    const registry = new TurnCancelRegistry({ storage: memoryStorage() })
    const as = (login: string, path: string): Promise<Response> => doPost(registry, path, login)
    expect(await (await as("alice", "/register")).json()).toEqual({ status: "started", generation: expect.any(String) })
    // A different login — and an anonymous caller — cannot kill alice's turn.
    expect(await (await as("bob", "/cancel")).json()).toEqual({ status: "forbidden" })
    expect(await (await doPost(registry, "/cancel")).json()).toEqual({ status: "forbidden" })
    // The run is untouched, and its owner can still kill it.
    expect(await (await as("alice", "/cancel")).json()).toEqual({ status: "cancelled" })
  })

  test("an owned active registration refuses a squatting re-register from anyone", async () => {
    const registry = new TurnCancelRegistry({ storage: memoryStorage() })
    const registerAs = (login: string): Promise<Response> =>
      registry.fetch(
        new Request("https://turn-cancel.internal/register", {
          method: "POST",
          headers: { "x-turn-owner": login }
        })
      )
    expect(await (await registerAs("alice")).json()).toEqual({ status: "started", generation: expect.any(String) })
    expect(await (await registerAs("bob")).json()).toEqual({ status: "already-running" })
    expect(await (await registerAs("alice")).json()).toEqual({ status: "already-running" })
  })
})

describe("the model bindings a turn body carries", () => {
  const read = (body: unknown) =>
    Effect.runPromise(readStartTurn(new Request("https://mvp.test/api/agent/turn", { method: "POST", body: JSON.stringify(body) })))
  const base = { runId: "r1", messages: [{ role: "user", content: "hi" }], instructions: "Be brief." } as const
  const binding = { protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY" } as const

  test("a body that binds nothing reads exactly as it did before bindings existed", async () => {
    expect(await read(base)).toEqual(base)
  })

  test("both bindings are kept as sent", async () => {
    expect(await read({ ...base, model: binding, decisionModel: binding })).toEqual({ ...base, model: binding, decisionModel: binding })
  })

  test("a binding this contract cannot read refuses the turn: unlike a hint it is never dropped", async () => {
    for (const bad of [{ model: { ...binding, protocol: "carrier-pigeon" } }, { decisionModel: { modelId: "typesafe-ai/jev" } }]) {
      const refused = await read({ ...base, tier: "gold", ...bad })
      if (!(refused instanceof Response)) throw new Error("expected a refusal")
      expect(refused.status).toBe(400)
      expect(((await refused.json()) as { code: string }).code).toBe("request_invalid")
    }
  })
})
