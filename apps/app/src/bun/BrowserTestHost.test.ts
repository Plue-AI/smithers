import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MODEL_CATALOG_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { ModelCatalogSchema } from "@smthrs/rpc/ConfiguredModel"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { createChatStub } from "../../e2e/support/ChatStub"
import { browserTestOptions } from "../../scripts/browser-test-host"
import { DEFAULT_CLOUD_API, startLocalServer } from "./server"

describe("browser tests separate fixture ownership from real-host authority", () => {
  test("default options cannot discover host credentials or inherit hybrid cloud configuration", async () => {
    const options = browserTestOptions("/fixture/owned", "/fixture/dist", {
      SMITHERS_LOCAL_MODE: "hybrid",
      SMITHERS_CLOUD_API: "https://not-a-test.invalid",
      CODEX_HOME: "/fixture/personal-credentials",
      OPENAI_API_KEY: "fixture-only-not-a-credential"
    })
    expect(options).toMatchObject({
      home: "/fixture/owned",
      stateDir: "/fixture/owned/state",
      agent: createChatStub,
      cloudMode: "offline",
      cloudApi: null,
      identityUpstream: null,
      env: {}
    })
  })

  test("a running fixture never reads ambient model credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-browser-credential-test-"))
    const dist = join(root, "dist")
    await mkdir(dist)
    await writeFile(join(dist, "index.html"), "<!doctype html><title>Fixture</title>")
    const options = browserTestOptions(root, dist, { OPENAI_API_KEY: "ambient-fixture-only" })
    try {
      const server = await startLocalServer(options)
      try {
        const response = await fetch(`${server.origin}${MODEL_CATALOG_PATH}`, {
          headers: { [LOCAL_SESSION_HEADER]: server.sessionToken }
        })
        expect(response.status).toBe(200)
        const catalog = ModelCatalogSchema.parse(await response.json())
        expect(catalog.credentials.find(row => row.name === "OPENAI_API_KEY")?.present).toBe(false)
        expect(catalog.credentials.find(row => row.name === "LOOPBACK")).toBeUndefined()
      } finally {
        await server.stop()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("real chat is a separate explicit opt-in and never imports real identity authority", async () => {
    const options = browserTestOptions("/fixture/owned", "/fixture/dist", {
      SMITHERS_CHAT_STUB: "0",
      OPENAI_API_KEY: "ambient-key-must-not-pass",
      SMITHERS_MODEL_KEY_LOOPBACK: "explicit-fixture-key",
      SMITHERS_MODEL_KEY_LOOPBACK_ORIGIN: "http://127.0.0.1:12345"
    })
    expect(options.agent).toBeUndefined()
    expect(options.cloudMode).toBe("hybrid")
    expect(options.home).toBe("/fixture/owned")
    expect(options.cloudApi).toBe(DEFAULT_CLOUD_API)
    // The Cloud user is the explicit SMITHERS_CLOUD_TOKEN, never a stored login.
    expect(await options.cloudKeychain!.read("smithers-cloud", "account")).toBeNull()
    expect(options.identityUpstream).toBeNull()
    expect(options.env).toEqual({
      SMITHERS_MODEL_KEY_LOOPBACK: "explicit-fixture-key",
      SMITHERS_MODEL_KEY_LOOPBACK_ORIGIN: "http://127.0.0.1:12345"
    })
    expect(() => browserTestOptions("/fixture/owned", "/fixture/dist", { SMITHERS_LOCAL_PORT: "NaN" })).toThrow("port")
  })
})
