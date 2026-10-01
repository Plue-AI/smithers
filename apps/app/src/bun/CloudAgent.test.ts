import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TURN_PATH, TURN_REPLAY_PATH, TURN_RETIRE_PATH, TURN_ERASE_PATH, CANCEL_PATH } from "@smthrs/rpc/AgentApiRoutes"
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

test("relay preserves renderer identity, journal seals and delivery bytes; completion never erases the backend journal", async () => {
  const seen: Array<{ path: string; body: unknown; authorization: string | null }> = []
  const cursor = { version: 1, runId: turn.runId, legId: turn.journal.legId, batch: 0, position: 0, hash: "0".repeat(64) }
  const wire = `${JSON.stringify({ type: "accepted", cursor })}\n${JSON.stringify({ type: "caught-up", cursor, terminal: true })}\n`
  const { post } = await fixture(async request => {
    const path = new URL(request.url).pathname
    if (path !== "/api/agent/turn") return Response.json({ status: "ok" })
    seen.push({ path, body: await request.json(), authorization: request.headers.get("authorization") })
    return new Response(wire, { headers: { "content-type": "application/x-ndjson", "x-smithers-turn-journal": "1" } })
  })
  const response = await post(TURN_PATH, turn)
  expect(response.headers.get("x-smithers-turn-journal")).toBe("1")
  expect(await response.text()).toBe(wire)
  await Bun.sleep(20)
  expect(seen).toEqual([{ path: TURN_PATH, body: turn, authorization: "Bearer backend-test-token" }])
})

test("replay, cancellation, retirement and proof-only erasure reach the same backend unchanged", async () => {
  const calls: Array<{ path: string; body: unknown; headers: Record<string, string> }> = []
  const { post } = await fixture(async request => {
    const path = new URL(request.url).pathname
    if (path.startsWith("/api/agent/")) calls.push({ path, body: await request.json(), headers: Object.fromEntries(request.headers) })
    return Response.json({ status: "fixture", path }, { headers: { "set-cookie": "upstream-secret=value" } })
  })
  const values = [
    [TURN_REPLAY_PATH, { runId: turn.runId, journal: turn.journal, after: { batch: 2 } }],
    [CANCEL_PATH, { runId: turn.runId }],
    [TURN_RETIRE_PATH, { runId: turn.runId, journal: turn.journal }],
    [TURN_ERASE_PATH, { runId: turn.runId, legId: turn.journal.legId, retirementProof: "a".repeat(64) }]
  ] as const
  for (const [path, body] of values) {
    const response = await post(path, body)
    expect(await response.json()).toEqual({ status: "fixture", path })
    expect(response.headers.get("set-cookie")).toBeNull()
  }
  expect(calls.map(({ path, body }) => [path, body])).toEqual(values.map(([path, body]) => [path, body]))
  for (const call of calls) {
    expect(call.headers.authorization).toBe("Bearer backend-test-token")
    expect(call.headers[LOCAL_SESSION_HEADER]).toBeUndefined()
  }
})

test("session admission prevents upstream requests; backend refusals and invalid journal identities stay visible", async () => {
  let calls = 0
  const refusal = { status: "conflict", message: "Different accepted request." }
  const { post } = await fixture(request => {
    if (new URL(request.url).pathname !== TURN_PATH) return Response.json({ status: "ok" })
    calls++
    return Response.json(refusal, { status: 409 })
  })
  expect((await post(TURN_PATH, turn, false)).status).toBe(401)
  expect((await post(TURN_PATH, { ...turn, journal: { ...turn.journal, version: 2 } })).status).toBe(400)
  expect(calls).toBe(0)
  const response = await post(TURN_PATH, turn)
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual(refusal)
  expect(calls).toBe(1)
})

test("backend redirects are refused without following the destination", async () => {
  let escaped = 0
  const foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { escaped++; return new Response("private") } })
  cleanup.push(() => foreign.stop(true))
  const { post } = await fixture(request => new URL(request.url).pathname === TURN_PATH
    ? new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${foreign.port}/private` } }) : Response.json({ status: "ok" }))
  const response = await post(TURN_PATH, turn)
  expect(response.status).toBe(502)
  expect(await response.json()).toMatchObject({ code: "upstream_malformed" })
  expect(escaped).toBe(0)
})

test("disconnecting delivery leaves the journal on the backend and replay keeps its original identity", async () => {
  const calls: Array<{ path: string; body: unknown }> = []
  const wire = `${JSON.stringify({ type: "accepted", cursor: { version: 1, runId: turn.runId, legId: turn.journal.legId, batch: 0, position: 0, hash: "0".repeat(64) } })}\n`
  const { post } = await fixture(async request => {
    const path = new URL(request.url).pathname
    if (!path.startsWith("/api/agent/")) return Response.json({ status: "ok" })
    calls.push({ path, body: await request.json() })
    return path === TURN_PATH ? new Response(wire, { headers: { "content-type": "application/x-ndjson", "x-smithers-turn-journal": "1" } })
      : Response.json({ status: "active", original: turn.journal.legId })
  })
  const response = await post(TURN_PATH, turn)
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(wire)
  void reader.cancel().catch(() => {})
  const access = { runId: turn.runId, journal: turn.journal }
  expect(await (await post(TURN_REPLAY_PATH, access)).json()).toEqual({ status: "active", original: turn.journal.legId })
  expect(calls).toEqual([{ path: TURN_PATH, body: turn }, { path: TURN_REPLAY_PATH, body: access }])
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
