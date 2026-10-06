import { afterEach, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { createCloudAuth } from "./CloudAuth"
import type { CloudKeychain } from "./CloudAuth"
import { startLocalServer } from "./server"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop() })
const directory = async (): Promise<string> => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "smithers-native-regression-")))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  await writeFile(join(path, "index.html"), "<!doctype html><head></head>")
  return path
}
const keychain = () => {
  let value: string | null = null
  const api: CloudKeychain = { read: async () => value, write: async (_s, _a, next) => { value = next }, remove: async () => { value = null } }
  return { api, value: () => value }
}
const credentials = { token: "review-test-token", username: "test", email: null, expiresAt: "2099-01-01T00:00:00Z" }
/*
 * Cloud's scope refusal in its own wire shape: the typed `forbidden` verdict
 * first, then plue's pinned sentence (`isCloudScopeRefusal`). A bare sentence
 * with no plue code degrades nothing, by design.
 */
const SCOPE_REFUSAL = JSON.stringify({ code: "forbidden", fault: "user", message: "insufficient token scope" })

test("the native browser route is session-gated and enabled only in hybrid mode", async () => {
  for (const cloudMode of ["offline", "hybrid"] as const) {
    const server = await startLocalServer({ distDir: await directory(), cloudMode, cloudApi: null, identityUpstream: null, log: () => {} })
    cleanup.push(() => server.stop())
    const path = `${server.origin}/api/tools/browser-fetch`
    const body = JSON.stringify({ url: "https://127.0.0.1/" })
    expect((await fetch(path, { method: "POST", body })).status).toBe(401)
    const headers = { [LOCAL_SESSION_HEADER]: server.sessionToken, "content-type": "application/json" }
    const response = await fetch(path, { method: "POST", headers, body })
    expect(response.status).toBe(cloudMode === "hybrid" ? 400 : 501)
    expect(await response.json()).toMatchObject({ code: cloudMode === "hybrid" ? "request_invalid" : "feature_unavailable_here" })
    const bootstrap = await (await fetch(`${server.origin}/api/bootstrap`, { headers })).json() as { capabilities: Array<string> }
    expect(bootstrap.capabilities.includes("browser.read")).toBe(cloudMode === "hybrid")
  }
})

test("sign-out invalidates a callback waiting for its scope probe", async () => {
  const saved = keychain()
  let release!: () => void; let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const auth = await createCloudAuth({ api: "https://cloud.test", keychain: saved.api,
    fetchImpl: async () => { entered(); await gate; return new Response("[]") } })
  cleanup.push(() => auth.stop())
  const login = await auth.start(); if (!("url" in login)) throw new Error(login.error)
  const port = new URL(login.url).searchParams.get("callback_port")
  await fetch(`http://127.0.0.1:${port}/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...credentials, callback_state: new URL(login.url).searchParams.get("callback_state") }) })
  await started; await auth.signOut(); release(); await Bun.sleep(20)
  expect(auth.session().state).toBe("signed-out"); expect(auth.token()).toBeUndefined(); expect(saved.value()).toBeNull()
})

test("expired credentials allow a fresh login and valid restores recheck scope", async () => {
  for (const expired of [true, false]) {
    const saved = keychain()
    await saved.api.write("", "", JSON.stringify({ ...credentials, expiresAt: expired ? "2000-01-01T00:00:00Z" : credentials.expiresAt }))
    let probes = 0
    const auth = await createCloudAuth({ api: "https://cloud.test", keychain: saved.api,
      fetchImpl: async () => { probes++; return new Response(SCOPE_REFUSAL, { status: 403 }) } })
    cleanup.push(() => auth.stop())
    expect(auth.session().state).toBe(expired ? "signed-out" : "signed-in"); expect(probes).toBe(expired ? 0 : 1)
    if (expired) { expect(saved.value()).toBeNull(); expect(await auth.start()).toHaveProperty("url") }
    else expect(auth.session().scopes).toBe("degraded")
  }
})
