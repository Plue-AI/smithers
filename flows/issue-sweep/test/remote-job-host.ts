import * as NodeServices from "@effect/platform-node/NodeServices"
import { DurableEngineState, EngineStore, StepBoundary } from "@smthrs/engine-store"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { RemoteChildProcessSpawner, type Sandbox } from "@smthrs/sandbox"
import { Effect, Layer, Option, Stream } from "effect"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import { access, appendFile, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DurableWriter } from "../../../packages/smithers/flows/database/src/index.ts"
import * as NodeDatabase from "../../../packages/smithers/flows/database/src/node/NodeDatabase.ts"
import * as Migrations from "../../../packages/smithers/flows/engine-store/src/Migrations.ts"
import * as OwnerIdentity from "../../../packages/smithers/flows/engine-store/src/OwnerIdentity.ts"
import { withCrypto } from "../../../packages/smithers/flows/engine-store/test/Sha256.ts"
import { SqlJournal } from "../../../packages/smithers/flows/journal/src/index.ts"
import { CacheStore } from "../../../packages/smithers/flows/step-cache/src/index.ts"
import { makeRemoteJob, RemoteFix } from "../work/flow.ts"

const directory = process.argv[2]!
const mode = process.argv[3]!
const input = {
  repo: "smithersai/smithers",
  issue: 3378,
  text: { title: "Restart", body: "Fix", comments: [] },
  placement: "cloud" as const
}
const Caller = Flow.make("issue-sweep/test-retained-caller", {
  payload: {},
  success: RemoteFix.successSchema,
  error: RemoteFix.errorSchema,
  body: () => RemoteFix.call(input)
})
const log = (kind: string, key: string) =>
  Effect.promise(() => appendFile(join(directory, "calls"), `${kind}:${key}\n`))
const present = (name: string) => Effect.promise(() => access(join(directory, name)).then(() => true, () => false))
const machineFile = (key: string) => `machine-${encodeURIComponent(key)}`
const session = (key: string): Sandbox.Session => ({
  id: key,
  remoteId: `retained:${key}`,
  workdir: "/workspace",
  writeFile: () => Effect.void,
  readFile: (path) =>
    Effect.succeed(
      new TextEncoder().encode(
        path.endsWith("/key")
          ? key
          : path.endsWith("/out")
          ? "Fixed"
          : path.endsWith("/err")
          ? ""
          : path.endsWith("/exit")
          ? "0"
          : path.endsWith("/base")
          ? "abcdef"
          : "rotated-login"
      )
    ),
  spawn: (command) =>
    Effect.gen(function*() {
      let stdout = ""
      if (command.includes("setsid /bin/sh")) {
        if (!(yield* present(`launched-${encodeURIComponent(key)}`))) {
          yield* Effect.promise(() => writeFile(join(directory, `launched-${encodeURIComponent(key)}`), "1"))
          yield* log("launch", key)
        }
      } else if (command.startsWith("if test -f")) {
        yield* log("status", key)
        stdout = (yield* present("exited")) ? "Exited 0" : "Running"
      } else if (command.includes("kill -TERM")) {
        yield* log("cancel", key)
      } else if (command.includes("smithers-capture.")) {
        yield* log("capture", key)
        stdout = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n"
      }
      return {
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        exitCode: Effect.succeed(0)
      }
    })
})
const provider: Sandbox.Provider = {
  retained: true,
  acquire: (key) =>
    Effect.promise(() => writeFile(join(directory, machineFile(key)), "retained")).pipe(Effect.as(session(key))),
  attach: (handle) =>
    present(machineFile(handle.id)).pipe(
      Effect.flatMap((exists) =>
        exists
          ? Effect.succeed(session(handle.id))
          : Effect.fail(new RemoteChildProcessSpawner.ProviderError({ code: "not_found", message: "machine lost" }))
      )
    ),
  destroy: (handle) =>
    log("destroy", handle.id).pipe(
      Effect.andThen(Effect.promise(() => rm(join(directory, machineFile(handle.id)), { force: true })))
    )
}
const ops = makeRemoteJob({
  provider: () => Effect.succeed(provider),
  reserve: () => Effect.succeed({ agent: "codex" as const, account: "account-1" }),
  restore: () => {},
  release: () => {},
  readLogin: () => Effect.succeed("borrowed-login"),
  saveLogin: (_account, login) => Effect.promise(() => writeFile(join(directory, "saved-login"), login)),
  cool: () => Effect.void
})
const implementations = RemoteFix.toLayer({
  ...ops,
  start: (input, key) => log("start", key).pipe(Effect.andThen(ops.start(input, key))),
  collect: (handle, key, exited) => log("collect", key).pipe(Effect.andThen(ops.collect(handle, key, exited)))
})
const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "external-job-test" as never, changeId: "external-job-test" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})
const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: join(directory, "state.sqlite") })
)
const sqlServices = Layer.provideMerge(
  Layer.mergeAll(
    AttemptStore.layer,
    CacheStore.layer,
    RunStore.layer,
    DurableEngineState.layer,
    SqlJournal.layer({ capacity: 64, overflow: "reject" })
  ),
  Layer.provideMerge(Migrations.layer, database)
)
const requirements = Layer.mergeAll(
  sqlServices,
  StepBoundary.layerTest(),
  OwnerIdentity.layer,
  Layer.succeed(Jj.Jj, jj)
)

await Effect.runPromise(withCrypto(Effect.scoped(
  Effect.gen(function*() {
    const engine = yield* EngineStore.make({
      owner: { hostId: `external-job-${mode}` },
      journalSource: "external-job-test",
      isAlive: () => Effect.succeed(false)
    })
    const layerScope = yield* Effect.scope
    const layers = Layer.mergeAll(implementations, Interpreter.layer(Caller))
    yield* Layer.buildWithScope(layers.pipe(Layer.provideMerge(Action.layerImplementations)), layerScope).pipe(
      Effect.provideService(FlowRuntime.FlowRuntime, engine)
    )
    if (mode === "start" || mode === "cancel") {
      yield* engine.execute(Caller, { executionId: "external-job-root", payload: {}, discard: true })
    }
    const runs = yield* RunStore.RunStore
    // Allow startup/recovery scheduling overhead around the real 15s job probe.
    const settleDeadline = Date.now() + 60_000
    while (Date.now() < settleDeadline) {
      const row = yield* runs.get("external-job-root")
      if (mode === "start" && row.status === "suspended") {
        process.stdout.write(`${JSON.stringify({ status: "parked" })}\n`)
        return yield* Effect.never
      }
      if (mode === "cancel" && row.status === "suspended") {
        yield* engine.interrupt(Caller, "external-job-root")
        for (let attempt = 0; attempt < 200; attempt++) {
          const calls = yield* Effect.promise(() => readFile(join(directory, "calls"), "utf8"))
          const cancelled = yield* runs.get("external-job-root")
          if (calls.includes("cancel:") && cancelled.status === "cancelled") {
            process.stdout.write(`${JSON.stringify({ status: "cancelled" })}\n`)
            return
          }
          yield* Effect.sleep("25 millis")
        }
        return yield* Effect.die("cancellation did not finish")
      }
      if (mode === "restart" && row.status === "completed") {
        const outcome = Option.getOrThrow(yield* engine.poll(Caller, "external-job-root"))
        if (outcome._tag !== "Complete" || outcome.exit._tag !== "Success") {
          return yield* Effect.die("missing completion result")
        }
        process.stdout.write(`${JSON.stringify({ status: "completed", value: outcome.exit.value })}\n`)
        return
      }
      if (row.status === "failed" || row.status === "cancelled") {
        return yield* Effect.die(row.stateJson)
      }
      yield* Effect.sleep("25 millis")
    }
    return yield* Effect.die("external job did not settle")
  }).pipe(
    Effect.provide(requirements),
    Effect.provide(KeyValueStore.layerFileSystem(join(directory, "receipts"))),
    Effect.provide(NodeServices.layer)
  )
)))
