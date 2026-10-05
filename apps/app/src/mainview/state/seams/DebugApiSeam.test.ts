import { expect, test } from "bun:test"
import { createDebugApiSeam, debugApiFailureCopy, RESPONSE_TEXT_CAP } from "./DebugApiSeam"
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
test("an unenumerated failure class never reaches the exchange or durable copy", async () => {
  const { seam } = setup(async () => Response.json({ class: "private_password", message: "x" }, { status: 500 }))
  await seam.open("getStack"); await seam.send({ operationId: "getStack" })
  const failure = seam.get().model.exchange!.failure!
  expect(JSON.stringify(failure)).not.toContain("private_password")
  expect(debugApiFailureCopy({ class: "private_password", status: 500 })).toBe("The API answered HTTP 500 (unclassified).")
  expect(debugApiFailureCopy({ class: "permission", status: 403 })).toBe("The API answered HTTP 403 (permission).")
})
test("a subscriber that ends the account as the Send starts stops the confirmed mutation before fetch", async () => {
  const { seam, calls } = setup(async () => Response.json({}))
  await seam.open("putSecrets")
  const input = { operationId: "putSecrets", values: { body: '{"name":"CI"}' } }
  await seam.send(input)
  const confirmation = seam.get().confirmation
  let ended = false
  seam.subscribe(() => { if (seam.get().busy && !ended) { ended = true; seam.endAccount() } })
  await seam.send({ ...input, intent: "confirm", confirmation })
  expect(ended).toBe(true)
  expect(calls).toHaveLength(0)
  expect(seam.get().busy).toBeFalsy()
  expect(seam.get().model.exchange).toBeUndefined()
})
test("an account change clears the selection", async () => {
  const { seam } = setup()
  await seam.open("putSecrets")
  const before = seam.get().epoch
  seam.endAccount()
  expect(seam.get().model.selected).toBeUndefined()
  expect(seam.get().fields).toEqual([])
  expect(seam.get().epoch).not.toBe(before)
})

const AWS_ID = "ASIAIOSFODNN7EXAMPLE", AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", SLACK = "xoxs-abcdefghijklmnop", SHORT = "k_12345", PADDED = "c2VjcmV0cGFkZGVkPQ=="
const EXPLOITS = [AWS_ID, AWS_SECRET, SLACK, SHORT, PADDED]
test("only allowlisted headers show, and an unlisted media type is labeled other", async () => {
  const { seam } = setup(async () => new Response('{"id":1}', { headers: { "Content-Type": "application/json; charset=utf-8", ETag: '"abc123"', "X-Request-Id": "req-1",
    "Retry-After": "30", "X-Debug": AWS_ID, "X-Amz-Secret": AWS_SECRET, Server: SLACK, Link: PADDED } }))
  await seam.open("getStack"); await seam.send({ operationId: "getStack" })
  expect(seam.get().model.exchange!.response!.headers).toEqual([["content-type", "application/json"], ["etag", '"abc123"'], ["retry-after", "30"], ["x-request-id", "req-1"]])
  for (const value of EXPLOITS) expect(JSON.stringify(seam.get())).not.toContain(value)
  const escaped = setup(async () => new Response("opaque", { headers: { "Content-Type": "application/ghp_abcdefghijklmnopqrstuvwxyz0123456789" } }))
  await escaped.seam.open("getStack"); await escaped.seam.send({ operationId: "getStack" })
  expect(escaped.seam.get().model.exchange!.response!.body).toBe("[not shown: 6 bytes, other]")
  expect(JSON.stringify(escaped.seam.get())).not.toContain("ghp_")
})
test("the viewer's own response shows as returned: JSON pretty-printed, text and error bodies as-is up to a cap", async () => {
  const json = setup(async () => Response.json({ id: 7, note: AWS_SECRET, nested: [{ hint: SHORT }] }))
  await json.seam.open("getStack"); await json.seam.send({ operationId: "getStack" })
  expect(json.seam.get().model.exchange!.response!.body).toBe(JSON.stringify({ id: 7, note: AWS_SECRET, nested: [{ hint: SHORT }] }, null, 2))
  const text = setup(async () => new Response("password=small-secret", { headers: { "Content-Type": "text/plain" } }))
  await text.seam.open("getStack"); await text.seam.send({ operationId: "getStack" })
  expect(text.seam.get().model.exchange!.response!.body).toBe("password=small-secret")
  const failed = setup(async () => Response.json({ class: "infra", message: "disk full on mini" }, { status: 500 }))
  await failed.seam.open("getStack"); await failed.seam.send({ operationId: "getStack" })
  expect(failed.seam.get().model.exchange!.failure).toEqual({ class: "infra", message: "disk full on mini", status: 500 })
  expect(failed.seam.get().model.exchange!.response!.body).toContain("disk full on mini")
  const big = setup(async () => new Response("x".repeat(RESPONSE_TEXT_CAP + 10), { headers: { "Content-Type": "text/plain" } }))
  await big.seam.open("getStack"); await big.seam.send({ operationId: "getStack" })
  expect(big.seam.get().model.exchange!.response!.body).toBe(`${"x".repeat(RESPONSE_TEXT_CAP)}\n[truncated: ${RESPONSE_TEXT_CAP + 10} bytes, text/plain]`)
  const binary = setup(async () => new Response("\u0000\u0001", { headers: { "Content-Type": "application/ghp_abcdefghijklmnop" } }))
  await binary.seam.open("getStack"); await binary.seam.send({ operationId: "getStack" })
  expect(binary.seam.get().model.exchange!.response!.body).toBe("[not shown: 2 bytes, other]")
})
test("the request echo and confirm prefills show the viewer's own values", async () => {
  const { seam, calls } = setup(async () => Response.json({}))
  await seam.open("deleteFile")
  await seam.send({ operationId: "deleteFile", values: { "path:path": AWS_ID, "query:line": "4" } })
  expect(seam.get().model.pending).toEqual({ method: "DELETE", path: `/api/files/${AWS_ID}?line=4` })
  expect(seam.get().fields).toEqual([{ name: "path:path", label: "path", kind: "text", required: true, value: AWS_ID }, { name: "query:line", label: "line", kind: "text", required: false, value: "4" }])
  await seam.send({ operationId: "deleteFile", intent: "confirm", confirmation: seam.get().confirmation, values: { "path:path": AWS_ID, "query:line": "4" } })
  expect(calls[0]!.url).toBe(`http://mini.local/api/files/${AWS_ID}?line=4`)
  expect(seam.get().model.exchange!.request.url).toBe(calls[0]!.url)
})
test("a credential-minting operation withholds its response, request echo, URL values and prefills", async () => {
  const { seam, calls } = setup(async () => Response.json({ access_token: "short-private-token" }))
  await seam.open("post_api_oauth2_token")
  const input = { operationId: "post_api_oauth2_token", values: { body: '{"code":"short-private-code"}', "query:state": "private-state" } }
  await seam.send(input)
  expect(seam.get().fields).toEqual([])
  expect(JSON.stringify(seam.get())).not.toContain("private")
  await seam.send({ ...input, intent: "confirm", confirmation: seam.get().confirmation })
  expect(calls[0]!.url).toBe("http://mini.local/api/oauth2/token?state=private-state")
  expect(calls[0]!.init.body).toBe('{"code":"short-private-code"}')
  expect(seam.get().model.exchange!.request.url).toBe("http://mini.local/api/oauth2/token?state=[withheld]")
  expect(seam.get().model.exchange!.request.body).toBe("[withheld]")
  expect(seam.get().model.exchange!.response!.body).toBe("[withheld]")
  expect(JSON.stringify(seam.get())).not.toContain("private")
})
test("the confirmation shows a random id the pending request holds; the same request gets a fresh id each time", async () => {
  const { seam, calls } = setup(async () => Response.json({}))
  await seam.open("deleteFile")
  const input = { operationId: "deleteFile", values: { "path:path": "a.ts" } }
  await seam.send(input)
  const first = seam.get().target
  await seam.send(input)
  const second = seam.get().target
  expect(first).toBeTruthy(); expect(second).toBeTruthy(); expect(second).not.toBe(first)
  await seam.send({ ...input, intent: "confirm", confirmation: seam.get().confirmation, values: { "path:path": "b.ts" } }).catch(() => {})
  expect(calls).toHaveLength(0)
  await seam.send(input)
  await seam.send({ ...input, intent: "confirm", confirmation: seam.get().confirmation })
  expect(calls).toHaveLength(1)
})
