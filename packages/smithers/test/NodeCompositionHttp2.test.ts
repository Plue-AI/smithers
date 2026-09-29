import { Context, Effect, Layer, Scope } from "effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createSecureServer, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

const observed = vi.hoisted(() => ({
  agents: [] as Array<{ destroy: () => Promise<unknown>; destroyed: boolean }>,
  executors: [] as Array<unknown>,
  evaluatorEntered: undefined as (() => void) | undefined
}))

vi.mock("@effect/platform-node/NodeHttpClient", async (importOriginal) => {
  // Supply TLS options to real Undici Agents for the local HTTP/2 fixture.
  const original = await importOriginal<typeof import("@effect/platform-node/NodeHttpClient")>()
  const { Effect } = await import("effect")
  const { Agent } = await import("@effect/platform-node/Undici")
  return {
    ...original,
    makeDispatcher: Effect.acquireRelease(
      Effect.sync(() => {
        const agent = new Agent({ allowH2: true, connect: { rejectUnauthorized: false } })
        observed.agents.push(agent)
        return agent
      }),
      (agent) => Effect.promise(() => agent.destroy())
    )
  }
})

vi.mock("@smthrs/model/RequestExecutor", async (importOriginal) => {
  const original = await importOriginal<typeof import("@smthrs/model/RequestExecutor")>()
  const { Effect } = await import("effect")
  return {
    ...original,
    makeWith: (...args: Parameters<typeof original.makeWith>) =>
      Effect.tap(original.makeWith(...args), (executor) => Effect.sync(() => observed.executors.push(executor)))
  }
})

vi.mock("@smthrs/model/Evaluator", async (importOriginal) => {
  // Park the judge call after the default composition has built its executor.
  const original = await importOriginal<typeof import("@smthrs/model/Evaluator")>()
  const { Effect, Layer } = await import("effect")
  return {
    ...original,
    layerFromSeat: () =>
      Layer.succeed(original.Evaluator, {
        evaluate: () => Effect.sync(() => observed.evaluatorEntered?.()).pipe(Effect.andThen(Effect.never))
      })
  }
})

vi.mock("../src/internal/NativeEquipment.ts", async (importOriginal) => {
  // Resolve a seat without consulting this machine's subscription login.
  const original = await importOriginal<typeof import("../src/internal/NativeEquipment.ts")>()
  const { Effect } = await import("effect")
  return { ...original, seatResolver: () => ({ resolve: () => Effect.succeed({}) }) }
})

import * as MigrateLayers from "@smthrs/migrate/flow/Layers"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as SuggestFlow from "../src/suggest/SuggestFlow.ts"

const characterSource: string = new URL("../../../evals/agent/character/subject.ts", import.meta.url).href

const evaluator = Layer.succeed(Evaluator.Evaluator, { evaluate: () => Effect.die("unused") })

const check = (make: (root: string) => Effect.Effect<unknown, unknown, Scope.Scope>) => async () => {
  for (const name of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"] as const) vi.stubEnv(name, "")
  const directory = mkdtempSync(join(tmpdir(), "smithers-composed-h2-"))
  const keyPath = join(directory, "key.pem")
  const certPath = join(directory, "cert.pem")
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    "/CN=localhost",
    "-days",
    "1"
  ], { stdio: "ignore" })
  const sessions: Array<ServerHttp2Session> = []
  const server = createSecureServer({ key: readFileSync(keyPath), cert: readFileSync(certPath), allowHTTP1: false })
  server.on("session", (session) => sessions.push(session))
  server.on("stream", (stream: ServerHttp2Stream) => {
    stream.respond({ ":status": 200, "content-type": "application/json" })
    stream.end("{}")
  })
  observed.agents.length = 0
  observed.executors.length = 0
  observed.evaluatorEntered = undefined
  try {
    const url = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (address === null || typeof address === "string") throw new Error("Expected a TCP listener")
        resolve(`https://127.0.0.1:${address.port}`)
      })
    })
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* make(directory)
      const executor = observed.executors.at(-1) as RequestExecutor.RequestExecutor | undefined
      expect(executor).toBeDefined()
      if (executor === undefined) return
      const request = () => HttpClientRequest.get(`${url}/model`)
      const warm = yield* executor.execute(request(), { modelId: "test-model" })
      expect(warm.status).toBe(200)
      expect(yield* warm.text).toBe("{}")
      expect(sessions).toHaveLength(1)
      const peerClosed = new Promise<void>((resolve) => sessions[0]!.once("close", resolve))
      sessions[0]!.goaway()
      sessions[0]!.close()
      yield* Effect.promise(() => peerClosed)
      const afterPeerLoss = yield* executor.execute(request(), { modelId: "test-model" })
      expect(afterPeerLoss.status).toBe(200)
      expect(yield* afterPeerLoss.text).toBe("{}")
      expect(sessions).toHaveLength(2)
      const initialAgents = [...observed.agents]
      for (const agent of initialAgents) yield* Effect.promise(() => agent.destroy())
      const failure = yield* Effect.flip(executor.execute(request(), { modelId: "test-model" }))
      expect(failure.code).toBe("transport")
      expect(observed.agents).toHaveLength(initialAgents.length)
      const recovered = yield* executor.execute(request(), { modelId: "test-model" })
      expect(recovered.status).toBe(200)
      expect(yield* recovered.text).toBe("{}")
      expect(sessions).toHaveLength(3)
      expect(observed.agents).toHaveLength(initialAgents.length + 1)
    })))
    expect(observed.agents.length).toBeGreaterThan(1)
    expect(observed.agents.every((agent) => agent.destroyed)).toBe(true)
  } finally {
    for (const session of sessions) session.destroy()
    await Promise.all(observed.agents.map((agent) => agent.destroy()))
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
    observed.evaluatorEntered = undefined
    vi.unstubAllEnvs()
  }
}

describe("public Node compositions recover closed HTTP/2 sessions and destroyed pools", () => {
  it(
    "suggest",
    check((root) =>
      Layer.build(SuggestFlow.layerNode({
        root,
        seat: "openai:test-model",
        environment: { OPENAI_API_KEY: "test" },
        evaluator
      }))
    ),
    30_000
  )

  it(
    "migrate",
    check((root) =>
      Layer.build(MigrateLayers.layerNode({
        root,
        seat: "openai:test-model",
        environment: { OPENAI_API_KEY: "test" },
        evaluator,
        commands: { typecheck: [], flowsDir: "flows" },
        runStatePaths: []
      }))
    ),
    30_000
  )

  it(
    "migrate default evaluator",
    check((root) =>
      Effect.gen(function*() {
        const context = yield* Layer.build(MigrateLayers.layerNode({
          root,
          seat: "openai:test-model",
          environment: { OPENAI_API_KEY: "test" },
          commands: { typecheck: [], flowsDir: "flows" },
          runStatePaths: []
        }))
        const evaluator = Context.get(context, Evaluator.Evaluator)
        let entered!: () => void
        const ready = new Promise<void>((resolve) => entered = resolve)
        observed.evaluatorEntered = entered
        yield* Effect.forkChild(evaluator.evaluate({ state: {}, questions: {} }), { startImmediately: true })
        yield* Effect.promise(() => ready)
      })
    ),
    30_000
  )

  it(
    "character",
    check((root) =>
      Effect.promise(() => import(/* @vite-ignore */ characterSource)).pipe(
        Effect.flatMap((character) =>
          character.resolveLive("openai:test-model", root) as Effect.Effect<unknown, unknown, Scope.Scope>
        )
      )
    ),
    30_000
  )
})
