/**
 * The host program `37-host-containment.ts` kills.
 *
 * It is a separate process because the example is about what survives a host
 * that never got to run a finalizer, and there is no way to produce that state
 * from inside the process that has to observe it.
 *
 * Usage: `node 37-host-containment-host.ts <sqlite file> <hostId>`. It prints
 * the process id of the group it started, then waits to be killed. Startup
 * failures print their cause to stderr and exit with status 1.
 */
import { Action, Capability, Flow, Interpreter } from "@smthrs/flows"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { dirname } from "node:path"

const filename = process.argv[2]
const hostId = process.argv[3]
if (filename === undefined || hostId === undefined) {
  throw new Error("usage: 37-host-containment-host.ts <sqlite file> <hostId>")
}

/**
 * Starts a two-process tree that outlives anything short of a group SIGKILL.
 *
 * When its host dies, the group's process owner stops the group with SIGTERM
 * and keeps it until the grace period ends. This tree ignores SIGTERM before it
 * reports ready, and its grace period is longer than the example, so after the
 * host's SIGKILL only the host's replacement can reap the group.
 */
const Spawn = Action.make({
  name: "examples/host-containment/spawn",
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: "examples/host-containment/spawn/v1",
  execute: Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const handle = yield* Effect.orDie(spawner.spawn(ChildProcess.make(
      "sh",
      ["-c", "trap '' TERM; sleep 300 & echo ready; sleep 300"],
      { forceKillAfter: "60 seconds" }
    )))
    // Both sleeps inherit the ignored SIGTERM, so a stop from here on cannot
    // end the tree.
    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line === "ready"),
      Stream.runHead,
      Effect.orDie
    )
    // Printed only after the spawn returned, and the spawn returns only after
    // the ledger has durably recorded it. Whoever reads this line may kill this
    // process immediately.
    process.stdout.write(`${handle.pid as number}\n`)
    yield* Effect.orDie(handle.exitCode)
    return "woke"
  })
})

const Start = Action.make("examples/host-containment/start", {
  payload: { what: Schema.String },
  success: Schema.String
})

const Containment = Flow.make("examples/host-containment", {
  payload: { what: Schema.String },
  success: Schema.String,
  body: (payload) => Start.call(payload)
})

const flows = Interpreter.layer(Containment).pipe(
  Layer.provideMerge(Start.toLayer(() => Spawn)),
  Layer.provideMerge(Action.layerImplementations)
)

const exit = await Effect.runPromise(
  Effect.exit(
    Containment.execute({ what: "spawn" }, { executionId: "host-containment" }).pipe(
      Effect.provide(
        NodeRuntime.layerHost(
          {
            filename,
            workspaceRoot: dirname(filename),
            owner: { hostId },
            signals: [],
            rules: [
              new Capability.Permission.Rule({
                effect: "allow",
                pattern: new Capability.Capability.CapabilityPattern({ action: "proc:spawn", resource: "*" })
              })
            ]
          },
          flows
        )
      ),
      Effect.scoped
    )
  )
)

if (Exit.isFailure(exit)) {
  process.stderr.write(`${Cause.pretty(exit.cause)}\n`)
  process.exitCode = 1
}
