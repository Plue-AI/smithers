/**
 * A caller engine in its own process for the cross-host recovery drill
 * (#2784): a durable `EngineStore` over SQLite drives `PlacedParent`, whose
 * `Hosts` table binds the `serving` target to another process's engine,
 * reached over HTTP through the public `FlowProxy` protocol. It prints one
 * `result` or `failure` line when the parent settles.
 *
 * usage: placed-caller-engine.ts <sqlite> <port> <execution-id> <name> <waitMs>
 */
import { Hosts } from "@smthrs/engine"
import { Action, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Cause, Effect, Exit, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import * as EngineStore from "../../src/EngineStore.ts"
import * as StepBoundary from "../../src/StepBoundary.ts"
import * as TestStores from "../../src/test/TestStores.ts"
import { withCrypto } from "../Sha256.ts"
import { PlacedParent } from "./PlacedParentFlow.ts"

const [filename, port, executionId, name, waitMs] = process.argv.slice(2)
if (
  filename === undefined || port === undefined || executionId === undefined || name === undefined ||
  waitMs === undefined
) {
  throw new Error("usage: placed-caller-engine.ts <sqlite> <port> <execution-id> <name> <waitMs>")
}

const line = (value: unknown) => Effect.sync(() => process.stdout.write(`${JSON.stringify(value)}\n`))

const serving: Hosts.Binding = {
  _tag: "Proxy",
  connect: (group) =>
    RpcClient.make(group as never).pipe(
      Effect.provide(
        RpcClient.layerProtocolHttp({ url: `http://127.0.0.1:${port}/` }).pipe(
          Layer.provide(RpcSerialization.layerJson),
          Layer.provide(FetchHttpClient.layer)
        )
      )
    )
}

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "placed-caller" as never, changeId: "placed-caller" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const program = Effect.scoped(Effect.gen(function*() {
  const engine = yield* EngineStore.make({
    owner: { hostId: `placed-caller-${process.pid}` },
    journalSource: "placed-caller",
    // Every earlier caller process is gone, so its claims are reclaimable.
    isAlive: () => Effect.succeed(false)
  })
  const context = yield* Layer.build(
    Interpreter.layer(PlacedParent).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
    )
  )
  yield* line({ event: "started", executionId })
  const exit = yield* Effect.exit(
    PlacedParent.execute({ name, waitMs: Number(waitMs) }, { executionId }).pipe(Effect.provide(context))
  )
  yield* Exit.isSuccess(exit)
    ? line({ event: "result", value: exit.value })
    : line({ event: "failure", cause: Cause.pretty(exit.cause) })
})).pipe(
  Effect.provide(Hosts.layer({ serving })),
  Effect.provide(jj),
  Effect.provide(StepBoundary.layerTest()),
  Effect.provide(TestStores.layerAt(filename))
)

// A process entrypoint: running the Effect here is the intended boundary.
await Effect.runPromise(withCrypto(program))
