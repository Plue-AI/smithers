import { NodeServices } from "@effect/platform-node"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
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

// GET /api/flows serves the built-in TODO flow at the digest the backend
// embeds (services/builtin_flows.json). It must be the content digest the
// flow registry measures for the composition this repository ships, so a
// change to flows/todo/flow.ts changes the served version too.
test("the backend serves the built-in TODO flow at the digest the registry measures", async () => {
  const served: Record<string, string> = JSON.parse(
    await readFile(new URL("../../packages/backend/internal/services/builtin_flows.json", import.meta.url), "utf8")
  )
  const todo = await Registry.make({
    sources: [{ root: fileURLToPath(new URL("../", import.meta.url)), source: "project", naming: "path" }]
  }).pipe(
    Effect.flatMap((registry) => registry.get("todo")),
    Effect.provide(Discovery.layer),
    Effect.provide(NodeServices.layer),
    Effect.runPromise
  )
  assert.deepEqual(Object.keys(served), ["todo"])
  assert.equal(
    served.todo,
    todo.body.contentDigest,
    "flows/todo/flow.ts changed: set todo in packages/backend/internal/services/builtin_flows.json to its sha256"
  )
})
