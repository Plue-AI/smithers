import assert from "node:assert/strict"
import { test } from "node:test"
import { rollout, type RolloutHost, type RolloutReceipt } from "../rollout/runtime.ts"

const previous = { version: "good-version", revision: "old-sha" }
const candidate = { version: "bad-version", revision: "new-sha" }
const fixture = (
  options: { fail?: string; publishThrows?: boolean; restoreThrows?: boolean; verifyThrows?: boolean } = {}
) => {
  const events: string[] = []
  const receipts: RolloutReceipt[] = []
  const host: RolloutHost = {
    capture: async () => previous,
    publish: async () => {
      events.push("publish")
      if (options.publishThrows) throw Error("secret")
      return candidate
    },
    checks: ["CN-1", "site"],
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
test("an unhealthy baseline refuses before publication", async () => {
  const f = fixture({ fail: "baseline:site" })
  assert.equal((await rollout(f.host)).status, "refused")
  assert.equal(f.events.includes("publish"), false)
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
  const [{ default: Flow, executionLayer }, { FlowEngine }, NodeCrypto, { Effect, Layer }] = await Promise.all([
    import("../rollout/flow.ts"),
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
