import { afterEach, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { createCloudAuth } from "./CloudAuth"
import type { CloudKeychain } from "./CloudAuth"
import { fakeBackend, signedInKeychain } from "./fixtures/FakeBackendTurns"
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

test("a backend refusal preserves the first response stream", async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const encoder = new TextEncoder()
  let calls = 0
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fakeBackend(() => ++calls > 1 ? new Response(null, { status: 409 }) : new Response(new ReadableStream<Uint8Array>({ start(controller) {
    stream = controller
    controller.enqueue(encoder.encode(`${JSON.stringify({ type: "delta", kind: "text", text: "first" })}\n`))
  } }))) })
  cleanup.push(() => { upstream.stop(true) })
  const server = await startLocalServer({ distDir: await directory(), cloudMode: "hybrid", cloudApi: `http://127.0.0.1:${upstream.port}`,
    cloudKeychain: signedInKeychain(), identityUpstream: null, log: () => {} })
  cleanup.push(() => server.stop())
  const headers = { [LOCAL_SESSION_HEADER]: server.sessionToken, "content-type": "application/json" }
  const body = JSON.stringify({ runId: "duplicate", messages: [], instructions: "" })
  const first = await fetch(`${server.origin}/api/chat/turn`, { method: "POST", headers, body })
  const original = first.text()
  expect((await fetch(`${server.origin}/api/chat/turn`, { method: "POST", headers, body })).status).toBe(409)
  stream!.enqueue(encoder.encode(`${JSON.stringify({ type: "done", reason: "stop" })}\n`)); stream!.close()
  const result = await Promise.race([original, Bun.sleep(1000).then(() => "TIMED OUT")])
  expect(result).toContain('"type":"done"'); expect(result).toContain('"text":"first"')
})


test("a hybrid host's chat is a backend turn as the signed-in Cloud user, and refused by code when signed out", async () => {
  const seen: Array<{ path: string; authorization: string | null }> = []
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    seen.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") })
    return fakeBackend(() => new Response(`${JSON.stringify({ type: "delta", kind: "text", text: "from the backend" })}\n${JSON.stringify({ type: "done", reason: "stop" })}\n`))(request)
  } })
  cleanup.push(() => { upstream.stop(true) })
  const body = JSON.stringify({ runId: "backend-turn", messages: [{ role: "user", content: "hi" }], instructions: "" })
  const signedIn = await startLocalServer({ distDir: await directory(), cloudMode: "hybrid", cloudApi: `http://127.0.0.1:${upstream.port}`,
    cloudKeychain: signedInKeychain(), identityUpstream: null, log: () => {} })
  cleanup.push(() => signedIn.stop())
  const answer = await fetch(`${signedIn.origin}/api/agent/turn`, { method: "POST", headers: { [LOCAL_SESSION_HEADER]: signedIn.sessionToken, "content-type": "application/json" }, body })
  expect(answer.status).toBe(200)
  const text = await answer.text()
  expect(text).toContain('"text":"from the backend"'); expect(text).toContain('"type":"done"')
  expect(seen.filter((one) => one.path === "/api/agent/turn")).toEqual([{ path: "/api/agent/turn", authorization: "Bearer backend-test-token" }])
  expect(seen.filter((one) => one.path.startsWith("/api/agent/turn/"))).toEqual([])

  const signedOut = await startLocalServer({ distDir: await directory(), cloudMode: "hybrid", cloudApi: `http://127.0.0.1:${upstream.port}`,
    cloudKeychain: { read: async () => null, write: async () => {}, remove: async () => {} }, identityUpstream: null, log: () => {} })
  cleanup.push(() => signedOut.stop())
  const turns = seen.length
  const recorded = JSON.stringify({ ...JSON.parse(body), journal: { version: 1, legId: "signed-out-leg", token: "signed_out_private_capability_1234567890" } })
  // Recorded or not, the refusal keeps its code: no leg is admitted to stream it as an error.
  for (const turn of [body, recorded]) {
    const refused = await fetch(`${signedOut.origin}/api/agent/turn`, { method: "POST", headers: { [LOCAL_SESSION_HEADER]: signedOut.sessionToken, "content-type": "application/json" }, body: turn })
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({ error: { code: "cloud_sign_in_required" } })
  }
  expect(seen.length).toBe(turns)

  const noCloud = await startLocalServer({ distDir: await directory(), cloudMode: "hybrid", cloudApi: null, identityUpstream: null, log: () => {} })
  cleanup.push(() => noCloud.stop())
  const unavailable = await fetch(`${noCloud.origin}/api/agent/turn`, { method: "POST", headers: { [LOCAL_SESSION_HEADER]: noCloud.sessionToken, "content-type": "application/json" }, body })
  expect(await unavailable.json()).toMatchObject({ error: { code: "agent_unavailable" } })
})

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
