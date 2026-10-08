// Runs only against the qualified bundled install owned by C-SEC-02.
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { parse } from "yaml"
import { createAppController } from "../../../src/mainview/state/AppController"
import { createAppStore } from "../../../src/mainview/state/AppStore"
import { memoryStorage, silentAgent } from "../../../src/mainview/state/TestFixtures"
import type { OpenApiDocument } from "../../../src/mainview/state/seams/DebugApiSeam"

const origin = process.env.DEBUG_API_TEST_ORIGIN!
const cookie = process.env.DEBUG_API_TEST_COOKIE!
const repository = process.env.DEBUG_API_TEST_REPOSITORY!
const [owner, repo] = repository.split("/")
assert.ok(owner && repo)
assert.ok(origin && cookie)
let requests = 0
const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
const controller = createAppController(store, silentAgent, {
  openApi: async () => parse(readFileSync("../../docs/api/openapi.yaml", "utf8")) as OpenApiDocument,
  debugApiOrigin: origin,
  debugApiGates: () => ({ catalog: true, authorizer: true, view: true }),
  fetchImpl: (url, init) => {
    requests++
    const headers = new Headers(init?.headers)
    headers.set("cookie", `smithers_session=${cookie}; __csrf=isolation-csrf`)
    headers.set("X-CSRF-Token", "isolation-csrf")
    headers.set("Origin", origin)
    return fetch(url, { ...init, headers })
  }
})
const settle = async (ready: () => boolean) => {
  for (let n = 0; n < 500 && !ready(); n++) await Bun.sleep(10)
  assert.ok(ready(), "background Send settled")
}
try {
  const operationId = "post_api_repos_owner_repo_invoke"
  assert.equal((await controller.runCommandForResult("debug-api", operationId)).status, "executed")
  await settle(() => store.collections.cards.has("debug-api"))
  assert.equal(requests, 0)
  const values = { "path:owner": owner, "path:repo": repo, body: '{"flow":"debug-canary","input":{}}' }
  assert.equal((await controller.runCommandForResult("debug-api", JSON.stringify({ intent: "send", operationId, values }))).status, "executed")
  await settle(() => !!controller.debugApi.get().confirmation)
  assert.equal(requests, 0)
  assert.equal((await controller.runCommandForResult("debug-api", JSON.stringify({ intent: "confirm", operationId, values, confirmation: controller.debugApi.get().confirmation }))).status, "executed")
  await settle(() => !!controller.debugApi.get().model.exchange && !controller.debugApi.get().busy)
  assert.equal(requests, 1)
  const exchange = controller.debugApi.get().model.exchange!
  assert.equal(exchange.response?.status, 201)
  assert.equal(exchange.failure, undefined)
  const receipt = JSON.parse(exchange.response!.body)
  assert.equal(receipt.flow, "debug-canary")
  assert.equal(receipt.path, "flows/debug-canary/flow.ts")
  assert.equal(receipt.status, "queued")
  assert.ok(Number.isSafeInteger(receipt.run_id) && receipt.run_id > 0)
  assert.equal(receipt.id, receipt.run_id)
  // No cookies or confirmation tokens are emitted with the public run handle.
  console.log(JSON.stringify({ runId: receipt.run_id, status: 201, requests, beforeConfirm: 0 }))
} finally {
  await controller.dispose()
}
