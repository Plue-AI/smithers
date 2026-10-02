import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MODEL_CATALOG_PATH, MODEL_TEST_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { ModelCatalogSchema } from "@smthrs/rpc/ConfiguredModel"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { startLocalServer, type LocalServer } from "./server"
let dist: string
let server: LocalServer
let calls = 0
beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-model-catalog-"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Smithers</title>")
  server = await startLocalServer({ port: 0, distDir: dist, env: {
    SMITHERS_MODEL_KEY_LOOPBACK: "secret-catalog-only",
    SMITHERS_MODEL_KEY_LOOPBACK_ORIGIN: "http://127.0.0.1:47500"
  }, modelFetch: Object.assign(async () => { calls++; throw new Error("No model request expected") }, { preconnect: () => {} }) })
})
afterAll(async () => { await server.stop(); await rm(dist, { recursive: true, force: true }) })
test("configured credential catalog needs the local session and never exposes values", async () => {
  const bare = await fetch(`${server.origin}${MODEL_CATALOG_PATH}`)
  expect(bare.status).toBe(401)
  const response = await fetch(`${server.origin}${MODEL_CATALOG_PATH}`, { headers: { [LOCAL_SESSION_HEADER]: server.sessionToken } })
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(text).not.toContain("secret-catalog-only")
  const catalog = ModelCatalogSchema.parse(JSON.parse(text))
  expect(catalog.credentials).toContainEqual({ name: "LOOPBACK", present: true, origins: ["http://127.0.0.1:47500"] })
  expect(calls).toBe(0)
})
test("the removed model experiment route makes no model call", async () => {
  const response = await fetch(`${server.origin}${MODEL_TEST_PATH}`, { method: "POST", headers: {
    [LOCAL_SESSION_HEADER]: server.sessionToken, "content-type": "application/json"
  }, body: JSON.stringify({ model: { id: "lab", protocol: "openai-chat", modelId: "experiment", credential: "LOOPBACK", baseUrl: "http://127.0.0.1:47500" } }) })
  expect(response.status).toBe(404)
  expect(calls).toBe(0)
})
