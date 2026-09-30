import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { NodeWS } from "@effect/platform-node/NodeSocket"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlLive from "@smthrs/control/ControlLive"
import * as ScopedToken from "@smthrs/control/ScopedToken"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import * as Database from "@smthrs/database/bun/BunDatabase"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import { Migrations, SqlJournal } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Migrations as RunMigrations, RunStore } from "@smthrs/run-store"
import * as RunCatalog from "@smthrs/sync/RunCatalog"
import * as SyncAuth from "@smthrs/sync/SyncAuth"
import * as SyncServer from "@smthrs/sync/SyncServer"
import * as WorkspaceShare from "@smthrs/sync/WorkspaceShare"
import { Context, Effect, Layer, Logger } from "effect"
import { HttpServer } from "effect/unstable/http"
import assert from "node:assert/strict"
import * as BunGateway from "../../src/bun/BunGateway.ts"
import * as Projections from "../../src/Projections.ts"

const health = { workspaceHash: "bun-workspace", gatewayId: "bun-gateway", protocolVersion: "1", version: "1.0.0-rc.0" }
const storage = Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), RunStore.layer).pipe(
  Layer.provideMerge(
    Layer.provideMerge(
      DatabaseMigrations.layer([Migrations.set, RunMigrations.set]),
      Layer.provideMerge(DurableWriter.layer(), Database.layer({ filename: ":memory:" }))
    )
  )
)
const stack = Layer.mergeAll(Projections.layer, SyncServer.layer, SyncAuth.layer).pipe(
  Layer.provideMerge(Layer.merge(RunCatalog.layerNoop, WorkspaceShare.layerNoop)),
  Layer.provideMerge(ControlLive.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      SqlControlRuntime.layer({}).pipe(Layer.orDie),
      NotificationQueue.layer,
      ControlExecutor.layer(ControlExecutor.makeNoop()),
      Registry.layerNoop()
    )
  ),
  Layer.provideMerge(Layer.merge(storage, BunCrypto.layer))
)
const served = (options: BunGateway.ServerOptions) => BunGateway.layer(health, options).pipe(Layer.provideMerge(stack))
const request = JSON.stringify({ _tag: "Request", id: 1, tag: "List", payload: { _tag: "runs" }, headers: [] }) + "\n"

await Effect.runPromise(Effect.scoped(
  Effect.gen(function*() {
    for (const options of [{ host: "0.0.0.0" }, { host: "0.0.0.0", listen: true }]) {
      const refusal = yield* Layer.build(served(options)).pipe(Effect.flip)
      assert.equal(refusal._tag, "@smthrs/gateway/GatewayError")
      if (refusal._tag !== "@smthrs/gateway/GatewayError") throw refusal
      assert.equal(refusal.code, "bind_failed")
    }
    const context = yield* Layer.build(served({ host: "127.0.0.1", port: 0, credential: "test-bun-token" }))
    const address = Context.get(context, HttpServer.HttpServer).address
    assert.equal(address._tag, "InetAddressV4")
    if (address._tag !== "InetAddressV4") throw new Error("expected TCP")
    const url = `http://127.0.0.1:${address.port}`
    const bindFailure = yield* Layer.build(
      served({ host: "127.0.0.1", port: address.port, credential: "test-bun-token" })
    ).pipe(Effect.flip)
    assert.equal(bindFailure._tag, "@smthrs/gateway/GatewayError")
    if (bindFailure._tag !== "@smthrs/gateway/GatewayError") throw bindFailure
    assert.equal(bindFailure.code, "bind_failed")
    yield* Effect.promise(async () => {
      assert.deepEqual(await (await fetch(`${url}/health`)).json(), health)
      const uncredentialed = await fetch(`${url}/rpc`, { method: "POST", body: request })
      assert.equal(uncredentialed.status, 200)
      assert.match(await uncredentialed.text(), /\/control\/Unauthorized/)
      assert.equal((await fetch(`${url}/projections`, { method: "POST", body: request })).status, 401)
      assert.equal((await fetch(`${url}/health`, { headers: { host: "rebind.example" } })).status, 421)
      assert.equal((await fetch(`${url}/health`, { headers: { origin: "https://attacker.example" } })).status, 403)
      const result = await fetch(`${url}/rpc`, {
        method: "POST",
        body: request,
        headers: { authorization: "Bearer test-bun-token", "content-type": "application/json" }
      })
      assert.equal(result.status, 200)
      assert.match(await result.text(), /"Success"/)
    })
    const exchange = (target: string, headers: Record<string, string>, payload = request) =>
      new Promise<string>((resolve, reject) => {
        const socket = new NodeWS.WebSocket(url.replace("http:", "ws:") + target, { headers })
        const timer = setTimeout(() => {
          socket.terminate()
          reject(new Error("WebSocket RPC timeout"))
        }, 10_000)
        socket.on("error", (error) => {
          clearTimeout(timer)
          reject(error)
        })
        socket.on("open", () => socket.send(payload))
        socket.on("message", (data) => {
          const text = String(data)
          if (!text.includes("\"Exit\"")) return
          clearTimeout(timer)
          socket.close()
          resolve(text)
        })
      })
    const frame = yield* Effect.promise(() => exchange("/rpc/ws", { authorization: "Bearer test-bun-token" }))
    assert.match(frame, /"Success"/)
    // A scoped token minted under the bearer reads, and is refused a mutation in band.
    const scoped = yield* ScopedToken.mint({ key: "test-bun-token", scopes: ["read:runs"], ttlMillis: 60_000 })
    const plan = JSON.stringify({ _tag: "Request", id: 1, tag: "Plan", payload: { flowId: "system/test", input: {} }, headers: [] }) + "\n"
    yield* Effect.promise(async () => {
      assert.match(await exchange("/rpc/ws", { authorization: `Bearer ${scoped.token}` }), /"Success"/)
      assert.match(await exchange("/rpc/ws", { authorization: `Bearer ${scoped.token}` }, plan), /does not authorize Plan/)
    })
    // A browser cannot set the header: it trades the bearer for a single-use ticket.
    yield* Effect.promise(async () => {
      assert.equal((await fetch(`${url}/auth/ticket`, { method: "POST" })).status, 401)
      const issued = await fetch(`${url}/auth/ticket`, {
        method: "POST",
        headers: { authorization: "Bearer test-bun-token" }
      })
      assert.equal(issued.status, 200)
      const { ticket } = await issued.json() as { ticket: string }
      assert.match(await exchange(`/rpc/ws?ticket=${ticket}`, {}), /"Success"/)
      // Ingress answers before any upgrade, so a plain GET shows the replay refusal.
      assert.equal((await fetch(`${url}/rpc/ws?ticket=${ticket}`)).status, 401)
    })
    process.stdout.write(
      JSON.stringify({
        runtime: "bun",
        passed: true,
        checks:
          "SQLite, HTTP RPC, authenticated WebSocket RPC, scoped token, WebSocket ticket, bind conflict, bearer, Host and Origin"
      }) + "\n"
    )
    // The bind-conflict probe logs the operating-system cause at error level; stdout is the one JSON result the test parses, so the log goes to stderr.
  }).pipe(Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)])))
))
