/**
 * A projection handler that dies is the gateway's own bug. The raw defect is
 * logged on the server; the `/projections` wire carries only the designed
 * sentence. A typed `GatewayError` still arrives with its code and message.
 */
import { SyncAuth as SyncAuthTag } from "@smthrs/sync/SyncRpcs"
import * as SyncServer from "@smthrs/sync/SyncServer"
import { Cause, Effect, Layer, Logger, Stream } from "effect"
import { HttpServer } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { GatewayError } from "../src/GatewayError.ts"
import type * as GatewayServer from "../src/GatewayServer.ts"
import * as NodeGateway from "../src/node/NodeGateway.ts"
import { Projections } from "../src/Projections.ts"
import { stack } from "./GatewayStack.ts"

const secret = "secret internal detail"
const sentence = "Something went wrong on our side. Not your fault."

const health: GatewayServer.Health = {
  workspaceHash: "workspace-hash",
  gatewayId: "gateway-1",
  protocolVersion: "1",
  version: "1.0.0-rc.0"
}

const served = (logs: Array<string>) =>
  NodeGateway.layer(health, { host: "127.0.0.1", port: 0 }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(Projections, {
          snapshot: (selector) =>
            selector._tag === "run-summary"
              ? Effect.die(new Error(secret))
              : Effect.fail(new GatewayError({ code: "run_unavailable", message: "The run is unavailable" })),
          subscribe: () => Stream.die(new Error(secret))
        }),
        SyncServer.layerNoop,
        Layer.succeed(SyncAuthTag, () => Effect.die("sync is unavailable"))
      ).pipe(Layer.provideMerge(stack()))
    ),
    Layer.provide(Logger.layer([
      Logger.make(({ cause, message }) => {
        logs.push(`${JSON.stringify(message)} ${Cause.pretty(cause)}`)
      })
    ]))
  )

const snapshot = (selector: object) =>
  Effect.flatMap(HttpServer.HttpServer, (server) => {
    if (server.address._tag !== "InetAddressV4") throw new Error("expected a TCP gateway")
    const url = `http://127.0.0.1:${server.address.port}/projections`
    return Effect.promise(() =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `${
          JSON.stringify({ _tag: "Request", id: 1, tag: "Projection.Snapshot", payload: { selector }, headers: [] })
        }\n`
      }).then((response) => response.text())
    )
  })

const run = <A>(logs: Array<string>, effect: Effect.Effect<A, never, HttpServer.HttpServer>) =>
  Effect.runPromise(effect.pipe(Effect.provide(served(logs)), Effect.scoped))

describe("gateway projection defect redaction", () => {
  it("sends the designed sentence for a handler defect and logs the raw defect", async () => {
    const logs: Array<string> = []
    const body = await run(logs, snapshot({ _tag: "run-summary", runId: "run-1" }))

    const frame = JSON.parse(body.split("\n")[0] ?? "{}") as {
      readonly exit: { readonly _tag: string; readonly cause: ReadonlyArray<Record<string, unknown>> }
    }
    expect(frame.exit._tag).toBe("Failure")
    expect(frame.exit.cause).toEqual([{ _tag: "Die", defect: { name: "Error", message: sentence } }])
    expect(body).not.toContain(secret)
    expect(logs.some((line) => line.includes(secret))).toBe(true)
  })

  it("delivers a typed GatewayError intact", async () => {
    const body = await run([], snapshot({ _tag: "run-events", runId: "run-1" }))

    expect(body).toContain("run_unavailable")
    expect(body).toContain("The run is unavailable")
    expect(body).not.toContain(sentence)
  })
})
