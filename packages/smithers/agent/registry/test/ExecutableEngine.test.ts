/**
 * A discovered flow, run.
 *
 * `Executable.test.ts` proves the bridge builds the right declaration. This
 * one proves the declaration is one the durable engine drives: every case runs
 * against a real `EngineStore` over a SQLite FILE, with the production
 * `StepBoundary` and filesystem `WorkspaceSandbox`, because the answers that
 * matter here — a settled execution, a journal, a step-cache row reused by a
 * second run — do not exist in a memory engine.
 *
 * The golden in the middle is the annotation ladder: a cache policy declared on
 * a descriptor's body reaches the recorded result, a declared priority reaches
 * the plan scheduler's admission order, and a declared placement reaches the
 * envelope the delegate a host spawns reads.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { EngineStore } from "@smthrs/engine-store"
import * as PlanScheduler from "@smthrs/engine-store/PlanScheduler"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Action, Flow, Graph, Interpreter } from "@smthrs/flow"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import { Journal, type JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Node, Plan } from "@smthrs/plan"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { type Ownership, RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as Descriptor from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as Registry from "../src/Registry.ts"
import standalone, { Shout } from "./fixtures/executable/flows/standalone/flow.ts"

const flowsRoot = fileURLToPath(new URL("./fixtures/executable/flows", import.meta.url))
const projectRoot = fileURLToPath(new URL("./fixtures/executable", import.meta.url))
const platform = Layer.mergeAll(AtomicFileSystem.layer, NodePath.layer)

/** What the delegate was handed, in call order. */
const spawned: Array<Executable.Invocation> = []

/** How many times the sealed step under the delegate actually executed. */
let executions = 0

/**
 * The sealed step whose recorded result may be reused.
 *
 * A shareable step needs all three declarations: `tier: "sealed"`, an
 * `idempotencyKey` another run can derive, and a HARD file boundary the host
 * measures the execution against. An empty read and write set is the honest
 * declaration for a body that touches no files.
 */
const Compile = Action.make({
  name: "registry-test/Compile",
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: "registry-test/compile/v1",
  metadata: { readSet: [], writeSet: [], boundaryMode: "hard" },
  execute: Effect.sync(() => {
    executions++
    return "compiled"
  })
})

/** The action the delegate's body names; the host attaches its code below. */
const Run = Action.make("registry-test/Run", {
  payload: Executable.Invocation,
  success: Schema.String
})

/**
 * The registered flow every fixture delegates to.
 *
 * It stands in for the host driver a real composition registers — the agent
 * cell, the shell runner — and it is a real `@smthrs/flow` flow, registered
 * the same way, so what this suite proves about the bridge holds for those.
 */
const Echo = Flow.make("test/echo", {
  payload: Executable.Invocation,
  success: Schema.String,
  body: (payload) => Run.call(payload)
})

/**
 * The agent driver a descriptor that names no flow delegates to.
 *
 * A descriptor naming a delegate flow inherits that flow's authority, which
 * discovery cannot read, so its projected tier is `irreversible` and the engine
 * will not reuse its result. A descriptor that names none and declares its own
 * capabilities projects a real tier, which is what the cache golden needs, so
 * the fixtures in it delegate here.
 */
const Agent = Flow.make("agent", {
  payload: Executable.Invocation,
  success: Schema.String,
  body: (payload) => Run.call(payload)
})

const runLayer = Run.toLayer((payload) =>
  Effect.map(Compile, (artifact) => {
    spawned.push(payload)
    return `${payload.flow}:${artifact}`
  })
)

/** Makes an incorrectly reused bridge result observable in the returned value. */
const invocationResult = (payload: Pick<Executable.Invocation, "input" | "model" | "placement">): string =>
  JSON.stringify({ input: payload.input, model: payload.model, placement: payload.placement })

const inputDependentRunLayer = Run.toLayer((payload) =>
  Effect.sync(() => {
    spawned.push(payload)
    return invocationResult(payload)
  })
)

const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () =>
      Effect.succeed({
        commitId: "registry-executable-snapshot" as never,
        changeId: "registry-executable-snapshot" as never
      }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const scan = Effect.gen(function*() {
  const discovery = yield* Discovery.Discovery
  return yield* discovery.scan({ source: "project", root: flowsRoot, naming: "path" })
}).pipe(Effect.provide(Discovery.layer.pipe(Layer.provide(platform))), Effect.provide(platform))

const descriptorNamed = (name: string) =>
  Effect.map(scan, (result) => {
    const found = result.entries.find((entry) => entry.name === name)
    expect(found, name).toBeDefined()
    return found as Descriptor.FlowDescriptor
  })

const executableNamed = (name: string) =>
  Effect.flatMap(
    descriptorNamed(name),
    (descriptor) => Executable.fromDescriptor(descriptor, { delegates: [Echo, Agent] })
  ).pipe(Effect.provide(platform))

/** A private directory for one case's engine database and workspace. */
const workspace = (name: string): string => mkdtempSync(join(tmpdir(), `registry-executable-${name}-`))

/**
 * The durable runtime the bridged flow is registered with: real SQLite, the
 * production boundary and sandbox pairing that makes a sealed result eligible
 * for the step cache, and a complete cache environment so the engine may claim
 * a result is reusable at all.
 */
const durable = <A, E, R>(filename: string, hostId: string, registration: Layer.Layer<A, E, R>) =>
  registration.pipe(
    Layer.provideMerge(
      EngineStore.layer({
        owner: { hostId },
        journalSource: `${hostId}-engine`,
        isAlive: () => Effect.succeed(false)
      }).pipe(
        Layer.provideMerge(
          Layer.merge(StepBoundary.layer, WorkspaceSandbox.layerFileSystem()).pipe(
            Layer.provideMerge(ArtifactStore.layerMemory),
            Layer.provideMerge(TestStores.layerAt(filename)),
            Layer.provideMerge(Workspace.layer(dirname(filename)))
          )
        )
      )
    ),
    Layer.provideMerge(
      Layer.mergeAll(stubJj, Action.layerCacheEnvironment({ layers: [], capabilities: {} }))
    ),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(platform)
  )

const registrationFor = (executable: Executable.Executable, implementation = runLayer) =>
  Layer.mergeAll(implementation, Interpreter.layer(Echo), Interpreter.layer(Agent), executable.layer).pipe(
    Layer.provideMerge(Action.layerImplementations)
  ) as Layer.Layer<unknown, never, never>

/** Executes one bridged flow and reads the journal that execution wrote. */
const execute = (
  executable: Executable.Executable,
  filename: string,
  hostId: string,
  executionId: string,
  input: Schema.Json,
  implementation = runLayer
) =>
  Effect.gen(function*() {
    const result = yield* executable.flow.execute({ input }, { executionId })
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: executionId as JournalEvent.RunId, limit: 200 })
    return { result, events: page.entries.map((entry) => entry.eventType) }
  }).pipe(
    Effect.provide(durable(filename, hostId, registrationFor(executable, implementation))),
    Effect.scoped,
    Effect.orDie
  )

describe("a discovered flow runs on the durable engine", () => {
  for (const name of ["greet", "tuned"]) {
    it.effect(`supports a custom delegate without explicit codecs through ${name}`, () =>
      Effect.gen(function*() {
        const descriptor = yield* descriptorNamed(name)
        const delegate: Executable.Delegate = {
          _tag: "test/echo",
          call: (payload) => Node.succeed({ echoed: payload.input }),
          execute: (payload) => Effect.succeed({ echoed: payload.input })
        }
        const executable = yield* Executable.fromDescriptor(descriptor, { delegates: [delegate] }).pipe(
          Effect.provide(platform)
        )
        const filename = join(workspace(`custom-${name}`), "engine.db")
        const result = yield* execute(executable, filename, `custom-${name}`, `custom-${name}`, { value: 42 })
        expect(result.result).toEqual({ echoed: { value: 42 } })
      }))
  }

  for (const name of ["greet", "tuned", "cacheable"]) {
    it.effect(`persists and replays transforming results and typed failures through ${name}`, () =>
      Effect.gen(function*() {
        class Refused extends Schema.TaggedError<Refused>()("test/BridgeRefused", { message: Schema.String }) {}
        let calls = 0
        const TypedRun = Action.make("registry-test/TypedRun", {
          payload: Executable.Invocation,
          success: Schema.NumberFromString,
          error: Refused
        })
        const Typed = Flow.make(name === "cacheable" ? "agent" : "test/echo", {
          payload: Executable.Invocation,
          success: Schema.NumberFromString,
          error: Refused,
          body: (payload) => TypedRun.call(payload)
        })
        const descriptor = yield* descriptorNamed(name)
        const executable = yield* Executable.fromDescriptor(descriptor, { delegates: [Typed] }).pipe(
          Effect.provide(platform)
        )
        const registration = Layer.mergeAll(
          TypedRun.toLayer((payload) =>
            Effect.suspend(() => {
              calls++
              return payload.input === "refuse"
                ? Effect.fail(new Refused({ message: "expected refusal" }))
                : Effect.succeed(42)
            })
          ),
          Interpreter.layer(Typed),
          executable.layer
        ).pipe(Layer.provideMerge(Action.layerImplementations))
        const filename = join(workspace(`codecs-${name}`), "engine.db")
        for (const input of ["succeed", "refuse"]) {
          const incarnations = name === "cacheable" && input === "succeed"
            ? ["first", "reopened", "sibling"]
            : ["first", "reopened"]
          for (const incarnation of incarnations) {
            const executionId = `codecs-${name}-${input}${incarnation === "sibling" ? "-new-run" : ""}`
            const observed = yield* Effect.gen(function*() {
              const exit = yield* executable.flow.execute({ input }, { executionId }).pipe(Effect.exit)
              const row = yield* (yield* RunStore.RunStore).get(executionId)
              return { exit, state: JSON.parse(row.stateJson), status: row.status }
            }).pipe(
              Effect.provide(durable(filename, `${executionId}-${incarnation}`, registration)),
              Effect.scoped
            )
            if (input === "succeed") {
              expect(observed.exit).toEqual(Exit.succeed(42))
              expect(observed.status).toBe("completed")
              expect(observed.state.result).toMatchObject({ exit: { _tag: "Success", value: "42" } })
            } else {
              expect(Exit.isFailure(observed.exit)).toBe(true)
              if (Exit.isFailure(observed.exit)) {
                expect(observed.exit.cause.reasons).toHaveLength(1)
                const reason = observed.exit.cause.reasons[0]!
                expect(reason._tag).toBe("Fail")
                if (reason._tag === "Fail") {
                  expect(reason.error).toBeInstanceOf(Refused)
                  expect(reason.error).toEqual(new Refused({ message: "expected refusal" }))
                }
              }
              expect(observed.status).toBe("failed")
              expect(observed.state.result.exit.cause).toContainEqual({
                _tag: "Fail",
                error: { _tag: "test/BridgeRefused", message: "expected refusal" }
              })
            }
            // Reopening serves terminal results; a separate cacheable run also
            // decodes the stored string through the dispatched action codec.
            expect(calls).toBe(input === "succeed" ? 1 : 2)
          }
        }
      }))
  }

  it.effect("drives a flow.ts descriptor to completion over SQLite", () =>
    Effect.gen(function*() {
      spawned.length = 0
      const directory = workspace("module")
      const filename = join(directory, "engine.db")
      const executable = yield* executableNamed("greet")
      const observed = yield* execute(executable, filename, "registry-module", "greet-1", { name: "world" })

      expect(observed.result).toBe("greet:compiled")
      // The run went through the durable engine, not around it: the database
      // file exists and the execution's lifecycle is journalled under its id.
      expect(existsSync(filename)).toBe(true)
      expect(observed.events.length).toBeGreaterThan(0)
      // The delegate received the descriptor's metadata and the caller's input.
      expect(spawned.map((invocation) => invocation.flow)).toEqual(["greet"])
      expect(spawned[0]?.input).toEqual({ name: "world" })
      expect(spawned[0]?.flows).toEqual(["test/echo"])
    }))

  it.effect("drives a flow.mdx descriptor to completion over SQLite", () =>
    Effect.gen(function*() {
      spawned.length = 0
      const directory = workspace("markdown")
      const filename = join(directory, "engine.db")
      const executable = yield* executableNamed("changelog")
      const observed = yield* execute(executable, filename, "registry-markdown", "changelog-1", { args: "v2" })

      expect(observed.result).toBe("changelog:compiled")
      expect(existsSync(filename)).toBe(true)
      // A markdown flow's body reaches the delegate as a rendered prompt: this
      // is the whole of what makes a `flow.mdx` runnable rather than readable.
      expect(spawned[0]?.prompt).toContain("Summarize the changes since the previous release")
      expect(spawned[0]?.prompt).toContain("Base directory:")
      expect(spawned[0]?.input).toEqual({ args: "v2" })
    }))

  for (
    const [label, name, expected] of [
      ["takes the branch its body chose", "ada", "ADA"],
      ["takes the other branch", "", "silence"]
    ] as const
  ) {
    it.effect(`drives a flow.ts that IS a @smthrs/flow flow and ${label}`, () =>
      Effect.gen(function*() {
        const directory = workspace(`standalone-${expected}`)
        const filename = join(directory, "engine.db")
        const descriptor = yield* descriptorNamed("standalone").pipe(Effect.provide(platform))
        // No delegate is registered, and none is needed: the module's default
        // export is the flow, so its own graph is what the engine drives.
        const executable = yield* Executable.fromDescriptor(descriptor, { delegates: [] }).pipe(
          Effect.provide(platform)
        )
        const observed = yield* Effect.gen(function*() {
          return yield* executable.flow.execute({ input: { name } }, { executionId: `standalone-${expected}` })
        }).pipe(
          Effect.provide(
            durable(
              filename,
              `registry-standalone-${expected}`,
              Layer.mergeAll(
                Shout.toLayer(({ name }) => Effect.succeed(name.toUpperCase())),
                executable.layer
              ).pipe(Layer.provideMerge(Action.layerImplementations)) as Layer.Layer<unknown, never, never>
            )
          ),
          Effect.scoped,
          Effect.orDie
        )

        expect(observed).toBe(expected)
        expect(existsSync(filename)).toBe(true)
      }))
  }

  it.effect("serves a second run a self-delegating flow's recorded result", () =>
    Effect.gen(function*() {
      let shouts = 0
      const filename = join(workspace("standalone-cache"), "engine.db")
      const descriptor = yield* descriptorNamed("standalone").pipe(Effect.provide(platform))
      // The policy a `@smthrs/flow` declaration carries is lowered exactly as a
      // `@smthrs/core` one is: the run becomes ONE dispatched step with the
      // flow beneath it as a child execution, which is the only shape a
      // recorded result can be served again from.
      const executable = yield* Executable.fromDescriptor(descriptor, {
        delegates: [],
        load: () =>
          Effect.succeed({
            default: standalone.annotate(CacheEnvironment.CachePolicyAnnotation, { ttlMs: 60_000, scope: "shared" })
          })
      }).pipe(Effect.provide(platform))
      expect(executable.lowered.cache).toEqual({ ttlMs: 60_000, scope: "shared" })
      expect(executable.descriptor.effects.tier).toBe("sealed")

      const run = (executionId: string, hostId: string) =>
        executable.flow.execute({ input: { name: "ada" } }, { executionId }).pipe(
          Effect.provide(
            durable(
              filename,
              hostId,
              Layer.mergeAll(
                Shout.toLayer(({ name }) =>
                  Effect.sync(() => {
                    shouts++
                    return name.toUpperCase()
                  })
                ),
                executable.layer
              ).pipe(Layer.provideMerge(Action.layerImplementations)) as Layer.Layer<unknown, never, never>
            )
          ),
          Effect.scoped,
          Effect.orDie
        )

      expect(yield* run("standalone-cache-1", "registry-standalone-cache-a")).toBe("ADA")
      expect(yield* run("standalone-cache-2", "registry-standalone-cache-b")).toBe("ADA")
      // The second run never reached the flow's own step.
      expect(shouts).toBe(1)
    }))

  for (const cache of [false, true]) {
    it.effect(`keeps a canonical same-tag declaration's input codec separate from its admission adapter (cache: ${cache})`, () =>
      Effect.gen(function*() {
        const filename = join(workspace(`canonical-${cache}`), "engine.db")
        const descriptor = yield* descriptorNamed("standalone").pipe(Effect.provide(platform))
        const declaration = Flow.make("standalone", {
          payload: { name: Schema.String },
          success: Schema.String,
          capabilities: [],
          effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
          body: ({ name }) => Node.succeed(name.toUpperCase())
        })
        const executable = yield* Executable.fromDescriptor(descriptor, {
          delegates: [],
          load: () =>
            Effect.succeed({
              default: cache
                ? declaration.annotate(CacheEnvironment.CachePolicyAnnotation, { ttlMs: 60_000, scope: "shared" })
                : declaration
            })
        }).pipe(Effect.provide(platform))
        expect(declaration._tag).toBe("standalone")
        expect(executable.descriptor.name).toBe("standalone")
        expect(executable.declaredTag).toBe("standalone")
        expect(executable.flow._tag).not.toBe(declaration._tag)
        const run = (id: string) =>
          executable.flow.execute({ input: { name: "ada" } }, { executionId: id }).pipe(
            Effect.provide(
              durable(
                filename,
                id,
                executable.layer.pipe(Layer.provideMerge(Action.layerImplementations)) as Layer.Layer<
                  unknown,
                  never,
                  never
                >
              )
            ),
            Effect.scoped,
            Effect.orDie
          )
        expect(yield* run(`canonical-${cache}-first`)).toBe("ADA")
        expect(yield* run(`canonical-${cache}-restarted`)).toBe("ADA")
      }))
  }

  it.effect("refuses a discovered flow whose delegate no host registered", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("orphan").pipe(Effect.provide(platform))
      const failure = yield* Effect.flip(
        Executable.fromDescriptor(descriptor, { delegates: [Echo, Agent] }).pipe(Effect.provide(platform))
      )
      // The refusal happens before the engine is asked to drive anything, so
      // an operator reads the missing flow's name instead of an empty `AnyOf`
      // issue raised at dispatch.
      expect(failure.code).toBe("missing_delegate")
      expect(failure.message).toContain("test/missing")
    }))
})

describe("the annotation golden", () => {
  it.effect("serves a second run the result a declared cache policy made reusable", () =>
    Effect.gen(function*() {
      executions = 0
      spawned.length = 0
      const directory = workspace("cache")
      const filename = join(directory, "engine.db")
      const executable = yield* executableNamed("cacheable")

      // The SAME invocation, twice, in two separate runs over one database
      // file. The descriptor declares `{ ttlMs: 60_000, scope: "shared" }`, so
      // the dispatched step carries an address a sibling run derives too.
      const first = yield* execute(executable, filename, "registry-cache-a", "cacheable-1", { name: "one" })
      const second = yield* execute(executable, filename, "registry-cache-b", "cacheable-2", { name: "one" })

      expect(first.result).toBe("cacheable:compiled")
      expect(second.result).toBe("cacheable:compiled")
      // The second run never started the delegate: it served the row the first
      // run recorded for the bridged step. That is the whole of what a
      // descriptor's cache policy buys, and the control below is the same
      // descriptor without the declaration.
      expect(spawned.length).toBe(1)
      expect(executions).toBe(1)
    }))

  for (const partition of ["input", "model", "placement"] as const) {
    it.effect(`partitions the persisted bridge cache by ${partition} across A, B, A runs`, () =>
      Effect.gen(function*() {
        spawned.length = 0
        const filename = join(workspace(`cache-${partition}`), "engine.db")
        const base = yield* descriptorNamed("cacheable")
        const results: Array<unknown> = []
        for (const [index, variant] of ["A", "B", "A"].entries()) {
          const input = { name: partition === "input" ? variant : "same" }
          const model = partition === "model" ? (variant === "A" ? "smart" : "fast") : null
          const placement = partition === "placement" ? (variant === "A" ? "local" : "sandbox") : null
          // Reconstruct the bridge and reopen the same SQLite file in a fresh
          // runtime for every distinct execution.
          const executable = yield* Executable.fromDescriptor(
            new Descriptor.FlowDescriptor({
              ...base,
              model: Option.fromNullishOr(model),
              placement: Option.fromNullishOr(placement)
            }),
            { delegates: [Echo, Agent] }
          ).pipe(Effect.provide(platform))
          const observed = yield* execute(
            executable,
            filename,
            `registry-${partition}-${index}`,
            `${partition}-${index}`,
            input,
            inputDependentRunLayer
          )
          expect(observed.result).toBe(invocationResult({ input, model, placement }))
          expect(spawned.length).toBe(index === 0 ? 1 : 2)
          results.push(observed.result)
        }
        expect(results[0]).not.toBe(results[1])
        expect(results[2]).toBe(results[0])
        expect(spawned).toHaveLength(2)
      }))
  }

  it.effect("runs the delegate again when the descriptor declares no policy", () =>
    Effect.gen(function*() {
      executions = 0
      spawned.length = 0
      const directory = workspace("uncached")
      const filename = join(directory, "engine.db")
      const executable = yield* executableNamed("cacheable-plain")

      yield* execute(executable, filename, "registry-uncached-a", "plain-1", { name: "one" })
      yield* execute(executable, filename, "registry-uncached-b", "plain-2", { name: "one" })

      // No policy, no cross-run address for the bridged step, so the delegate
      // runs on every execution. The delegate's OWN sealed step still reuses
      // its recorded result, which is why `executions` stays 1: the two caches
      // are different units and only the outer one is the descriptor's to
      // declare.
      expect(executable.lowered.cache).toBeUndefined()
      expect(spawned.length).toBe(2)
      expect(executions).toBe(1)
    }))

  it.effect("narrows the cache address from a descriptor's declared scope", () =>
    Effect.gen(function*() {
      executions = 0
      spawned.length = 0
      const directory = workspace("scoped")
      const filename = join(directory, "engine.db")
      const executable = yield* executableNamed("cacheable-scoped")

      // Identical to the `cacheable` case in everything but the policy: this
      // descriptor declares `scope: "run"`, which `@smthrs/engine-store`
      // `ActionPersistence` folds into the cache row's ADDRESS. The second run
      // derives a different address, finds nothing, and runs the delegate.
      yield* execute(executable, filename, "registry-scoped-a", "scoped-1", { name: "one" })
      yield* execute(executable, filename, "registry-scoped-b", "scoped-2", { name: "one" })

      expect(executable.lowered.cache).toEqual({ scope: "run" })
      expect(spawned.length).toBe(2)
      expect(executions).toBe(1)
    }))

  it.effect("stops serving a recorded result past the descriptor's declared ttl", () =>
    Effect.gen(function*() {
      executions = 0
      spawned.length = 0
      const directory = workspace("expiring")
      const filename = join(directory, "engine.db")
      const executable = yield* executableNamed("cacheable-expiring")

      const first = yield* execute(executable, filename, "registry-expiring-a", "expiring-1", { name: "one" })
      // The suite runs on a test clock, so the age the engine measures is the
      // one this line states rather than however long the first run took.
      yield* TestClock.adjust("10 millis")
      const second = yield* execute(executable, filename, "registry-expiring-b", "expiring-2", { name: "one" })

      expect(executable.lowered.cache).toEqual({ ttlMs: 1, scope: "shared" })
      // Identical to the `cacheable` case in everything but `ttlMs`, and the
      // engine journalled the age verdict it acted on rather than leaving the
      // re-execution to be explained by a fresh clock reading.
      expect(spawned.length).toBe(2)
      expect(first.events).toContain("flows.engine.cache-provenance")
      expect(second.events).toContain("flows.engine.cache-provenance")
    }))

  it.effect("does not reuse a result whose read set is a pattern and whose boundary is soft", () =>
    Effect.gen(function*() {
      executions = 0
      spawned.length = 0
      const directory = workspace("reads")
      const filename = join(directory, "engine.db")
      const executable = yield* executableNamed("cacheable-reads")

      yield* execute(executable, filename, "registry-reads-a", "reads-1", { name: "one" })
      yield* execute(executable, filename, "registry-reads-b", "reads-2", { name: "one" })

      // The declared reads reach the dispatched step as one glob, because a
      // descriptor declares file inputs as strings and discovery measures
      // nothing. A globbed read set cannot say which expansion its key names,
      // and `mode: "expected"` is not the hard boundary a shared result needs,
      // so the policy is honored by being refused: the delegate runs again.
      expect(executable.lowered.cache).toEqual({ ttlMs: 60_000, scope: "shared" })
      expect(executable.descriptor.effects.reads).toEqual(["notes/*.md"])
      expect(spawned.length).toBe(2)
    }))

  it.effect("does not reuse a delegating descriptor's result, whatever it declares", () =>
    Effect.gen(function*() {
      executions = 0
      spawned.length = 0
      const directory = workspace("delegating")
      const filename = join(directory, "engine.db")
      const executable = yield* executableNamed("tuned")

      yield* execute(executable, filename, "registry-delegating-a", "tuned-1", { name: "one" })
      yield* execute(executable, filename, "registry-delegating-b", "tuned-2", { name: "one" })

      // `tuned` declares the same policy `cacheable` does AND `tier: "sealed"`,
      // and still runs twice. Naming a delegate flow without declaring
      // capabilities is what costs it the reuse: the delegate's authority is
      // not statically visible, so discovery projects the conservative wildcard, the descriptor's effective tier
      // becomes `irreversible`, and `ActionPersistence` caches a `sealed`
      // dispatch and nothing else. The policy reaches admission and is refused
      // there. Anything else would let a flow with unbounded authority claim
      // its own result is reusable.
      expect(executable.lowered.cache).toEqual({ ttlMs: 60_000, scope: "shared" })
      expect(executable.descriptor.effects.tier).toBe("irreversible")
      expect(spawned.length).toBe(2)
    }))

  it.effect("hands the delegate the placement the descriptor declared", () =>
    Effect.gen(function*() {
      spawned.length = 0
      const directory = workspace("placement")
      const executable = yield* executableNamed("tuned")
      yield* execute(executable, join(directory, "engine.db"), "registry-placement", "tuned-3", { name: "one" })

      // What a host selects a spawn target with: the delegate the bridge
      // spawned sees the directive rather than having to re-read the source.
      expect(spawned[0]?.placement).toBe("sandbox")
      expect(executable.lowered.placement?._tag).toBe("flows/core/Placement/Sandbox")
    }))

  it.effect("starts the higher-priority discovered flow first under a capacity of one", () =>
    Effect.gen(function*() {
      const tuned = yield* executableNamed("tuned")
      const greet = yield* executableNamed("greet")
      // Two independent delegating nodes, ready in the same pass. `Node.all`
      // fixes no order and declaration order would start the unprioritized
      // one, so only the descriptor's declared priority can decide.
      const both = Flow.make("registry-test/both", {
        payload: {},
        success: Schema.Unknown,
        error: Schema.Unknown,
        body: () =>
          Node.all({
            plain: greet.flow.body({ input: null }),
            tuned: tuned.flow.body({ input: null })
          })
      })
      const drafts = Graph.drafts(Graph.build(both, {}))
      const idOf = (suffix: string): string => {
        const id = drafts.map((draft) => draft.id).find((candidate) => candidate.endsWith(suffix))
        expect(id, suffix).toBeDefined()
        return id as string
      }
      expect(drafts.find((draft) => draft.id === idOf(".all.tuned"))?.priority).toBe(7)

      const directory = workspace("priority")
      const started: Array<string> = []
      const owner: Ownership.OwnerId = { hostId: "registry-priority", pid: 11, nonce: "registry-priority-process" }
      const stores = TestStores.layerAt(join(directory, "scheduler.db"))
      const harness = Layer.mergeAll(
        StepBoundary.layerTest(),
        stubJj,
        PlanScheduler.layerExecutor({
          execute: ({ node }) =>
            Effect.sync(() => {
              started.push(node.id)
              return node.id
            })
        })
      ).pipe(Layer.provideMerge(stores), Layer.provideMerge(NodeCrypto.layer), Layer.provideMerge(platform))

      yield* Effect.gen(function*() {
        const plan = yield* Plan.compile({
          planId: "registry-priority-plan",
          flow: "registry-test/both",
          nodes: drafts
        })
        const runs = yield* RunStore.RunStore
        yield* runs.create("registry-priority-run", "{}")
        const row = yield* runs.get("registry-priority-run")
        const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
        const claim = yield* runs.claim("registry-priority-run", snapshot, owner, 1)
        if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
        const activated = yield* runs.activate("registry-priority-run", owner, claim.claimedAtMs, snapshot)
        if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
        yield* PlanScheduler.make({
          runId: "registry-priority-run",
          owner,
          sourceId: "registry-priority",
          concurrency: { steps: 1 }
        }).run(plan)
      }).pipe(Effect.provide(harness), Effect.scoped, Effect.orDie)

      const prioritized = started.indexOf(idOf(".all.tuned"))
      const plain = started.indexOf(idOf(".all.plain"))
      expect(prioritized).toBeGreaterThanOrEqual(0)
      expect(prioritized).toBeLessThan(plain)
    }))
})

describe("the host seam", () => {
  it.effect("registers every discovered flow through the runtime's registry parameter", () =>
    Effect.gen(function*() {
      spawned.length = 0
      const directory = workspace("host")
      const options: Executable.Options = { delegates: [Echo] }
      // The whole seam, composed the way a host composes it: discovery over
      // `<root>/flows/**` is the runtime's registry, and the registration phase
      // is the catalog built from it. Nothing lists a flow by hand.
      const runtime = durable(
        join(directory, "engine.db"),
        "registry-host",
        Layer.mergeAll(runLayer, Interpreter.layer(Echo), Executable.layer(options)).pipe(
          Layer.provideMerge(Action.layerImplementations)
        ).pipe(Layer.provideMerge(Registry.layerProject({ root: projectRoot })))
      )

      const observed = yield* Effect.gen(function*() {
        const executable = yield* Executable.fromRegistry("changelog", options)
        return yield* executable.flow.execute({ input: { args: "v3" } }, { executionId: "host-1" })
      }).pipe(Effect.provide(runtime), Effect.scoped, Effect.orDie)

      expect(observed).toBe("changelog:compiled")
      expect(spawned[0]?.flow).toBe("changelog")
      expect(spawned[0]?.input).toEqual({ args: "v3" })
    }))
})
