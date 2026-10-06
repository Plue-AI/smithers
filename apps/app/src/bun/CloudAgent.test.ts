import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TURN_REPLAY_PATH, TURN_ERASE_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { signedInKeychain } from "./fixtures/FakeBackendTurns"
import { startLocalServer } from "./server"

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop() })
const turn = { runId: "renderer-run", messages: [], instructions: "brief", journal: { version: 1, legId: "renderer-leg", token: "renderer_private_capability_1234567890" } }
const fixture = async (respond: (request: Request) => Response | Promise<Response>, signedIn = true) => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond })
  cleanup.push(() => upstream.stop(true))
  const root = await mkdtemp(join(tmpdir(), "smithers-relay-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "index.html"), "<!doctype html>")
  const host = await startLocalServer({ distDir: root, cloudMode: "hybrid", cloudApi: `http://127.0.0.1:${upstream.port}`, cloudKeychain: signedIn ? signedInKeychain() : { read: async () => null, write: async () => {}, remove: async () => {} }, identityUpstream: null, log: () => {} })
  cleanup.push(() => host.stop())
  const post = (path: string, body: unknown, authenticated = true) => fetch(`${host.origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { [LOCAL_SESSION_HEADER]: host.sessionToken } : {}) }, body: JSON.stringify(body) })
  return { host, post }
}

test("retired write routes never reach the upstream; private replay still does", async () => {
  const seen: Array<{ path: string; body: unknown; authorization: string | null }> = []
  const { post } = await fixture(async request => {
    if (request.method === "GET") return Response.json({ status: "ok" })
    seen.push({ path: new URL(request.url).pathname, body: await request.json(), authorization: request.headers.get("authorization") })
    return Response.json({ status: "ok", batches: [] })
  })
  for (const path of ["/api/agent/turn", "/api/agent/turn/cancel", "/api/agent/turn/retire", "/api/chat/turn", "/api/chat/cancel"]) expect((await post(path, turn)).status).toBe(404)
  expect(seen).toEqual([])
  const access = { runId: turn.runId, journal: turn.journal }
  expect(await (await post(TURN_REPLAY_PATH, access)).json()).toEqual({ status: "ok", batches: [] })
  expect(seen).toEqual([{ path: TURN_REPLAY_PATH, body: access, authorization: "Bearer backend-test-token" }])
})

test("proof-only erase survives sign-out while replay remains authenticated", async () => {
  const calls: Array<{ path: string; body: unknown; authorization: string | null }> = []
  const { post } = await fixture(async request => {
    calls.push({ path: new URL(request.url).pathname, body: await request.json(), authorization: request.headers.get("authorization") })
    return Response.json({ status: "retired" })
  }, false)
  const proof = { runId: turn.runId, legId: turn.journal.legId, retirementProof: "b".repeat(64) }
  expect((await post(TURN_REPLAY_PATH, { runId: turn.runId, journal: turn.journal })).status).toBe(401)
  expect(await (await post(TURN_ERASE_PATH, proof)).json()).toEqual({ status: "retired" })
  expect(calls).toEqual([{ path: TURN_ERASE_PATH, body: proof, authorization: null }])
})
