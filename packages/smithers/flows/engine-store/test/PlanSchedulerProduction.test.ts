/**
 * The acceptance test for the whole lane, under the PRODUCTION composition:
 * the filesystem-backed `StepBoundary` and the filesystem-backed
 * `WorkspaceSandbox` over a real temporary workspace. No `layerTest` anywhere.
 *
 * A plan is compiled and persisted, the scheduler drives it, one input file is
 * edited, and the same plan is driven again. The promise Bazel makes and this
 * repository has been claiming since `Step Keys` was written is that only the
 * cone below the edit re-runs and every unchanged branch is a cache hit. This
 * is where that stops being a claim.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Jj } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelWorkspace from "@smthrs/kernel/Workspace"
import { KeyMaterial, Plan } from "@smthrs/plan"
import * as FileSet from "@smthrs/plan/FileSet"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { type Ownership, RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as StepSandbox from "../src/StepSandbox.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "plan-host", pid: 55, nonce: "plan-process" }

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "plan-snapshot" as never, changeId: "plan-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/**
 * The production composition: the kernel-guarded filesystem rooted at the
 * workspace — the seam every declaration's workspace-relative path resolves
 * through — plus the real boundary and the real sandbox.
 */
const production = (root: string) => {
  const workspaceFs = KernelFileSystem.layer.pipe(
    Layer.provide(AtomicFileSystem.layer),
    Layer.provideMerge(NodePath.layer),
    Layer.provide(KernelWorkspace.layer(root)),
    Layer.provide(GrantStore.layerNoop)
  )
  const artifacts = ArtifactStore.layerFileSystem({
    directory: join(root, ".flows/objects"),
    durability: "best-effort"
  }).pipe(
    Layer.provideMerge(workspaceFs)
  )
  return Layer.mergeAll(
    StepBoundary.layer.pipe(Layer.provide(artifacts)),
    jjLayer,
    StepSandbox.layer.pipe(
      Layer.provide(artifacts),
      Layer.provide(KernelWorkspace.layer(root))
    )
  ).pipe(Layer.provideMerge(artifacts))
}

/** The real filesystem boundary without the execution sandbox, for tests that deliberately move the host between dispatches. */
const boundaryOnly = (root: string) => {
  const workspaceFs = KernelFileSystem.layer.pipe(
    Layer.provide(AtomicFileSystem.layer),
    Layer.provideMerge(NodePath.layer),
    Layer.provide(KernelWorkspace.layer(root)),
    Layer.provide(GrantStore.layerNoop)
  )
  const artifacts = ArtifactStore.layerFileSystem({
    directory: join(root, ".flows/objects"),
    durability: "best-effort"
  }).pipe(
    Layer.provideMerge(workspaceFs)
  )
  return Layer.mergeAll(
    StepBoundary.layer.pipe(Layer.provide(artifacts)),
    jjLayer
  ).pipe(Layer.provideMerge(artifacts))
}

const write = (path: string, content: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(join(path, ".."), { recursive: true })
    yield* fs.writeFileString(path, content)
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie)

const read = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(
    Effect.provide(NodeFileSystem.layer),
    Effect.orDie
  )

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    /* v8 ignore next */
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    /* v8 ignore next */
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

/**
 * An ordinary body: it reads its declared inputs and writes its declared
 * output. It knows nothing about plans, sandboxes, or keys — which is the
 * point of the executor seam.
 */
const renderer = (ran: Array<string>): PlanScheduler.Executor => ({
  execute: ({ boundary, node }) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const parts: Array<string> = []
      for (const entry of StepBoundary.exactReads(boundary)) parts.push(yield* fs.readFileString(entry.path))
      const output = FileSet.expand(node.effects.writes)[0]!
      if (typeof output !== "string") return yield* Effect.die(new Error("renderer expects an exact output"))
      yield* fs.makeDirectory(join(output, ".."), { recursive: true })
      yield* fs.writeFileString(output, `${node.id}(${parts.join("+")})`)
      ran.push(node.id)
      return { bytes: parts.join("+").length }
    }).pipe(Effect.orDie) as unknown as Effect.Effect<unknown, unknown>
})

const graph = (): ReadonlyArray<Plan.NodeDraft> => [
  {
    id: "render-a",
    material: {
      version: KeyMaterial.version,
      kind: "sealed" as const,
      body: { action: "render" },
      inputs: [{ _tag: "Literal" as const, value: "a" }],
      layers: [],
      capabilities: []
    },
    effects: {
      reads: ["src/a.txt"],
      writes: ["out/a.txt"],
      boundaryMode: "hard" as const
    }
  },
  {
    id: "render-b",
    material: {
      version: KeyMaterial.version,
      kind: "sealed" as const,
      body: { action: "render" },
      inputs: [{ _tag: "Literal" as const, value: "b" }],
      layers: [],
      capabilities: []
    },
    effects: {
      reads: ["src/b.txt"],
      writes: ["out/b.txt"],
      boundaryMode: "hard" as const
    }
  },
  {
    id: "combine",
    material: {
      version: KeyMaterial.version,
      kind: "sealed" as const,
      body: { action: "combine" },
      inputs: [
        { _tag: "Ref" as const, from: "render-a", path: [] },
        { _tag: "Ref" as const, from: "render-b", path: [] }
      ],
      layers: [],
      capabilities: []
    },
    effects: {
      reads: ["out/a.txt", "out/b.txt"],
      writes: ["out/all.txt"],
      boundaryMode: "hard" as const
    }
  }
]

const outcomes = (report: PlanScheduler.Report) =>
  Object.fromEntries(report.settlements.map((settlement) => [settlement.nodeId, settlement.outcome]))

interface DraftOptions {
  readonly inputs?: ReadonlyArray<KeyMaterial.InputRef>
  readonly reads?: Plan.NodeEffects["reads"]
  readonly writes?: Plan.NodeEffects["writes"]
  readonly removes?: ReadonlyArray<string>
  readonly conflictStrategy?: Plan.PairStrategy
  readonly runtimeStrategy?: Plan.RuntimeStrategy
}

const draft = (id: string, options: DraftOptions = {}): Plan.NodeDraft => ({
  id,
  material: {
    version: KeyMaterial.version,
    kind: "sealed",
    body: { action: id },
    inputs: options.inputs ?? [],
    layers: [],
    capabilities: []
  },
  effects: {
    reads: options.reads ?? [],
    writes: options.writes ?? [`out/${id}.txt`],
    ...(options.removes === undefined ? {} : { removes: options.removes }),
    boundaryMode: "hard"
  },
  ...(options.conflictStrategy === undefined ? {} : { conflictStrategy: options.conflictStrategy }),
  ...(options.runtimeStrategy === undefined ? {} : { runtimeStrategy: options.runtimeStrategy })
})

/**
 * Every case here drives a plan through the PRODUCTION host filesystem: the
 * capability kernel's guarded `FileSystem` over
 * `@smthrs/platform-node/AtomicFileSystem`. Node has no `openat(2)`, so that
 * adapter spends one CPython process per filesystem operation — about 130 ms
 * on an idle machine, and several times that on a host running the whole
 * package graph. A two-node plan settles in roughly forty of them, so these
 * cases are bounded by process spawns rather than by the work they describe,
 * and Vitest's 60 s wall is one load multiplier away from firing on a
 * perfectly correct run. One case already carried this budget; it belongs to
 * the suite, because every case here pays the same per-operation price. It
 * stays FINITE so a genuine hang still fails the run.
 */
describe("a persisted plan driven end to end under the production composition", { timeout: 120_000 }, () => {
  it.effect(
    "re-runs only the cone below an edited input; every unchanged branch is a cache hit",
    () =>
      Effect.gen(function*() {
        const root = mkdtempSync(join(tmpdir(), "flows-plan-"))
        const plan = yield* withCrypto(Plan.compile({ planId: "prod-plan", flow: "example/Render", nodes: graph() }))
        const first: Array<string> = []
        const second: Array<string> = []

        const stores = TestStores.layer()
        const program = Effect.gen(function*() {
          yield* write(join(root, "src/a.txt"), "alpha")
          yield* write(join(root, "src/b.txt"), "beta")

          yield* activate("prod-run-1")
          const one = PlanScheduler.make({ runId: "prod-run-1", owner, sourceId: "plan/prod-run-1" })
          const recorded = yield* one.record(plan)
          const before = yield* Effect.provide(
            one.run(plan),
            Layer.merge(production(root), PlanScheduler.layerExecutor(renderer(first)))
          )

          // The world moves: one source file is edited between runs. Nothing else
          // changes — same plan value, same keys, same declarations.
          yield* write(join(root, "src/a.txt"), "ALPHA")

          yield* activate("prod-run-2")
          const two = PlanScheduler.make({ runId: "prod-run-2", owner, sourceId: "plan/prod-run-2" })
          const after = yield* Effect.provide(
            two.run(plan),
            Layer.merge(production(root), PlanScheduler.layerExecutor(renderer(second)))
          )
          const events = yield* JournalRecords.entries("prod-run-2", undefined, 512)
          return { after, before, events, recorded }
        }).pipe(Effect.provide(stores))

        const { after, before, events, recorded } = yield* withCrypto(program)

        expect(recorded).toEqual({ _tag: "Recorded" })
        expect(outcomes(before)).toEqual({ "render-a": "built", "render-b": "built", combine: "built" })
        expect(first.sort()).toEqual(["combine", "render-a", "render-b"])

        // THE HEADLINE. `render-b` reads a file nothing touched, so its dispatch
        // key is unchanged and the cross-run cache serves it: it never executed in
        // run 2. `render-a` re-keyed because the host measured different bytes,
        // and `combine` re-keyed because the file `render-a` produced changed.
        expect(outcomes(after)).toEqual({ "render-a": "built", "render-b": "clean", combine: "built" })
        expect(second.sort()).toEqual(["combine", "render-a"])

        // The workspace holds what the second run computed, copied back through
        // the sandbox's materialize.
        expect(yield* withCrypto(read(join(root, "out/a.txt")))).toBe("render-a(ALPHA)")
        expect(yield* withCrypto(read(join(root, "out/all.txt")))).toBe("combine(render-a(ALPHA)+render-b(beta))")

        // And the journal explains it: a cache hit for the clean node, node
        // outcomes for all three.
        const settled = events.entries.filter((entry) => entry.eventType === "flows.engine.node-settled")
        expect(settled.map((entry) => (entry.payload as { nodeId: string }).nodeId).sort()).toEqual([
          "combine",
          "render-a",
          "render-b"
        ])
        expect(
          events.entries.some((entry) =>
            entry.eventType === "flows.engine.cache-provenance" &&
            (entry.payload as { action?: string }).action === undefined
          )
        ).toBe(true)
      })
  )

  it.effect("pins a source-glob expansion once per run and re-keys when a new file matches", () =>
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "flows-plan-glob-"))
      const output = join(root, "out/glob.txt")
      const plan = yield* withCrypto(Plan.compile({
        planId: "prod-glob-plan",
        flow: "example/Glob",
        nodes: [{
          id: "render-glob",
          material: {
            version: KeyMaterial.version,
            kind: "sealed",
            body: { action: "render-glob" },
            inputs: [],
            layers: [],
            capabilities: []
          },
          effects: {
            reads: [{ _tag: "Glob", include: ["src/*.txt"] }],
            writes: ["out/glob.txt"],
            boundaryMode: "hard"
          }
        }]
      }))
      const stores = TestStores.layer()
      const runs: Array<string> = []
      const program = Effect.gen(function*() {
        yield* write(join(root, "src/a.txt"), "a")
        yield* activate("prod-glob-1")
        const first = yield* Effect.provide(
          PlanScheduler.make({ runId: "prod-glob-1", owner, sourceId: "glob/1" }).run(plan),
          Layer.merge(production(root), PlanScheduler.layerExecutor(renderer(runs)))
        )
        yield* write(join(root, "src/b.txt"), "b")
        yield* activate("prod-glob-2")
        const second = yield* Effect.provide(
          PlanScheduler.make({ runId: "prod-glob-2", owner, sourceId: "glob/2" }).run(plan),
          Layer.merge(production(root), PlanScheduler.layerExecutor(renderer(runs)))
        )
        return { first, second }
      }).pipe(Effect.provide(stores))
      const result = yield* withCrypto(program)
      expect(outcomes(result.first)).toEqual({ "render-glob": "built" })
      expect(outcomes(result.second)).toEqual({ "render-glob": "built" })
      expect(runs).toEqual(["render-glob", "render-glob"])
      expect(yield* withCrypto(read(output))).toBe("render-glob(a+b)")
    }))

  it.effect("pins source members of a mixed glob while observing producer outputs after settlement", () =>
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "flows-plan-mixed-glob-"))
      const glob: FileSet.Glob = { _tag: "Glob", include: ["src/**"] }
      const plan = yield* withCrypto(Plan.compile({
        planId: "mixed-glob-plan",
        flow: "example/MixedGlob",
        nodes: [
          draft("writer", { writes: ["src/gen.ts"] }),
          draft("reader-first", { reads: [glob] }),
          draft("move-world", { inputs: [{ _tag: "Pending", from: "reader-first" }] }),
          draft("reader-second", {
            inputs: [{ _tag: "Pending", from: "move-world" }],
            reads: [glob]
          })
        ]
      }))
      const seen = new Map<string, FileBoundary>()
      const executor: PlanScheduler.Executor = {
        execute: ({ boundary, node }) =>
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            if (node.id.startsWith("reader-")) seen.set(node.id, boundary)
            if (node.id === "move-world") {
              // The scheduler has already observed the run's source world. Move
              // one member and add another between the two reader dispatches.
              yield* write(join(root, "src/lib.ts"), "library-after-start")
              yield* write(join(root, "src/arrival.ts"), "arrived-mid-run")
            }
            const output = FileSet.expand(node.effects.writes)[0]!
            if (typeof output !== "string") return yield* Effect.die(new Error("test expects an exact output"))
            yield* fs.makeDirectory(join(output, ".."), { recursive: true })
            yield* fs.writeFileString(output, node.id === "writer" ? "generated-after-producer" : node.id)
            return node.id
          }) as unknown as Effect.Effect<unknown, unknown>
      }
      const report = yield* withCrypto(
        Effect.gen(function*() {
          yield* write(join(root, "src/lib.ts"), "library-at-start")
          yield* activate("prod-mixed-glob")
          return yield* Effect.provide(
            PlanScheduler.make({ runId: "prod-mixed-glob", owner, sourceId: "glob/mixed" }).run(plan),
            Layer.merge(boundaryOnly(root), PlanScheduler.layerExecutor(executor))
          )
        }).pipe(Effect.provide(TestStores.layer()))
      )

      expect(outcomes(report)).toEqual({
        writer: "built",
        "reader-first": "built",
        "move-world": "built",
        "reader-second": "built"
      })
      const first = StepBoundary.exactReads(seen.get("reader-first")!)
      const second = StepBoundary.exactReads(seen.get("reader-second")!)
      const digestAt = (entries: ReadonlyArray<{ readonly path: string; readonly digest: string }>, path: string) =>
        entries.find((entry) => entry.path === path)?.digest

      // Both readers key the source member to the run-start bytes, even though
      // the host moved between their dispatches.
      expect(digestAt(first, "src/lib.ts")).toBe(sha256("library-at-start"))
      expect(digestAt(second, "src/lib.ts")).toBe(sha256("library-at-start"))
      // The exact producer path is discovered after its writer settles.
      expect(digestAt(first, "src/gen.ts")).toBe(sha256("generated-after-producer"))
      expect(digestAt(second, "src/gen.ts")).toBe(sha256("generated-after-producer"))
      // An unproduced arrival was not part of the run-start expansion and never
      // enters a later boundary.
      expect(second.some((entry) => entry.path === "src/arrival.ts")).toBe(false)
    }))

  it.effect("pins exact and glob inputs before a declared future writer or remover", () =>
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "flows-plan-future-writer-"))
      const plan = yield* withCrypto(Plan.compile({
        planId: "future-writer-plan",
        flow: "example/FutureWriter",
        nodes: [
          draft("move-world"),
          draft("reader", {
            reads: ["src/config.ts", { _tag: "Glob", include: ["src/**"] }],
            inputs: [{ _tag: "Pending", from: "move-world" }]
          }),
          draft("future-writer", {
            writes: ["src/config.ts", { _tag: "TreeArtifact", path: "src/generated" }],
            removes: ["src/obsolete.ts"],
            inputs: [{ _tag: "Ref", from: "reader", path: [] }]
          })
        ]
      }))
      let observed: FileBoundary | undefined
      const executor: PlanScheduler.Executor = {
        execute: ({ boundary, node }) =>
          Effect.gen(function*() {
            if (node.id === "move-world") {
              yield* write(join(root, "src/config.ts"), "changed-after-start")
              yield* write(join(root, "src/generated/arrival.ts"), "arrived-after-start")
            }
            if (node.id === "reader") observed = boundary
            if (node.id === "future-writer") {
              yield* write(join(root, "src/config.ts"), "produced-later")
              const fs = yield* FileSystem.FileSystem
              yield* fs.remove("src/obsolete.ts")
            } else {
              yield* write(join(root, `out/${node.id}.txt`), node.id)
            }
            return node.id
          }) as unknown as Effect.Effect<unknown, unknown>
      }
      const report = yield* withCrypto(
        Effect.gen(function*() {
          yield* write(join(root, "src/config.ts"), "initial-config")
          yield* write(join(root, "src/obsolete.ts"), "initial-obsolete")
          yield* activate("prod-future-writer")
          return yield* Effect.provide(
            PlanScheduler.make({ runId: "prod-future-writer", owner, sourceId: "versions/future" }).run(plan),
            Layer.merge(boundaryOnly(root), PlanScheduler.layerExecutor(executor))
          )
        }).pipe(Effect.provide(TestStores.layer()))
      )
      expect(outcomes(report)).toEqual({ "move-world": "built", reader: "built", "future-writer": "built" })
      expect(StepBoundary.exactReads(observed!)).toEqual([
        { path: "src/config.ts", digest: sha256("initial-config") },
        { path: "src/obsolete.ts", digest: sha256("initial-obsolete") }
      ])
    }))

  it.effect("executes a read-write-read-write-read sequence against each intended file version", () =>
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "flows-plan-file-versions-"))
      const plan = yield* withCrypto(Plan.compile({
        planId: "file-versions-plan",
        flow: "example/FileVersions",
        nodes: [
          draft("before", { reads: ["src/config.ts"] }),
          draft("first", { writes: ["src/config.ts"], inputs: [{ _tag: "Pending", from: "before" }] }),
          draft("between", {
            reads: [{ _tag: "Glob", include: ["src/**"] }],
            inputs: [{ _tag: "Pending", from: "first" }]
          }),
          draft("last", { writes: ["src/config.ts"], inputs: [{ _tag: "Pending", from: "between" }] }),
          draft("after", { reads: ["src/config.ts"], inputs: [{ _tag: "Pending", from: "last" }] })
        ]
      }))
      const seen = new Map<string, string>()
      const executor: PlanScheduler.Executor = {
        execute: ({ node }) =>
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            if (node.id === "first" || node.id === "last") {
              yield* fs.writeFileString("src/config.ts", node.id)
            } else {
              const value = yield* fs.readFileString("src/config.ts")
              seen.set(node.id, value)
              yield* fs.makeDirectory("out", { recursive: true })
              yield* fs.writeFileString(`out/${node.id}.txt`, value)
            }
            return node.id
          }) as unknown as Effect.Effect<unknown, unknown>
      }
      const report = yield* withCrypto(
        Effect.gen(function*() {
          yield* write(join(root, "src/config.ts"), "initial")
          yield* activate("prod-file-versions")
          return yield* Effect.provide(
            PlanScheduler.make({ runId: "prod-file-versions", owner, sourceId: "versions/sequence" }).run(plan),
            Layer.merge(production(root), PlanScheduler.layerExecutor(executor))
          )
        }).pipe(Effect.provide(TestStores.layer()))
      )
      expect(outcomes(report)).toEqual({
        before: "built",
        first: "built",
        between: "built",
        last: "built",
        after: "built"
      })
      expect(Object.fromEntries(seen)).toEqual({ before: "initial", between: "first", after: "last" })
    }))

  it.effect("replays a self-updating source after independently reopening the database", () =>
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "flows-plan-source-reopen-"))
      mkdirSync(join(root, ".flows"))
      const database = join(root, ".flows/state.sqlite")
      const plan = yield* withCrypto(Plan.compile({
        planId: "source-reopen-plan",
        flow: "example/SourceReopen",
        nodes: [draft("update", {
          reads: ["config.txt", { _tag: "Glob", include: ["*.txt"] }],
          writes: ["config.txt"]
        })]
      }))
      let bodies = 0
      const executor: PlanScheduler.Executor = {
        execute: () =>
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const input = yield* fs.readFileString("config.txt")
            yield* fs.writeFileString("config.txt", `${input}!`)
            bodies++
            return input
          }) as unknown as Effect.Effect<unknown, unknown>
      }
      const drive = () =>
        PlanScheduler.make({ runId: "source-reopen", owner, sourceId: "source/reopen" }).run(plan).pipe(
          Effect.provide(Layer.merge(production(root), PlanScheduler.layerExecutor(executor)))
        )
      yield* write(join(root, "config.txt"), "initial")
      yield* write(join(root, "context.txt"), "initial-context")
      const first = yield* withCrypto(
        activate("source-reopen").pipe(
          Effect.andThen(drive()),
          Effect.provide(TestStores.layerAt(database))
        )
      )
      yield* write(join(root, "context.txt"), "changed-context")
      yield* write(join(root, "arrival.txt"), "arrived-after-observation")
      const replay = yield* withCrypto(drive().pipe(Effect.provide(TestStores.layerAt(database))))
      expect(outcomes(first)).toEqual({ update: "built" })
      expect(outcomes(replay)).toEqual({ update: "clean" })
      expect(replay.settlements[0]!.dispatchKey).toBe(first.settlements[0]!.dispatchKey)
      expect(replay.results).toEqual(first.results)
      expect(bodies).toBe(1)
      expect(yield* read(join(root, "config.txt"))).toBe("initial!")
      const next = yield* withCrypto(
        activate("source-new-run").pipe(
          Effect.andThen(
            PlanScheduler.make({ runId: "source-new-run", owner, sourceId: "source/new" }).run(plan).pipe(
              Effect.provide(Layer.merge(production(root), PlanScheduler.layerExecutor(executor)))
            )
          ),
          Effect.provide(TestStores.layerAt(database))
        )
      )
      expect(outcomes(next)).toEqual({ update: "built" })
      expect(bodies).toBe(2)
      expect(yield* read(join(root, "config.txt"))).toBe("initial!!")
    }))

  it.effect("refuses an environment change on reopen before repeating a completed file update", () =>
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "flows-plan-environment-reopen-"))
      mkdirSync(join(root, ".flows"))
      const database = join(root, ".flows/state.sqlite")
      const plan = yield* withCrypto(Plan.compile({
        planId: "environment-plan",
        flow: "test/EnvironmentRecovery",
        nodes: [{
          id: "update",
          material: {
            version: KeyMaterial.version,
            kind: "sealed",
            body: { action: "update" },
            inputs: [],
            layers: [],
            capabilities: []
          },
          effects: { reads: ["config.txt"], writes: ["config.txt"], boundaryMode: "hard" }
        }]
      }))
      let bodies = 0
      const executor: PlanScheduler.Executor = {
        execute: () =>
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const before = yield* fs.readFileString("config.txt")
            yield* fs.writeFileString("config.txt", `${before}!`)
            bodies++
            return before
          }) as unknown as Effect.Effect<unknown, unknown>
      }
      const drive = (version: string) =>
        PlanScheduler.make({
          runId: "environment-reopen",
          owner,
          sourceId: "environment/reopen",
          environment: { declared: true, layers: [version], capabilities: {} }
        }).run(plan).pipe(Effect.provide(Layer.merge(production(root), PlanScheduler.layerExecutor(executor))))
      yield* write(join(root, "config.txt"), "initial")
      yield* withCrypto(
        activate("environment-reopen").pipe(
          Effect.andThen(drive("runtime-v1")),
          Effect.provide(TestStores.layerAt(database))
        )
      )
      const failure = yield* withCrypto(
        Effect.flip(drive("runtime-v2")).pipe(Effect.provide(TestStores.layerAt(database)))
      )
      expect(failure).toMatchObject({ code: "store_failed", cause: { code: "incompatible_state" } })
      expect(bodies).toBe(1)
      expect(yield* read(join(root, "config.txt"))).toBe("initial!")
      const replay = yield* withCrypto(drive("runtime-v1").pipe(Effect.provide(TestStores.layerAt(database))))
      expect(outcomes(replay)).toEqual({ update: "clean" })
      expect(bodies).toBe(1)
    }))

  it.effect("recovers prior pins and appended-generation glob membership across independent database openings", () =>
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "flows-plan-generation-reopen-"))
      mkdirSync(join(root, ".flows"))
      const database = join(root, ".flows/state.sqlite")
      const base = yield* withCrypto(Plan.compile({
        planId: "generation-reopen-plan",
        flow: "example/GenerationReopen",
        nodes: [draft("base", { reads: ["src/original.txt"] })]
      }))
      const grown = yield* withCrypto(Plan.append(base, [draft("next", {
        reads: [{ _tag: "Glob", include: ["extra/*.txt"] }],
        inputs: [{ _tag: "Pending", from: "base" }]
      })]))
      const ran: Array<string> = []
      const drive = (plan: Plan.Plan) =>
        PlanScheduler.make({
          runId: "generation-reopen",
          owner,
          sourceId: "generation/reopen"
        }).run(plan).pipe(Effect.provide(Layer.merge(production(root), PlanScheduler.layerExecutor(renderer(ran)))))
      yield* write(join(root, "src/original.txt"), "original")
      yield* withCrypto(
        activate("generation-reopen").pipe(
          Effect.andThen(drive(base)),
          Effect.provide(TestStores.layerAt(database))
        )
      )
      yield* write(join(root, "extra/one.txt"), "seen-on-growth")
      const elaborated = yield* withCrypto(drive(grown).pipe(Effect.provide(TestStores.layerAt(database))))
      expect(outcomes(elaborated)).toEqual({ base: "clean", next: "built" })
      yield* write(join(root, "src/original.txt"), "changed-original")
      yield* write(join(root, "extra/one.txt"), "changed-extra")
      yield* write(join(root, "extra/arrival.txt"), "new-member")
      const replay = yield* withCrypto(drive(grown).pipe(Effect.provide(TestStores.layerAt(database))))
      expect(outcomes(replay)).toEqual({ base: "clean", next: "clean" })
      expect(replay.settlements.map((node) => node.dispatchKey)).toEqual(
        elaborated.settlements.map((node) => node.dispatchKey)
      )
      expect(ran).toEqual(["base", "next"])
      expect(yield* read(join(root, "out/next.txt"))).toBe("next(seen-on-growth)")
    }))

  it.effect("enumerates producer candidates only inside exact, glob, and tree writer scopes", () =>
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "flows-plan-writer-scopes-"))
      const plan = yield* withCrypto(Plan.compile({
        planId: "writer-scope-plan",
        flow: "example/WriterScopes",
        nodes: [
          draft("scoped-writer", {
            writes: [
              "src/exact.ts",
              { _tag: "Glob", include: ["src/generated/**"] },
              { _tag: "TreeArtifact", path: "src/tree" }
            ],
            removes: ["src/removed.ts"]
          }),
          draft("scoped-reader", { reads: [{ _tag: "Glob", include: ["src/**"] }] })
        ]
      }))
      let boundary: FileBoundary | undefined
      const executor: PlanScheduler.Executor = {
        execute: ({ boundary: measured, node }) =>
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const put = (path: string, content: string) =>
              fs.makeDirectory(join(path, ".."), { recursive: true }).pipe(
                Effect.andThen(fs.writeFileString(path, content))
              )
            if (node.id === "scoped-writer") {
              yield* put("src/exact.ts", "exact")
              yield* put("src/generated/nested.ts", "glob")
              yield* put("src/tree/member.ts", "tree")
              yield* fs.remove("src/removed.ts")
            } else {
              boundary = measured
              yield* put("out/scoped-reader.txt", "reader")
            }
            return node.id
          }) as unknown as Effect.Effect<unknown, unknown>
      }
      yield* withCrypto(
        Effect.gen(function*() {
          yield* write(join(root, "src/source.ts"), "source")
          yield* write(join(root, "src/removed.ts"), "remove-me")
          yield* activate("prod-writer-scopes")
          return yield* Effect.provide(
            PlanScheduler.make({ runId: "prod-writer-scopes", owner, sourceId: "glob/scopes" }).run(plan),
            Layer.merge(boundaryOnly(root), PlanScheduler.layerExecutor(executor))
          )
        }).pipe(Effect.provide(TestStores.layer()))
      )

      expect(StepBoundary.exactReads(boundary!).map((entry) => entry.path)).toEqual([
        "src/exact.ts",
        "src/generated/nested.ts",
        "src/source.ts",
        "src/tree/member.ts"
      ])
    }))

  it.effect("pins a newly observed appended-generation source at append time exactly once", () =>
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "flows-plan-append-pin-"))
      const sourceGlob: FileSet.Glob = { _tag: "Glob", include: ["src/**"] }
      const plan = yield* withCrypto(Plan.compile({
        planId: "append-pin-plan",
        flow: "example/AppendPin",
        nodes: [
          draft("lane-a", {
            writes: ["shared.out"],
            conflictStrategy: "lane",
            runtimeStrategy: "stop-merge"
          }),
          draft("lane-b", {
            reads: [sourceGlob],
            writes: ["shared.out"],
            conflictStrategy: "lane",
            runtimeStrategy: "stop-merge"
          }),
          draft("move-after-append", { inputs: [{ _tag: "Pending", from: "lane-a" }] })
        ]
      }))
      let mergeBoundary: FileBoundary | undefined
      const executor: PlanScheduler.Executor = {
        execute: ({ boundary, node }) =>
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            if (node.id === "lane-b") {
              // This path did not exist in generation zero's expansion. The
              // appended merge generation observes and pins these bytes.
              yield* write(join(root, "src/late.ts"), "seen-at-append")
              return yield* Effect.fail(
                new WorkspaceSandbox.MaterializationConflict({
                  paths: ["shared.out"],
                  message: "force stop-merge elaboration"
                })
              )
            }
            if (node.id === "move-after-append") {
              // This node wins the next capped admission pass after append. If
              // the merge re-observed its source at dispatch, it would see these
              // bytes.
              yield* write(join(root, "src/late.ts"), "changed-after-append")
            }
            if (node.kind === "merge") mergeBoundary = boundary
            const output = FileSet.expand(node.effects.writes)[0]!
            if (typeof output !== "string") return yield* Effect.die(new Error("test expects an exact output"))
            yield* fs.makeDirectory(join(output, ".."), { recursive: true })
            yield* fs.writeFileString(output, node.id)
            return node.id
          }) as unknown as Effect.Effect<unknown, unknown>
      }
      const report = yield* withCrypto(
        Effect.gen(function*() {
          yield* write(join(root, "src/base.ts"), "base-at-start")
          yield* activate("prod-append-pin")
          const service = PlanScheduler.make({
            runId: "prod-append-pin",
            owner,
            sourceId: "glob/append",
            concurrency: { steps: 1 }
          })
          yield* service.record(plan)
          return yield* Effect.provide(
            service.run(plan),
            Layer.merge(boundaryOnly(root), PlanScheduler.layerExecutor(executor))
          )
        }).pipe(Effect.provide(TestStores.layer()))
      )

      expect(report.appended).toEqual(["lane-b+merge"])
      expect(outcomes(report)).toEqual({
        "lane-a": "built",
        "lane-b": "skipped",
        "move-after-append": "built",
        "lane-b+merge": "built"
      })
      const mergeReads = StepBoundary.exactReads(mergeBoundary!)
      expect(mergeReads.find((entry) => entry.path === "src/base.ts")?.digest).toBe(sha256("base-at-start"))
      expect(mergeReads.find((entry) => entry.path === "src/late.ts")?.digest).toBe(sha256("seen-at-append"))
      expect(yield* withCrypto(read(join(root, "src/late.ts")))).toBe("changed-after-append")
    }))

  it.effect("admits only the read glob's own members from an overlapping writer glob's scope", () =>
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "flows-plan-writer-scope-"))
      const plan = yield* withCrypto(Plan.compile({
        planId: "writer-scope-plan",
        flow: "example/WriterScope",
        nodes: [
          draft("generator", { writes: [{ _tag: "Glob", include: ["gen/**"] }] }),
          draft("reader", { reads: [{ _tag: "Glob", include: ["gen/*.ts"] }] })
        ]
      }))
      let readerBoundary: FileBoundary | undefined
      const executor: PlanScheduler.Executor = {
        execute: ({ boundary, node }) =>
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            if (node.id === "generator") {
              yield* fs.makeDirectory("gen", { recursive: true })
              yield* fs.writeFileString("gen/typed.ts", "typed-member")
              yield* fs.writeFileString("gen/blob.bin", "binary-member")
              return node.id
            }
            readerBoundary = boundary
            yield* fs.makeDirectory("out", { recursive: true })
            yield* fs.writeFileString("out/reader.txt", node.id)
            return node.id
          }) as unknown as Effect.Effect<unknown, unknown>
      }
      const report = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("prod-writer-scope")
          return yield* Effect.provide(
            PlanScheduler.make({ runId: "prod-writer-scope", owner, sourceId: "glob/writer-scope" }).run(plan),
            Layer.merge(boundaryOnly(root), PlanScheduler.layerExecutor(executor))
          )
        }).pipe(Effect.provide(TestStores.layer()))
      )
      expect(outcomes(report)).toEqual({ generator: "built", reader: "built" })
      const reads = StepBoundary.exactReads(readerBoundary!)
      // The writer glob's scope holds both files; only the one the READ glob
      // matches is a member of the reader's boundary.
      expect(reads.find((entry) => entry.path === "gen/typed.ts")?.digest).toBe(sha256("typed-member"))
      expect(reads.some((entry) => entry.path === "gen/blob.bin")).toBe(false)
    }))

  it.effect("skips an exact producer path that stats as a directory at dispatch", () =>
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "flows-plan-dir-producer-"))
      const plan = yield* withCrypto(Plan.compile({
        planId: "dir-producer-plan",
        flow: "example/DirProducer",
        nodes: [
          draft("producer", { writes: ["gen/artifact"] }),
          draft("mutator", { inputs: [{ _tag: "Pending", from: "producer" }] }),
          draft("reader", {
            inputs: [{ _tag: "Pending", from: "mutator" }],
            reads: [{ _tag: "Glob", include: ["gen/*"] }]
          })
        ]
      }))
      let readerBoundary: FileBoundary | undefined
      const executor: PlanScheduler.Executor = {
        execute: ({ boundary, node }) =>
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            if (node.id === "reader") readerBoundary = boundary
            if (node.id === "mutator") {
              // Replace the produced file with a directory before the reader
              // measures: a directory is not a measurable file input, so the
              // reader's boundary must skip the path rather than fail on it.
              yield* fs.remove("gen/artifact")
              yield* fs.makeDirectory("gen/artifact", { recursive: true })
            }
            const output = FileSet.expand(node.effects.writes)[0]!
            if (typeof output !== "string") return yield* Effect.die(new Error("test expects an exact output"))
            yield* fs.makeDirectory(join(output, ".."), { recursive: true })
            yield* fs.writeFileString(output, node.id)
            return node.id
          }) as unknown as Effect.Effect<unknown, unknown>
      }
      const report = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("prod-dir-producer")
          return yield* Effect.provide(
            PlanScheduler.make({ runId: "prod-dir-producer", owner, sourceId: "glob/dir-producer" }).run(plan),
            Layer.merge(boundaryOnly(root), PlanScheduler.layerExecutor(executor))
          )
        }).pipe(Effect.provide(TestStores.layer()))
      )
      expect(outcomes(report)).toEqual({ producer: "built", mutator: "built", reader: "built" })
      const reads = StepBoundary.exactReads(readerBoundary!)
      expect(reads.some((entry) => entry.path === "gen/artifact")).toBe(false)
    }))
})
