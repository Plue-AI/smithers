// Real process/database/filesystem recovery; Jj itself is a protocol stub.
import * as NodePath from "@effect/platform-node/NodePath"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { Jj } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { KeyMaterial, Plan } from "@smthrs/plan"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { RunStore } from "@smthrs/run-store"
import { Cause, Clock, Effect, Exit, FileSystem, Layer } from "effect"
import { join } from "node:path"
import * as PlanScheduler from "../../src/PlanScheduler.ts"
import * as StepBoundary from "../../src/StepBoundary.ts"
import * as StepSandbox from "../../src/StepSandbox.ts"
import * as TestStores from "../../src/test/TestStores.ts"

const [root, mode] = process.argv.slice(2)
if (!root || !["crash", "resume"].includes(mode)) throw new Error("Expected temporary workspace and crash/resume mode")
if (mode === "crash") process.stdin.resume()
const liveClock = await Effect.runPromise(Clock.clockWith(Effect.succeed))
// All first-process lease/attempt stamps are deliberately aged. Monotonic
// scheduling stays real; takeover still checks that the killed PID is dead.
const fixtureClock = mode === "crash" ? {
  currentTimeMillisUnsafe: () => 1, currentTimeMillis: Effect.succeed(1),
  currentTimeNanosUnsafe: () => 1_000_000n, currentTimeNanos: Effect.succeed(1_000_000n),
  monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: liveClock.monotonicTimeNanos,
  sleep: (duration) => liveClock.sleep(duration)
} : liveClock
const owner = { hostId: "plan-input-process", pid: process.pid, nonce: `process-${process.pid}` }
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
    snapshot: () => Effect.succeed({ changeId: "test-snapshot" }), restore: () => Effect.void,
    diff: () => Effect.succeed(""), workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void, status: () => Effect.succeed("")
  }))
).pipe(Layer.provideMerge(artifacts))
let updates = 0
let changedEnvironmentRefused = false
const executor = PlanScheduler.layerExecutor({
  execute: ({ node }) => Effect.gen(function*() {
    if (node.id === "pause") {
      if (mode === "crash") {
        process.stdout.write("ready-to-kill\n")
        return yield* Effect.never
      }
      return "resumed"
    }
    const fs = yield* FileSystem.FileSystem
    const before = yield* fs.readFileString("config.txt")
    yield* fs.writeFileString("config.txt", `${before}!`)
    updates++
    return before
  })
})
const report = await Effect.runPromise(Effect.gen(function*() {
  const runs = yield* RunStore.RunStore
  if (mode === "crash") yield* runs.create("input-process-run", "{}")
  const row = yield* runs.get("input-process-run")
  const now = yield* Clock.currentTimeMillis
  if (row.owner) {
    let dead = false
    try { process.kill(row.owner.pid, 0) } catch (error) { dead = error.code === "ESRCH" }
    if (!dead) throw new Error("Previous process has not exited")
  }
  const claim = yield* runs.claimAndOwn("input-process-run", {
    status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs
  }, owner, now, row.owner ? {
    expectedOwner: row.owner, checkedAtMs: now, kind: "same-host-pid-dead"
  } : undefined)
  if (claim._tag !== "Activated") throw new Error(`Ownership was not acquired: ${claim._tag}`)
  const material = (id, inputs = []) => ({
    version: KeyMaterial.version, kind: "sealed", body: { action: id }, inputs, layers: [], capabilities: []
  })
  const plan = yield* Plan.compile({
    planId: "input-process-plan", flow: "example/InputProcess", nodes: [
      { id: "update", material: material("update"), effects: { reads: ["config.txt"], writes: ["config.txt"], boundaryMode: "hard" } },
      { id: "pause", material: material("pause", [{ _tag: "Pending", from: "update" }]), effects: { reads: [], writes: [], boundaryMode: "hard" } }
    ]
  })
  if (mode === "resume") {
    const changed = yield* PlanScheduler.make({
      runId: "input-process-run", owner, sourceId: "input-process",
      environment: { declared: true, layers: ["changed-runtime"], capabilities: {} }
    }).run(plan).pipe(Effect.exit)
    if (Exit.isSuccess(changed) || Cause.squash(changed.cause)?.cause?.code !== "incompatible_state") {
      throw new Error("Changed environment was not refused before recovery")
    }
    changedEnvironmentRefused = true
  }
  return yield* PlanScheduler.make({ runId: "input-process-run", owner, sourceId: "input-process" }).run(plan)
}).pipe(
  Effect.provide(Layer.merge(host, executor)),
  Effect.provide(TestStores.layerAt(join(root, ".flows/state.sqlite"))), Effect.provide(NodeCrypto.layer),
  Effect.provideService(Clock.Clock, fixtureClock)
))
process.stdout.write(JSON.stringify({ updates, changedEnvironmentRefused, settlements: report.settlements, results: report.results }) + "\n")
