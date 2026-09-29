/**
 * Runs `wrapped` through the flow runtime:
 *
 *   node --experimental-strip-types flows/wrapped/main.ts --harness claude-code \
 *     --cwd <dir> --task "<text>" [--session <id>] [--permission plan|acceptEdits] [--dry-run]
 *
 * Prints one JSON line per fact: the memory Output, the exact argv, then the
 * result. `--dry-run` prepares the prompt (or, with --session, replays the launch's)
 * but never records a session or spawns.
 * With AI_GATEWAY_API_KEY set, memory asks Jev first and falls back to the
 * host judge, as the TUI host does.
 */
import { NodeRuntime as PlatformRuntime, NodeServices } from "@effect/platform-node"
import { Action, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as EvaluatorBackup from "@smthrs/model/EvaluatorBackup"
import { Effect, Layer, Redacted, Schema } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { evaluatorLayer } from "../repository/jev-checks.ts"
import Wrapped, { grants, layer, recallSession, selectMemory, writePrompt } from "./flow.ts"
import { type Command, commandFor } from "./launch.ts"
import { defaultPermission, Harness, Permission } from "./prompt.ts"

const { values } = parseArgs({
  options: {
    harness: { type: "string", default: "claude-code" },
    cwd: { type: "string" },
    task: { type: "string" },
    session: { type: "string" },
    permission: { type: "string" },
    "dry-run": { type: "boolean" }
  }
})
const print = (fact: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(fact)}\n`)
const argv = (command: Command) => [command.executable, ...command.args]

if (values.task === undefined || values.cwd === undefined) {
  process.stderr.write(
    "usage: node --experimental-strip-types flows/wrapped/main.ts --harness claude-code --cwd <dir> --task <text> [--session <id>] [--permission plan|acceptEdits] [--dry-run]\n"
  )
  process.exit(2)
}
const harness = Schema.decodeUnknownSync(Harness)(values.harness)
const cwd = await realpath(resolve(values.cwd))
const task = values.task
const session = values.session
const permission = values.permission === undefined ? undefined : Schema.decodeUnknownSync(Permission)(values.permission)

const hostJudge = evaluatorLayer(process.env)
const key = process.env.AI_GATEWAY_API_KEY
const evaluator = key === undefined || key === "" ? hostJudge : (() => {
  const gateway = Evaluator.layerVercelGateway({ apiKey: Redacted.make(key) }).pipe(
    Layer.provide(KernelHttpClient.layer),
    // eslint-disable-next-line no-restricted-syntax -- Jev HTTP only, as apps/tui/src/host.ts; no filesystem or shell sits above it
    Layer.provide(GrantStore.layerNoop),
    Layer.provide(FetchHttpClient.layer)
  )
  return Layer.effect(
    Evaluator.Evaluator,
    Effect.gen(function*() {
      const primary = yield* Effect.provide(Effect.service(Evaluator.Evaluator), gateway)
      const backup = yield* Effect.provide(Effect.service(Evaluator.Evaluator), hostJudge)
      return EvaluatorBackup.withFallback(primary, backup)
    })
  )
})()
const services = Layer.mergeAll(NodeServices.layer, evaluator)

const dryRun = Effect.gen(function*() {
  const prepared = session === undefined
    ? yield* Effect.flatMap(
      Effect.tap(selectMemory(task, cwd), (memory) => Effect.sync(() => print({ memory }))),
      (memory) => writePrompt({ cwd, permission: permission ?? defaultPermission, memory })
    )
    : yield* recallSession(cwd, session, permission)
  const command = yield* commandFor({ harness, task, cwd, resume: session !== undefined, ...prepared })
  print({ argv: argv(command), extra: prepared.extra })
}).pipe(Effect.provide(services))

const launched = Effect.suspend(() => {
  const layers = Layer.mergeAll(
    layer({
      onMemory: (memory) => print({ memory }),
      observe: (command) => print({ argv: argv(command) }),
      observeOutput: (stdout) => print({ stdout })
    }).pipe(Layer.provide(services)),
    Interpreter.layer(Wrapped)
  ).pipe(Layer.provideMerge(Action.layerImplementations))
  const runId = `wrapped-${crypto.randomUUID()}`
  return Effect.scoped(
    Wrapped.execute({
      harness,
      task,
      cwd,
      ...(session === undefined ? {} : { session }),
      ...(permission === undefined ? {} : { permission })
    }, { executionId: runId })
      .pipe(Effect.provide(NodeRuntime.layerHost({
        filename: resolve(cwd, ".flows", "wrapped", "engine.db"),
        workspaceRoot: cwd,
        owner: { hostId: `wrapped-${process.pid}` },
        signals: [],
        rules: [grants(cwd)]
      }, layers)))
  ).pipe(Effect.flatMap((result) => Effect.sync(() => print({ runId, result }))))
})

// runMain interrupts on SIGINT and SIGTERM, so the launch's finalizer kills
// the harness's process group before the host exits. The harness runs in its
// own group, so a closed terminal's SIGHUP reaches only the host: turn it into
// the same interrupt.
process.on("SIGHUP", () => process.kill(process.pid, "SIGTERM"))
PlatformRuntime.runMain(values["dry-run"] ? dryRun : launched)
