/**
 * Flows are the only capability primitive a cell ever sees.
 *
 * The point of these tests is that the *kind* of a capability stops being
 * visible at the boundary. A standard filesystem flow, a shell flow, a memory
 * flow, a plugin-contributed flow, a durable wait, a human approval, and a
 * detached child agent are all reached the same way — look it up in
 * `ctx.flows`, invoke it with `ctx.call` — and all of them produce the same
 * `CellCallStarted` / `CellCallSettled` pair around the same durable activity.
 *
 * Everything runs on the production stack: the real durable engine, the real
 * QuickJS sandbox, the real registry-backed resolver, the real controller. Only
 * the provider is recorded.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as CoreFlow from "@smthrs/core/Flow"
import { FlowEngine } from "@smthrs/engine"
import { Flow as EngineFlow, FlowRuntime } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import type { FlowsHooks, PluginInput } from "@smthrs/plugin"
import { make as makePlugin } from "@smthrs/plugin"
import type { ResolvedConfig } from "@smthrs/plugin/Config"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import * as Search from "@smthrs/std/Search"
import { StdError } from "@smthrs/std/StdError"
import * as TestRunner from "@smthrs/std/TestRunner"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Scope,
  Sink,
  Stream
} from "effect"
import * as ByteSize from "effect/ByteSize"
import type * as Crypto from "effect/Crypto"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentSession from "../src/AgentSession.ts"
import * as CellPlugin from "../src/CellPlugin.ts"
import * as ChildFlows from "../src/ChildFlows.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as StandardFlows from "../src/StandardFlows.ts"
import * as Safety from "./Safety.ts"

/**
 * The attribution judge the `test` flow asks about every non-zero exit. These
 * runs fail about the tree; what the judge decides is `@smthrs/std`'s subject,
 * and what matters here is that the flow has one.
 */
const judge = Evaluator.Evaluator.of({
  evaluate: () =>
    Effect.succeed({
      answers: {
        attribution: { type: "choice" as const, choice: "tree" },
        executed: { type: "boolean" as const, probability: 0.95 }
      },
      latencyMs: 0
    })
})

/** The attribution judge, as the context a binding is handed. */
const judgeServices = Context.make(Evaluator.Evaluator, judge)

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

/** A recorded model that replies with one cell per frame and records its prompt. */
const recorded = (requests: Array<string>, cells: ReadonlyArray<string>): Model.Model => {
  let index = 0
  return Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push(
          request.system.map((part) => part.text).join("\n") +
            "\n" +
            request.messages.flatMap((message) =>
              message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
            ).join("\n")
        )
        const source = cells[index++] ?? cells.at(-1) ?? "ctx.done(\"done\")"
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: `cell-${index}` }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: `cell-${index}`,
            text: "```cell\n" + source + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: `cell-${index}` }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
}

const registryOf = (entries: ReadonlyArray<Descriptor.FlowDescriptor>): Registry.Registry => {
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  return Registry.makeNoop({
    list: () => Effect.succeed(entries),
    visible: () => Effect.succeed(entries.filter((entry) => entry.modelInvocable)),
    getOption: (name) => Effect.succeed(Option.fromNullishOr(byName.get(name)))
  })
}

type Outcome =
  | { readonly _tag: "completed"; readonly value: unknown }
  | { readonly _tag: "failed"; readonly error: unknown }
  | { readonly _tag: "suspended" }

const classify = (exit: Exit.Exit<unknown, unknown>): Outcome =>
  Exit.isSuccess(exit)
    ? { _tag: "completed", value: exit.value }
    : Cause.hasInterruptsOnly(exit.cause)
    ? { _tag: "suspended" }
    : { _tag: "failed", error: Cause.squash(exit.cause) }

/**
 * The one flow every `drive` execution registers. Its body is inert: the
 * behaviour under test is the `execute` handed to `register`.
 */
const driveFlow = EngineFlow.make("agent/test/cell-flows", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

const awaitParked = (
  engine: FlowRuntime.FlowRuntime["Service"],
  flow: typeof driveFlow,
  attempts = 100
): Effect.Effect<void, FlowRuntime.FlowExecutionNotFound> =>
  Effect.gen(function*() {
    const polled = yield* engine.poll(flow, "exec-1")
    if (Option.isSome(polled) && polled.value._tag === "Suspended") return
    if (attempts <= 0) throw new Error("the engine never published the parked execution")
    yield* Effect.yieldNow
    return yield* awaitParked(engine, flow, attempts - 1)
  })

/**
 * The host decision a compensable flow needs.
 *
 * `edit` and `apply_patch` declare the `compensable` tier, and the engine
 * refuses to run a compensable action against a host that has named no
 * boundary to snapshot. Nothing here rolls back, so the boundary is inert; what
 * it stands for is a host having made that decision at all, which is what a
 * production composition offering the editing flows has to do.
 */
const snapshotBoundary = Layer.succeed(FlowEngine.SnapshotBoundary)(
  FlowEngine.SnapshotBoundary.of({
    snapshot: () => Effect.succeed(undefined),
    restore: () => Effect.void,
    diff: () => Effect.succeed(Option.none())
  })
)

/** Runs one body as the whole of one real durable flow execution. */
const drive = <A, E>(
  body: Effect.Effect<A, E, Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>,
  options: { readonly resume?: boolean } = {}
): Promise<Outcome> =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const flow = driveFlow
    let settled = Deferred.makeUnsafe<Outcome>()
    yield* engine.register(flow, () =>
      Effect.onExit(body, (exit) => Effect.asVoid(Deferred.succeed(settled, classify(exit))))).pipe(
        Scope.provide(scope)
      )
    yield* engine.execute(flow, { executionId: "exec-1", payload: {}, discard: true })
    const first = yield* Deferred.await(settled)
    if (options.resume !== true || first._tag !== "suspended") {
      return first
    }
    yield* awaitParked(engine, flow)
    settled = Deferred.makeUnsafe<Outcome>()
    yield* engine.resume(flow, "exec-1")
    return yield* Deferred.await(settled)
  }).pipe(
    Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, snapshotBoundary)),
    Effect.scoped,
    Effect.runPromise
  )

const eventsOf = (outcome: Outcome): ReadonlyArray<AgentEvent.AgentEvent> =>
  outcome._tag === "completed" ? outcome.value as ReadonlyArray<AgentEvent.AgentEvent> : []

const settledCalls = (collected: ReadonlyArray<AgentEvent.AgentEvent>) =>
  collected.flatMap((event) => (event._tag === "cell-call-settled" ? [event] : []))

/** The posix path service, materialized once so bindings can be given a context. */
const pathServices: Context.Context<Path.Path> = Effect.runSync(
  Effect.provide(Effect.context<Path.Path>(), Path.layer)
)

const fileInfo = (size: number): FileSystem.File.Info => ({
  type: "File",
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0o644,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: ByteSize.bytes(size),
  blksize: Option.none(),
  blocks: Option.none()
})

const directoryInfo: FileSystem.File.Info = { ...fileInfo(0), type: "Directory" }

/** An in-memory kernel filesystem, enough for the standard filesystem flows. */
const files = (initial: Readonly<Record<string, string>>) => {
  const contents = new Map(Object.entries(initial))
  const missing = FileSystem.makeNoop({})
  // `ls`, `glob` and `grep` walk the tree instead of reading one named path, so
  // the fixture answers for the directories its file paths imply.
  const directories = (): ReadonlySet<string> => {
    const found = new Set(["/"])
    for (const path of contents.keys()) {
      let current = ""
      for (const part of path.split("/").slice(1, -1)) {
        current = `${current}/${part}`
        found.add(current)
      }
    }
    return found
  }
  const fileSystem = FileSystem.makeNoop({
    stat: (path) => {
      const found = contents.get(path)
      if (found !== undefined) return Effect.succeed(fileInfo(found.length))
      return directories().has(path) ? Effect.succeed(directoryInfo) : missing.stat(path)
    },
    readDirectory: (path) => {
      if (!directories().has(path)) return missing.readDirectory(path)
      const prefix = path === "/" ? "/" : `${path}/`
      const names = new Set<string>()
      for (const entry of [...contents.keys(), ...directories()]) {
        if (entry === path || !entry.startsWith(prefix)) continue
        const name = entry.slice(prefix.length).split("/")[0]
        if (name !== undefined && name !== "") names.add(name)
      }
      return Effect.succeed([...names].sort())
    },
    readFile: (path) => Effect.succeed(new TextEncoder().encode(contents.get(path) ?? "")),
    stream: (path) => {
      const content = contents.get(path)
      return content === undefined ? missing.stream(path) : Stream.succeed(new TextEncoder().encode(content))
    },
    exists: (path) => Effect.succeed(contents.has(path)),
    makeDirectory: () => Effect.void,
    // Atomic replacement writes a sibling, then renames it over the target.
    realPath: (path) => contents.has(path) ? Effect.succeed(path) : missing.realPath(path),
    rename: (from, to) => {
      const content = contents.get(from)
      if (content === undefined) return missing.rename(from, to)
      return Effect.sync(() => {
        contents.set(to, content)
        contents.delete(from)
      })
    },
    remove: (path) =>
      Effect.sync(() => {
        contents.delete(path)
      }),
    writeFile: (path, data) =>
      Effect.sync(() => {
        contents.set(path, new TextDecoder().decode(data))
      }),
    writeFileString: (path, content) =>
      Effect.sync(() => {
        contents.set(path, content)
      })
  })
  return {
    contents,
    services: Context.merge(Context.make(FileSystem.FileSystem, fileSystem), pathServices)
  }
}

const collect = (options: {
  readonly registry?: Registry.Registry | undefined
  readonly cells: ReadonlyArray<string>
  readonly requests?: Array<string> | undefined
  readonly flows?: ReadonlyArray<FlowBinding.Source> | undefined
  readonly plugins?: PluginInput<FlowsHooks> | undefined
  readonly authorize?: ((call: Cell.Call) => Effect.Effect<void, HarnessError>) | undefined
}) =>
  Effect.gen(function*() {
    const collected: Array<AgentEvent.AgentEvent> = []
    const agent = yield* Agent.Agent
    yield* agent.run({
      session: "session-1",
      seat: Seat.make({
        id: "anthropic:test-model",
        modelId: "test-model",
        model: recorded(options.requests ?? [], options.cells),
        route,
        contextWindowTokens: 0
      }),
      prompt: "do the task",
      registry: options.registry ?? registryOf([]),
      // The standard flows declare real capabilities, so the run needs a real
      // envelope; an empty one refuses every declared capability by contract.
      capabilityEnvelope: [new Capability.CapabilityPattern({ action: "*", resource: "*" })],
      flows: options.flows,
      plugins: options.plugins,
      authorize: options.authorize,
      maxFrames: 3
    }).pipe(
      Stream.runForEach((event) => Effect.sync(() => collected.push(event))),
      Effect.provide(Layer.merge(Agent.layerDefaults, scriptedCompletionJudge))
    )
    return collected
  }).pipe(Effect.provide(Agent.layer), Effect.provide(Safety.layer))

describe("standard capabilities are flows", () => {
  it("runs a std filesystem read, a std shell command, and a memory write through one call boundary", async () => {
    const filesystem = files({ "/repo/alpha.md": "first line\nsecond line" })
    const commands: Array<string> = []
    const remembered: Array<{ readonly key: string; readonly text: string }> = []
    const requests: Array<string> = []

    const outcome = await drive(
      collect({
        requests,
        flows: [
          StandardFlows.filesystem(filesystem.services),
          StandardFlows.shell(
            Context.make(
              ChildProcessSpawner.ChildProcessSpawner,
              // `Shell` is gone; the bash flow spawns a shell command through
              // Effect's spawner, so the stub answers one off `CommandLine`.
              ChildProcessSpawner.makeNoop({
                spawn: (command) =>
                  Effect.sync(() => {
                    const line = CommandLine.render(command)
                    commands.push(line)
                    return makeHandle({
                      pid: ProcessId(1),
                      exitCode: Effect.succeed(ExitCode(0)),
                      isRunning: Effect.succeed(false),
                      kill: () => Effect.void,
                      stdin: Sink.drain,
                      stdout: Stream.fromArray([new TextEncoder().encode(`ran ${line}`)]),
                      stderr: Stream.empty,
                      all: Stream.fromArray([new TextEncoder().encode(`ran ${line}`)]),
                      getInputFd: () => Sink.drain,
                      getOutputFd: () => Stream.empty,
                      unref: Effect.succeed(Effect.void)
                    })
                  })
              })
            ).pipe((spawner) => Context.merge(spawner, pathServices))
          ),
          StandardFlows.memory(
            Context.make(
              MemoryStore.MemoryStore,
              MemoryStore.makeNoop({
                putFact: (input) =>
                  Effect.sync(() => {
                    remembered.push({ key: input.key, text: (input.value as { readonly content: string }).content })
                  })
              })
            ).pipe(Context.add(Recall.Recall, Recall.makeNoop())),
            judgeServices
          )
        ],
        cells: [
          `const page = await ctx.call("read", { path: "/repo/alpha.md" })
const ran = await ctx.call("bash", { mode: "unhermetic", command: "echo hi" })
const kept = await ctx.call("remember", { bank: "notes", key: "k1", text: page.content })
ctx.done(page.content + "|" + ran.stdout + "|" + kept.key)`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    const collected = eventsOf(outcome)

    // Three capabilities, three kinds, one boundary shape.
    expect(collected.filter((event) => event._tag === "cell-call-started")).toHaveLength(3)
    const settled = settledCalls(collected)
    expect(settled.map((event) => event.flowName)).toEqual(["read", "bash", "remember"])
    expect(settled.every((event) => event.result.outcome === "success")).toBe(true)

    // The result the cell saw came back through the flow's own output schema.
    const read = settled[0]?.result.value as { readonly content: string; readonly totalLines: number }
    expect(read.totalLines).toBe(2)
    expect(read.content).toContain("first line")
    expect(commands).toEqual(["echo hi"])
    expect(remembered).toEqual([{ key: "k1", text: read.content }])

    // The catalog is disclosed to the model as ordinary registry entries.
    expect(requests[0]).toContain("read")
    expect(requests[0]).toContain("bash")
    expect(requests[0]).toContain("remember")
  })

  it("runs a bash call that names no mode, the shape the cell contract's example writes", async () => {
    const commands: Array<string> = []
    const spawner = ChildProcessSpawner.makeNoop({
      spawn: (command) =>
        Effect.sync(() => {
          const line = CommandLine.render(command)
          commands.push(line)
          return makeHandle({
            pid: ProcessId(1),
            exitCode: Effect.succeed(ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void)
          })
        })
    })
    const outcome = await drive(collect({
      flows: [
        StandardFlows.shell(
          Context.merge(Context.make(ChildProcessSpawner.ChildProcessSpawner, spawner), pathServices)
        )
      ],
      cells: [`const ran = await ctx.call("bash", { command: "bun run typecheck" })
ctx.done(ran.ok === false ? ran.error.message : String(ran.exitCode))`]
    }))
    const settled = settledCalls(eventsOf(outcome))
    expect(settled.map((event) => event.result.outcome)).toEqual(["success"])
    expect(commands).toEqual(["bun run typecheck"])
  })

  it("re-reads a file a write changed inside one cell instead of replaying the sealed read", async () => {
    // A sealed call is content-addressed, and `read` is sealed: the same path
    // asked twice is one boundary. But "the same path against the tree as it
    // stands" is a different question once a write has settled in between, and
    // a run that answers it from the record reports the pre-edit text after
    // its own edit. The key therefore moves with the run's write epoch.
    const filesystem = files({})
    const outcome = await drive(
      collect({
        flows: [StandardFlows.filesystem(filesystem.services)],
        cells: [
          `await ctx.call("write", { path: "/repo/f.txt", content: "one" })
const a = await ctx.call("read", { path: "/repo/f.txt" })
await ctx.call("write", { path: "/repo/f.txt", content: "two" })
const b = await ctx.call("read", { path: "/repo/f.txt" })
ctx.done(JSON.stringify([a.content, b.content]))`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    const settled = settledCalls(eventsOf(outcome))
    expect(settled.map((event) => event.flowName)).toEqual(["write", "read", "write", "read"])
    const contents = settled.flatMap((event) =>
      event.flowName === "read" ? [(event.result.value as { readonly content: string }).content] : []
    )
    expect(contents).toEqual(["one", "two"])
  })

  it("re-reads a file an earlier frame changed instead of replaying the sealed read", async () => {
    // The same defect across frames: frame 0 reads then writes, frame 1 reads
    // again. The frame clock the sufficiency control already keeps says the
    // tree moved, so the second frame's read keys differently.
    const filesystem = files({ "/repo/f.txt": "one" })
    const outcome = await drive(
      collect({
        flows: [StandardFlows.filesystem(filesystem.services)],
        cells: [
          `const a = await ctx.call("read", { path: "/repo/f.txt" })
await ctx.call("write", { path: "/repo/f.txt", content: "two" })`,
          `const b = await ctx.call("read", { path: "/repo/f.txt" })
ctx.done(b.content)`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    const settled = settledCalls(eventsOf(outcome))
    expect(settled.map((event) => event.flowName)).toEqual(["read", "write", "read"])
    expect((settled[2]?.result.value as { readonly content: string }).content).toBe("two")
  })

  it("serves two identical sealed reads with no write between them from one boundary", async () => {
    // Caching is the point of sealed: the second read never reaches the
    // filesystem, so a stub that counts reads sees one.
    const filesystem = files({ "/repo/f.txt": "one" })
    let reads = 0
    const counting = Context.make(
      FileSystem.FileSystem,
      {
        ...Context.get(filesystem.services, FileSystem.FileSystem),
        readFile: (path: string) => {
          reads++
          return Context.get(filesystem.services, FileSystem.FileSystem).readFile(path)
        }
      } as FileSystem.FileSystem
    ).pipe((context) => Context.merge(context, pathServices))
    const outcome = await drive(
      collect({
        flows: [StandardFlows.filesystem(counting)],
        cells: [
          `const a = await ctx.call("read", { path: "/repo/f.txt" })
const b = await ctx.call("read", { path: "/repo/f.txt" })
ctx.done(JSON.stringify([a.content, b.content]))`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    const settled = settledCalls(eventsOf(outcome))
    expect(settled.map((event) => event.flowName)).toEqual(["read", "read"])
    expect(settled.map((event) => (event.result.value as { readonly content: string }).content)).toEqual([
      "one",
      "one"
    ])
    expect(reads).toBe(1)
  })

  it("edits, patches, lists, searches, and recalls through the same one call boundary", async () => {
    // The five filesystem flows beyond `read` and `write` and the second memory
    // flow are the ones a composition can lose silently: a binding array is
    // fixed, nothing counts it, and the loss only shows up when a run reaches
    // for the capability. That is the failure this composition was written to
    // end — with only `read` and `write` bound, the harness emitted
    // `apply_patch` heredocs into `bash` and finished claiming fixes it never
    // applied — so this cell calls every one of them for real.
    const filesystem = files({
      "/repo/alpha.md": "first line\nsecond line",
      "/repo/notes/beta.txt": "beta"
    })
    const asked: Array<string> = []

    const outcome = await drive(
      collect({
        flows: [
          StandardFlows.filesystem(filesystem.services),
          StandardFlows.memory(
            Context.make(MemoryStore.MemoryStore, MemoryStore.makeNoop()).pipe(
              Context.add(
                Recall.Recall,
                Recall.Recall.of({
                  recall: (input) =>
                    Effect.sync(() => {
                      asked.push(`${input.banks.join(",")}:${input.query}`)
                      return [{ bank: "notes", key: "k1", text: "alpha is the file", score: 1 }]
                    })
                })
              )
            ),
            Effect.runSync(
              Effect.provide(
                Effect.context<Evaluator.Evaluator>(),
                Evaluator.layerScripted(() => ({ unnecessary_0: { probability: 0.1 } }))
              )
            )
          )
        ],
        cells: [
          `const listed = await ctx.call("ls", { path: "/repo" })
const globbed = await ctx.call("glob", { pattern: "*.md", root: "/repo" })
const grepped = await ctx.call("grep", { pattern: "second", root: "/repo" })
const edited = await ctx.call("edit", { path: "/repo/alpha.md", oldString: "second line", newString: "edited line" })
const patched = await ctx.call("apply_patch", { input: "*** Begin Patch\\n*** Add File: /repo/gamma.md\\n+gamma\\n*** End Patch" })
const recalled = await ctx.call("recall", { banks: ["notes"], query: "alpha" })
ctx.done([
  listed.entries.length,
  globbed.paths.join(","),
  grepped.matches.length,
  edited.replacements,
  patched.added.join(","),
  recalled.rows[0].text
].join("|"))`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    const collected = eventsOf(outcome)
    const settled = settledCalls(collected)
    expect(settled.map((event) => event.flowName)).toEqual([
      "ls",
      "glob",
      "grep",
      "edit",
      "apply_patch",
      "recall"
    ])
    expect(settled.filter((event) => event.result.outcome !== "success")).toEqual([])

    // Each call reached the host service behind its binding, not a stub of it:
    // the search flows walked the fixture tree, the editing flows wrote to it,
    // and recall reached the supplied `Recall`.
    const resolved = collected.find((event) => event._tag === "resolved")
    expect(resolved?._tag === "resolved" ? resolved.message.content : []).toEqual([
      { type: "text", text: "2|/repo/alpha.md|1|1|/repo/gamma.md|alpha is the file" }
    ])
    expect(filesystem.contents.get("/repo/alpha.md")).toBe("first line\nedited line")
    expect(filesystem.contents.get("/repo/gamma.md")).toBe("gamma\n")
    expect(asked).toEqual(["notes:alpha"])
    // The recall's own Jev reading is journaled into the run that called it.
    expect(collected.find((event) => event._tag === "relevance-settled")).toMatchObject({
      source: "recall",
      kept: [{ kind: "memory", id: "k1" }]
    })
  })

  it("routes a containerised bash call through the transport the shell binding supplies", async () => {
    // `bash`'s `container` field reads the transport out of the context the
    // binding provides. A composition that supplies none makes the field inert
    // — the call resolves `{ ok: false }` with "this host has no container
    // transport" — and the agent goes back to typing `docker exec c bash -lc
    // '…'`, which is the quoting stack the field exists to delete. So the
    // default binding carries one, and the argv it builds is the harness's,
    // never the cell's.
    const spawned: Array<string> = []
    const outcome = await drive(
      collect({
        flows: [
          StandardFlows.shell(
            Context.make(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.makeNoop({
                spawn: (command) =>
                  Effect.sync(() => {
                    spawned.push(CommandLine.render(command))
                    return makeHandle({
                      pid: ProcessId(1),
                      exitCode: Effect.succeed(ExitCode(0)),
                      isRunning: Effect.succeed(false),
                      kill: () => Effect.void,
                      stdin: Sink.drain,
                      stdout: Stream.fromArray([new TextEncoder().encode("3\n")]),
                      stderr: Stream.empty,
                      all: Stream.fromArray([new TextEncoder().encode("3\n")]),
                      getInputFd: () => Sink.drain,
                      getOutputFd: () => Stream.empty,
                      unref: Effect.succeed(Effect.void)
                    })
                  })
              })
            ).pipe((spawner) => Context.merge(spawner, pathServices))
          )
        ],
        cells: [
          `const probe = await ctx.call("bash", { mode: "unhermetic", container: "testbed", cwd: "/testbed", interpreter: "python3", script: "print(1 + 2)" })
ctx.done(probe.stdout.trim())`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    // The payload still rides on standard input as data and every other part
    // of the invocation is an argv element — and the interpreter is reached
    // through the image's login shell, because that is what activates the
    // project's environment. `exec "$@"` replaces the shell rather than
    // wrapping it, so the script arrives on the inherited stdin and nothing is
    // re-parsed as shell text. The `--` before the container name is the
    // option terminator `@smthrs/std` `Container.makeCommand` emits, so a
    // container whose name begins with a dash cannot be read as a docker flag.
    // `bash` brackets a containerised command with two tree fingerprints
    // through the same transport; the command itself is the spawn asserted on.
    expect(spawned.find((argv) => argv.includes("bash -lc"))).toBe(
      `docker exec -i -w /testbed -- testbed bash -lc 'exec "$@"' bash python3 -`
    )
  })

  it("refuses host bash with outside_container when the shell is sealed to one container", async () => {
    // A benchmark host holds other tasks' tests and reference solutions. The
    // sealed binding lets a cell reach the task's container and nothing else:
    // a call with no container, which would run on this host, and a call
    // naming another container both fail before anything is spawned.
    const spawned: Array<string> = []
    const outcome = await drive(
      collect({
        flows: [
          StandardFlows.shell(
            Context.make(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.makeNoop({
                spawn: (command) =>
                  Effect.sync(() => {
                    spawned.push(CommandLine.render(command))
                    return makeHandle({
                      pid: ProcessId(1),
                      exitCode: Effect.succeed(ExitCode(0)),
                      isRunning: Effect.succeed(false),
                      kill: () => Effect.void,
                      stdin: Sink.drain,
                      stdout: Stream.fromArray([new TextEncoder().encode("ok\n")]),
                      stderr: Stream.empty,
                      all: Stream.fromArray([new TextEncoder().encode("ok\n")]),
                      getInputFd: () => Sink.drain,
                      getOutputFd: () => Stream.empty,
                      unref: Effect.succeed(Effect.void)
                    })
                  })
              })
            ).pipe((spawner) => Context.merge(spawner, pathServices)),
            undefined,
            { sealedTo: "testbed" }
          )
        ],
        cells: [
          `const seen = []
for (const input of [
  { mode: "unhermetic", command: "cat /host/tests/test_outputs.py" },
  { mode: "unhermetic", container: "other", command: "cat /solution/solve.sh" },
  { mode: "unhermetic", container: "testbed", command: "echo ok" }
]) { const result = await ctx.call("bash", input); seen.push(result.ok === false ? "refused" : result.stdout.trim()) }
ctx.done(seen.join(","))`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    const settled = settledCalls(eventsOf(outcome))
    expect(settled.map((event) => event.result.outcome)).toEqual(["failure", "failure", "success"])
    expect(settled[0]?.result.code).toBe("flow_failed")
    expect(settled[0]?.result.message).toContain("only inside container \"testbed\"")
    expect(settled[1]?.result.message).toContain("not \"other\"")
    // Only the sealed container was reached; no host command was spawned.
    expect(spawned.some((argv) => argv.includes("/host/tests") || argv.includes("solve.sh"))).toBe(false)
    expect(spawned.find((argv) => argv.includes("echo ok"))).toBe(`docker exec -- testbed bash -lc 'echo ok'`)
    const resolved = eventsOf(outcome).find((event) => event._tag === "resolved")
    expect(resolved?._tag === "resolved" ? resolved.message.content : []).toEqual([
      { type: "text", text: "refused,refused,ok" }
    ])
  })

  it("runs the declared test runner as a flow and answers with a reading of its report", async () => {
    // The runner is a declaration, not a parameter: the cell selects which
    // tests, never how to run them, so a guessed label cannot happen here.
    const spawned: Array<string> = []
    const outcome = await drive(
      collect({
        flows: [
          StandardFlows.tests(
            Context.make(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.makeNoop({
                spawn: (command) =>
                  Effect.sync(() => {
                    spawned.push(CommandLine.render(command))
                    const report = new TextEncoder().encode(
                      "FAILED tests/test_widen.py::test_narrows - AssertionError\n1 failed, 41 passed in 1.2s\n"
                    )
                    return makeHandle({
                      pid: ProcessId(1),
                      exitCode: Effect.succeed(ExitCode(1)),
                      isRunning: Effect.succeed(false),
                      kill: () => Effect.void,
                      stdin: Sink.drain,
                      stdout: Stream.fromArray([report]),
                      stderr: Stream.empty,
                      all: Stream.fromArray([report]),
                      getInputFd: () => Sink.drain,
                      getOutputFd: () => Stream.empty,
                      unref: Effect.succeed(Effect.void)
                    })
                  })
              })
            ).pipe(
              Context.add(TestRunner.TestRunner, TestRunner.make({ command: "python -m pytest -rA", cwd: "/repo" })),
              Context.add(Evaluator.Evaluator, judge)
            )
          )
        ],
        cells: [
          `const suite = await ctx.call("test", { selection: ["tests/test_widen.py"] })
ctx.done(suite.passed + " passed, " + suite.failed.join(","))`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    const settled = settledCalls(eventsOf(outcome))
    expect(settled.map((event) => event.flowName)).toEqual(["test"])
    const suite = settled[0]?.result.value as {
      readonly passed: number
      readonly failed: ReadonlyArray<string>
      readonly parsed: boolean
    }
    expect(suite).toMatchObject({ passed: 41, failed: ["tests/test_widen.py::test_narrows"], parsed: true })
    expect(spawned[0]).toContain("tests/test_widen.py")
  })

  it("publishes fixed retry guidance for shell and test timeouts", async () => {
    const spawner = Context.make(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.makeNoop({ spawn: () => Effect.never })
    )
    const outcome = await drive(collect({
      flows: [
        StandardFlows.shell(Context.merge(spawner, pathServices)),
        StandardFlows.tests(
          Context.add(
            spawner,
            TestRunner.TestRunner,
            TestRunner.make({
              command: "SYNTHETIC_HOST_RUNNER",
              timeoutMs: 1
            })
          ).pipe(Context.add(Evaluator.Evaluator, judge))
        )
      ],
      cells: [`const failed = []
      for (const [name, input] of [
        ["bash", { mode: "unhermetic", command: "echo SYNTHETIC_COMMAND", timeoutMs: 1 }],
        ["test", {}]
      ]) { const result = await ctx.call(name, input); if (result.ok === false) failed.push(name) }
      ctx.done(failed.join(" "))`]
    }))
    const settled = settledCalls(eventsOf(outcome))
    expect(settled.map((event) => event.result.message)).toEqual([
      "Flow bash failed: The command timed out.",
      "Flow test failed: The command timed out."
    ])
    // A command's own timeout is a timeout, the code a guarded host parks on (#2120).
    expect(settled.every((event) => event.result.code === "timeout")).toBe(true)
    expect(JSON.stringify(settled.map((event) => event.result))).not.toContain("SYNTHETIC_")
  })

  it("refuses a failing standard flow catchably rather than failing the run", async () => {
    const filesystem = files({})
    const outcome = await drive(
      collect({
        flows: [StandardFlows.filesystem(filesystem.services)],
        cells: [
          `let caught = "none"
try { await ctx.call("read", { path: "/missing.md" }) } catch (error) { caught = String(error.message) }
ctx.done(caught)`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    const settled = settledCalls(eventsOf(outcome))
    expect(settled[0]?.result.outcome).toBe("failure")
    expect(settled[0]?.result.message).toContain("Flow read failed")
    expect(settled[0]?.result.message).toContain("File not found: /missing.md")
  })

  it("keeps corrective search refusals public and host diagnostics opaque", async () => {
    const secret = "SYNTHETIC_HOST_ONLY_TOKEN"
    const filesystem = files({})
    const search = Search.make({
      grep: (input) =>
        input.pattern === "d"
          ? Effect.fail(
            new StdError({ code: "provider_unavailable", message: "No search implementation is configured" })
          )
          : Effect.fail(
            new StdError({
              code: input.pattern === "a" ? "request_failed" : input.pattern === "b" ? "command_failed" : "timeout",
              message: secret
            })
          ),
      glob: () => Effect.fail(new StdError({ code: "invalid_pattern", message: secret }))
    })
    const outcome = await drive(collect({
      flows: [StandardFlows.filesystem(filesystem.services, search)],
      cells: [`for (const [name, input] of [
        ["grep", { pattern: "(?=a)", path: "/repo" }],
        ["grep", { pattern: "a", path: "/repo" }],
        ["glob", { pattern: "*", path: "/repo" }],
        ["grep", { pattern: "b", path: "/repo" }],
        ["grep", { pattern: "c", path: "/repo" }],
        ["grep", { pattern: "d", path: "/repo" }]
      ]) { try { await ctx.call(name, input) } catch {} }
      ctx.done("done")`]
    }))
    const settled = settledCalls(eventsOf(outcome))
    // The contract's own rejection names what broke; a peer's raw text never passes.
    expect(settled[0]?.result.message).toBe(
      "Flow grep failed: Unsupported ripgrep pattern \"(?=a)\": special groups and lookaround are not supported"
    )
    expect(settled[1]?.result.message).toBe("Flow grep failed.")
    expect(settled[2]?.result.message).toContain("Unsupported ripgrep pattern")
    expect(settled[3]?.result.message).toBe("Flow grep failed.")
    expect(settled[4]?.result.message).toBe("Flow grep failed: The command timed out.")
    expect(settled[5]?.result.message).toContain("No search implementation is configured")
    expect(JSON.stringify(settled)).not.toContain(secret)
  })

  it("refuses an approval catchably when the host has nobody to ask", async () => {
    const outcome = await drive(
      collect({
        flows: [StandardFlows.approval(StandardFlows.askerNoop())],
        cells: [
          `let caught = "none"
try { await ctx.call("ask", { question: "ship it?" }) } catch (error) { caught = String(error.message) }
ctx.done(caught)`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    const settled = settledCalls(eventsOf(outcome))
    expect(settled[0]?.result.outcome).toBe("failure")
    expect(settled[0]?.result.message).toContain("nobody to ask")
  })

  it("parks before the effect runs when authority is denied, and proceeds once it is granted", async () => {
    const remembered: Array<string> = []
    const attempts: Array<string> = []
    let denied = false
    const outcome = await drive(
      collect({
        flows: [
          StandardFlows.memory(
            Context.make(
              MemoryStore.MemoryStore,
              MemoryStore.makeNoop({
                putFact: (input) => Effect.sync(() => void remembered.push(input.key))
              })
            ).pipe(Context.add(Recall.Recall, Recall.makeNoop())),
            judgeServices
          )
        ],
        authorize: (call) =>
          Effect.suspend(() => {
            attempts.push(call.flowName)
            if (denied) return Effect.void
            denied = true
            return Effect.fail(
              new HarnessError({
                code: "engine_failed",
                message: "permission required",
                cause: Schema.encodeUnknownSync(Permission.PermissionRequired)(
                  new Permission.PermissionRequired({
                    requestId: "remember-approval",
                    capability: Capability.make("fs:write", "**"),
                    tier: "irreversible",
                    meta: {}
                  })
                )
              })
            )
          }),
        cells: [
          `const kept = await ctx.call("remember", { bank: "notes", key: "k1", text: "hello" })
ctx.done(kept.key)`
        ]
      }),
      { resume: true }
    )

    expect(outcome._tag).toBe("completed")
    // Authority is decided before the boundary opens, so the denied attempt
    // never executed the effect; the granted one executed it exactly once.
    expect(attempts).toEqual(["remember", "remember"])
    expect(remembered).toEqual(["k1"])
    const resolved = eventsOf(outcome).find((event) => event._tag === "resolved")
    expect(resolved?._tag === "resolved" ? resolved.message.content : []).toEqual([
      { type: "text", text: "k1" }
    ])
  })

  it("waits through the engine's durable clock as an ordinary flow", async () => {
    const outcome = await drive(
      Effect.gen(function*() {
        const services = yield* Effect.context<Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>()
        return yield* collect({
          flows: [StandardFlows.clock(services)],
          cells: [
            `const waited = await ctx.call("wait", { seconds: 0 })
ctx.done(String(waited.waitedSeconds))`
          ]
        })
      })
    )

    expect(outcome._tag).toBe("completed")
    const settled = settledCalls(eventsOf(outcome))
    expect(settled.map((event) => event.flowName)).toEqual(["wait"])
    expect(settled[0]?.result.value).toEqual({ waitedSeconds: 0 })
  })

  it("refuses waits above the ceiling or outside finite time without scheduling them", async () => {
    const scheduled: Array<string> = []
    const outcome = await drive(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const services = yield* Effect.context<Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>()
        const immediateClock = FlowRuntime.FlowRuntime.of({
          ...engine,
          scheduleClock: (flow, options) =>
            Effect.sync(() => {
              scheduled.push(options.clock.name)
            }).pipe(
              Effect.andThen(
                engine.deferredDone(options.clock.deferred, {
                  flowName: flow._tag,
                  executionId: options.executionId,
                  deferredName: options.clock.deferred.name,
                  exit: Exit.void
                })
              )
            )
        })
        const clockServices = Context.add(services, FlowRuntime.FlowRuntime, immediateClock)
        return yield* collect({
          flows: [StandardFlows.clock(clockServices, { maxSeconds: 61 })],
          cells: [
            `const refused = []
const over = await ctx.call("wait", { seconds: 62 })
if (over.ok === false) refused.push(over.error.message)
const exact = await ctx.call("wait", { seconds: 61 })
ctx.done(refused.length + ":" + exact.waitedSeconds)`
          ]
        })
      })
    )

    expect(outcome._tag).toBe("completed")
    const settled = settledCalls(eventsOf(outcome))
    expect(settled.map((event) => event.result.outcome)).toEqual(["failure", "success"])
    expect(settled[0]?.result.message).toContain("61")
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.split("/").at(-1)).toBe("1")

    const source = StandardFlows.clock(
      Context.empty() as Context.Context<
        Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
      >,
      { maxSeconds: 61 }
    )
    const bindings = await Effect.runPromise(source.bindings())
    const nonFinite = await Effect.runPromise(
      bindings[0]!.run(
        ({
          flowName: "wait",
          input: { seconds: Number.POSITIVE_INFINITY },
          capabilities: [],
          effects: {
            reads: [],
            writes: [],
            mode: "expected",
            onConflict: "serialize",
            tier: "irreversible"
          },
          placement: Option.none(),
          identity: {
            session: "session-1",
            frame: 0,
            cell: "cell-digest",
            ordinal: 0,
            declaration: "wait-declaration",
            layers: []
          }
        }) as unknown as Cell.Call
      )
    )

    expect(nonFinite).toMatchObject({
      outcome: "failure",
      message: expect.stringContaining("finite")
    })
    expect(scheduled).toHaveLength(1)
  })

  it("clamps a host ceiling that would remove the bound instead of lowering it", async () => {
    // The ceiling is what keeps a parked run distinguishable from a hung one,
    // and a configured value read straight into the comparison can delete it
    // silently: `NaN` makes every `seconds > maxSeconds` test false, and
    // `Infinity` or a value above the default admits a wait no operator will
    // outlive. Hosts may only LOWER the documented hour.
    const waitOf = (maxSeconds: number, seconds: number) =>
      Effect.gen(function*() {
        const source = StandardFlows.clock(
          Context.empty() as Context.Context<
            Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
          >,
          { maxSeconds }
        )
        const bindings = yield* source.bindings()
        return yield* bindings[0]!.run(
          ({
            flowName: "wait",
            input: { seconds },
            capabilities: [],
            effects: {
              reads: [],
              writes: [],
              mode: "expected",
              onConflict: "serialize",
              tier: "irreversible"
            },
            placement: Option.none(),
            identity: {
              session: "session-1",
              frame: 0,
              cell: "cell-digest",
              ordinal: 0,
              declaration: "wait-declaration",
              layers: []
            }
          }) as unknown as Cell.Call
        )
      })

    const beyond = StandardFlows.defaultMaxWaitSeconds + 1
    for (const ceiling of [Number.NaN, Number.POSITIVE_INFINITY, 1e12, 86_400]) {
      const refusal = await Effect.runPromise(waitOf(ceiling, beyond))
      expect(refusal).toMatchObject({
        outcome: "failure",
        message: expect.stringContaining(String(StandardFlows.defaultMaxWaitSeconds))
      })
    }
  })

  it("keeps two waits of the same duration apart, because a durable clock is named", async () => {
    // A durable clock is identified by its name — the deferred it awaits is
    // `DurableClock/<name>` — so a name derived from the duration would make
    // the second of two equal waits await the first's already-settled deferred.
    // The name is the call identity instead, which is unique per call and
    // stable across replay.
    const scheduled: Array<string> = []
    const outcome = await drive(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const services = yield* Effect.context<Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>()
        const immediateClock = FlowRuntime.FlowRuntime.of({
          ...engine,
          scheduleClock: (flow, options) =>
            Effect.sync(() => {
              scheduled.push(options.clock.name)
            }).pipe(
              Effect.andThen(
                engine.deferredDone(options.clock.deferred, {
                  flowName: flow._tag,
                  executionId: options.executionId,
                  deferredName: options.clock.deferred.name,
                  exit: Exit.void
                })
              )
            )
        })
        const clockServices = Context.add(services, FlowRuntime.FlowRuntime, immediateClock)
        return yield* collect({
          flows: [StandardFlows.clock(clockServices)],
          cells: [
            `const first = await ctx.call("wait", { seconds: 61 })
const second = await ctx.call("wait", { seconds: 61 })
ctx.done(String(first.waitedSeconds + second.waitedSeconds))`
          ]
        })
      })
    )

    expect(outcome._tag).toBe("completed")
    const settled = settledCalls(eventsOf(outcome))
    expect(settled.map((event) => event.flowName)).toEqual(["wait", "wait"])
    expect(settled.map((event) => event.identity.ordinal)).toEqual([0, 1])
    expect(settled.every((event) => event.result.outcome === "success")).toBe(true)
    expect(scheduled).toHaveLength(2)
    expect(new Set(scheduled).size).toBe(2)
    expect(scheduled.map((name) => name.split("/").at(-1))).toEqual(["0", "1"])
  })
})

describe("plugin-contributed flows", () => {
  it("publishes only the configuration and cell hooks this host dispatches", () => {
    expect(CellPlugin.hooks).toEqual({
      config: "waterfall",
      configResolved: "parallel",
      cellRegistry: "waterfall",
      cellFlows: "waterfall",
      cellMonitors: "waterfall",
      cellModelRequest: "waterfall"
    })
  })

  it("reports an unencodable composition identity as config_invalid", async () => {
    // `@smthrs/plugin` admits config through a JSON gate of its own now, so a
    // run started with a function-valued key is refused before it ever reaches
    // this boundary and `Agent.test.ts` pins that earlier refusal. The check
    // here stays because the gate and the digest are different seams: a hook
    // that rewrites config during resolution, or any later widening of the
    // gate, would hand this function a value the composition digest cannot
    // hash, and it must answer with a typed `config_invalid` rather than a
    // canonicalization defect. Reaching it needs a value the gate would have
    // stopped, which is what the cast constructs.
    const kernel = await Effect.runPromise(CellPlugin.make())
    const invalid = { requestAudit: () => "not-json" } as unknown as ResolvedConfig
    const failure = await Effect.runPromise(
      CellPlugin.identity([], kernel.plugins, invalid).pipe(Effect.flip)
    )

    expect(failure).toMatchObject({
      code: "config_invalid",
      message: "The resolved cell composition cannot be used as durable identity"
    })
  })

  const ping = CoreFlow.make({
    name: "ping",
    description: "A capability contributed by a plugin.",
    input: Schema.Struct({ note: Schema.String }),
    output: Schema.Struct({ echoed: Schema.String }),
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" }
  })

  it("discloses and resolves a plugin's executable flow from one snapshot", async () => {
    const executed: Array<string> = []
    const requests: Array<string> = []
    const plugin = CellPlugin.fromBindings({
      name: "flows-plugin-ping",
      // `enforce` and `apply` are the kernel's, unchanged; passing them here
      // proves the authoring helper forwards rather than reimplements them.
      enforce: "pre",
      apply: "harness",
      bindings: [
        FlowBinding.make({
          flow: ping,
          handler: (input) =>
            Effect.sync(() => {
              executed.push(input.note)
              return { echoed: `pong:${input.note}` }
            })
        })
      ]
    })
    const excluded = CellPlugin.fromBindings({
      name: "flows-plugin-excluded",
      apply: "engine",
      bindings: [
        FlowBinding.make({
          flow: CoreFlow.make({
            name: "engine-only",
            description: "Never reaches a harness host.",
            input: Schema.Struct({}),
            output: Schema.Struct({})
          }),
          handler: () => Effect.succeed({})
        })
      ]
    })

    const outcome = await drive(
      collect({
        requests,
        plugins: [plugin, excluded],
        cells: [
          `const out = await ctx.call("ping", { note: "one" })
ctx.done(out.echoed)`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    expect(executed).toEqual(["one"])
    // Disclosure and resolution agree, which is only true if they read the same
    // composed snapshot.
    expect(requests[0]).toContain("A capability contributed by a plugin.")
    expect(requests[0]).not.toContain("Never reaches a harness host.")
    expect(settledCalls(eventsOf(outcome))[0]?.result.value).toEqual({ echoed: "pong:one" })
  })

  it("honours apply, enforce, and the ordered waterfall when plugins transform the flow list", async () => {
    const order: Array<string> = []
    const contributed = (
      name: string,
      label: string,
      options: {
        readonly enforce?: "pre" | "post" | undefined
        readonly apply?: "engine" | "harness" | undefined
      } = {}
    ) =>
      makePlugin<FlowsHooks>({
        name,
        ...(options.enforce === undefined ? {} : { enforce: options.enforce }),
        ...(options.apply === undefined ? {} : { apply: options.apply }),
        hooks: {
          cellFlows: (bindings) =>
            Effect.sync(() => {
              order.push(label)
              return [
                ...bindings,
                FlowBinding.make({
                  flow: CoreFlow.make({
                    name: `flow-${label}`,
                    description: `Contributed by ${label}.`,
                    input: Schema.Struct({}),
                    output: Schema.Struct({ from: Schema.String }),
                    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" }
                  }),
                  handler: () => Effect.succeed({ from: label })
                })
              ]
            })
        }
      })

    const requests: Array<string> = []
    const outcome = await drive(
      collect({
        requests,
        plugins: [
          contributed("normal", "normal"),
          contributed("engine-only", "engine-only", { apply: "engine" }),
          contributed("first", "first", { enforce: "pre", apply: "harness" })
        ],
        cells: [
          `const out = await ctx.call("flow-first", {})
ctx.done(out.from)`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    expect(order).toEqual(["first", "normal"])
    expect(requests[0]).toContain("flow-first")
    expect(requests[0]).toContain("flow-normal")
    // `apply: "engine"` excludes the plugin from a harness host entirely.
    expect(requests[0]).not.toContain("flow-engine-only")
  })

  it("fails safely when two bindings claim one name", async () => {
    const duplicate = FlowBinding.make({ flow: ping, handler: () => Effect.succeed({ echoed: "a" }) })
    const outcome = await drive(
      collect({
        flows: [FlowBinding.source("first", [duplicate]), FlowBinding.source("second", [duplicate])],
        cells: ["ctx.done(\"unreachable\")"]
      })
    )

    expect(outcome).toMatchObject({ _tag: "failed", error: { code: "assembly_failed" } })
  })

  it("fails safely when a plugin contributes a name the host already bound", async () => {
    const outcome = await drive(
      collect({
        flows: [FlowBinding.source("host", [
          FlowBinding.make({ flow: ping, handler: () => Effect.succeed({ echoed: "host" }) })
        ])],
        // No `enforce`, no `apply`: the plain authoring case.
        plugins: [CellPlugin.fromBindings({
          name: "flows-plugin-collides",
          bindings: [FlowBinding.make({ flow: ping, handler: () => Effect.succeed({ echoed: "plugin" }) })]
        })],
        cells: ["ctx.done(\"unreachable\")"]
      })
    )

    expect(outcome).toMatchObject({
      _tag: "failed",
      error: { code: "assembly_failed", message: expect.stringContaining("Two executable bindings are named") }
    })
  })

  it("refuses a call whose disclosed declaration is not the bound one", async () => {
    // A discovered flow shadows a binding of the same name. Discovery keeps the
    // name; the binding must not be dispatched behind the other declaration.
    const discovered = new Descriptor.FlowDescriptor({
      name: "ping",
      description: "A discovered ping.",
      body: new Descriptor.BodyRefModule({ path: "/flows/ping/flow.ts" }),
      input: new Descriptor.SchemaRefNone(),
      output: new Descriptor.SchemaRefNone(),
      model: Option.none(),
      flows: [],
      capabilities: [],
      effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
      placement: Option.none(),
      modelInvocable: true,
      path: "/flows/ping",
      frontmatter: {},
      provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
    })
    let executed = false
    const outcome = await drive(
      collect({
        registry: registryOf([discovered]),
        flows: [FlowBinding.source("shadowed", [
          FlowBinding.make({
            flow: ping,
            handler: () =>
              Effect.sync(() => {
                executed = true
                return { echoed: "never" }
              })
          })
        ])],
        cells: [
          `let caught = "none"
try { await ctx.call("ping", { note: "one" }) } catch (error) { caught = String(error.message) }
ctx.done(caught)`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    expect(executed).toBe(false)
    const settled = settledCalls(eventsOf(outcome))
    expect(settled[0]?.result.outcome).toBe("failure")
    expect(settled[0]?.result.message).toContain("does not match the bound implementation")
  })
})

describe("subagents are flows", () => {
  const children = (spawned: Array<string>): ChildFlows.Children =>
    ChildFlows.makeNoop({
      spawn: (input) =>
        Effect.sync(() => {
          spawned.push(input.flow)
          return { child: `child-${spawned.length}` }
        }),
      await: (input) => Effect.succeed({ child: input.child, output: "the child finished" })
    })

  it("spawns and collects a child through ordinary flow calls with the same event shape", async () => {
    const spawned: Array<string> = []
    const outcome = await drive(
      collect({
        flows: [ChildFlows.source(children(spawned))],
        cells: [
          `const child = await ctx.call("agent/spawn", { flow: "review", input: { path: "a.md" } })
const done = await ctx.call("agent/await", { child: child.child })
ctx.done(done.output)`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    expect(spawned).toEqual(["review"])
    const collected = eventsOf(outcome)
    expect(collected.filter((event) => event._tag === "cell-call-started")).toHaveLength(2)
    expect(settledCalls(collected).map((event) => event.flowName)).toEqual(["agent/spawn", "agent/await"])
  })

  it("refuses every lifecycle operation the host does not implement", async () => {
    const outcome = await drive(
      collect({
        flows: [ChildFlows.source(ChildFlows.makeNoop())],
        cells: [
          `const caught = []
for (const call of [["agent/spawn", { flow: "review" }], ["agent/send", { child: "c", message: "hi" }], ["agent/await", { child: "c" }]]) {
  const result = await ctx.call(call[0], call[1])
  if (result.ok === false) caught.push(result.error.message)
}
ctx.done(caught.join("|"))`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    const settled = settledCalls(eventsOf(outcome))
    expect(settled.map((event) => event.flowName)).toEqual(["agent/spawn", "agent/send", "agent/await"])
    expect(settled.every((event) => event.result.outcome === "failure")).toBe(true)
    expect(settled.map((event) => event.result.message)).toEqual([
      "Flow agent/spawn failed: This host runs no detached children, so agent/spawn is unavailable.",
      "Flow agent/send failed: This host runs no detached children, so agent/send is unavailable.",
      "Flow agent/await failed: This host runs no detached children, so agent/await is unavailable."
    ])
  })

  it("does not rerun a settled child call when the cell replays after a park", async () => {
    const spawned: Array<string> = []
    let denied = false
    const outcome = await drive(
      collect({
        flows: [
          ChildFlows.source(children(spawned)),
          StandardFlows.approval({ ask: () => Effect.succeed({ answer: "yes", approved: true }) })
        ],
        // Authority is denied once, for the approval call only. The cell
        // re-executes from the top on resume: `agent/spawn` must replay its
        // recorded result rather than spawning a second child.
        authorize: (call) =>
          Effect.suspend(() => {
            if (call.flowName !== "ask" || denied) return Effect.void
            denied = true
            return Effect.fail(
              new HarnessError({
                code: "engine_failed",
                message: "permission required",
                cause: Schema.encodeUnknownSync(Permission.PermissionRequired)(
                  new Permission.PermissionRequired({
                    requestId: "child-approval",
                    capability: Capability.make("fs:write", "**"),
                    tier: "irreversible",
                    meta: {}
                  })
                )
              })
            )
          }),
        cells: [
          `const child = await ctx.call("agent/spawn", { flow: "review" })
const answer = await ctx.call("ask", { question: "merge it?" })
ctx.done(child.child + ":" + answer.answer)`
        ]
      }),
      { resume: true }
    )

    expect(outcome._tag).toBe("completed")
    // One spawn across the original attempt and the resumed one.
    expect(spawned).toEqual(["review"])
    const resolved = eventsOf(outcome).find((event) => event._tag === "resolved")
    expect(resolved?._tag === "resolved" ? resolved.message.content : []).toEqual([
      { type: "text", text: "child-1:yes" }
    ])
  })
})

/**
 * The four call semantics a run card has to tell apart, produced by real
 * declarations through the real boundary.
 *
 * Nothing here writes a journal payload by hand. Each record is what
 * `AgentSession.trace` projected out of an event the production controller
 * emitted, and each call's `descriptor` field is whatever `Cell.callOf` copied
 * off the declaration the catalog resolved. The four cases are the ones a
 * reader must keep apart: a standard flow, a custom flow that declares its own
 * words, a custom flow that takes a standard name and means something else,
 * and a flow that declares nothing at all.
 *
 * The produced trail is pinned as `fixtures/call-descriptor-trail.json` and
 * read back by `apps/app` `RunTraceDescriptor.test.ts`, which is the card half
 * of the same proof. Regenerate with `SMITHERS_UPDATE_FIXTURES=1`; a change
 * this test does not accept is a change the card is never shown.
 */
describe("a call carries what its declaration says it does", () => {
  /** A custom flow with words of its own: the declaration a host author writes. */
  const inspect = CoreFlow.make({
    name: "inspect",
    description: "Look at one file without changing it.",
    input: Schema.Struct({ path: Schema.String }),
    output: Schema.Struct({ note: Schema.String }),
    effects: { reads: ["/**"], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" }
  })

  /** A custom flow that takes a standard name and means the opposite of it. */
  const shadowed = CoreFlow.make({
    name: "write",
    description: "Record a reading about one file. It changes nothing.",
    input: Schema.Struct({ path: Schema.String }),
    output: Schema.Struct({ note: Schema.String }),
    effects: { reads: ["/**"], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" }
  })

  /** A flow that declares no display metadata: unknown, and said as unknown. */
  const mystery = CoreFlow.make({
    name: "mystery",
    description: "Declares nothing about how it reads.",
    input: Schema.Struct({ path: Schema.String }),
    output: Schema.Struct({ note: Schema.String }),
    effects: { reads: ["/**"], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" }
  })

  const reading: Descriptor.CallPresentation = {
    verb: { pending: "inspecting", success: "inspected", failure: "failed to inspect" },
    subject: "path",
    result: "text"
  }

  /**
   * Identities a card only has to see pair, replaced by ones that do not move.
   *
   * A cell digest, a call id and a declaration digest are content hashes, so
   * every unrelated edit to a standard flow's source would otherwise rewrite
   * this fixture. The three measured durations are zeroed for the same reason:
   * a wall clock is not a fact about a declaration. Every other byte is the
   * producer's.
   */
  const settle = () => {
    const identities = new Map<string, string>()
    return <A>(value: A): A =>
      JSON.parse(
        JSON.stringify(value)
          .replaceAll(/(cell-call-v1:)?[0-9a-f]{64}/g, (held) => {
            // A call id keeps its declared shape: it is the one identity a
            // reader decodes rather than merely pairs on.
            const minted = identities.get(held) ??
              (held.startsWith("cell-call-v1:")
                ? `cell-call-v1:${String(identities.size + 1).padStart(64, "0")}`
                : `digest-${identities.size + 1}`)
            identities.set(held, minted)
            return minted
          })
          .replaceAll(/"(durationMillis|latencyMs|elapsedMs)":\s*\d+/g, (_whole, field: string) => `"${field}": 0`)
      ) as A
  }

  /** The agent trail, as the run card stores a journal row. */
  const trail = (collected: ReadonlyArray<AgentEvent.AgentEvent>) => {
    const records: Array<unknown> = []
    for (const event of collected) {
      const projected = AgentSession.trace(event)
      if (projected === undefined) continue
      // `at` is the record's position: the producer stamps wall-clock time
      // where it journals, outside `trace`.
      const at = (records.length + 1) * 100
      records.push({
        runId: "run-1",
        sequence: records.length + 1,
        kind: projected.eventType,
        occurredAt: at,
        payload: { ...projected.payload as Record<string, unknown>, at }
      })
    }
    return records
  }

  /**
   * The invoked half of the same calls, as the native producer delivers them.
   *
   * The envelope is the shape `@smthrs/engine-store` `CallFacts` writes and
   * `@smthrs/gateway` `nativeCallEvent` accepts, each pinned by its own
   * package's tests. What is produced here is `descriptor`, read off the real
   * call the controller built.
   */
  const nativeFacts = (collected: ReadonlyArray<AgentEvent.AgentEvent>) =>
    collected.flatMap((event) => {
      if (event._tag !== "cell-call-started") return []
      const { session, ...identity } = event.call.identity
      const descriptor = Cell.displayDescriptor(event.call)
      const id = AgentSession.callId(event.call.identity)
      const sequence = identity.ordinal + 1
      return [{
        runId: "run-1",
        sequence,
        kind: "control.engine.event",
        occurredAt: sequence * 100,
        payload: {
          version: 1,
          executionId: "native",
          generation: 0,
          sequence,
          emittedAtMs: sequence * 100,
          sourceSequence: 0,
          sourceId: `call-fact-v1:${id}:invoked`,
          eventType: "flows.harness.call-fact.v1",
          payload: {
            version: 1,
            phase: "invoked",
            callId: id,
            identity: { runId: "run-1", ...identity },
            flowName: event.call.flowName,
            input: event.call.input,
            ...(descriptor === undefined ? {} : { descriptor })
          }
        }
      }]
    })

  it("produces standard, custom, shadowed and unknown semantics for a card to read", async () => {
    const filesystem = files({ "/repo/alpha.md": "first line\nsecond line" })
    const note = (input: { readonly path: string }) => Effect.succeed({ note: `about ${input.path}` })

    // Run one: the standard catalog beside a custom flow with its own words.
    const declared = await drive(
      collect({
        flows: [
          StandardFlows.filesystem(filesystem.services),
          FlowBinding.source("host/inspect", [
            FlowBinding.make({ flow: inspect, handler: note, activity: "reads", presentation: reading })
          ])
        ],
        cells: [
          `const page = await ctx.call("read", { path: "/repo/alpha.md" })
const seen = await ctx.call("inspect", { path: "/repo/alpha.md" })
ctx.done(page.startLine + ":" + seen.note)`
        ]
      })
    )
    expect(declared._tag).toBe("completed")

    // Run two: a flow named `write` that reads, beside one that declares
    // nothing. The catalog refuses a duplicate name, so the standard `write`
    // is not offered here — which is what shadowing a standard name means.
    const unnamed = await drive(
      collect({
        flows: [
          FlowBinding.source("host/shadowed", [
            FlowBinding.make({ flow: shadowed, handler: note, activity: "reads", presentation: reading }),
            FlowBinding.make({ flow: mystery, handler: note })
          ])
        ],
        cells: [
          `const seen = await ctx.call("write", { path: "/repo/alpha.md" })
const other = await ctx.call("mystery", { path: "/repo/alpha.md" })
ctx.done(seen.note + "|" + other.note)`
        ]
      })
    )
    expect(unnamed._tag).toBe("completed")

    const stable = settle()
    const produced = stable({
      declared: trail(eventsOf(declared)),
      shadowed: trail(eventsOf(unnamed)),
      native: nativeFacts(eventsOf(unnamed))
    })

    const opened = [...produced.declared, ...produced.shadowed].filter((record) =>
      (record as { kind: string }).kind === "control.agent.cell-call-started"
    ).map((record) => (record as { payload: Record<string, unknown> }).payload)

    // The producer emitted the declaration's own fields, for every case.
    expect(opened.map((payload) => payload.descriptor)).toEqual([
      {
        name: "read",
        activity: "reads",
        presentation: {
          verb: { pending: "reading", success: "read", failure: "failed to read" },
          subject: "path",
          result: "read"
        }
      },
      { name: "inspect", activity: "reads", presentation: reading },
      { name: "write", activity: "reads", presentation: reading },
      // A flow that declared nothing carries nothing: no key, not a null.
      undefined
    ])
    expect(opened.every((payload) => payload.descriptor === undefined || "name" in (payload.descriptor as object)))
      .toBe(true)

    const path = fileURLToPath(new URL("./fixtures/call-descriptor-trail.json", import.meta.url))
    const serialized = `${JSON.stringify(produced, undefined, 2)}\n`
    if (process.env.SMITHERS_UPDATE_FIXTURES === "1") await writeFile(path, serialized)
    expect(serialized).toBe(await readFile(path, "utf8"))
  }, 60_000)
})

describe("jev is a flow", () => {
  /** The output the run completed with, read off the applied transition. */
  const completionOf = (outcome: Outcome): string | undefined => {
    for (const event of eventsOf(outcome)) {
      if (event._tag === "transition-applied" && event.transition._tag === "complete") return event.transition.output
    }
    return undefined
  }

  /**
   * A judge that answers from the state it is shown and records each request.
   * A question id named in `byId` is answered with that probability.
   */
  const judgeByState = (byId: Readonly<Record<string, number>> = {}) => {
    const asked: Array<Evaluator.Request> = []
    const services = Context.make(
      Evaluator.Evaluator,
      Effect.runSync(
        Effect.provide(
          Effect.service(Evaluator.Evaluator),
          Evaluator.layerScripted((request) => {
            asked.push(request)
            const state = request.state as {
              readonly files?: ReadonlyArray<{ readonly path: string }>
              readonly i?: number
            }
            return Object.fromEntries(
              Object.keys(request.questions).map((id) => {
                if (byId[id] !== undefined) return [id, { probability: byId[id] }]
                if (state.files !== undefined) {
                  return [id, { probability: state.files[Number(id)]!.path.includes("auth") ? 0.95 : 0.05 }]
                }
                return [id, { probability: (state.i ?? 0) % 2 === 0 ? 0.9 : 0.1 }]
              })
            )
          })
        )
      )
    )
    return { asked, services }
  }

  it("answers a cell's questions about its own JSON through the one call boundary", async () => {
    const judge = judgeByState()
    const outcome = await drive(
      collect({
        flows: [StandardFlows.jev(judge.services)],
        cells: [
          `const files = [{ path: "src/auth/login.py" }, { path: "src/billing/invoice.py" }, { path: "src/auth/session.py" }]
const judged = await ctx.call("jev", { state: { files }, questions: Object.fromEntries(files.map((f, i) => [String(i), { type: "boolean", instructions: "Does files[" + i + "], at " + f.path + ", implement or call authentication?" }])) })
if (judged.ok === false) throw new Error(judged.error.message)
ctx.done(files.filter((_, i) => judged.answers[String(i)].value).map((f) => f.path).join(","))`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    const settled = settledCalls(eventsOf(outcome))
    expect(settled.map((event) => event.flowName)).toEqual(["jev"])
    // One request carried every question, and the judge saw them as the cell
    // wrote them.
    expect(judge.asked).toHaveLength(1)
    expect(Object.keys(judge.asked[0]!.questions)).toEqual(["0", "1", "2"])
    const value = settled[0]?.result.value as { readonly answers: Record<string, { readonly value: boolean }> }
    expect(Object.entries(value.answers).map(([id, answer]) => [id, answer.value])).toEqual([
      ["0", true],
      ["1", false],
      ["2", true]
    ])
    expect(completionOf(outcome)).toBe("src/auth/login.py,src/auth/session.py")
  })

  it("runs the taught jev example verbatim: one call, the confident file kept, the unsure one printed", async () => {
    // The example is read off the prompt the run is actually shown, so the
    // test fails the moment the teaching stops running as written.
    const requests: Array<string> = []
    const shown = await drive(collect({
      requests,
      flows: [StandardFlows.jev(judgeByState().services)],
      cells: [`ctx.done("shown")`]
    }))
    expect(shown._tag).toBe("completed")
    const example = /```cell\n([\s\S]*?)```/.exec(requests[0]!.slice(requests[0]!.indexOf("Hundreds fit in one call")))
    expect(example).not.toBeNull()

    const match = (file: string) => ({ file, line: 1, text: "timeout", before: [], after: [] })
    const search = Search.make({
      grep: () =>
        Effect.succeed({
          matches: [match("src/session.py"), match("src/session.py"), match("src/config.py"), match("src/clock.py")],
          files: ["src/session.py", "src/config.py", "src/clock.py"],
          filesSearched: 3,
          skippedBinary: 0,
          truncated: false
        }),
      glob: () => Effect.fail(new StdError({ code: "provider_unavailable", message: "unused" }))
    })
    const judge = judgeByState({ "src/session.py": 0.9, "src/config.py": 0.6, "src/clock.py": 0.05 })
    const printed: Array<string> = []
    const outcome = await drive(collect({
      requests: printed,
      flows: [StandardFlows.filesystem(files({}).services, search), StandardFlows.jev(judge.services)],
      cells: [example![1]!, `ctx.done(JSON.stringify({ kept, uncertain }))`]
    }))

    expect(outcome._tag).toBe("completed")
    const settled = settledCalls(eventsOf(outcome))
    expect(settled.map((event) => event.flowName)).toEqual(["grep", "jev"])
    expect(judge.asked).toHaveLength(1)
    expect(Object.keys(judge.asked[0]!.questions)).toEqual(["src/session.py", "src/config.py", "src/clock.py"])
    expect(printed[1]).toContain("src/config.py")
    expect(completionOf(outcome)).toBe(JSON.stringify({ kept: ["src/session.py"], uncertain: ["src/config.py"] }))
  })

  it("settles many concurrent calls from one cell, each of which reaches the judge", async () => {
    const judge = judgeByState()
    const outcome = await drive(
      collect({
        flows: [StandardFlows.jev(judge.services)],
        cells: [
          `const results = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => ctx.call("jev", { state: { i }, questions: { even: { type: "boolean", instructions: "Is i even?" } } })))
ctx.done(results.map((r) => r.ok === false ? "failed" : String(r.answers.even.value)).join(","))`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    const settled = settledCalls(eventsOf(outcome))
    expect(settled.map((event) => event.flowName)).toEqual(Array.from({ length: 8 }, () => "jev"))
    expect(settled.every((event) => event.result.outcome === "success")).toBe(true)
    // Every call reached the judge with its own state, in dispatch order: the
    // host settles a cell's calls one at a time, so eight promises awaited
    // together are eight sequential evaluations, not one.
    expect(judge.asked.map((request) => (request.state as { readonly i: number }).i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(completionOf(outcome)).toBe("true,false,true,false,true,false,true,false")
  })

  it("hands the cell the judge's failure code instead of an answer", async () => {
    const outcome = await drive(
      collect({
        flows: [
          StandardFlows.jev(
            Context.make(
              Evaluator.Evaluator,
              Effect.runSync(Effect.provide(Effect.service(Evaluator.Evaluator), Evaluator.layerUnavailable()))
            )
          )
        ],
        cells: [
          `const judged = await ctx.call("jev", { state: { i: 1 }, questions: { even: { type: "boolean", instructions: "Is i even?" } } })
ctx.done(judged.ok === false ? judged.error.code + " " + judged.error.message : "answered " + JSON.stringify(judged.answers))`
        ]
      })
    )
    expect(outcome._tag).toBe("completed")
    // A typed failure that says Jev was unavailable, and no instruction to
    // substitute the model's own judgment for it.
    expect(completionOf(outcome)).toBe(
      `flow_failed Flow jev failed: unreachable: ${Evaluator.unreachableMessage}`
    )
    expect(completionOf(outcome)).toContain("Jev was unavailable")
    expect(completionOf(outcome)).not.toMatch(/decide without|without it|yourself/)
  })
})
