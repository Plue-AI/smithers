// Real TypeScript roster host for the Go composed-live integration boundary.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as ControlError from "@smthrs/control/ControlError"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { createServer } from "node:http"
import * as HostBranchPresence from "../src/HostBranchPresence.ts"
const server = HttpRouter.serve(
  HostBranchPresence.layer({
    runtimeArtifactDigest: "a".repeat(64),
    sourceRevision: "b".repeat(40),
    ownerGeneration: 1,
    authenticate: (headers) =>
      headers.authorization === "Bearer presence-fixture"
        ? Effect.succeed({ id: "host", kind: "bearer", stampedAt: 1 })
        : Effect.fail(new ControlError.Unauthorized({ message: "Unauthorized" }))
  }),
  { disableListenLog: true, disableLogger: true }
).pipe(
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
)
Effect.runPromise(
  Effect.gen(function*() {
    const server = yield* HttpServer.HttpServer
    if (server.address._tag !== "InetAddressV4") throw new Error("IPv4 required")
    console.log(`PORT=${server.address.port}`)
    yield* Effect.never
  }).pipe(Effect.provide(server), Effect.scoped)
).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
