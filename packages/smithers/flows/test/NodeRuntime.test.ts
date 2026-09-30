/**
 * The supported production composition, booted end to end over a real SQLite
 * file.
 *
 * `src/NodeRuntime.ts` is the one module in this package that a host program
 * calls to stand a durable engine up, and every claim its doc comment makes is
 * an ordering claim: the parent directory exists before the database opens,
 * migrations finish before a store is built, the engine is built over those
 * stores, and `registerFlows` finishes before the composed services are
 * exposed — so a persisted run cannot resume through this composition before
 * its flow has been registered. None of that is observable from a type, and a
 * double cannot establish any of it, so this suite drives the module the way a
 * program does: one temp-directory SQLite file, three separate scopes over it,
 * and `node:sqlite` reading the same file back independently.
 *
 * The three scopes are the whole journey. Scope one migrates, registers, runs
 * a flow to completion, and parks a second flow on a durable deferred. Its
 * closure is the graceful shutdown — the module installs no signal handlers,
 * so scope closure is the documented shutdown path. Scope two is a process
 * that completes the deferred but registers NO flow: the run must stay parked,
 * because the engine leaves a wake for an unregistered flow alone. Scope three
 * registers the flow again and touches nothing else; the registration sweep is
 * what has to notice the completed deferred and drive the run home.
 *
 * The host seams are supplied here rather than by the library, the same way a
 * program supplies them: a tiny Node filesystem bridge for the one directory
 * creation the composition owns, SHA-256 over `node:crypto`, and a `Jj` stub
 * because the flows below take no compensable snapshot.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { afterAll, describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import { createHash, webcrypto } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  Action,
  DurableDeferred,
  EngineStore as EngineStorePackage,
  Flow,
  FlowRuntime,
  Interpreter,
  Kernel,
  RunStore as RunStorePackage
} from "../src/index.ts"
import * as NodeRuntime from "../src/NodeRuntime.ts"

const { StepBoundary, WorkspaceSandbox } = EngineStorePackage
const { RunStore } = RunStorePackage
const { Jj } = Kernel

const directory = mkdtempSync(join(tmpdir(), "flows-node-runtime-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * The database lives one level BELOW the temp directory that exists. Creating
 * the parent recursively is the composition's first documented step, so the
 * filename is chosen to fail if it is skipped.
 */
const filename = join(directory, "state", "gate.sqlite")

/**
 * A Jujutsu service that records nothing. The engine calls it for compensable
 * snapshots; every flow here is ordinary, so a stub keeps the composition
 * honest without requiring a jj binary on the host.
 */
const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "node-runtime-gate" as never, changeId: "node-runtime-gate" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** SHA-256 and random bytes from Node's built-in crypto service. */
const hostCrypto: Layer.Layer<Crypto.Crypto> = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => webcrypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.succeed(
        new Uint8Array(createHash(algorithm.replace("-", "").toLowerCase()).update(data).digest())
      )
  })
)

/**
 * The composition itself only needs to create the configured database parent.
 * The stub addresses nothing else, so it attests whole-volume isolation, which
 * the workspace sandbox requires of any host it copies back onto.
 */
const hostFileSystem: Layer.Layer<FileSystem.FileSystem> = Layer.succeed(
  FileSystem.FileSystem,
  KernelFileSystem.withIsolatedFileSystem(FileSystem.makeNoop({
    makeDirectory: (path, options) =>
      Effect.sync(() => {
        mkdirSync(path, { recursive: options?.recursive })
      })
  }))
)

/** The three services the composition leaves to the host program. */
const host = Layer.mergeAll(hostCrypto, hostFileSystem, stubJj)

/** Every dispatch the journey makes, so a replayed one is visible as a count. */
const dispatches = { assess: 0, read: 0, tally: 0 }

const Approval = DurableDeferred.make("flows/gate/approval", {
  success: Schema.String
})

/**
 * A sealed step in front of the durable wait. Its result is journaled on the
 * first pass, so a resumed run that re-enters the body must NOT dispatch it
 * again — the counter below is that contract.
 */
const ReadDocument = Action.make({
  name: "flows/gate/read-document",
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: "flows/gate/read-document/v1",
  execute: Effect.sync(() => {
    dispatches.read += 1
    return "draft body"
  })
})

const Assess = Action.make("flows/gate/assess", {
  payload: { document: Schema.String },
  success: Schema.String
})

const Review = Flow.make("flows/gate/review", {
  payload: { document: Schema.String },
  success: Schema.String,
  body: (payload) => Assess.call(payload)
})

const Tally = Action.make("flows/gate/tally", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

const Count = Flow.make("flows/gate/count", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Tally.call({ value })
})

const assess = ({ document }: { readonly document: string }) =>
  Effect.gen(function*() {
    dispatches.assess += 1
    const body = yield* ReadDocument
    const verdict = yield* DurableDeferred.await(Approval)
    return `${document}:${body}:${verdict}`
  })

const tally = ({ value }: { readonly value: number }) =>
  Effect.sync(() => {
    dispatches.tally += 1
    return value * 2
  })

/**
 * The registration phase the composition takes as its final startup step.
 *
 * The implementations are provided BENEATH the interpreters rather than merged
 * beside them, so the table a dispatch reads is filled before any flow is
 * registered. Registration is what arms the sweep, and the sweep can re-drive
 * a persisted run immediately — a run that woke into a half-built
 * implementation table would be a race this ordering removes.
 */
const registerFlows = Layer.mergeAll(Interpreter.layer(Review), Interpreter.layer(Count)).pipe(
  Layer.provideMerge(Layer.mergeAll(Assess.toLayer(assess), Tally.toLayer(tally))),
  Layer.provideMerge(Action.layerImplementations)
)

const options = (hostId: string) => ({
  filename,
  workspaceRoot: directory,
  owner: { hostId },
  // A single-process host: no previously recorded owner is ever still alive.
  isAlive: () => Effect.succeed(false)
})

/** One incarnation of the production runtime, with its flows registered. */
const incarnation = (hostId: string) =>
  NodeRuntime.layer(
    options(hostId),
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    registerFlows
  ).pipe(Layer.provide(host))

/** The same runtime with NO flow registered, which is a different process. */
const bystander = (hostId: string) =>
  NodeRuntime.layer(
    options(hostId),
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    Layer.empty
  ).pipe(Layer.provide(host))

/** Reads the file back through an independent connection, not through a store. */
const readBack = <A>(query: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(filename, { readOnly: true })
  try {
    return query(database)
  } finally {
    database.close()
  }
}

/** The value a settled poll answered with, and `undefined` while it has none. */
const completedValue = (result: Option.Option<Flow.Result<unknown, unknown>>): unknown =>
  Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)
    ? result.value.exit.value
    : undefined

describe("the supported Node SQLite composition", () => {
  it.each([
    ["omitted", {}],
    ["null", { owner: null }]
  ])("refuses a host owner that is %s before constructing the default liveness probe", (_, owner) => {
    const root = join(directory, "absent-host-owner")
    expect(() =>
      NodeRuntime.layerHost(
        { filename: join(root, "engine.db"), workspaceRoot: root, ...owner } as never,
        Layer.empty
      )
    ).toThrowError(expect.objectContaining({
      _tag: "@smthrs/flows/RuntimeConfigurationError",
      code: "invalid_runtime_configuration",
      field: "owner.hostId"
    }))
    expect(existsSync(root)).toBe(false)
  })

  it("refuses an unusable configuration before it opens anything", () => {
    // Validation is eager: `layer` builds the composition when it is CALLED,
    // so a program with an empty filename fails at wiring time rather than
    // opening a database at some arbitrary later scope.
    //
    // Each refusal is pinned by CODE and FIELD, not by a message. `field` is
    // the whole reason `RuntimeConfigurationError` carries more than a string:
    // an embedder that surfaces "which option did I get wrong" reads it, and a
    // bare `.toThrow()` would let a refactor collapse every refusal back into
    // one "options" answer without failing anything.
    const refusal = (field: string) => expect.objectContaining({ code: "invalid_runtime_configuration", field })
    const declare = (options: NodeRuntime.Options) => () =>
      NodeRuntime.layer(
        options,
        StepBoundary.layer,
        WorkspaceSandbox.layerFileSystem(),
        Layer.empty
      )

    expect(
      declare({
        filename: "",
        workspaceRoot: directory,
        owner: { hostId: "gate" },
        isAlive: () => Effect.succeed(false)
      })
    )
      .toThrowError(refusal("filename"))
    expect(declare({ filename, workspaceRoot: directory, owner: { hostId: "" }, isAlive: () => Effect.succeed(false) }))
      .toThrowError(refusal("owner.hostId"))
    // A JavaScript caller can omit `owner` altogether; the refusal still has
    // to name the field rather than crash on the dereference.
    expect(declare({ filename, workspaceRoot: directory, isAlive: () => Effect.succeed(false) } as never))
      .toThrowError(refusal("owner.hostId"))
    expect(declare({ filename, workspaceRoot: "", owner: { hostId: "gate" }, isAlive: () => Effect.succeed(false) }))
      .toThrowError(refusal("workspaceRoot"))
    expect(() => NodeRuntime.storage("")).toThrowError(refusal("filename"))
    // `storage`'s second argument is its own refusal path, and it used to
    // escape as a raw schema failure with no code at all.
    expect(() => NodeRuntime.storage(filename, "")).toThrowError(refusal("workspaceRoot"))
    // Function hooks are not JSON values. A JavaScript caller that passes the wrong shape has
    // to hear about it here rather than at the first ownership claim, hours
    // into a run.
    expect(
      declare({ filename, workspaceRoot: directory, owner: { hostId: "gate" }, isAlive: "not a function" as never })
    )
      .toThrowError(refusal("isAlive"))
    // Nothing above may have created the database the journey below owns.
    expect(existsSync(filename)).toBe(false)
  })

  it("validates an optional execution predicate eagerly without invoking it or opening storage", () => {
    const root = join(directory, "predicate-validation")
    const database = join(root, "runtime.sqlite")
    const declare = (canExecute: NodeRuntime.Options["canExecute"]) =>
      NodeRuntime.layer(
        { ...options("predicate-validation"), filename: database, workspaceRoot: root, canExecute },
        StepBoundary.layer,
        WorkspaceSandbox.layerFileSystem(),
        Layer.empty
      )
    for (const invalid of [null, false, 0, "not a function", {}, []]) {
      expect(() => declare(invalid as never)).toThrowError(expect.objectContaining({
        code: "invalid_runtime_configuration",
        field: "canExecute"
      }))
    }
    let invocations = 0
    expect(() =>
      declare(() => {
        invocations++
        return Effect.succeed(false)
      })
    ).not.toThrow()
    expect(() => declare(undefined)).not.toThrow()
    expect(invocations).toBe(0)
    expect(existsSync(root)).toBe(false)
    expect(existsSync(database)).toBe(false)
  })

  it("validates the optional engine-wake recorder eagerly without invoking it or opening storage", () => {
    const root = join(directory, "recorder-validation")
    const database = join(root, "runtime.sqlite")
    const declare = (requestResume: NodeRuntime.Options["requestResume"]) =>
      NodeRuntime.layer(
        { ...options("recorder-validation"), filename: database, workspaceRoot: root, requestResume },
        StepBoundary.layer,
        WorkspaceSandbox.layerFileSystem(),
        Layer.empty
      )
    for (const invalid of [null, false, 0, "not a function", {}, []]) {
      expect(() => declare(invalid as never)).toThrowError(expect.objectContaining({
        code: "invalid_runtime_configuration",
        field: "requestResume"
      }))
    }
    let invocations = 0
    expect(() =>
      declare(() => {
        invocations++
        return Effect.void
      })
    ).not.toThrow()
    expect(() => declare(undefined)).not.toThrow()
    expect(invocations).toBe(0)
    expect(existsSync(root)).toBe(false)
    expect(existsSync(database)).toBe(false)
  })

  it("stores artifacts beside the database without nesting a second .flows directory", async () => {
    const root = join(directory, "artifact-root")
    const database = join(root, ".flows", "engine.sqlite")
    const payload = new TextEncoder().encode("node-runtime-artifact-root")
    const digest = await Effect.runPromise(
      Effect.gen(function*() {
        const artifacts = yield* ArtifactStore.ArtifactStore
        return yield* artifacts.put(payload)
      }).pipe(
        Effect.provide(NodeRuntime.storage(database, root)),
        Effect.provide(Layer.merge(NodeFileSystem.layer, NodeCrypto.layer)),
        Effect.scoped
      )
    )

    expect(existsSync(join(root, ".flows", "objects", digest.slice(0, 2), digest))).toBe(true)
    expect(existsSync(join(root, ".flows", ".flows"))).toBe(false)
  })

  it("resolves and snapshots relative storage options when the layer is declared", async () => {
    const root = join(directory, "relative-options")
    mkdirSync(root, { recursive: true })
    const originalDirectory = process.cwd()
    const mutable = {
      filename: "state/runtime.sqlite",
      workspaceRoot: directory,
      owner: { hostId: "relative-a" },
      isAlive: () => Effect.succeed(false)
    }
    const declared = (() => {
      process.chdir(root)
      try {
        return NodeRuntime.layer(
          mutable,
          StepBoundary.layer,
          WorkspaceSandbox.layerFileSystem(),
          Layer.empty
        )
      } finally {
        process.chdir(originalDirectory)
      }
    })()
    mutable.filename = "moved/runtime.sqlite"
    mutable.owner.hostId = "relative-b"
    mutable.isAlive = () => Effect.succeed(true)

    await Effect.runPromise(
      Layer.build(declared).pipe(
        Effect.provide(host),
        Effect.scoped
      )
    )
    expect(existsSync(join(root, "state", "runtime.sqlite"))).toBe(true)
    expect(existsSync(join(originalDirectory, "moved", "runtime.sqlite"))).toBe(false)
  })

  it("migrates, runs, shuts down, and resumes a parked run over one file", async () => {
    // ---------------------------------------------------------------- scope 1
    // Migrate, register, drive one flow to completion, park a second.
    const first = await Effect.runPromise(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const value = yield* Count.execute({ value: 21 }, { executionId: "gate-count" })
        yield* Review.execute({ document: "rfc" }, {
          executionId: "gate-review",
          discard: true
        })
        // A discarded execute returns once the run is scheduled, so wait for
        // the background drive to park it before the scope shuts down.
        while ((yield* runs.get("gate-review")).status !== "suspended") yield* Effect.sleep("5 millis")
        return {
          count: yield* runs.get("gate-count"),
          review: yield* runs.get("gate-review"),
          value
        }
      }).pipe(Effect.provide(incarnation("gate-a")), Effect.provide(hostCrypto), Effect.scoped)
    )

    expect(first.value).toBe(42)
    expect(first.count.status).toBe("completed")
    // The parked run released its claim, which is what makes it reclaimable.
    expect(first.review.status).toBe("suspended")
    expect(first.review.owner).toBeNull()
    expect(dispatches).toEqual({ assess: 1, read: 1, tally: 1 })

    // The composition created the parent directory it was pointed below, and
    // the durable state is a real file on disk that another connection reads.
    expect(existsSync(filename)).toBe(true)
    const persisted = readBack((database) => ({
      runs: database.prepare("SELECT run_id, status FROM flows_runs ORDER BY run_id").all(),
      deferred: database.prepare("SELECT COUNT(*) AS total FROM flows_deferred_completions").get(),
      journal: database.prepare("SELECT COUNT(*) AS total FROM flows_journal_events").get()
    }))
    expect(persisted.runs).toEqual([
      { run_id: "gate-count", status: "completed" },
      { run_id: "gate-review", status: "suspended" }
    ])
    // Migrations ran and the journal recorded the lifecycle; the deferred the
    // parked run waits on has no completion yet.
    expect((persisted.journal as { total: number }).total).toBeGreaterThan(0)
    expect(persisted.deferred).toEqual({ total: 0 })

    // ---------------------------------------------------------------- scope 2
    // A process that completes the deferred but registers no flow. The wake it
    // schedules must find no registration and leave the durable waiting row
    // alone, so the run is still there for a worker that registers the flow.
    const second = await Effect.runPromise(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.deferredDone(Approval, {
          flowName: Review._tag,
          executionId: "gate-review",
          deferredName: Approval.name,
          exit: Exit.succeed("approved")
        })
        const runs = yield* RunStore.RunStore
        // Long enough for a resume this process must NOT perform.
        yield* Effect.sleep("250 millis")
        return yield* runs.get("gate-review")
      }).pipe(Effect.provide(bystander("gate-b")), Effect.scoped)
    )

    expect(second.status).toBe("suspended")
    expect(dispatches.assess).toBe(1)
    expect(readBack((database) => database.prepare("SELECT COUNT(*) AS total FROM flows_deferred_completions").get()))
      .toEqual({ total: 1 })

    // ---------------------------------------------------------------- scope 3
    // Registration is the only thing this scope asks for. The sweep the
    // engine arms on `register` is what has to notice the completed deferred
    // and drive the parked run to a result.
    const third = await Effect.runPromise(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        let row = yield* runs.get("gate-review")
        for (let attempt = 0; attempt < 200 && (row.status === "suspended" || row.status === "running"); attempt++) {
          yield* Effect.sleep("25 millis")
          row = yield* runs.get("gate-review")
        }
        return {
          replayed: yield* Count.execute({ value: 21 }, { executionId: "gate-count" }),
          result: yield* Review.poll("gate-review"),
          row
        }
      }).pipe(Effect.provide(incarnation("gate-c")), Effect.provide(hostCrypto), Effect.scoped)
    )

    expect(third.row.status).toBe("completed")
    expect(completedValue(third.result)).toBe("rfc:draft body:approved")
    // The settled run from scope one is read back, not re-executed.
    expect(third.replayed).toBe(42)
    expect(dispatches.tally).toBe(1)
    // The resumed body re-entered, and the sealed step in front of the wait
    // replayed its journaled result instead of dispatching a second time.
    expect(dispatches.assess).toBe(2)
    expect(dispatches.read).toBe(1)

    expect(readBack((database) => database.prepare("SELECT status FROM flows_runs ORDER BY run_id").all()))
      .toEqual([{ status: "completed" }, { status: "completed" }])
  }, 60_000)

  it("hands back a wired context in the caller's own scope", async () => {
    // `make` is the lower seam an integration reaches for when it wants the
    // CONTEXT rather than a layer — the time-travel example builds a second
    // engine-backed service over the same storage that way — and `layer` is
    // nothing but `Layer.effectContext` around it. Two claims have to hold
    // together: the context is fully wired when it arrives, so a flow driven
    // straight off it settles without any further registration; and the scope
    // that owns the database is the CALLER's, so leaving that scope is what
    // closes the file. It is declared last in this block because it
    // dispatches `Tally`, which the journey above counts.
    const own = join(directory, "make-context", "engine.sqlite")

    const settled = await Effect.runPromise(
      Effect.gen(function*() {
        const context = yield* NodeRuntime.make(
          {
            filename: own,
            workspaceRoot: directory,
            owner: { hostId: "make-context" },
            isAlive: () => Effect.succeed(false)
          },
          StepBoundary.layer,
          WorkspaceSandbox.layerFileSystem(),
          registerFlows
        )
        return yield* Count.execute({ value: 4 }, { executionId: "make-context" }).pipe(
          Effect.provide(context)
        )
      }).pipe(Effect.provide(host), Effect.scoped)
    )

    expect(settled).toBe(8)
    const database = new DatabaseSync(own, { readOnly: true })
    try {
      expect(database.prepare("SELECT status FROM flows_runs").all()).toEqual([{ status: "completed" }])
    } finally {
      database.close()
    }
  }, 60_000)
})

/**
 * The host half of the composition.
 *
 * `layer` leaves the host to the caller: `Jj`, `FileSystem`, `Crypto`, the
 * step boundary and the workspace sandbox are arguments or requirements, and
 * every embedder wired the same pieces in the same order to satisfy them.
 * `layerHost` is that wiring, so these cases supply NOTHING but the option
 * record — a missing default shows up here as a boot failure or a denied
 * capability, not as a subtle difference in behavior.
 */
describe("the Node host composition", () => {
  const hostRoot = join(directory, "host")
  const hostFile = join(hostRoot, "runtime.sqlite")
  const note = join(hostRoot, "note.txt")

  /** Reads a workspace file through whatever `FileSystem` the host installed. */
  const ReadNote = Action.make({
    name: "flows/host/read-note",
    success: Schema.String,
    tier: "sealed",
    idempotencyKey: "flows/host/read-note/v1",
    execute: Effect.gen(function*() {
      const files = yield* FileSystem.FileSystem
      return yield* Effect.orDie(files.readFileString(note))
    })
  })

  /** Tries to run a command, and reports the refusal instead of failing on it. */
  const TrySpawn = Action.make({
    name: "flows/host/try-spawn",
    success: Schema.String,
    tier: "sealed",
    idempotencyKey: "flows/host/try-spawn/v1",
    execute: Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const attempt = yield* Effect.exit(spawner.string(ChildProcess.make("echo", ["hi"])))
      return Exit.isFailure(attempt) ? `refused: ${String(attempt.cause)}` : `ran: ${attempt.value}`
    })
  })

  /**
   * Reaches the filesystem and the network with no rule authorizing either,
   * so a raw host service left beside the guarded one would answer instead
   * of refusing.
   */
  const TryUngranted = Action.make({
    name: "flows/host/try-ungranted",
    success: Schema.String,
    tier: "sealed",
    idempotencyKey: "flows/host/try-ungranted/v1",
    execute: Effect.gen(function*() {
      const files = yield* FileSystem.FileSystem
      const http = yield* HttpClient.HttpClient
      const read = yield* Effect.exit(files.readFileString(note))
      const fetched = yield* Effect.exit(http.get("http://127.0.0.1:9/"))
      const describe = (exit: Exit.Exit<unknown, unknown>) =>
        Exit.isFailure(exit) ? `refused: ${String(exit.cause)}` : "answered"
      return JSON.stringify({ fs: describe(read), http: describe(fetched) })
    })
  })

  const Probe = Action.make("flows/host/probe", {
    payload: { what: Schema.String },
    success: Schema.String
  })

  const Host = Flow.make("flows/host/probe-flow", {
    payload: { what: Schema.String },
    success: Schema.String,
    body: (payload) => Probe.call(payload)
  })

  /** The process group the sleeping action left running, for the kill assertion. */
  const spawned: Array<number> = []

  /** The same, for the run a SECOND driver interrupts. */
  const interrupted: Array<number> = []

  /**
   * A compensable action. The ENGINE, not the body, takes a jj pre-image before
   * this runs, through the same guarded `Jj` a flow body sees, so a host whose
   * grant store has no `jj:*` rule could not execute it at all.
   */
  const Mutate = Action.make({
    name: "flows/host/mutate",
    success: Schema.String,
    tier: "compensable",
    idempotencyKey: "flows/host/mutate/v1",
    execute: Effect.succeed("mutated")
  })

  /** Tries action-facing Jj directly; engine-private authority must not leak here. */
  const TryJjStatus = Action.make({
    name: "flows/host/try-jj-status",
    success: Schema.String,
    tier: "sealed",
    idempotencyKey: "flows/host/try-jj-status/v1",
    execute: Effect.gen(function*() {
      const jj = yield* Jj.Jj
      const attempt = yield* Effect.exit(jj.status())
      return Exit.isFailure(attempt) ? `refused: ${String(attempt.cause)}` : attempt.value
    })
  })

  /** Spawns a two-process tree and waits for it, so a released run has one to kill. */
  const Sleep = Action.make({
    name: "flows/host/sleep",
    success: Schema.String,
    tier: "sealed",
    idempotencyKey: "flows/host/sleep/v1",
    execute: Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const handle = yield* Effect.orDie(spawner.spawn(ChildProcess.make("sh", ["-c", "sleep 60 & sleep 60"])))
      spawned.push(handle.pid as number)
      yield* Effect.orDie(handle.exitCode)
      return "woke"
    })
  })

  const groupIsAlive = (pgid: number): boolean => {
    try {
      process.kill(-pgid, 0)
      return true
    } catch {
      return false
    }
  }

  /** A second sleeping tree, so the interrupt case does not share the first's. */
  const SleepAgain = Action.make({
    name: "flows/host/sleep-again",
    success: Schema.String,
    tier: "sealed",
    idempotencyKey: "flows/host/sleep-again/v1",
    execute: Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const handle = yield* Effect.orDie(spawner.spawn(ChildProcess.make("sh", ["-c", "sleep 60 & sleep 60"])))
      interrupted.push(handle.pid as number)
      yield* Effect.orDie(handle.exitCode)
      return "woke"
    })
  })

  const probe = ({ what }: { readonly what: string }) =>
    Effect.gen(function*() {
      if (what === "read") return yield* ReadNote
      if (what === "spawn") return yield* TrySpawn
      if (what === "mutate") return yield* Mutate
      if (what === "jj-status") return yield* TryJjStatus
      if (what === "ungranted") return yield* TryUngranted
      if (what === "sleep-again") return yield* SleepAgain
      return yield* Sleep
    })

  const hostFlows = Interpreter.layer(Host).pipe(
    Layer.provideMerge(Probe.toLayer(probe)),
    Layer.provideMerge(Action.layerImplementations)
  )

  /**
   * A stand-in for a discovered flow catalog.
   *
   * The real one is `@smthrs/registry`, an agent-group package the engine
   * barrel does not depend on. What the registry seam promises is an ORDER —
   * the catalog is provided beneath registration and above the engine — and
   * that order is visible with any service at all in the catalog's position.
   */
  interface Catalog {
    readonly names: ReadonlyArray<string>
  }
  const Catalog: Context.Service<Catalog, Catalog> = Context.Service("flows/test/NodeRuntime/Catalog")

  /**
   * Naming a registry service without supplying its layer must not compile.
   *
   * The registry-free arities are OVERLOADS rather than a defaulted parameter,
   * and that is the whole safety property. A defaulted parameter cannot honor
   * a caller-chosen registry type: `layerHost<Registered, never, never,
   * Catalog, never, never>(options, registerFlows)` would compile, and the
   * layer it returned would CLAIM to provide `Catalog` while providing
   * nothing — a service-not-found defect discovered when the layer builds,
   * hours from the call that caused it. The conditional argument tuple requires a registry layer whenever
   * its type parameters name a service, so the mismatch is unspellable. Every assertion below is a compile-time
   * one: the `layerHost` call declares a layer and never builds it, and the
   * two `Parameters` reads never run anything at all.
   */
  it("cannot name a registry service without supplying its layer", () => {
    // @ts-expect-error a declared registry service requires the registry layer
    const declared = NodeRuntime.layerHost<never, never, never, Catalog, never, never>(
      { filename: hostFile, workspaceRoot: directory, owner: { hostId: "registry-arity-host" }, signals: [] },
      Layer.empty
    )
    expect(declared).toBeDefined()

    // `layer` and `make` use the same conditional argument tuple, and their boundary and
    // sandbox arguments make an explicit instantiation unreadable. Their
    // signature is what the assertion reads instead: once a registry type is
    // named, the only applicable signature is the five-argument one, so the
    // parameter list has no optional tail to omit. A defaulted parameter would
    // report `4 | 5` here and hand back the same lying layer.
    type Exact<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false
    type LayerArity = Parameters<
      typeof NodeRuntime.layer<never, never, never, never, never, never, never, Catalog, never, never>
    >["length"]
    type MakeArity = Parameters<
      typeof NodeRuntime.make<never, never, never, never, never, never, never, Catalog, never, never>
    >["length"]
    const registryIsRequired: [Exact<LayerArity, 5>, Exact<MakeArity, 5>] = [true, true]

    expect(registryIsRequired).toEqual([true, true])
  })

  const readHostBack = <A>(query: (database: DatabaseSync) => A): A => {
    const database = new DatabaseSync(hostFile, { readOnly: true })
    try {
      return query(database)
    } finally {
      database.close()
    }
  }

  it("runs a sealed host-reading action with nothing but its own options", async () => {
    mkdirSync(hostRoot, { recursive: true })
    writeFileSync(note, "host note")

    const value = await Effect.runPromise(
      Host.execute({ what: "read" }, { executionId: "host-read" }).pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            {
              filename: hostFile,
              workspaceRoot: directory,
              owner: { hostId: "host-a" },
              signals: [],
              rules: [[
                new Permission.Rule({
                  effect: "allow",
                  pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: `${hostRoot}/**` })
                })
              ]]
            },
            hostFlows
          )
        ),
        Effect.scoped
      )
    )

    expect(value).toBe("host note")
  }, 60_000)

  it("denies a process spawn that no rule authorizes", async () => {
    const value = await Effect.runPromise(
      Host.execute({ what: "spawn" }, { executionId: "host-spawn" }).pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            { filename: hostFile, workspaceRoot: directory, owner: { hostId: "host-b" }, signals: [] },
            hostFlows
          )
        ),
        Effect.scoped
      )
    )

    expect(value).toMatch(/^refused:/)
  }, 60_000)

  it("hands an action body only guarded filesystem and network services", async () => {
    mkdirSync(hostRoot, { recursive: true })
    writeFileSync(note, "host note")
    const value = await Effect.runPromise(
      Host.execute({ what: "ungranted" }, { executionId: "host-ungranted" }).pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            { filename: hostFile, workspaceRoot: directory, owner: { hostId: "host-u" }, signals: [] },
            hostFlows
          )
        ),
        Effect.scoped
      )
    )
    const observed = JSON.parse(value) as { readonly fs: string; readonly http: string }
    // Spawn and Jj refusals have their own cases above; these are the two
    // remaining host slots with authority to guard.
    expect(observed.fs).toMatch(/^refused:.*Permission/s)
    expect(observed.http).toMatch(/^refused:.*Permission/s)
  }, 60_000)

  it("builds the registry between the engine and registration, with both in scope", async () => {
    // The optional `registry` argument exists for ONE documented ordering
    // claim: the catalog is built after the engine and before registration, so
    // a registration that reads a catalog off it — `@smthrs/registry`'s
    // `Executable.layer`, which turns every discovered descriptor into a
    // registered durable flow — has the catalog AND the live engine in hand.
    // Nothing in the repository passes a registry, so the claim was
    // unexercised; this case is what makes it a behavior rather than a
    // sentence. `Catalog` stands in for the real registry because
    // `@smthrs/registry` is an agent-group package this one does not depend on;
    // what is under test is the build order, not the catalog's own contents.
    mkdirSync(hostRoot, { recursive: true })
    writeFileSync(note, "host note")
    const observed: Array<{ readonly names: ReadonlyArray<string>; readonly engine: boolean }> = []
    const catalog = Layer.succeed(Catalog)({ names: ["discovered-child"] })
    const registration = Layer.effectDiscard(
      Effect.gen(function*() {
        const discovered = yield* Catalog
        const engine = yield* FlowRuntime.FlowRuntime
        observed.push({ names: discovered.names, engine: engine !== undefined })
      })
    ).pipe(Layer.provideMerge(hostFlows))

    const value = await Effect.runPromise(
      Host.execute({ what: "read" }, { executionId: "host-registry" }).pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            {
              filename: hostFile,
              workspaceRoot: directory,
              owner: { hostId: "host-registry" },
              signals: [],
              rules: [[
                new Permission.Rule({
                  effect: "allow",
                  pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: `${hostRoot}/**` })
                })
              ]]
            },
            registration,
            catalog
          )
        ),
        Effect.scoped
      )
    )

    // The registration ran with both services resolvable, and the runtime it
    // finished is the one that then drove a flow home.
    expect(observed).toEqual([{ names: ["discovered-child"], engine: true }])
    expect(value).toBe("host note")
  }, 60_000)

  it("grants from a later ruleset but keeps the first ruleset's deny a veto", async () => {
    // A nested `rules` value is not a flat list with extra brackets.
    // `@smthrs/capability`'s `evaluate` gives `rulesets[0]` — the CONFIGURED
    // policy — a hard veto and then applies last-match-wins across the rest,
    // so a deny in the first ruleset and a deny in the second behave
    // differently. The single-ruleset cases above cannot see that asymmetry.
    const spawn = (effect: "allow" | "deny") =>
      new Permission.Rule({
        effect,
        pattern: new Capability.CapabilityPattern({ action: "proc:spawn", resource: "*" })
      })
    const attempt = (hostId: string, executionId: string, rules: NodeRuntime.HostOptions["rules"]) =>
      Effect.runPromise(
        Host.execute({ what: "spawn" }, { executionId }).pipe(
          Effect.provide(
            NodeRuntime.layerHost({
              filename: hostFile,
              workspaceRoot: directory,
              owner: { hostId },
              signals: [],
              rules
            }, hostFlows)
          ),
          Effect.scoped
        )
      )

    // Nothing in the configured ruleset matches, so the grant in the second
    // ruleset is what decides — and it is honored.
    expect(await attempt("host-rules-later", "host-rules-later", [[], [spawn("allow")]])).toMatch(/^ran:/)
    // The same allow, behind a configured deny, cannot lift it.
    expect(await attempt("host-rules-veto", "host-rules-veto", [[spawn("deny")], [spawn("allow")]]))
      .toMatch(/^refused:/)
  }, 60_000)

  it("installs the shutdown signals it was not told about, and removes them again", async () => {
    const before = process.listenerCount("SIGTERM")

    const during = await Effect.runPromise(
      Effect.sync(() => process.listenerCount("SIGTERM")).pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            { filename: hostFile, workspaceRoot: directory, owner: { hostId: "host-c" } },
            Layer.empty
          )
        ),
        Effect.scoped
      )
    )

    expect(during).toBe(before + 1)
    expect(process.listenerCount("SIGTERM")).toBe(before)
  }, 60_000)

  it("snapshots policy, signal, owner, and path options before the host builds", async () => {
    mkdirSync(hostRoot, { recursive: true })
    writeFileSync(note, "host note")
    const snapshotFile = join(hostRoot, "snapshot-runtime.sqlite")
    const movedFile = join(hostRoot, "moved-runtime.sqlite")
    const signals: Array<NodeJS.Signals> = ["SIGUSR2", "SIGUSR2"]
    const rules = [
      new Permission.Rule({
        effect: "allow",
        pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: `${hostRoot}/**` })
      })
    ]
    const configured = {
      filename: snapshotFile,
      workspaceRoot: hostRoot,
      owner: { hostId: "snapshot-host" },
      signals,
      shutdownTimeoutMs: 25,
      rules
    }
    const declared = NodeRuntime.layerHost(configured, hostFlows)
    configured.filename = movedFile
    configured.owner.hostId = "mutated-host"
    configured.shutdownTimeoutMs = Number.NaN
    signals.splice(0, signals.length, "SIGTERM")
    rules[0] = new Permission.Rule({
      effect: "deny",
      pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "*" })
    })

    const beforeUser = process.listenerCount("SIGUSR2")
    const beforeTerm = process.listenerCount("SIGTERM")
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        return {
          user: process.listenerCount("SIGUSR2"),
          term: process.listenerCount("SIGTERM"),
          value: yield* Host.execute({ what: "read" }, { executionId: "host-options-snapshot" })
        }
      }).pipe(Effect.provide(declared), Effect.scoped)
    )

    expect(observed).toEqual({ user: beforeUser + 1, term: beforeTerm, value: "host note" })
    expect(existsSync(snapshotFile)).toBe(true)
    expect(existsSync(movedFile)).toBe(false)
    expect(process.listenerCount("SIGUSR2")).toBe(beforeUser)
  }, 60_000)

  it("rejects uncatchable or unknown signals and invalid shutdown timers before installing listeners", () => {
    const before = process.listenerCount("SIGUSR2")
    for (const signal of ["SIGKILL", "SIGSTOP", "SIGNOTASIGNAL"] as Array<NodeJS.Signals>) {
      expect(() =>
        NodeRuntime.layerHost(
          {
            filename: hostFile,
            workspaceRoot: directory,
            owner: { hostId: "invalid-signal" },
            signals: ["SIGUSR2", signal]
          },
          Layer.empty
        )
      ).toThrow(/cannot install signal/)
    }
    for (
      const shutdownTimeoutMs of [
        -1,
        0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        NodeRuntime.maximumShutdownTimeoutMs + 1
      ]
    ) {
      expect(() =>
        NodeRuntime.layerHost(
          {
            filename: hostFile,
            workspaceRoot: directory,
            owner: { hostId: "invalid-timeout" },
            signals: [],
            shutdownTimeoutMs
          },
          Layer.empty
        )
      ).toThrow(/shutdownTimeoutMs/)
    }
    expect(process.listenerCount("SIGUSR2")).toBe(before)
  })

  it("refuses signal and rule configuration that is not the array it claims to be", () => {
    // The signal and rule guards sit beside the value checks above and answer
    // the other half of the same question: a JavaScript caller can hand these
    // options any shape at all, and a host that iterated a string or indexed a
    // non-array would install nonsense policy instead of refusing it. Each
    // case names the collection it got wrong.
    const before = process.listenerCount("SIGUSR2")
    expect(() =>
      NodeRuntime.layerHost(
        {
          filename: hostFile,
          workspaceRoot: directory,
          owner: { hostId: "invalid-signals" },
          signals: "SIGTERM" as never
        },
        Layer.empty
      )
    ).toThrow(/signals must be an array/)
    expect(() =>
      NodeRuntime.layerHost(
        {
          filename: hostFile,
          workspaceRoot: directory,
          owner: { hostId: "invalid-rules" },
          signals: [],
          rules: "deny-everything" as never
        },
        Layer.empty
      )
    ).toThrow(/rules must be an array/)
    // A ruleset list is recognized by its first member, so the refusal has to
    // reach every later member too: this one is a policy list whose second
    // ruleset is not a list.
    expect(() =>
      NodeRuntime.layerHost(
        {
          filename: hostFile,
          workspaceRoot: directory,
          owner: { hostId: "invalid-ruleset" },
          signals: [],
          rules: [[], "deny-everything"] as never
        },
        Layer.empty
      )
    ).toThrow(/rulesets must be arrays/)
    expect(process.listenerCount("SIGUSR2")).toBe(before)
  })

  it("snapshots containment and hands the reaper the seam the caller declared", async () => {
    // Containment is the one option group whose members are callbacks and
    // scalars a caller keeps a reference to. Every member has to survive the
    // snapshot: dropping `system` would silently swap in the real platform
    // seam, which reaps live process groups on the machine. None may be
    // re-read after declaration either, because the layer builds later than
    // the call that declared it. An inherited ledger record drives the reaper
    // through every callback. Without that record a fresh database observes
    // only the process group and boot time, so dropping a later callback from
    // the snapshot would leave this case green.
    mkdirSync(hostRoot, { recursive: true })
    const containmentFile = join(hostRoot, "containment-runtime.sqlite")
    const containmentHost = "containment-host"
    const previousOwnerPid = process.pid + 10_000
    const orphanPid = previousOwnerPid + 1
    // `layerHost` gives its ledger `process.pid`; `containment.ownerPid` only
    // configures the reaper guard. Build the prior incarnation's ledger over
    // the same production storage so its public `record` API writes an orphan
    // that the host below can inherit without fabricated journal rows.
    const recorded = await Effect.runPromise(
      Effect.gen(function*() {
        const ledger = yield* Kernel.ProcessLedger.ProcessLedger
        return yield* ledger.record({ pid: orphanPid, pgid: null, commandDigest: "snapshot seam" })
      }).pipe(
        Effect.provide(
          Kernel.ProcessLedger.layer({ hostId: containmentHost, ownerPid: previousOwnerPid }).pipe(
            Layer.provide(NodeRuntime.storage(containmentFile)),
            Layer.provide(Layer.merge(NodeFileSystem.layer, NodeCrypto.layer))
          )
        ),
        Effect.scoped
      )
    )
    const asked: Array<string> = []
    const declaredSystem = {
      isAlive: () => {
        asked.push("isAlive")
        return "dead" as const
      },
      startedAtMs: () => {
        asked.push("startedAtMs")
        return { _tag: "started", startedAtMs: recorded.startedAtMs } as const
      },
      ownGroup: () => {
        asked.push("ownGroup")
        return null
      },
      bootedAtMs: () => {
        asked.push("bootedAtMs")
        return 0
      },
      refuseTarget: () => {
        asked.push("refuseTarget")
        return undefined
      },
      killTree: () => {
        asked.push("killTree")
        return "already-gone" as const
      }
    }
    const replacedSystem = {
      ...declaredSystem,
      ownGroup: () => {
        asked.push("replaced")
        return null
      }
    }
    // No `graceMs`: the spawner's own default is what a caller who names only
    // the seam is asking for, and the snapshot must not invent one.
    const containment = {
      platform: process.platform,
      ownerPid: process.pid,
      system: declaredSystem
    }
    const declared = NodeRuntime.layerHost(
      {
        filename: containmentFile,
        workspaceRoot: directory,
        owner: { hostId: containmentHost },
        signals: [],
        containment
      },
      hostFlows
    )
    // Mutated after declaration and before the build. The layer already holds
    // its own copy, so `replaced` must never be recorded below.
    containment.system = replacedSystem

    await Effect.runPromise(Effect.provide(Effect.void, declared).pipe(Effect.scoped))

    expect(asked).toEqual(["ownGroup", "bootedAtMs", "refuseTarget", "isAlive", "startedAtMs", "killTree"])
  }, 60_000)

  it("leaves with the signal's default status when the operator signals twice", async () => {
    // The handler's two escapes only run in a process that is on its way out,
    // so the child-process suites can observe their EFFECT but never execute
    // them here. Emitting the signal on this process drives the very listener
    // `layerHost` installed, with `process.exit` captured so the worker
    // survives to assert on what the handler asked for.
    const asked: Array<number | undefined> = []
    const realExit = process.exit
    ;(process as unknown as { exit: unknown }).exit = (code?: number) => {
      asked.push(code)
    }

    try {
      await Effect.runPromise(
        Effect.promise(async () => {
          // The first signal is the graceful path: it closes the runtime scope
          // and arms the deadline, and asks for no exit itself.
          process.emit("SIGTERM")
          expect(asked).toEqual([])
          // A zero deadline is the shutdown that outlasted its budget, so the
          // timer leaves on the next macrotask rather than after a wall-clock
          // wait this suite would have to sit through.
          await new Promise((resolve) => setTimeout(resolve, 5))
          // The third is the operator asking twice.
          process.emit("SIGTERM")
        }).pipe(
          Effect.provide(
            NodeRuntime.layerHost(
              { filename: hostFile, workspaceRoot: directory, owner: { hostId: "host-twice" }, shutdownTimeoutMs: 0 },
              Layer.empty
            )
          ),
          Effect.scoped
        )
      )
    } finally {
      ;(process as unknown as { exit: unknown }).exit = realExit
    }

    expect(asked).toEqual([NodeRuntime.signalExitCode("SIGTERM"), NodeRuntime.signalExitCode("SIGTERM")])
    // `128 + signal number` is the status the default behavior would have
    // produced, and an unrecognized name has no behavior to read, so it
    // answers `SIGTERM`'s.
    expect(NodeRuntime.signalExitCode("SIGTERM")).toBe(143)
    expect(NodeRuntime.signalExitCode("SIGINT")).toBe(130)
    expect(NodeRuntime.signalExitCode("SIGNOTASIGNAL" as NodeJS.Signals)).toBe(143)
  }, 60_000)

  it("releases the run it owns when a shutdown signal arrives, and kills what it spawned", async () => {
    // Every precondition the shutdown is read against is RECORDED here and
    // asserted after the run, because the block below ends in `Effect.exit`:
    // an `expect` inside it is a caught defect, ordinary scope cleanup still
    // releases the run and kills its group on the way out, and the durable
    // checks at the bottom then pass on a closure no signal caused.
    const observed: {
      status: string | undefined
      spawned: number
      aliveBeforeSignal: boolean
      signalSent: boolean
      settled: Exit.Exit<unknown, unknown> | undefined
    } = { status: undefined, spawned: 0, aliveBeforeSignal: false, signalSent: false, settled: undefined }

    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const running = yield* Effect.forkChild(
          Effect.exit(Host.execute({ what: "sleep" }, { executionId: "host-signal" })),
          { startImmediately: true }
        )
        let row = yield* runs.get("host-signal")
        for (let attempt = 0; attempt < 400 && (row.status !== "running" || spawned.length === 0); attempt++) {
          yield* Effect.sleep("25 millis")
          row = yield* runs.get("host-signal")
        }
        yield* Effect.sync(() => {
          observed.status = row.status
          // The action really did start an OS process tree, so the kill
          // assertion at the bottom is about a process that existed.
          observed.spawned = spawned.length
          observed.aliveBeforeSignal = spawned.length === 1 && groupIsAlive(spawned[0]!)
        })
        // SIGUSR2 is the one user signal Node does not reserve — SIGUSR1
        // starts the inspector — so the handler under test is the only
        // listener this raise reaches.
        yield* Effect.sync(() => {
          process.kill(process.pid, "SIGUSR2")
          observed.signalSent = true
        })
        observed.settled = yield* Effect.exit(Fiber.join(running))
      }).pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            {
              filename: hostFile,
              workspaceRoot: directory,
              owner: { hostId: "host-d" },
              signals: ["SIGUSR2"],
              rules: [[
                new Permission.Rule({
                  effect: "allow",
                  pattern: new Capability.CapabilityPattern({ action: "proc:spawn", resource: "*" })
                })
              ]]
            },
            hostFlows
          )
        ),
        Effect.scoped,
        Effect.exit
      )
    )

    // A defect is the composition's failure, so it is rethrown with its own
    // message rather than folded into a boolean. The block may end
    // INTERRUPTED — the signal closes the runtime scope underneath it — but
    // it may not die.
    if (Exit.isFailure(outcome) && Cause.hasDies(outcome.cause)) throw Cause.squash(outcome.cause)
    expect(Exit.isSuccess(outcome) || Cause.hasInterruptsOnly(outcome.cause)).toBe(true)

    // What the shutdown was read against: a run this host was really driving,
    // one live process group, and a signal that was really raised. Without
    // these three the checks below prove only that a scope closed.
    expect(observed.status).toBe("running")
    expect(observed.spawned).toBe(1)
    expect(observed.aliveBeforeSignal).toBe(true)
    expect(observed.signalSent).toBe(true)
    // The caller settles with the released run rather than waiting on it, and
    // a release is an interruption of the fiber that was driving it. The
    // forked effect is itself `Effect.exit`-wrapped, so the interruption is
    // whichever of the two levels caught it.
    expect(observed.settled).toBeDefined()
    const settled = observed.settled !== undefined && Exit.isSuccess(observed.settled)
      ? observed.settled.value as Exit.Exit<unknown, unknown>
      : observed.settled
    expect(settled !== undefined && Exit.isFailure(settled) && Cause.hasInterrupts(settled.cause)).toBe(true)

    // The run is reclaimable, not abandoned: `suspended` with the reason the
    // engine parks a released run under, and no owner still holding it.
    expect(
      readHostBack((database) =>
        database.prepare("SELECT status, waiting_reason, owner_host_id FROM flows_runs WHERE run_id = 'host-signal'")
          .get()
      )
    ).toMatchObject({ status: "suspended", waiting_reason: "released", owner_host_id: null })

    // Containment is what makes the release complete: the action's scope closed
    // with the run, and closing it took the whole process group with it rather
    // than leaving a `sleep` behind for nobody.
    const deadline = Date.now() + 10_000
    while (groupIsAlive(spawned[0]!) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(groupIsAlive(spawned[0]!)).toBe(false)
  }, 60_000)

  it("takes a compensable pre-image privately without granting action-facing Jj", async () => {
    if (!existsSync(join(hostRoot, ".jj"))) execFileSync("jj", ["git", "init", hostRoot], { stdio: "ignore" })
    const outcome = await Effect.runPromise(
      Effect.exit(Host.execute({ what: "mutate" }, { executionId: "host-mutate" })).pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            { filename: hostFile, workspaceRoot: hostRoot, owner: { hostId: "host-m" }, signals: [] },
            hostFlows
          )
        ),
        Effect.scoped
      )
    )

    expect(outcome).toMatchObject({ _tag: "Success", value: "mutated" })

    const direct = await Effect.runPromise(
      Host.execute({ what: "jj-status" }, { executionId: "host-jj-status" }).pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            { filename: hostFile, workspaceRoot: hostRoot, owner: { hostId: "host-j" }, signals: [] },
            hostFlows
          )
        ),
        Effect.scoped
      )
    )
    expect(direct).toMatch(/^refused:/)
    expect(direct).toMatch(/Permission/)
  }, 60_000)

  it("keeps engine bookkeeping independent of an explicit action-facing Jj denial", async () => {
    if (!existsSync(join(hostRoot, ".jj"))) execFileSync("jj", ["git", "init", hostRoot], { stdio: "ignore" })
    const outcome = await Effect.runPromise(
      Effect.exit(Host.execute({ what: "mutate" }, { executionId: "host-mutate-denied" })).pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            {
              filename: hostFile,
              workspaceRoot: hostRoot,
              owner: { hostId: "host-n" },
              signals: [],
              rules: [
                new Permission.Rule({
                  effect: "deny",
                  pattern: new Capability.CapabilityPattern({ action: "jj:snapshot", resource: "*" })
                })
              ]
            },
            hostFlows
          )
        ),
        Effect.scoped
      )
    )

    expect(outcome).toMatchObject({ _tag: "Success", value: "mutated" })
  }, 60_000)

  it("kills what a run spawned when a SECOND driver over the same file interrupts it", async () => {
    // Cancellation from another process is the shape an operator's `cancel`
    // has: the run is driven here and interrupted from a driver that shares
    // only the SQLite file. Containment has to survive that route too, not
    // just the signal one.
    const host = (hostId: string) =>
      NodeRuntime.layerHost(
        {
          filename: hostFile,
          workspaceRoot: directory,
          owner: { hostId },
          signals: [],
          containment: { graceMs: 300 },
          rules: [
            new Permission.Rule({
              effect: "allow",
              pattern: new Capability.CapabilityPattern({ action: "proc:spawn", resource: "*" })
            })
          ]
        },
        hostFlows
      )

    const caller = await Effect.runPromise(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const running = yield* Effect.forkChild(
          Effect.exit(Host.execute({ what: "sleep-again" }, { executionId: "host-cancel" })),
          { startImmediately: true }
        )
        let row = yield* runs.get("host-cancel")
        for (let attempt = 0; attempt < 400 && (row.status !== "running" || interrupted.length === 0); attempt++) {
          yield* Effect.sleep("25 millis")
          row = yield* runs.get("host-cancel")
        }
        expect(row.status).toBe("running")
        expect(interrupted).toHaveLength(1)
        expect(groupIsAlive(interrupted[0]!)).toBe(true)

        // The second driver: its own engine, its own owner, the same file. Its
        // `interrupt` writes a durable cancellation request rather than
        // touching a fiber it does not hold.
        yield* Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          yield* engine.interrupt(Host, "host-cancel")
        }).pipe(Effect.provide(host("host-cancel-b")), Effect.scoped)

        // The owner observes the request on its heartbeat cadence, so the wait
        // is bounded by that plus the containment grace, not by a poll count.
        for (let attempt = 0; attempt < 80 && row.status !== "cancelled"; attempt++) {
          yield* Effect.sleep("100 millis")
          row = yield* runs.get("host-cancel")
        }
        expect(row.status).toBe("cancelled")

        // graceMs is 300 above, so the group has to be gone well inside this.
        for (let attempt = 0; attempt < 32 && groupIsAlive(interrupted[0]!); attempt++) {
          yield* Effect.sleep("25 millis")
        }
        expect(groupIsAlive(interrupted[0]!)).toBe(false)

        // The caller settles with the run. A cross-driver cancel interrupts
        // the fiber that asked for it, so nothing here interrupts it by hand:
        // the settlement is the assertion.
        let settled = running.pollUnsafe()
        for (let attempt = 0; attempt < 200 && settled === undefined; attempt++) {
          yield* Effect.sleep("25 millis")
          settled = running.pollUnsafe()
        }
        return settled
      }).pipe(Effect.provide(host("host-cancel-a")), Effect.scoped, Effect.exit)
    )

    // Asserted out here, where a failure is the test's: every `expect` inside
    // the block above is swallowed by its own `Effect.exit`.
    const settled = Exit.isSuccess(caller) ? caller.value : undefined
    expect(settled).toBeDefined()
    const outcome = settled !== undefined && Exit.isSuccess(settled)
      ? settled.value as Exit.Exit<unknown, unknown>
      : settled
    expect(outcome !== undefined && Exit.isFailure(outcome) && Cause.hasInterrupts(outcome.cause)).toBe(true)

    // Read back through an independent connection: what the second driver's
    // request produced is a durable row, not an in-process observation.
    expect(
      readHostBack((database) => database.prepare("SELECT status FROM flows_runs WHERE run_id = 'host-cancel'").get())
    ).toMatchObject({ status: "cancelled" })
  }, 60_000)
})

/**
 * Shared-store execution routing: `Options.canExecute`.
 *
 * The option's documented job is to route "shared-store runs to the host
 * configured for their workspace", and the whole of its wiring is one field
 * forwarded into `EngineStore.layer` (`src/NodeRuntime.ts`,
 * `canExecute: validated.canExecute`). Validation cannot see that field: a
 * composition that dropped it would still refuse a non-function eagerly and
 * still never invoke a valid one before it builds, so the eager-validation
 * case above stays green while the option does nothing.
 *
 * What pins the forwarding is a run the wrong host must LEAVE and the right
 * host must finish, over one SQLite file — the deployment the option exists
 * for. `@smthrs/engine-store`'s own ownership suite drives `RunDriver`
 * directly and the CLI's workspace suite exercises the routing helper;
 * neither reaches this composition.
 */
describe("shared-store execution routing", () => {
  const routingRoot = join(directory, "routing")
  const routingFile = join(routingRoot, "runtime.sqlite")

  const Land = Action.make("flows/routing/land", {
    payload: { workspace: Schema.String },
    success: Schema.String
  })

  const Route = Flow.make("flows/routing/route", {
    payload: { workspace: Schema.String },
    success: Schema.String,
    body: (payload) => Land.call(payload)
  })

  /** Which host ran the action, in the order they ran it. */
  const executedBy: Array<string> = []

  /** Every `host:run` pair a routing predicate was consulted about. */
  const consulted: Array<string> = []

  /** One host's registration, whose action records the host that dispatched it. */
  const routingFlows = (hostId: string) =>
    Interpreter.layer(Route).pipe(
      Layer.provideMerge(
        Land.toLayer(({ workspace }) =>
          Effect.sync(() => {
            executedBy.push(hostId)
            return `${hostId}:${workspace}`
          })
        )
      ),
      Layer.provideMerge(Action.layerImplementations)
    )

  /** The row a routing predicate is handed, taken from the public option. */
  type RoutedRun = Parameters<NonNullable<NodeRuntime.Options["canExecute"]>>[0]

  /**
   * The workspace a run was started for, read off the state its row already
   * carries. A predicate runs BEFORE any claim, so the row is the only thing
   * it can key on.
   */
  const workspaceOf = (row: RoutedRun): string => {
    const state = JSON.parse(row.stateJson) as { readonly payload?: { readonly workspace?: string } }
    return state.payload?.workspace ?? ""
  }

  const routingOptions = (hostId: string, workspace: string): NodeRuntime.Options => ({
    filename: routingFile,
    workspaceRoot: routingRoot,
    owner: { hostId },
    isAlive: () => Effect.succeed(false),
    canExecute: (row) =>
      Effect.sync(() => {
        consulted.push(`${hostId}:${row.runId}`)
        return workspaceOf(row) === workspace
      })
  })

  const routingHost = (options: NodeRuntime.Options, hostId: string) =>
    NodeRuntime.layer(
      options,
      StepBoundary.layer,
      WorkspaceSandbox.layerFileSystem(),
      routingFlows(hostId)
    ).pipe(Layer.provide(host))

  /** Reads the routing file back through an independent connection. */
  const readRouting = <A>(query: (database: DatabaseSync) => A): A => {
    const database = new DatabaseSync(routingFile, { readOnly: true })
    try {
      return query(database)
    } finally {
      database.close()
    }
  }

  it("executes a run only on the host whose predicate admits it", async () => {
    const alphaOptions = routingOptions("alpha-host", "alpha")
    const alpha = routingHost(alphaOptions, "alpha-host")
    // The predicate is snapshotted when `layer` is CALLED. A caller that
    // keeps its options object and edits it afterwards — the same object a
    // long-lived host program holds — must not be able to move a run onto a
    // host that was never configured for it. The replacement admits
    // everything and records nothing, so `consulted` below also says which
    // function the engine actually asked.
    const mutated = alphaOptions as { canExecute: NodeRuntime.Options["canExecute"] }
    mutated.canExecute = () => Effect.succeed(true)

    const first = await Effect.runPromise(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        // A run for the OTHER host's workspace. `discard` is what makes the
        // refusal observable: an undriven run has no result to wait for.
        yield* Route.execute({ workspace: "beta" }, { executionId: "route-to-beta", discard: true })
        const mine = yield* Route.execute({ workspace: "alpha" }, { executionId: "route-to-alpha" })
        return { foreign: yield* runs.get("route-to-beta"), mine }
      }).pipe(Effect.provide(alpha), Effect.provide(hostCrypto), Effect.scoped)
    )

    // This host ran its own workspace's run, and only that one.
    expect(first.mine).toBe("alpha-host:alpha")
    expect(executedBy).toEqual(["alpha-host"])
    // The refused run was left exactly as it was created: never claimed,
    // never owned, still there for the host that serves its workspace.
    expect(first.foreign.status).toBe("pending")
    expect(first.foreign.owner).toBeNull()
    expect(first.foreign.claim).toBeNull()
    // The predicate the layer was BUILT with is the one the engine asked, not
    // the one the caller wrote into its options object afterwards.
    expect(consulted).toContain("alpha-host:route-to-beta")

    // The host that serves `beta` finds the run waiting and drives it home.
    const settled = await Effect.runPromise(
      Route.execute({ workspace: "beta" }, { executionId: "route-to-beta" }).pipe(
        Effect.provide(routingHost(routingOptions("beta-host", "beta"), "beta-host")),
        Effect.provide(hostCrypto),
        Effect.scoped
      )
    )

    expect(settled).toBe("beta-host:beta")
    expect(executedBy).toEqual(["alpha-host", "beta-host"])
    // Read back through an independent connection: routing decided which
    // process did the work, not which one recorded a result.
    expect(readRouting((database) => database.prepare("SELECT run_id, status FROM flows_runs ORDER BY run_id").all()))
      .toEqual([
        { run_id: "route-to-alpha", status: "completed" },
        { run_id: "route-to-beta", status: "completed" }
      ])
  }, 60_000)
})
