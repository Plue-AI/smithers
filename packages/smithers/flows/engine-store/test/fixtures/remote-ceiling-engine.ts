/**
 * A serving engine in its own process for the remote capability ceiling cases
 * (#2852): a durable `EngineStore` over SQLite serves `RemoteWrite` through
 * `FlowProxyServer` on a real HTTP listener. The flow writes through the
 * kernel's guarded `FileSystem` over a real `GrantStore` whose rules allow the
 * workspace, so inside it only the carried ceiling can refuse a write.
 *
 * usage: remote-ceiling-engine.ts <sqlite> <workspace> <port>
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodePath from "@effect/platform-node/NodePath"
import { FlowProxy, FlowProxyServer } from "@smthrs/engine"
import { DurableClock, FlowRuntime } from "@smthrs/flow"
import { Capability, Jj, Permission } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { Effect, FileSystem, Layer, Option } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { createServer } from "node:http"
import { join } from "node:path"
import * as EngineStore from "../../src/EngineStore.ts"
import * as StepBoundary from "../../src/StepBoundary.ts"
import * as TestStores from "../../src/test/TestStores.ts"
import { withCrypto } from "../Sha256.ts"
import { RemoteWrite } from "./RemoteCeilingFlow.ts"

const [filename, root, port] = process.argv.slice(2)
if (filename === undefined || root === undefined || port === undefined) {
  throw new Error("usage: remote-ceiling-engine.ts <sqlite> <workspace> <port>")
}

const line = (value: unknown) => Effect.sync(() => process.stdout.write(`${JSON.stringify(value)}\n`))

const host = KernelFileSystem.layer.pipe(
  Layer.provide(AtomicFileSystem.layer),
  Layer.provide(NodePath.layer),
  Layer.provide(Workspace.layer(root)),
  Layer.provide(
    GrantStore.layer({
      attended: false,
      rules: [
        new Permission.Rule({
          effect: "allow",
          pattern: new Capability.CapabilityPattern({ action: "fs:write", resource: `${root}/**` })
        })
      ]
    }).pipe(Layer.provide(Workspace.layer(root)))
  )
)

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "remote" as never, changeId: "remote" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const program = Effect.scoped(Effect.gen(function*() {
  const engine = yield* EngineStore.make({
    owner: { hostId: `remote-ceiling-${process.pid}` },
    journalSource: "remote-ceiling",
    // Every earlier serving process is gone, so its claims are reclaimable.
    isAlive: () => Effect.succeed(false)
  })
  const fs = yield* FileSystem.FileSystem
  yield* engine.register(RemoteWrite, ({ name, waitMs }) =>
    Effect.gen(function*() {
      yield* line({ event: "running", name })
      if (waitMs > 0) {
        yield* DurableClock.sleep({ name: "hold", duration: `${waitMs} millis`, inMemoryThreshold: "1 millis" })
      }
      const written = yield* Effect.result(fs.writeFileString(join(root, name), "written"))
      if (written._tag === "Success") return "written"
      const denial = written.failure._tag === "PlatformError"
        ? Permission.fromPlatformError(written.failure)
        : Option.none()
      return Option.isSome(denial) ? `denied:${denial.value._tag.split("/").at(-1)}` : `failed:${written.failure._tag}`
    }))
  yield* Layer.build(
    HttpRouter.serve(
      RpcServer.layerHttp({ group: FlowProxy.toRpcGroup([RemoteWrite]), path: "/", protocol: "http" }).pipe(
        Layer.provide(FlowProxyServer.layerRpcHandlers([RemoteWrite])),
        Layer.provide(RpcSerialization.layerJson)
      )
    ).pipe(
      Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, engine)),
      Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: Number(port) }))
    )
  )
  yield* line({ event: "listening" })
  return yield* Effect.never
})).pipe(
  Effect.provide(host),
  Effect.provide(jj),
  Effect.provide(StepBoundary.layerTest()),
  Effect.provide(TestStores.layerAt(filename))
)

// A process entrypoint: running the Effect here is the intended boundary.
await Effect.runPromise(withCrypto(program))
