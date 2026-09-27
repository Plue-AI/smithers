// Real process/SQLite/filesystem frontier; Jj and the losing conflict are
// controlled protocol seams, not a native-Jj merge correctness test.
import * as NodePath from "@effect/platform-node/NodePath"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { Jj } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { PlanStore } from "@smthrs/plan-store"
import { KeyMaterial, Plan, StepKey } from "@smthrs/plan"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { RunStore } from "@smthrs/run-store"
import { Clock, Effect, Fiber, FileSystem, Layer, Option } from "effect"
import { join } from "node:path"
import * as PlanMergeStore from "../../src/PlanMergeStore.ts"
import * as PlanScheduler from "../../src/PlanScheduler.ts"
import * as StepBoundary from "../../src/StepBoundary.ts"
import * as StepSandbox from "../../src/StepSandbox.ts"
import * as TestStores from "../../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../../src/WorkspaceSandbox.ts"

const [root, mode, frontier] = process.argv.slice(2)
if (!root || !["crash", "resume"].includes(mode) || !["intent", "completion"].includes(frontier)) {
  throw new Error("Expected temporary workspace, crash/resume, and intent/completion")
}
if (mode === "crash") process.stdin.resume()
const liveClock = await Effect.runPromise(Clock.clockWith(Effect.succeed))
// Age durable stamps without changing real monotonic scheduling. The next
// process still proves this exact PID dead before acquiring ownership.
const clock = mode === "crash" ? {
  currentTimeMillisUnsafe: () => 1, currentTimeMillis: Effect.succeed(1),
  currentTimeNanosUnsafe: () => 1_000_000n, currentTimeNanos: Effect.succeed(1_000_000n),
  monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: liveClock.monotonicTimeNanos, sleep: (duration) => liveClock.sleep(duration)
} : liveClock
const owner = { hostId: "plan-merge-frontier", pid: process.pid, nonce: `process-${process.pid}` }
const workspaceFs = KernelFileSystem.layer.pipe(
  Layer.provide(AtomicFileSystem.layer), Layer.provideMerge(NodePath.layer),
  Layer.provide(Workspace.layer(root)), Layer.provide(GrantStore.layerNoop)
)
const artifacts = ArtifactStore.layerFileSystem({ directory: join(root, ".flows/objects"), durability: "best-effort" })
  .pipe(Layer.provideMerge(workspaceFs))
const host = Layer.mergeAll(
  StepBoundary.layer.pipe(Layer.provide(artifacts)),
  StepSandbox.layer.pipe(Layer.provide(artifacts), Layer.provide(Workspace.layer(root))),
  Layer.succeed(Jj.Jj, Jj.make({
    snapshot: () => Effect.succeed({ changeId: "test" }), restore: () => Effect.void,
    diff: () => Effect.succeed(""), workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void, status: () => Effect.succeed("")
  }))
).pipe(Layer.provideMerge(artifacts))
const calls = []
const executor = PlanScheduler.layerExecutor({ execute: ({ node }) => Effect.gen(function*() {
  calls.push(node.id)
  if (node.id === "b") return yield* Effect.fail(new WorkspaceSandbox.MaterializationConflict({
    paths: ["shared.txt"], message: "controlled competing landing"
  }))
  if (mode === "crash") {
    if (frontier === "intent" && node.id === "a") return yield* Effect.never
    if (frontier === "completion" && node.kind === "merge") {
      process.stdout.write("ready-to-kill\n")
      return yield* Effect.never
    }
  }
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString("shared.txt", node.kind === "merge" ? "merged" : "winner")
  return node.id
}) })
const report = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const runId = "merge-frontier-run"
  const runs = yield* RunStore.RunStore
  if (mode === "crash") yield* runs.create(runId, "{}")
  const row = yield* runs.get(runId)
  const now = yield* Clock.currentTimeMillis
  if (row.owner) {
    let dead = false
    try { process.kill(row.owner.pid, 0) } catch (error) { dead = error.code === "ESRCH" }
    if (!dead) throw new Error("Previous owner is not dead")
  }
  const claim = yield* runs.claimAndOwn(runId, {
    status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs
  }, owner, now, row.owner ? { expectedOwner: row.owner, checkedAtMs: now, kind: "same-host-pid-dead" } : undefined)
  if (claim._tag !== "Activated") throw new Error(`Ownership not acquired: ${claim._tag}`)
  const base = yield* Plan.compile({ planId: "merge-frontier-plan", flow: "test/MergeFrontier", nodes: ["a", "b"].map((id) => ({
    id, material: { version: KeyMaterial.version, kind: "sealed", body: id, inputs: [], layers: [], capabilities: [] },
    effects: { reads: [], writes: ["shared.txt"], boundaryMode: "hard" },
    conflictStrategy: "lane", runtimeStrategy: "stop-merge"
  })) })
  const scheduler = PlanScheduler.make({ runId, owner, sourceId: "merge-frontier" })
  if (mode === "crash") yield* scheduler.record(base)
  const merges = yield* PlanMergeStore.PlanMergeStore
  const identity = { runId, planId: base.planId, baseDigest: base.baseDigest, environmentDigest: yield* StepKey.environmentIdentity() }
  if (mode === "crash" && frontier === "intent") {
    const fiber = yield* scheduler.run(base).pipe(Effect.forkScoped({ startImmediately: true }))
    while ((yield* merges.list(identity, owner)).length === 0) yield* Effect.yieldNow
    process.stdout.write("ready-to-kill\n")
    return yield* Fiber.join(fiber)
  }
  // Exercise loaded-grown recovery at completion, original-base recovery at
  // intent. Both start with new store/service instances in a new process.
  const plans = yield* PlanStore.PlanStore
  const candidate = mode === "resume" && frontier === "completion" ? Option.getOrThrow(yield* plans.get(base.planId)) : base
  const result = yield* scheduler.run(candidate)
  const decisions = yield* merges.list(identity, owner)
  if (decisions.length !== 1 || decisions[0].completion?.generation !== 1) throw new Error("Incorrect merge decision count")
  return result
})).pipe(
  Effect.provide(Layer.merge(host, executor)), Effect.provide(TestStores.layerAt(join(root, ".flows/state.sqlite"))),
  Effect.provide(NodeCrypto.layer), Effect.provideService(Clock.Clock, clock)
))
process.stdout.write(JSON.stringify({ calls, appended: report.appended, settlements: report.settlements, results: report.results }) + "\n")
