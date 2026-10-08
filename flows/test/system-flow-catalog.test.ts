import { NodeServices } from "@effect/platform-node"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { FileSystem } from "effect"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { provisionBuiltins } from "../repository/registry.ts"
import { systemFlows } from "./fixtures/system-flows.ts"

test("launch-spec fixtures agree with the canonical backend system catalog", async () => {
  const [catalog, realHost] = await Promise.all([
    readFile(new URL("../../packages/backend/internal/services/flow_catalog.go", import.meta.url), "utf8"),
    readFile(new URL("../../packages/backend/flowdispatch/real_host_test.go", import.meta.url), "utf8")
  ])
  const declaration = catalog.match(/var SystemFlows = \[\]string\{([\s\S]*?)\n\}/)?.[1]
  assert.ok(declaration, "canonical SystemFlows declaration must exist")
  const canonical = [...declaration.matchAll(/"([^"\n]+)"/g)].map((match) => match[1])
  assert.ok(canonical.length > 0)
  assert.equal(new Set(canonical).size, canonical.length, "canonical names must be unique")
  assert.deepEqual([...systemFlows].sort(), [...canonical].sort(), "TypeScript host fixture drifted")
  const realHostJSON = realHost.match(/`SMITHERS_SYSTEM_FLOWS=(\[[^`]*\])`/)?.[1]
  assert.ok(realHostJSON, "real-host fixture must supply the launch catalog")
  assert.deepEqual(JSON.parse(realHostJSON).sort(), [...canonical].sort(), "Go real-host fixture drifted")
})

// The shipped default uses the very same registry execution identity at admission.
test("the backend pins the shipped default's registry execution digest", async () => {
  const served: Record<string, string> = JSON.parse(
    await readFile(new URL("../../packages/backend/internal/services/builtin_flows.json", import.meta.url), "utf8")
  )
  await Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped()
    for (const policy of ["a".repeat(64), "b".repeat(64)]) {
      const builtin = yield* provisionBuiltins(root, policy)
      const todo = yield* builtin.registry.get("todo")
      assert.deepEqual(Object.keys(served), ["todo", "learning", "review"])
      const learning = yield* builtin.registry.get("learning")
      assert.equal(served.learning, "1fdfa26813fce28d5d5a9ec036cdc0e169cdb44cbb7459464f699c602c04bdcc")
      assert.equal(Descriptor.executionDigest(learning), "1fdfa26813fce28d5d5a9ec036cdc0e169cdb44cbb7459464f699c602c04bdcc")
      assert.equal(served.todo, Descriptor.executionDigest(todo))
      assert.notEqual(served.todo, todo.body.contentDigest, "the source hash alone cannot admit an execution")
      // Review's identity covers the modules beside its entry, measured where
      // the host wrote them, not only the entry's own bytes.
      const review = yield* builtin.registry.get("review")
      assert.equal(served.review, Descriptor.executionDigest(review))
      assert.ok(review.body._tag === "Module" && (review.body.imports?.length ?? 0) > 0)
      assert.ok(
        review.body.imports!.every((entry) => entry.path.startsWith("src/") && entry.contentDigest !== undefined)
      )
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)
})
