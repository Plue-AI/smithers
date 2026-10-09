import { strict as assert } from "node:assert"
import { createAppController } from "../../../src/mainview/state/AppController"
import { createAppStore } from "../../../src/mainview/state/AppStore"
import { memoryStorage, silentAgent } from "../../../src/mainview/state/TestFixtures"

// The production controller and command bridge use a real host-issued credential.
const origin = process.env.SMITHERS_API_ORIGIN!
const token = process.env.SMITHERS_TOKEN!
const expected = process.env.SMITHERS_EXPECT_DEBUG_REFUSAL ?? "never"
// Keep host credentials in the transport, never card input or page storage.
const transport = (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(url, {
  ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${token}` }
})
const bootstrapResponse = await transport(new URL("/api/bootstrap", origin))
assert.equal(bootstrapResponse.status, 200)
const bootstrap = await bootstrapResponse.json()
assert.ok(bootstrap.capabilities.includes("debug.api"))
let effects = 0
const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
const controller = createAppController(store, silentAgent, {
  bootstrap: { ...bootstrap, capabilities: ["debug.api"] },
  debugApiOrigin: origin,
  fetchImpl: (url, init) => {
    assert.equal(new URL(String(url)).pathname, "/api/commands/debug-api")
    effects++
    return transport(url, init)
  }
})
try {
  for (const door of ["open", "send", "submit", "native", "tool"] as const) {
    const result = door === "tool"
      ? { status: "failed", error: await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "debug-api", args: "get_api_todos" }) }) }
      : door === "submit"
      ? await controller.commands.submit({ name: "debug-api", actor: "agent", payload: { intent: "send", operationId: "get_api_todos" } })
      : door === "native"
      ? await controller.commands.runAsAgent("debug-api", "get_api_todos")
      : await controller.commands.runForAgent("debug-api", door === "open" ? "get_api_todos" : '{"intent":"send","operationId":"get_api_todos"}')
    assert.equal(result.status, "failed")
    assert.ok(result.status === "failed" && result.error.includes(expected === "never"
      ? "raw API bypasses flow typing and approvals; agents use flows"
      : expected === "scope" ? "Insufficient credential scope" : "Sign in again"), JSON.stringify(result))
  }
  assert.equal(store.collections.cards.has("debug-api"), false)
  assert.equal(effects, 5)
  console.log("C-UI-10 SHARED APP-AGENT PRECEDENCE PASS")
} finally { await controller.dispose() }
