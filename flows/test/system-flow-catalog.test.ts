import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
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
