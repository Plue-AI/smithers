import assert from "node:assert/strict"
import { test } from "node:test"
import { PublicationRefusal, rollout, type RolloutHost, type RolloutReceipt } from "../rollout/runtime.ts"

const previous = { version: "good-version", revision: "old-sha" }
const candidate = { version: "bad-version", revision: "new-sha" }
const fixture = (
  options: {
    fail?: string
    publishThrows?: boolean
    restoreThrows?: boolean
    verifyThrows?: boolean
    last?: RolloutReceipt | null
  } = {}
) => {
  const events: string[] = []
  const receipts: RolloutReceipt[] = []
  const host: RolloutHost = {
    lastReceipt: async () => options.last ?? null,
    capture: async () => {
      events.push("capture")
      return previous
    },
    publish: async () => {
      events.push("publish")
      if (options.publishThrows) throw Error("secret")
      return candidate
    },
    checks: ["CN-1", "site"],
    rollbackChecks: ["CN-1", "site"],
    check: async (name, target, phase) => {
      events.push(`${phase}:${name}:${target.revision}`)
      if (options.verifyThrows && phase === "candidate") throw Error("secret")
      return { status: options.fail === `${phase}:${name}` ? "failed" : "passed" }
    },
    restore: async (target) => {
      events.push(`restore:${target.version}`)
      if (options.restoreThrows) throw Error("secret")
    },
    record: async (receipt) => {
      receipts.push(structuredClone(receipt))
    }
  }
  return { host, events, receipts }
}

test("a deliberately red probe restores the captured version and re-verifies the old revision", async () => {
  const f = fixture({ fail: "candidate:CN-1" })
  const result = await rollout(f.host)
  assert.equal(result.status, "rolled-back")
  assert.deepEqual(result.failedChecks, ["CN-1"])
  assert.deepEqual(result.previous, previous)
  assert.equal(result.rollback, "succeeded")
  assert.equal(result.reverification.every((c) => c.status === "passed"), true)
  assert.deepEqual(f.events, [
    "capture",
    "baseline:CN-1:old-sha",
    "baseline:site:old-sha",
    "publish",
    "candidate:CN-1:new-sha",
    "candidate:site:new-sha",
    "restore:good-version",
    "restored:CN-1:old-sha",
    "restored:site:old-sha"
  ])
  assert.equal(f.receipts[1]?.status, "prepared")
  assert.equal(f.receipts.at(-1)?.status, "rolled-back")
})
test("green rollout never restores", async () => {
  const f = fixture()
  assert.equal((await rollout(f.host)).status, "passed")
  assert.equal(f.events.some((e) => e.startsWith("restore:")), false)
})
test("an unhealthy baseline permits a successful fix-forward", async () => {
  const f = fixture({ fail: "baseline:site" })
  const result = await rollout(f.host)
  assert.equal(result.status, "passed")
  assert.equal(result.baseline[1]?.status, "failed")
  assert.equal(f.events.includes("publish"), true)
})
test("publish uncertainty and thrown checks restore, with no exception text in receipts", async () => {
  for (const options of [{ publishThrows: true }, { verifyThrows: true }]) {
    const f = fixture(options)
    const result = await rollout(f.host)
    assert.equal(result.status, "rolled-back")
    assert.equal(f.events.filter((e) => e.startsWith("restore:")).length, 1)
    assert.equal(JSON.stringify(f.receipts).includes("secret"), false)
  }
})
test("rollback failure still re-verifies and never claims recovery", async () => {
  const f = fixture({ fail: "candidate:site", restoreThrows: true })
  const result = await rollout(f.host)
  assert.equal(result.status, "rollback-failed")
  assert.equal(result.reverification.length, 2)
})
test("failed re-verification retains a failed recovery receipt", async () => {
  const f = fixture({ publishThrows: true, fail: "restored:site" })
  const result = await rollout(f.host)
  assert.equal(result.status, "rollback-failed")
  assert.equal(result.reverification[1]?.status, "failed")
})
test("an empty required-check set refuses before capture or mutation", async () => {
  const f = fixture()
  f.host.checks = []
  await assert.rejects(rollout(f.host), /checks/)
  assert.deepEqual(f.events, [])
})
test("receipt storage failure after publication cannot bypass restoration", async () => {
  const f = fixture()
  const record = f.host.record
  f.host.record = async (r) => {
    if (r.status === "checking") throw Error("disk")
    await record(r)
  }
  assert.equal((await rollout(f.host)).status, "rolled-back")
  assert.equal(f.events.includes("restore:good-version"), true)
})
test("a moved deployment is refused without overwriting another rollout", async () => {
  const f = fixture()
  f.host.beforePublish = async () => {
    throw Error("new deployment")
  }
  assert.equal((await rollout(f.host)).status, "refused")
  assert.equal(f.events.some((e) => e === "publish" || e.startsWith("restore:")), false)
})

test("the public Smithers flow fails with the deterministic recovery receipt", async () => {
  const [{ default: Flow }, { executionLayer }, { FlowEngine }, NodeCrypto, { Effect, Layer }] = await Promise.all([
    import("../rollout/flow.ts"),
    import("../rollout/host.ts"),
    import("@smthrs/engine"),
    import("@effect/platform-node/NodeCrypto"),
    import("effect")
  ])
  const f = fixture({ fail: "candidate:site" })
  const layer = executionLayer(f.host).pipe(
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )
  const result = await Effect.runPromise(
    Flow.execute({}, { executionId: "rollout-failing-probe" }).pipe(
      Effect.match({
        onFailure: (receipt) => ({ failed: true, receipt }),
        onSuccess: (receipt) => ({ failed: false, receipt })
      }),
      Effect.provide(layer)
    )
  )
  assert.equal(result.failed, true)
  assert.notEqual(typeof result.receipt, "string")
  if (typeof result.receipt === "string" || !("status" in result.receipt)) throw new Error("Missing rollout receipt")
  assert.equal(result.receipt.status, "rolled-back")
  assert.deepEqual(result.receipt.failedChecks, ["site"])
  assert.equal(result.receipt.reverification.every((c) => c.status === "passed"), true)
})

test("missing published version identity is a publish failure and triggers restoration", async () => {
  const f = fixture()
  f.host.publish = async () => ({ version: "", revision: "new-sha" })
  const result = await rollout(f.host)
  assert.equal(result.status, "rolled-back")
  assert.deepEqual(result.failedChecks, ["publish"])
})

test("restoring a cutover fence verifies its own required checks, never app health", async () => {
  const f = fixture({ fail: "candidate:site" })
  f.host.previousChecks = ["fence-version", "maintenance-response"]
  const result = await rollout(f.host)
  assert.equal(result.status, "rolled-back")
  assert.deepEqual(result.reverification.map((c) => c.name), ["fence-version", "maintenance-response"])
  assert.equal(f.events.some((e) => e === "restored:site:old-sha"), false)
})

test("upstream failures mark the run red without rollback", async () => {
  const f = fixture({ fail: "candidate:CN-18" })
  f.host.checks = ["CN-1", "site", "CN-18"]
  const result = await rollout(f.host)
  assert.equal(result.status, "failed")
  assert.deepEqual(result.failedChecks, ["CN-18"])
  assert.equal(result.rollback, "not-needed")
  assert.equal(f.events.some((e) => e.startsWith("restore:")), false)
})

test("a failed fix-forward restores the red baseline and records all results", async () => {
  const f = fixture()
  f.host.check = async (name) => ({ status: name === "site" ? "failed" : "passed" })
  const result = await rollout(f.host)
  assert.equal(result.status, "rolled-back")
  for (const checks of [result.baseline, result.checks, result.reverification]) {
    assert.equal(checks.find((c) => c.name === "site")?.status, "failed")
  }
  assert.equal(f.events.filter((e) => e === "restore:good-version").length, 1)
})

test("upstream failures do not invalidate restoration", async () => {
  const f = fixture()
  f.host.checks = ["CN-1", "site", "CN-18"]
  f.host.check = async (name, _, phase) => ({
    status: name === "CN-18" || (phase === "candidate" && name === "site") ? "failed" : "passed"
  })
  assert.equal((await rollout(f.host)).status, "rolled-back")
})

test("capture errors write a refused receipt without exposing errors or publishing", async () => {
  const f = fixture()
  f.host.capture = async () => {
    throw Error("secret previous build stamp unreadable")
  }
  const result = await rollout(f.host)
  assert.equal(result.status, "refused")
  assert.equal(result.previous, null)
  assert.deepEqual(result.failedChecks, ["capture"])
  assert.equal(f.receipts.at(-1)?.status, "refused")
  assert.equal(JSON.stringify(f.receipts).includes("secret"), false)
  assert.deepEqual(f.events, [])
})

test("restoration detects a new failure even when another baseline check was already red", async () => {
  const f = fixture()
  f.host.check = async (name, _, phase) => ({ status: name === "site" || phase === "restored" ? "failed" : "passed" })
  assert.equal((await rollout(f.host)).status, "rollback-failed")
})

test("rollback check names cannot silently omit the required check set", async () => {
  for (const checks of [[], ["unknown"]]) {
    const f = fixture()
    f.host.rollbackChecks = checks
    await assert.rejects(rollout(f.host), /checks/)
    assert.deepEqual(f.events, [])
  }
})

const interruptedAt = (status: RolloutReceipt["status"]): RolloutReceipt => ({
  startedAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:01:00.000Z",
  status,
  previous,
  candidate: status === "checking" || status === "restoring" ? candidate : null,
  baseline: [{ name: "CN-1", status: "passed" }, { name: "site", status: "passed" }],
  checks: [],
  failedChecks: [],
  skippedChecks: [],
  rollback: "not-needed",
  reverification: []
})

test("a runner interrupted mid-publication is restored and re-verified before another rollout is admitted", async () => {
  // Run one: the runner dies while candidate checks are in flight.
  const store: RolloutReceipt[] = []
  const first = fixture()
  first.host.record = async (r) => {
    store.push(structuredClone(r))
  }
  first.host.check = (_name, _target, phase) =>
    phase === "candidate" ? new Promise(() => {}) : Promise.resolve({ status: "passed" })
  void rollout(first.host)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const interrupted = store.at(-1)!
  assert.equal(interrupted.status, "checking")

  // Run two reads the durable store and reconciles instead of publishing.
  const f = fixture({ last: interrupted })
  const result = await rollout(f.host)
  assert.equal(result.status, "rolled-back")
  assert.equal(result.startedAt, interrupted.startedAt)
  assert.deepEqual(result.candidate, candidate)
  assert.deepEqual(result.failedChecks, ["interrupted"])
  assert.equal(result.rollback, "succeeded")
  assert.deepEqual(result.reverification, [{ name: "CN-1", status: "passed" }, { name: "site", status: "passed" }])
  assert.deepEqual(f.events, ["restore:good-version", "restored:CN-1:old-sha", "restored:site:old-sha"])
  assert.deepEqual(f.receipts.map((r) => [r.startedAt, r.status]), [
    [interrupted.startedAt, "restoring"],
    [interrupted.startedAt, "rolled-back"]
  ])
})

test("every post-publication interruption restores; a failed restore is never reported as recovery", async () => {
  for (const status of ["publishing", "checking", "restoring"] as const) {
    const f = fixture({ last: interruptedAt(status) })
    assert.equal((await rollout(f.host)).status, "rolled-back")
    assert.equal(f.events.includes("publish"), false)
    const failed = fixture({ last: interruptedAt(status), restoreThrows: true })
    const result = await rollout(failed.host)
    assert.equal(result.status, "rollback-failed")
    assert.equal(result.reverification.length, 2)
    assert.equal(failed.events.some((e) => e === "capture" || e === "publish"), false)
  }
})

test("an interruption before publication closes its receipt and the new rollout proceeds", async () => {
  for (const status of ["captured", "prepared"] as const) {
    const f = fixture({ last: interruptedAt(status) })
    const result = await rollout(f.host)
    assert.equal(result.status, "passed")
    assert.notEqual(result.startedAt, "2026-09-30T00:00:00.000Z")
    assert.equal(f.events.some((e) => e.startsWith("restore:")), false)
    assert.deepEqual(f.receipts[0], {
      ...interruptedAt(status),
      status: "refused",
      failedChecks: ["interrupted"],
      updatedAt: f.receipts[0]!.updatedAt
    })
  }
})

test("a terminal last receipt admits the rollout unchanged", async () => {
  for (const status of ["passed", "failed", "refused", "rolled-back", "rollback-failed"] as const) {
    const f = fixture({ last: interruptedAt(status) })
    assert.equal((await rollout(f.host)).status, "passed")
    assert.equal(f.receipts.some((r) => r.startedAt === "2026-09-30T00:00:00.000Z"), false)
  }
})

test("an unreadable receipt store refuses before capture, publication or restoration", async () => {
  const f = fixture()
  f.host.lastReceipt = async () => {
    throw Error("secret store path")
  }
  const result = await rollout(f.host)
  assert.equal(result.status, "refused")
  assert.deepEqual(result.failedChecks, ["receipt"])
  assert.deepEqual(f.events, [])
  assert.equal(JSON.stringify(f.receipts).includes("secret"), false)
})

test("an interrupted receipt without a baseline cannot restore and refuses the rollout", async () => {
  const f = fixture({ last: { ...interruptedAt("checking"), previous: null } })
  const result = await rollout(f.host)
  assert.equal(result.status, "rollback-failed")
  assert.equal(result.rollback, "failed")
  assert.deepEqual(f.events, [])
})

test("publication refusal preserves its named check and prevents publishing", async () => {
  const f = fixture()
  const refusal = new PublicationRefusal("provenance")
  assert.ok(refusal instanceof Error)
  assert.equal(refusal.message, "provenance")
  assert.equal(refusal.check, "provenance")
  f.host.beforePublish = async () => { throw refusal }
  const result = await rollout(f.host)
  assert.equal(result.status, "refused")
  assert.deepEqual(result.failedChecks, ["provenance"])
  assert.equal(f.events.includes("publish"), false)
  assert.equal(f.events.some((event) => event.startsWith("restore:")), false)
})
