import * as NodeUndici from "@effect/platform-node/Undici"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as EgressHttpClient from "@smthrs/platform-node/EgressHttpClient"
import { Deferred, Effect, Fiber } from "effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createSecureServer, type Http2SecureServer, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const listen = (server: Http2SecureServer): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("Expected a TCP listener")
      resolve(`https://127.0.0.1:${address.port}`)
    })
  })

describe("Node HTTP/2 model transport recovery", () => {
  it("closes a canceled replacement before the caller scope exits", async () => {
    const agents: Array<NodeUndici.Agent> = []
    const closed: Array<NodeUndici.Agent> = []
    const during = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      let decorated = 0
      const acquire = Effect.acquireRelease(
        Effect.sync(() => {
          const agent = new NodeUndici.Agent()
          agents.push(agent)
          return agent
        }),
        (agent) =>
          Effect.promise(async () => {
            await agent.destroy()
            closed.push(agent)
          })
      )
      const transport = yield* EgressHttpClient.rebuildableTransport(acquire, (client) =>
        Effect.gen(function*() {
          decorated += 1
          if (decorated === 2) {
            yield* Deferred.succeed(entered, undefined)
            yield* Effect.never
          }
          return client
        }))
      const rebuilding = yield* Effect.forkChild(transport.rebuild, { startImmediately: true })
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(rebuilding)
      expect(closed).toEqual([agents[1]])
      expect(agents[0]!.destroyed).toBe(false)
      return [...closed]
    })))
    expect(during).toEqual([agents[1]])
    expect(closed).toEqual([agents[1], agents[0]])
  })

  it("replaces a destroyed HTTP/2 pool after bounded failures and serves a later call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-h2-"))
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
    const agents: Array<NodeUndici.Agent> = []
    try {
      const url = await listen(server)
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const acquire = Effect.acquireRelease(
          Effect.sync(() => {
            const agent = new NodeUndici.Agent({ allowH2: true, connect: { rejectUnauthorized: false } })
            agents.push(agent)
            return agent
          }),
          (agent) => Effect.promise(() => agent.destroy())
        )
        const transport = yield* EgressHttpClient.rebuildableTransport(acquire)
        const executor = yield* RequestExecutor.makeWith(transport, { maxRetries: 0 })
        const request = () => HttpClientRequest.get(`${url}/model`)
        const warm = yield* executor.execute(request(), { modelId: "test-model" })
        expect(warm.status).toBe(200)
        expect(sessions).toHaveLength(1)
        sessions[0]!.goaway()
        yield* Effect.promise(() => agents[0]!.destroy())

        const fixed = yield* RequestExecutor.makeWith(RequestExecutor.fixed(transport.client), { maxRetries: 0 })
        const fixedFailures = []
        for (let count = 0; count <= RequestExecutor.rebuildAfter; count++) {
          fixedFailures.push(yield* Effect.flip(fixed.execute(request(), { modelId: "test-model" })))
        }
        expect(fixedFailures.map((failure) => failure.code)).toEqual([
          "transport",
          "transport",
          "transport",
          "transport"
        ])
        expect(agents).toHaveLength(1)

        const failures = []
        for (let count = 0; count < RequestExecutor.rebuildAfter; count++) {
          failures.push(yield* Effect.flip(executor.execute(request(), { modelId: "test-model" })))
        }
        const recovered = yield* executor.execute(request(), { modelId: "test-model" })
        return { failures, status: recovered.status, sessionsDuringRun: sessions.length }
      })))
      expect(result.failures.map((failure) => failure.code)).toEqual(["transport", "transport", "transport"])
      expect(result.status).toBe(200)
      expect(agents).toHaveLength(2)
      expect(result.sessionsDuringRun).toBe(2)
    } finally {
      for (const session of sessions) session.destroy()
      await Promise.all(agents.map((agent) => agent.destroy()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
