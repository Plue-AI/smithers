/**
 * A handler defect is the server's own bug. Its raw text (a driver message,
 * a path, a secret in an error string) stays in the server log; every client
 * reads only the designed sentence. Typed control errors still arrive intact.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Cause, Effect, Layer, Logger, Schema, Stream } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
import { Control, layerNoop } from "../src/Control.ts"
import * as ControlClient from "../src/ControlClient.ts"
import { RunNotFound, TransportError } from "../src/ControlError.ts"
import { ControlDefect, defectMessage, layerNoopAuth } from "../src/ControlRpcs.ts"
import * as ControlServer from "../src/ControlServer.ts"

const secret = "secret internal detail"
const sentence = "Something went wrong on our side. Not your fault."

const dying = Layer.effect(
  Control,
  Effect.gen(function*() {
    const base = yield* Control
    return Control.of({
      ...base,
      list: () => Effect.die(new Error(secret)),
      watch: () => Stream.die(new Error(secret)),
      cancel: (input) => Effect.fail(new RunNotFound({ runId: input.runId }))
    })
  })
).pipe(Layer.provide(layerNoop))

const served = (logs: Array<string>) =>
  HttpRouter.serve(
    ControlServer.layerHttp.pipe(
      Layer.provide(layerNoopAuth()),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(dying)
    ),
    { disableListenLog: true, disableLogger: true }
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provide(Logger.layer([
      Logger.make(({ cause, message }) => {
        logs.push(`${JSON.stringify(message)} ${Cause.pretty(cause)}`)
      })
    ]))
  )

const baseUrl = Effect.map(HttpServer.HttpServer, (server) => {
  if (server.address._tag !== "InetAddressV4") throw new Error("expected a TCP control server")
  return `http://127.0.0.1:${server.address.port}`
})

const post = (url: string, line: object) =>
  Effect.promise(() =>
    fetch(`${url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/ndjson" },
      body: `${JSON.stringify(line)}\n`
    }).then((response) => response.text())
  )

const client = (url: string) =>
  ControlClient.layer({ url: `${url}/rpc` }).pipe(
    Layer.provide([
      NodeHttpClient.layerUndici,
      NodeSocket.layerWebSocket(`${url.replace("http://", "ws://")}/rpc/ws`),
      RpcSerialization.layerNdjson
    ])
  )

const run = <A, E>(logs: Array<string>, effect: Effect.Effect<A, E, HttpServer.HttpServer>) =>
  Effect.runPromise(effect.pipe(Effect.provide(served(logs)), Effect.scoped))

describe("control RPC defect redaction", () => {
  it("sends the designed sentence for a unary handler defect and logs the raw defect on the server", async () => {
    const logs: Array<string> = []
    const body = await run(
      logs,
      Effect.flatMap(
        baseUrl,
        (url) => post(url, { _tag: "Request", id: "1", tag: "List", payload: { _tag: "runs" }, headers: [] })
      )
    )

    expect(body).toContain(sentence)
    expect(body).not.toContain(secret)
    expect(body).not.toContain("at ")
    expect(logs.some((line) => line.includes(secret))).toBe(true)
  })

  it("still answers an undecodable payload with the request decoder's own sentence", async () => {
    const body = await run(
      [],
      Effect.flatMap(
        baseUrl,
        (url) => post(url, { _tag: "Request", id: "1", tag: "List", payload: { _tag: "runz" }, headers: [] })
      )
    )

    expect(body).toContain(`"_tag":"Die","defect":"Expected {`)
    expect(body).not.toContain(sentence)
  })

  it("sends the designed sentence for a streaming handler defect through the client", async () => {
    const logs: Array<string> = []
    const error = await run(
      logs,
      Effect.flatMap(baseUrl, (url) =>
        Effect.gen(function*() {
          const control = yield* Control
          return yield* control.watch({}).pipe(Stream.runDrain, Effect.flip)
        }).pipe(Effect.provide(client(url))))
    )

    expect(error).toBeInstanceOf(TransportError)
    const cause = (error as TransportError).cause
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe(sentence)
    expect(JSON.stringify(cause)).not.toContain(secret)
    expect(logs.some((line) => line.includes(secret))).toBe(true)
  })

  it("delivers a typed control error intact", async () => {
    const error = await run(
      [],
      Effect.flatMap(baseUrl, (url) =>
        Effect.gen(function*() {
          const control = yield* Control
          return yield* Effect.flip(control.cancel({ runId: "run-missing", idempotencyKey: "cancel-missing" }))
        }).pipe(Effect.provide(client(url))))
    )

    expect(error).toBeInstanceOf(RunNotFound)
    expect(error).toMatchObject({ code: "run_not_found", runId: "run-missing" })
  })
})

describe("ControlDefect", () => {
  const codec = Schema.toCodecJson(ControlDefect)

  it("encodes every non-string defect as the designed sentence", () => {
    const tagged = new RunNotFound({ runId: secret })
    for (const defect of [new Error(secret), tagged, { message: secret }, [secret], 42, null, undefined]) {
      const encoded = Schema.encodeUnknownSync(codec)(defect)
      expect(encoded).toEqual({ name: "Error", message: defectMessage })
      expect(JSON.stringify(encoded)).not.toContain(secret)
    }
    expect(defectMessage).toBe(sentence)
  })

  it("passes a string defect unchanged, since the server's request-decoding sentence is one", () => {
    const issue = "Expected \"runs\" | \"flows\", got \"runz\"\n  at [\"_tag\"]"
    expect(Schema.encodeUnknownSync(codec)(issue)).toBe(issue)
    expect(Schema.decodeUnknownSync(codec)(issue)).toBe(issue)
  })

  it("decodes the shape the default defect schema sends, so an older server stays readable", () => {
    const old = Schema.encodeUnknownSync(Schema.toCodecJson(Schema.Defect()))(new Error("old server text"))
    const decoded = Schema.decodeUnknownSync(codec)(old)
    expect(decoded).toBeInstanceOf(Error)
    expect((decoded as Error).message).toBe("old server text")

    const current = Schema.encodeUnknownSync(codec)(new Error(secret))
    const readByOldClient = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Defect()))(current)
    expect(readByOldClient).toBeInstanceOf(Error)
    expect((readByOldClient as Error).message).toBe(sentence)
  })
})
