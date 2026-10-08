import { strict as assert } from "node:assert"
import { createAppController } from "../../../src/mainview/state/AppController"
import { createAppStore } from "../../../src/mainview/state/AppStore"
import { memoryStorage, silentAgent } from "../../../src/mainview/state/TestFixtures"

// A live host-issued credential is injected only into this test process.
const origin = process.env.SMITHERS_API_ORIGIN!
const token = process.env.SMITHERS_TOKEN!
const user = await fetch(new URL("/api/user", origin), { headers: { Authorization: `Bearer ${token}` } })
assert.equal(user.status, 200)
const identity = await user.json()
assert.equal(identity.username, "ben")
assert.equal(identity.credential_kind, "delegated")
assert.equal(identity.via, "smithers")
let effects = 0
const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
const controller = createAppController(store, silentAgent, {
  debugApiOrigin: origin, debugApiGates: () => ({ catalog: true, authorizer: true, view: true }),
  fetchImpl: (url, init) => { effects++; return fetch(url, init) }
})
try {
  for (const args of ["get_api_todos", '{"intent":"send","operationId":"get_api_todos"}']) {
    const result = await controller.commands.runForAgent("debug-api", args)
    assert.equal(result.status, "failed")
    assert.ok(result.status === "failed" && result.error.includes("raw API bypasses flow typing and approvals; agents use flows"))
  }
  assert.equal(store.collections.cards.has("debug-api"), false)
  assert.equal(effects, 0)
  console.log("C-UI-10 AUTHENTICATED APP-AGENT LOCAL REFUSAL PASS")
} finally { await controller.dispose() }
