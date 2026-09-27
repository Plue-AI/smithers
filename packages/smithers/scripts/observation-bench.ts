/**
 * Times the workspace measurement under the CLI's own compositions.
 *
 * Three numbers on one tree:
 *
 * - `guarded` — the observer over `NodeControl.layerGuardedPlatform`, which is
 *   what `1a5d6214c` shipped. Every `stat` is one authorized host call, and on
 *   Node that is one descriptor-relative helper process per path. Sample it
 *   with a small `maxPaths` rather than waiting out a whole checkout.
 * - `host` — the observer over `NodeControl.layerHostPlatform`, which is what
 *   the executor composes today. Taken twice, because a frame takes the
 *   measurement twice.
 * - `boundary` — one `workspace-close`, the way `CellTurn` takes it at the end
 *   of every frame: the same measurement through `FlowEngineLike.record`. The
 *   flow engine underneath is the in-memory one, so the number is the
 *   measurement plus the port's own boundary work, without SQLite.
 *
 * Usage: `bun packages/smithers/scripts/observation-bench.ts [root] [maxPaths] [which]`
 * where `which` is `both` (default), `guarded`, `host`, or `batch`.
 * `batch` creates and cleans an independent fixture of `maxPaths` files.
 * Numbers are local measurements, not a production speed claim. Wrap a batch
 * run with `/usr/bin/time -l` to include helper CPU and OS peak memory.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Budget from "@smthrs/agent/Budget"
import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as WorkspaceObservation from "@smthrs/agent/WorkspaceObservation"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { Engine, Flow, FlowRuntime, Plan } from "@smthrs/flows"
import * as EngineLike from "@smthrs/harness/EngineLike"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { Effect, FileSystem, Layer, Path, Schema, Scope, Stream } from "effect"
import { createHash } from "node:crypto"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as NodeControl from "../src/NodeControl.ts"

const root = resolve(process.argv[2] ?? "evals/swebench/work/django__django-16612")
const maxPaths = Number(process.argv[3] ?? 50_000)
const which = process.argv[4] ?? "both"

const report = (label: string, elapsed: number, paths: number, complete: boolean): void =>
  console.log(
    `${label}: ${elapsed.toFixed(1)} ms for ${paths} paths (${
      (elapsed / Math.max(paths, 1)).toFixed(3)
    } ms/path, complete=${complete})`
  )

const walk = (label: string, platform: Layer.Layer<FileSystem.FileSystem>) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const started = performance.now()
    const observation = yield* WorkspaceObservation.observe(fileSystem, root, { maxPaths })
    report(label, performance.now() - started, observation.paths, observation.complete)
  }).pipe(Effect.provide(platform), Effect.scoped)

/** The port requires a model and a route to exist; a `workspace-close` calls neither. */
const inertModel: Model.Model = Model.make({ stream: () => Stream.empty })
const inertRoute: FlowEngineLike.RouteResolver = {
  prepare: () => Effect.fail(new ModelError({ code: "invalid_request", message: "the bench calls no model" }))
}

const benchFlow = Flow.make("cli/observation-bench", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Plan.Node.succeed(undefined)
})

const boundary = Effect.gen(function*() {
  const engine = yield* FlowRuntime.FlowRuntime
  const scope = yield* Effect.scope
  yield* engine.register(benchFlow, () =>
    Effect.gen(function*() {
      const port = yield* FlowEngineLike.make({ model: inertModel, route: inertRoute })
      const started = performance.now()
      const observed = yield* port.record({
        name: "workspace-close",
        identity: { session: "observation-bench", frame: 0, boundary: "bench" },
        success: Schema.Option(EngineLike.Observation),
        execute: port.observe
      })
      const elapsed = performance.now() - started
      report(
        "boundary   ",
        elapsed,
        observed._tag === "Some" ? observed.value.paths : 0,
        observed._tag === "Some" ? observed.value.complete : false
      )
    })).pipe(Scope.provide(scope))
  yield* engine.execute(benchFlow, { executionId: "observation-bench-1", payload: {} })
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      Engine.FlowEngine.layerMemory,
      NodeCrypto.layer,
      QuotaPolicy.layerDefault(),
      Budget.layerUnbounded(),
      WorkspaceObservation.layer(root, { maxPaths }).pipe(Layer.provide(NodeControl.layerHostPlatform))
    )
  ),
  Effect.scoped
)

const batchedBoundary = Effect.gen(function*() {
  if (!Number.isSafeInteger(maxPaths) || maxPaths <= 0 || maxPaths > 100_000) {
    throw new Error("batch fixture size must be 1 to 100000")
  }
  const directory = yield* Effect.acquireRelease(
    Effect.promise(async () => realpath(await mkdtemp(join(tmpdir(), "smithers-observation-batch-")))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
  )
  const content = "filesystem-batching\n".repeat(4)
  const digest = createHash("sha256").update(content).digest("hex")
  const paths = Array.from({ length: maxPaths }, (_, index) => `${String(index).padStart(6, "0")}.txt`)
  yield* Effect.forEach(paths, (path) => Effect.promise(() => writeFile(join(directory, path), content)), {
    concurrency: 4,
    discard: true
  })
  const host = KernelFileSystem.layer.pipe(
    Layer.provide(AtomicFileSystem.layer),
    Layer.provideMerge(NodePath.layer),
    Layer.provide(Workspace.layer(directory)),
    Layer.provide(GrantStore.layerNoop)
  )
  yield* Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const batch = KernelFileSystem.batch(fs)!
    let operations = 0
    let bytes = 0
    const measuredFs = Object.assign({ ...fs }, {
      [KernelFileSystem.FileSystemBatchTypeId]: {
        ...batch,
        execute: (requests: ReadonlyArray<KernelFileSystem.BatchRequest>) => {
          operations += requests.length
          bytes += requests.filter((request) => request.operation === "digest").length * Buffer.byteLength(content)
          return batch.execute(requests)
        }
      }
    })
    const service = StepBoundary.makeFileSystem(measuredFs, yield* Path.Path, ArtifactStore.makeMemory())
    const started = performance.now()
    const cpu = process.cpuUsage()
    const spawns = AtomicFileSystem.helperSpawns()
    const prepared = yield* service.prepare({
      readSet: [{ _tag: "Glob", include: ["**/*.txt"] }],
      writeSet: [{ _tag: "Glob", include: ["**/*.txt"] }],
      boundaryMode: "hard"
    })
    const settled = yield* service.settle(prepared)
    if (
      prepared.readSnapshot.length !== maxPaths ||
      prepared.readSnapshot.some((entry, index) => entry.path !== paths[index] || entry.digest !== digest)
    ) {
      throw new Error("benchmark read-set mismatch")
    }
    const outputs =
      (settled.declaredOutputs as { outputs: Array<{ path: string; digest: string; content: string }> }).outputs
    if (
      outputs.length !== maxPaths ||
      outputs.some((entry, index) =>
        entry.path !== paths[index] || entry.digest !== digest ||
        entry.content !== Buffer.from(content).toString("base64")
      )
    ) {
      throw new Error("benchmark output mismatch")
    }
    const helpers = AtomicFileSystem.helperSpawns() - spawns
    const expectedHelpers = 2 + 5 * Math.ceil(maxPaths / batch.maxSize)
    if (helpers !== expectedHelpers) throw new Error(`expected ${expectedHelpers} helper batches, received ${helpers}`)
    const used = process.cpuUsage(cpu)
    console.log(JSON.stringify({
      measurement: "local, warm fixture, one repetition, no warmup",
      node: process.version,
      paths: maxPaths,
      helpers,
      operations,
      contentBytesRead: bytes,
      parentCpuMicros: used.user + used.system,
      parentPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      elapsedMs: performance.now() - started,
      diffIdentity: settled.diffIdentity,
      verified: true
    }))
  }).pipe(Effect.provide(host), Effect.provide(NodeCrypto.layer))
}).pipe(Effect.scoped)

await Effect.runPromise(
  Effect.gen(function*() {
    if (which === "batch") return yield* batchedBoundary
    if (which !== "host") yield* walk("guarded    ", NodeControl.layerGuardedPlatform(root))
    if (which !== "guarded") {
      yield* walk("host (open) ", NodeControl.layerHostPlatform)
      yield* walk("host (close)", NodeControl.layerHostPlatform)
      yield* boundary
    }
  })
)
