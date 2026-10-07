import assert from "node:assert/strict"
import { test } from "node:test"
import { typecheckSource } from "../coding/flow-typecheck-build.mjs"

test("embedded type inputs round-trip completely and deterministically", async () => {
  const inputs = {
    files: { "/lib.d.ts": "declare const unicode: '🦋';\n".repeat(1000), "/empty.ts": "" },
    entries: { "@smthrs/flow": "/flow.ts" }, lib: "/lib.d.ts", node: "/node.d.ts"
  }
  const source = typecheckSource(inputs)
  assert.equal(source, typecheckSource(inputs))
  assert.ok(source.length < JSON.stringify(inputs).length)
  const module = await import(`data:text/javascript;base64,${Buffer.from(source + "export default __SMITHERS_FLOW_TYPES__;").toString("base64")}`)
  assert.deepEqual(module.default, inputs)
})
