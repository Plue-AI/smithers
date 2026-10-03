import { NodeServices } from "@effect/platform-node"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, Result, Schema } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { repositoryRegistration } from "../repository/registry.ts"

// T-AGT-04: absence is the guard, not flags supplied by an untrusted caller.
// Empty sources represent an install with no activated repository flow. The
// import callback and runtime sentinel are test observers, never substitutes
// for discovery, lookup or registration.
test("TestCeoUnavailableDependencies", async () => {
  const imported: string[] = []
  const registered: string[] = []
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function*() {
      const registry = yield* Registry.make({ sources: [] }).pipe(Effect.provide(Discovery.layer))
      const options: Executable.Options = {
        delegates: [],
        load: (path) => {
          imported.push(path)
          return Effect.die("must not import")
        }
      }
      const built = yield* Executable.catalog(options).pipe(Effect.provideService(Registry.Registry, registry))
      const runtime = Layer.succeed(FlowRuntime.FlowRuntime, {
        register: (flow: { readonly _tag: string }) =>
          Effect.sync(() => {
            registered.push(flow._tag)
          })
      } as never)
      const layer = repositoryRegistration(options, built, Layer.empty).pipe(
        Layer.provideMerge(Layer.mergeAll(runtime, Action.layerImplementations, NodeCrypto.layer)),
        Layer.provideMerge(Layer.succeed(Registry.Registry, registry))
      )
      yield* Effect.gen(function*() {
        const catalog = yield* Executable.Catalog
        assert.deepEqual(catalog.executables, [])
        const refusal = yield* Executable.fromRegistry("ceo", options).pipe(Effect.result)
        assert.ok(Result.isFailure(refusal))
        assert.equal(refusal.failure.code, "not_found")
      }).pipe(Effect.provide(layer))
      assert.deepEqual(imported, [])
      assert.deepEqual(registered, [])
    }).pipe(Effect.provide(NodeServices.layer))
  ))
})

test("TestCeoInternalOnly", async () => {
  const { CatalogTagSchema } = await import("../../packages/rpc/src/catalog/index.ts")
  assert.equal(CatalogTagSchema.safeParse("ceo").success, false)
  assert.equal(CatalogTagSchema.safeParse("flow.run").success, true)
  const factory = JSON.parse(await readFile(new URL("../../.smithers/factory.json", import.meta.url), "utf8"))
  assert.equal(factory.flows.some((flow: { id: string }) => flow.id === "ceo"), false)
  // Bun resolves the app's extensionless imports, as in its production build.
  execFileSync("bun", [
    "-e",
    `
    import assert from "node:assert/strict";
    import { flowFlows, repositoryFlowLeaves } from "./apps/app/src/mainview/flows/entries/flow.ts";
    import { nameOf, SURFACE_FLOWS } from "./apps/app/src/mainview/flows/registry.ts";
    const entries = flowFlows({});
    assert.ok(entries.some(row => nameOf(row) === "flow.run"));
    assert.ok(entries.every(row => nameOf(row) !== "ceo"));
    assert.ok(!SURFACE_FLOWS.includes("ceo"));
    assert.deepEqual(repositoryFlowLeaves({}, "team/repo", []), []);
    const installed = repositoryFlowLeaves({}, "team/repo", [{ id: "ceo", description: "Internal brief", modelInvocable: false }]);
    assert.equal(installed.length, 1);
    assert.equal(installed[0].metadata.workflow, "ceo");
    assert.equal(installed[0].binding.descriptor.modelInvocable, false);
  `
  ], { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: "pipe" })
  // No production entry imports the composition: activation owns that import.
  const catalog = await readFile(
    new URL("../../packages/backend/internal/services/flow_catalog.go", import.meta.url),
    "utf8"
  )
  assert.doesNotMatch(catalog, /"ceo"/)
})

test("reference brief preserves producer evidence without inventing observations", async () => {
  const { default: Ceo } = await import("./flow.ts")
  const { input, expected } = await import("./fixture.ts")
  const layer = Interpreter.layerWithImplementations(Ceo, Layer.empty).pipe(
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )
  const output = await Effect.runPromise(Ceo.execute(input, { executionId: "ceo-fixture" }).pipe(Effect.provide(layer)))
  assert.deepEqual(output, expected)
  assert.deepEqual(JSON.parse(JSON.stringify(output)), expected)
  assert.equal("presentation" in Ceo, false, "no unshipped custom renderer contract")
})

test("brief input rejects invalid producer state", async () => {
  const { Brief } = await import("./data.ts")
  const { input } = await import("./fixture.ts")
  assert.throws(() =>
    Schema.decodeUnknownSync(Brief)({
      ...input.brief,
      agents: [{ name: "a", role: "lead", doing: "", state: "offline" }]
    })
  )
  assert.throws(() =>
    Schema.decodeUnknownSync(Brief)({ ...input.brief, questions: [{ id: "q", q: "?", why: "", options: [1] }] })
  )
  assert.deepEqual(Schema.decodeUnknownSync(Brief)({}), {})
})

test("TestCeoBriefOnInstall", async (t) => {
  const origin = process.env.SMITHERS_API_ORIGIN ?? "http://127.0.0.1:4000"
  try {
    const health = await fetch(new URL("/health", origin), { signal: AbortSignal.timeout(3000) })
    if (!health.ok) {
      t.skip(`reference-install-not-serving: HTTP ${health.status}`)
      return
    }
  } catch {
    t.skip("reference-install-not-serving: Mac mini install health endpoint unavailable")
    return
  }
  const storageState = process.env.SMITHERS_CEO_STORAGE_STATE
  const actor = process.env.SMITHERS_CEO_ACTOR
  assert.ok(storageState, "reference install requires an authenticated member browser state")
  assert.ok(actor, "reference install must name the expected agent and member attribution")
  const { chromium } = await import("playwright")
  const { input } = await import("./fixture.ts")
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage({ storageState })
  await page.goto(origin)
  const command = async (value: string) => {
    await page.getByRole("button", { name: "Chat", exact: true }).waitFor()
    await page.keyboard.press("ControlOrMeta+k")
    const composer = page.getByTestId("composer-input")
    await composer.fill(value)
    await composer.press("Enter")
  }
  // Production flow-load must activate the committed fixture revision. Never
  // insert a definition or import the repository module in the browser here.
  await command("/flow ceo")
  await page.getByText("Active", { exact: true }).last().waitFor()
  await command(`/flow.run ceo ${JSON.stringify(input)}`)
  const card = page.locator(".smithers-card[data-kind=\"run-trace\"][aria-label^=\"ceo —\"]").last()
  await card.waitFor({ timeout: 180000 })
  await card.getByRole("button", { name: "Inspect", exact: true }).click()
  // README brief-field literals, independent of implementation output.
  for (const text of ["Will brief", "Ready?", "Review requested", "Observation unavailable"]) {
    await page.getByText(text, { exact: true }).last().waitFor()
  }
  await page.getByText(actor, { exact: true }).last().waitFor()
  assert.ok(await card.getAttribute("data-run-id"), "Inspect belongs to the accepted run")
})
