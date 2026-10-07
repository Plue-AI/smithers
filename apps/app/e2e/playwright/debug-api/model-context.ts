import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { parse } from "yaml"
import { createAppController } from "../../../src/mainview/state/AppController"
import { createAppStore } from "../../../src/mainview/state/AppStore"
import { memoryStorage, silentAgent } from "../../../src/mainview/state/TestFixtures"
import type { OpenApiDocument } from "../../../src/mainview/state/seams/DebugApiSeam"

const origin = process.env.SMITHERS_API_ORIGIN!
const canary = "DEBUG-RESPONSE-PRIVATE-3559"
const storage = memoryStorage(), writes: string[] = []
const store = await createAppStore({ kind: "localStorage", storage: {
  ...storage, setItem: (key, value) => { writes.push(value); storage.setItem(key, value) }
} })
const controller = createAppController(store, silentAgent, {
  baseUrl: origin, debugApiOrigin: origin,
  bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null },
  openApi: async () => parse(readFileSync("../../docs/api/openapi.yaml", "utf8")) as OpenApiDocument,
  debugApiGates: () => ({ view: true, catalog: true, authorizer: true }),
  fetchImpl: (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set("Cookie", "context_session=composed-context-session")
    return fetch(input, { ...init, headers })
  }
})
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 600 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(check(), "production app transition completed")
}
try {
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  assert.equal((await controller.runCommandForResult("debug-api", "get_api_user")).status, "executed")
  await waitFor(() => store.collections.cards.has("debug-api"))
  assert.equal((await controller.runCommandForResult("debug.api", JSON.stringify({ operationId: "get_api_user", intent: "send" }))).status, "executed")
  await waitFor(() => !!controller.debugApi.get().model.exchange?.response)
  assert.equal(controller.debugApi.get().model.exchange?.response?.status, 200)
  assert.ok(controller.debugApi.get().model.exchange?.response?.body.includes(canary))
  assert.equal(await controller.send("Where do we retry webhooks?"), true)
  await waitFor(() => !!store.session().sharedPrompts?.[0]?.turnId)
  const prompt = store.session().sharedPrompts![0]!
  assert.notEqual(prompt.state, "failed")
  const rows = Object.values(store.collections).flatMap(collection => [...(collection as unknown as { values: () => Iterable<unknown> }).values()])
  assert.ok(!JSON.stringify(rows).includes(canary))
  assert.ok(!writes.join("\n").includes(canary))
  console.log(JSON.stringify({ turnId: prompt.turnId }))
} finally { await controller.dispose(); await store.dispose?.() }
