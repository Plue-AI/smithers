/** Browser host for the production agent. Only checkpointed virtual-file flows cross the WASM boundary. */
import singlefile from "@jitl/quickjs-singlefile-browser-release-sync"
import * as Agent from "@smthrs/agent/Agent"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as Observation from "@smthrs/agent/WorkspaceObservation"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import * as Cell from "@smthrs/harness/Cell"
import { Observation as WorkspaceState } from "@smthrs/harness/EngineLike"
import * as Binding from "@smthrs/harness/FlowBinding"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Schema, Scope, Stream } from "effect"
import * as Crypto from "effect/Crypto"
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core"
import { resolveSeat, type Settings } from "./provider.ts"
import { canonical, type Files, type Journal, path } from "./store.ts"

function flows(journal: Journal, changed: () => void) {
  // Reconstruct execution from the original files. Recorded calls advance this private
  // view; the persisted head is never rolled back while recovering earlier cells.
  let files: Files = structuredClone(journal.head.run!.initial)
  const bind = (
    name: string,
    description: string,
    input: Schema.Top & Schema.ConstraintDecoder<unknown, never>,
    handler: (value: any) => unknown
  ) => {
    const flow = Flow.make(name, {
      description,
      payload: {},
      success: Schema.Unknown,
      body: () => Node.succeed(undefined)
    })
    const binding = Binding.make({
      flow: {
        ...flow,
        name,
        input,
        output: Schema.Unknown,
        capabilities: [],
        effects: {
          reads: ["/**"],
          writes: name === "write" ? ["/**"] : [],
          tier: name === "write" ? "compensable" : "sealed",
          mode: "hermetic",
          onConflict: "serialize"
        }
      },
      handler: (value) => Effect.tryPromise({ try: async () => handler(value), catch: (error) => error as Error })
    })
    return {
      ...binding,
      run: (call: Parameters<typeof binding.run>[0]) =>
        Effect.gen(function*() {
          const key = canonical(call.identity), inputKey = canonical(call.input)
          const saved = journal.head.run!.calls[key]
          if (saved) {
            if (saved.input !== inputKey) {
              return yield* Effect.die(new Error("Recorded flow input changed. Branch to continue."))
            }
            files = structuredClone(saved.files)
            return yield* Schema.decodeUnknownEffect(Cell.CallResult)(saved.result).pipe(Effect.orDie)
          }
          const before = structuredClone(files)
          const result = yield* binding.run(call)
          try {
            journal.update((frame) => {
              frame.files = structuredClone(files)
              frame.run!.calls[key] = { input: inputKey, result, files: structuredClone(files) }
              frame.events.push({
                kind: "flow",
                text: `${name}${
                  typeof call.input === "object" && call.input && "path" in call.input
                    ? ` ${String(call.input.path)}`
                    : ""
                }\n${canonical(result)}`
              })
            })
          } catch (error) {
            files = before
            throw error
          }
          changed()
          return result
        })
    }
  }
  const source = Binding.source("docs/sandbox", [
    bind("ls", "List sandbox files.", Schema.Struct({}), () => Object.keys(files).sort()),
    bind("read", "Read a sandbox file.", Schema.Struct({ path: Schema.String }), ({ path: value }) => {
      const key = path(value)
      if (!(key in files)) throw new Error("File not found")
      return { content: files[key] }
    }),
    bind(
      "write",
      "Write a sandbox file. Maximum 16 files of 8 KiB each.",
      Schema.Struct({ path: Schema.String, content: Schema.String }),
      ({ path: value, content }) => {
        const key = path(value)
        if (key === "check.js") throw new Error("Checks are read-only. Edit math.js.")
        if (new TextEncoder().encode(content).byteLength > 8192 || (!(key in files) && Object.keys(files).length >= 16)) {
          throw new Error("Sandbox file limit reached")
        }
        files[key] = content
        return { path: key }
      }
    ),
    bind("check", "Run the addition checks in an isolated JavaScript runtime.", Schema.Struct({}), async () => {
      const module = await newQuickJSWASMModuleFromVariant(singlefile)
      const runtime = module.newRuntime()
      runtime.setMemoryLimit(8 * 1024 * 1024)
      let ticks = 0
      runtime.setInterruptHandler(() => ++ticks > 1000)
      const vm = runtime.newContext()
      try {
        const result = vm.evalCode(
          `(() => { ${
            files["math.js"]?.replace(/\bexport\s+/g, "") ?? ""
          }; return JSON.stringify([add(2,3),add(-2,3)]); })()`
        )
        if (result.error) {
          const detail = vm.dump(result.error)
          result.error.dispose()
          return { passed: false, output: String(detail?.message ?? detail) }
        }
        const actual = JSON.parse(vm.getString(result.value))
        result.value.dispose()
        const passed = actual[0] === 5 && actual[1] === 1
        return { passed, actual, expected: [5, 1], output: passed ? "2 checks passed" : "Addition check failed" }
      } finally {
        vm.dispose()
        runtime.dispose()
      }
    })
  ])
  return {
    source,
    files: () => files,
    restore: (snapshot: Files) => {
      files = structuredClone(snapshot)
    }
  }
}
export async function run(journal: Journal, settings: Settings, changed: () => void, signal: AbortSignal) {
  const task = journal.head.run!
  const sandbox = flows(journal, changed)
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    Agent.layer.pipe(Layer.provide(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded()))),
    Agent.layerDefaults,
    FlowEngine.layerMemory,
    QuotaPolicy.layerDefault(),
    Budget.layerUnbounded(),
    Evaluator.layerUnavailable(),
    Layer.succeed(Observation.Observer)({
      observe: Effect.promise(async () =>
        new WorkspaceState({
          digest: Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(sandbox.files()))))
          ).map((byte) => byte.toString(16).padStart(2, "0")).join(""),
          paths: Object.keys(sandbox.files()).length,
          complete: true
        })
      )
    }),
    Layer.succeed(FlowEngine.SnapshotBoundary)({
      snapshot: () => Effect.sync(() => structuredClone(sandbox.files())),
      restore: (snapshot) => Effect.sync(() => sandbox.restore(snapshot as Files)),
      diff: () => Effect.succeed(undefined)
    }),
    // Effect's Web Crypto layer is supplied by the browser implementation below.
    Layer.succeed(Crypto.Crypto)(
      Crypto.make({
        randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
        digest: (algorithm, data) =>
          Effect.promise(async () => new Uint8Array(await crypto.subtle.digest(algorithm, new Uint8Array(data))))
      })
    )
  ))
  journal.update((frame) => {
    frame.run!.status = "running"
    delete frame.run!.error
  })
  changed()
  try {
    await runtime.runPromise(
      Effect.gen(function*() {
        const agent = yield* Agent.Agent, engine = yield* FlowRuntime.FlowRuntime
        const settled = Deferred.makeUnsafe<void, unknown>()
        const flow = Flow.make("docs/playground", {
          payload: {},
          success: Schema.Void,
          error: Schema.Unknown,
          body: () => Node.succeed(undefined)
        })
        const body = agent.run({
          session: task.id,
          prompt: task.prompt,
          seat: resolveSeat(settings, journal, changed),
          registry: Registry.makeNoop(),
          flows: [sandbox.source],
          maxFrames: 8,
          capacity: { park: false },
          modelParams: { maxTokens: 2048 },
          claimCap: 0,
          unmovedCap: 0,
          narrowingCap: 0,
          unresolvedCap: 0,
          system: [
            "Work in the browser sandbox. Use read, write, and check to fix math.js. No shell exists. Use ctx.call for all file operations. Keep the answer short.",
            `Earlier work: ${canonical(task.context ?? [])}`
          ],
          limits: { memoryBytes: 32 * 1024 * 1024, steps: 2_000_000, callMs: 30_000, totalMs: 120_000 }
        }).pipe(Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event._tag === "resolved") {
              const text = event.message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
              journal.update((frame) => {
                frame.events.push({ kind: "answer", text })
              })
              changed()
            }
          })
        ))
        const scope = yield* Effect.scope
        yield* engine.register(
          flow,
          () =>
            Effect.onExit(
              body,
              (exit) =>
                Exit.isSuccess(exit) ? Deferred.succeed(settled, undefined) : Deferred.failCause(settled, exit.cause)
            )
        )
          .pipe(Scope.provide(scope))
        yield* engine.execute(flow, { executionId: task.id, payload: {}, discard: true })
        yield* Deferred.await(settled)
      }).pipe(Effect.scoped),
      { signal }
    )
    journal.settle("done")
  } catch (error) {
    journal.settle("failed", signal.aborted ? "Stopped. Resume to continue." : failureMessage(error))
  } finally {
    await runtime.dispose()
    changed()
  }
}

function failureMessage(error: unknown): string {
  let current = error
  const seen = new Set<unknown>()
  let message = "The agent stopped. Resume to retry."
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    if ("message" in current && typeof current.message === "string") message = current.message
    current = "cause" in current ? current.cause : undefined
  }
  return message.slice(0, 500)
}
