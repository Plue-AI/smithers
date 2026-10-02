import { Effect, Fiber } from "effect"
import assert from "node:assert/strict"
import test from "node:test"
import { diskFloor, makeDiskGate, workspaceBytes } from "../disk.ts"

const cleanup = (events: string[]) => ({
  cleanGo: Effect.sync(() => {
    events.push("go")
  }),
  prunePnpm: Effect.sync(() => {
    events.push("pnpm")
  }),
  reapSettled: Effect.sync(() => {
    events.push("settled")
  })
})

test("healthy admission skips cleanup and reserves workspace footprint", async () => {
  const events: string[] = []
  await Effect.runPromise(
    makeDiskGate({ freeBytes: () => diskFloor + workspaceBytes, ...cleanup(events) })(workspaceBytes)
  )
  assert.deepEqual(events, [])
})

test("low disk cleans in order, rechecks, then waits without recleaning", async () => {
  const events: string[] = []
  let free = diskFloor + workspaceBytes - 1
  const gate = makeDiskGate({
    freeBytes: () => {
      events.push("probe")
      return free
    },
    ...cleanup(events),
    interval: "5 millis"
  })
  const fiber = Effect.runFork(gate(workspaceBytes))
  await Effect.runPromise(Effect.sleep("25 millis"))
  assert.deepEqual(events.slice(0, 5), ["probe", "go", "pnpm", "settled", "probe"])
  assert.equal(events.filter((e) => e === "settled").length, 1)
  free++
  await Effect.runPromise(Fiber.join(fiber))
})

test("cleanup failure still attempts later cleanup and accepts recovered space", async () => {
  const events: string[] = []
  let free = 0
  await Effect.runPromise(
    makeDiskGate({
      freeBytes: () => free,
      cleanGo: Effect.fail(new Error("go unavailable")),
      prunePnpm: Effect.sync(() => {
        events.push("pnpm")
      }),
      reapSettled: Effect.sync(() => {
        events.push("settled")
        free = diskFloor
      })
    })()
  )
  assert.deepEqual(events, ["pnpm", "settled"])
})

test("invalid disk evidence refuses admission", async () => {
  for (const value of [NaN, Infinity, -1]) {
    await assert.rejects(Effect.runPromise(makeDiskGate({ freeBytes: () => value })()), /disk probe/)
  }
})

test("waiting admission cancels without repeated cleanup", async () => {
  const events: string[] = []
  const fiber = Effect.runFork(makeDiskGate({ freeBytes: () => 0, ...cleanup(events), interval: "5 millis" })())
  await Effect.runPromise(Effect.sleep("20 millis"))
  await Effect.runPromise(Fiber.interrupt(fiber))
  assert.deepEqual(events, ["go", "pnpm", "settled"])
})

test("disk admission executes its typed cleanup action through the engine", async (t) => {
  const { FlowEngine } = await import("@smthrs/engine")
  const { Action } = await import("@smthrs/flow")
  const { Layer, ManagedRuntime } = await import("effect")
  const NodeCrypto = await import("@effect/platform-node/NodeCrypto")
  const NodeServices = await import("@effect/platform-node/NodeServices")
  const { DiskAdmission, makeDiskLayer } = await import("../disk.ts")
  const events: string[] = []
  let free = 0
  const gate = makeDiskGate({
    freeBytes: () => free,
    ...cleanup(events),
    reapSettled: Effect.sync(() => {
      events.push("settled")
      free = diskFloor + workspaceBytes
    })
  })
  const runtime = ManagedRuntime.make(
    makeDiskLayer(gate).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(NodeServices.layer)
    )
  )
  t.after(() => runtime.dispose())
  await runtime.runPromise(
    DiskAdmission.execute({ reserveBytes: workspaceBytes }, { executionId: "disk/new-workspace" })
  )
  assert.deepEqual(events, ["go", "pnpm", "settled"])
})

test("hanging cleanup is bounded and later cleanup still recovers disk", async () => {
  const events: string[] = []
  let free = 0
  await Effect.runPromise(
    makeDiskGate({
      freeBytes: () => free,
      cleanupTimeout: "5 millis",
      cleanGo: Effect.never,
      prunePnpm: Effect.sync(() => {
        events.push("pnpm")
      }),
      reapSettled: Effect.sync(() => {
        events.push("settled")
        free = diskFloor
      })
    })()
  )
  assert.deepEqual(events, ["pnpm", "settled"])
})

test("reaping requires durable settlement and fresh free ownership", async () => {
  const { makeSettledWorkspaceReaper } = await import("../disk.ts")
  const checked: number[] = []
  const removed: number[] = []
  const reaper = makeSettledWorkspaceReaper({
    check: (_repo, issue) => {
      checked.push(issue)
      return issue === 3 ? Effect.fail(new Error("unknown claim")) : Effect.succeed(issue === 1)
    },
    remove: (issue) =>
      Effect.sync(() => {
        removed.push(issue)
      })
  })
  reaper.remember("o/r", [
    { id: "1", status: "landed" },
    { id: "2", status: "failed" },
    { id: "3", status: "failed" },
    { id: "4", status: "working" },
    { id: "-1", status: "failed" },
    { id: "invalid", status: "landed" }
  ])
  await Effect.runPromise(reaper.reap)
  assert.deepEqual(checked, [1, 2, 3])
  assert.deepEqual(removed, [1])
  reaper.remember("o/r", [{ id: "2", status: "working" }])
  checked.length = 0
  await Effect.runPromise(reaper.reap)
  assert.deepEqual(checked, [3], "removed and resumed items are no longer candidates")
  assert.deepEqual(removed, [1], "active and unknown holders survive")
})
