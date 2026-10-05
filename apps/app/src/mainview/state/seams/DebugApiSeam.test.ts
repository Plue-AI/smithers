import { expect, test } from "bun:test"
import { createDebugApiSeam } from "./DebugApiSeam"
import { apiFixture, expectedOperations } from "./DebugApiFixtures.test-support"
const setup = (fetchImpl: (url: string, init: RequestInit) => Promise<Response> = async () => new Response('{"items":[]}')) => {
  let n = 0
  const calls: { url: string; init: RequestInit }[] = []
  const gates = { view: true, catalog: true, authorizer: true }
  const seam = createDebugApiSeam({ document: async () => apiFixture, origin: "http://mini.local", gates: () => gates, uuid: () => `key-${++n}`,
    fetch: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init) } })
  return { seam, gates, calls }
}
test("selection allowlists install-composition operations, excludes /api/admin and off-origin, without fetch", async () => {
  const { seam, calls } = setup()
  await seam.open("getStack")
  expect(seam.get().model.operations).toEqual(expectedOperations)
  expect(calls).toEqual([])
  seam.select("readFile")
  expect(seam.get().fields).toEqual([{ name: "path:path", label: "path", kind: "text", required: true }, { name: "query:line", label: "line", kind: "text", required: false }])
  await seam.send({ operationId: "readFile", values: { "path:path": "read me.ts", "query:line": "2" } })
  expect(calls[0]!.url).toBe("http://mini.local/api/files/read%20me.ts?line=2")
})
for (const key of ["view", "catalog", "authorizer"] as const) test(`unavailable ${key} refuses before schema load and fetch`, async () => {
  const { seam, gates, calls } = setup()
  gates[key] = false
  await expect(seam.open()).rejects.toThrow("unavailable")
  await expect(seam.send({ operationId: "getStack" })).rejects.toThrow("unavailable")
  expect(calls).toEqual([])
})
test("mutation confirmation, edits, retries and idempotency", async () => {
  let attempts = 0
  const { seam, calls } = setup(async () => new Response("{}", { status: ++attempts === 1 ? 503 : 200 }))
  await seam.open("putSecrets")
  const input = { operationId: "putSecrets", values: { body: '{"name":"CI","value":"private"}' } }
  await seam.send(input)
  expect(calls).toHaveLength(0)
  expect(JSON.stringify(seam.get())).not.toContain("private")
  const stale = seam.get().confirmation
  await expect(seam.send({ ...input, intent: "confirm", confirmation: stale, values: { body: '{"name":"changed"}' } })).rejects.toThrow("stale")
  expect(calls).toHaveLength(0)
  await seam.send(input)
  await seam.send({ ...input, intent: "confirm", confirmation: seam.get().confirmation })
  expect(JSON.stringify(seam.get())).not.toContain("private")
  const key = new Headers(calls[0]!.init.headers).get("Idempotency-Key")
  await seam.send(input)
  await seam.send({ ...input, intent: "confirm", confirmation: seam.get().confirmation })
  expect(new Headers(calls[1]!.init.headers).get("Idempotency-Key")).toBe(key)
  expect(calls[0]!.init).toMatchObject({ method: "PUT", credentials: "same-origin", redirect: "error", body: input.values.body })
  await seam.send(input)
  await seam.send({ ...input, intent: "confirm", confirmation: seam.get().confirmation })
  expect(new Headers(calls[2]!.init.headers).get("Idempotency-Key")).not.toBe(key)
})
test("typed 401 and sensitive headers, redirects, malformed JSON and unknown inputs", async () => {
  const { seam, calls } = setup(async () => new Response('{"code":"signed_out","class":"permission","message":"Sign in"}', { status: 401,
    headers: { "Set-Cookie": "private", Authorization: "private", "Content-Type": "application/json" } }))
  await seam.open("getStack")
  await seam.send({ operationId: "getStack" })
  expect(seam.get().model.exchange?.failure).toEqual({ class: "permission", message: "Sign in", status: 401 })
  expect(seam.get().model.exchange?.response?.headers).toEqual([["content-type", "application/json"]])
  await expect(seam.send({ operationId: "offOrigin" })).rejects.toThrow("Unknown")
  await expect(seam.send({ operationId: "getStack", values: { url: "https://elsewhere.test" } })).rejects.toThrow("Unknown")
  await expect(seam.send({ operationId: "putSecrets", values: { body: "invalid" } })).rejects.toThrow("JSON")
  expect(calls).toHaveLength(1)
  const redirected = setup(async () => { const response = new Response("", { status: 302 }); Object.defineProperty(response, "redirected", { value: true }); return response })
  await redirected.seam.open("getStack"); await redirected.seam.send({ operationId: "getStack" })
  expect(redirected.seam.get().model.exchange?.failure?.message).toBe("API redirect refused")
  expect(redirected.calls).toHaveLength(1)
})
test("pending requests deduplicate; a stale response cannot overwrite a newer selection", async () => {
  let finish!: (response: Response) => void
  const { seam, calls } = setup(() => new Promise(resolve => { finish = resolve }))
  await seam.open("getStack")
  const running = seam.send({ operationId: "getStack" })
  await seam.send({ operationId: "getStack" })
  expect(calls).toHaveLength(1)
  seam.select("readFile")
  finish(new Response("old")); await running
  expect(seam.get().model.selected).toBe("readFile")
  expect(seam.get().model.exchange).toBeUndefined()
  seam.dispose()
  expect(seam.get().model.operations).toEqual([])
  await expect(seam.open()).rejects.toThrow("unavailable")
})
const TICKET = `${"a1".repeat(32)}.eyJzZXNzaW9uX2hhc2giOiJhYmMifQ`
test("an unclassified response masks credential-named and token-shaped strings, fail closed", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567"
  const { seam } = setup(async () => Response.json({ name: "main", head: sha, session_token: "plain-private", nested: [{ apiKey: "k-private", count: 3 }],
    note: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", blob: "Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MGFiY2RlZmdo", cookie: "sid=private" }))
  await seam.open("getStack")
  await seam.send({ operationId: "getStack" })
  const body = JSON.parse(seam.get().model.exchange!.response!.body!)
  expect(body).toEqual({ name: "main", head: sha, session_token: "[redacted]", nested: [{ apiKey: "[redacted]", count: 3 }],
    note: "[redacted]", blob: "[redacted]", cookie: "[redacted]" })
})
test("the SSE ticket operation's response never reaches the response pane", async () => {
  const { seam, calls } = setup(async () => Response.json({ ticket: TICKET, expires_at: "2026-10-05T12:00:00Z" }))
  await seam.open("post_api_auth_sse_ticket")
  await seam.send({ operationId: "post_api_auth_sse_ticket" })
  await seam.send({ operationId: "post_api_auth_sse_ticket", intent: "confirm", confirmation: seam.get().confirmation })
  expect(calls).toHaveLength(1)
  expect(seam.get().model.exchange?.response?.status).toBe(200)
  expect(JSON.stringify(seam.get())).not.toContain("a1a1a1")
  expect(JSON.stringify(seam.get())).not.toContain("eyJzZXNzaW9u")
})
test("a failure message from the response body is masked before the seam keeps it", async () => {
  const { seam } = setup(async () => Response.json({ class: "infra", message: `bad ticket ${TICKET}` }, { status: 500 }))
  await seam.open("getStack")
  await seam.send({ operationId: "getStack" })
  expect(seam.get().model.exchange?.failure?.message).not.toContain("a1a1a1")
})
test("an account change aborts the in-flight Send, publishes nothing late, and clears pending state", async () => {
  let finish!: (response: Response) => void
  const { seam, calls } = setup(() => new Promise(resolve => { finish = resolve }))
  await seam.open("putSecrets")
  const input = { operationId: "putSecrets", values: { body: '{"name":"CI"}' } }
  await seam.send(input)
  const confirmation = seam.get().confirmation
  const running = seam.send({ ...input, intent: "confirm", confirmation })
  expect(seam.get().busy).toBe(true)
  seam.endAccount()
  expect(calls[0]!.init.signal?.aborted).toBe(true)
  finish(Response.json({ name: "CI" })); await running
  const after = seam.get()
  expect(after.busy).toBeFalsy()
  expect(after.confirmation).toBeUndefined()
  expect(after.model.exchange).toBeUndefined()
  expect(after.model.pending).toBeUndefined()
  expect(JSON.stringify(after)).not.toContain("CI")
  await seam.send(input)
  await expect(seam.send({ ...input, intent: "confirm", confirmation })).rejects.toThrow("stale")
  expect(calls).toHaveLength(1)
})
test("a confirmation is consumed by its execution; re-submitting it is stale and never fetches again", async () => {
  const { seam, calls } = setup(async () => new Response("{}", { status: 200 }))
  await seam.open("putSecrets")
  const input = { operationId: "putSecrets", values: { body: '{"name":"CI"}' } }
  await seam.send(input)
  const confirmation = seam.get().confirmation
  await seam.send({ ...input, intent: "confirm", confirmation })
  expect(calls).toHaveLength(1)
  await expect(seam.send({ ...input, intent: "confirm", confirmation })).rejects.toThrow("stale")
  expect(calls).toHaveLength(1)
})
test("a failed confirmed Send needs a fresh confirmation and keeps its retry identity", async () => {
  let attempts = 0
  const { seam, calls } = setup(async () => new Response("{}", { status: ++attempts === 1 ? 503 : 200 }))
  await seam.open("putSecrets")
  const input = { operationId: "putSecrets", values: { body: '{"name":"CI"}' } }
  await seam.send(input)
  const confirmation = seam.get().confirmation
  await seam.send({ ...input, intent: "confirm", confirmation })
  await expect(seam.send({ ...input, intent: "confirm", confirmation })).rejects.toThrow("stale")
  await seam.send(input)
  await seam.send({ ...input, intent: "confirm", confirmation: seam.get().confirmation })
  expect(calls).toHaveLength(2)
  expect(new Headers(calls[1]!.init.headers).get("Idempotency-Key")).toBe(new Headers(calls[0]!.init.headers).get("Idempotency-Key"))
})
