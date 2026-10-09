import { Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import appendixC from "../../apps/app/src/mainview/flows/fixtures/AppendixC.json" with { type: "json" }
import { auditRuntimeTags } from "../../scripts/catalog-policy.ts"
import { policyRegistration, withProductionRegistries } from "../../scripts/catalog-runtime.ts"

test("built native and coding hosts expose their actual private registrations", { timeout: 120_000 }, async () => {
  await withProductionRegistries((inventories, runtimes) => Effect.gen(function*() {
    assert.deepEqual(inventories.map(inventory => inventory.host), ["native", "coding", "coding-wiki"])
    assert.equal(runtimes.length, 3)
    assert.ok(inventories[0]!.tags.some(tag => tag.id === "agent/run"))
    const coding = inventories[1]!.tags
    assert.ok(coding.some(tag => tag.id === "coding/ImplementAtom"))
    assert.ok(inventories[2]!.tags.some(tag => tag.id === "coding/RefreshWiki"))
    assert.ok(coding.some(tag => tag.id === "coding/prepare-atom" && tag.source === "flows/coding/atoms.ts"))
    // These are the actual private layers, not the already-clean public
    // repository route inventory. Keep identifying pending migrations.
    assert.equal(coding.some(tag => tag.id === "coding/Vibe"), false, "delivery is inlined in the TODO plan")
    assert.equal(coding.some(tag => tag.id === "coding/Request"), false, "request is inlined in the TODO plan")
    for (const [index, runtime] of runtimes.entries()) {
      let admitted = 0
      let executed = 0
      const registration = policyRegistration({ ...runtime, register: (...args) => { admitted++; return runtime.register(...args) } }, "machine")
      const forbidden = appendixC.rows.filter(row => row.status === "replaced" && !(row.id in appendixC.engineeringOverrides))
      assert.ok(forbidden.length > 0)
      for (const row of forbidden) {
        const flow = Flow.make(row.id, { payload: Schema.Struct({}), success: Schema.Void, body: () => { executed++; return Node.succeed(undefined) } })
        const result = yield* Effect.exit(registration(flow, () => Effect.sync(() => { executed++ })))
        assert.equal(result._tag, "Failure", row.id)
      }
      for (const id of ["invented/Flow", "repository/Setup", "coding/refresh-restacked-evidence"]) {
        const flow = Flow.make(id, { payload: Schema.Struct({}), success: Schema.Void, body: () => { executed++; return Node.succeed(undefined) } })
        assert.equal((yield* Effect.exit(registration(flow, () => Effect.void)))._tag, "Failure", id)
      }
      assert.equal(admitted, 0, "policy must reject before real engine admission")
      assert.equal(executed, 0, "registry construction must execute no repository body")
      if (index === 0) {
        const allowed = Flow.make("coding/ImplementAtom", { payload: Schema.Struct({}), success: Schema.Void, body: () => { executed++; return Node.succeed(undefined) } })
        yield* registration(allowed, () => Effect.sync(() => { executed++ }))
        assert.equal(admitted, 1, "an allowed registration reaches the real engine")
        assert.equal(executed, 0, "registration does not execute the allowed flow either")
      }
    }
  }))
})

test("the default build command audits production registries, while the app/CLI inventory is clean", { timeout: 120_000 }, async () => {
  const script = fileURLToPath(new URL("../../scripts/catalog-allowlist.ts", import.meta.url))
  const app = spawnSync("bun", [script, "--app-cli"], { encoding: "utf8", timeout: 60_000 })
  assert.equal(app.status, 0, app.stderr)
  assert.equal(app.stdout, "")
  const inventory = await withProductionRegistries(inventories => Effect.succeed(inventories))
  const violations = inventory.flatMap(row => auditRuntimeTags(row.tags))
  const combined = spawnSync("bun", [script], { encoding: "utf8", timeout: 60_000 })
  assert.equal(combined.status, violations.length === 0 ? 0 : 1, combined.stderr)
  for (const { id, reason } of violations) assert.ok(combined.stderr.includes(`${reason}: ${id}`), `${reason}: ${id}`)
})

test("production host refuses replaced entry points before executing their bodies", { timeout: 120_000 }, async () => {
  const forbidden = appendixC.rows.filter(row => row.status === "replaced" && !(row.id in appendixC.engineeringOverrides))
  for (const row of forbidden) {
    let executed = 0
    const flow = Flow.make(row.id, { payload: Schema.Struct({}), success: Schema.Void, body: () => { executed++; return Node.succeed(undefined) } })
    let allowed = 0
    const registration = Layer.effectDiscard(Effect.gen(function*() {
      const runtime = yield* FlowRuntime.FlowRuntime
      for (const id of Object.keys(appendixC.engineeringOverrides)) {
        const retained = Flow.make(id, { payload: Schema.Struct({}), success: Schema.Void, body: () => { executed++; return Node.succeed(undefined) } })
        yield* runtime.register(retained, () => Effect.sync(() => { executed++ }))
        allowed++
      }
      yield* runtime.register(flow, () => Effect.sync(() => { executed++ }))
    }))
    await assert.rejects(withProductionRegistries(() => Effect.void, registration), error => {
      assert.ok(String(error).includes(`replaced: ${row.id}`), String(error))
      return true
    })
    assert.equal(allowed, Object.keys(appendixC.engineeringOverrides).length, "E-19 engine launches remain admissible")
    assert.equal(executed, 0, "host admission must execute no forbidden body or handler")
  }
})
