import { expect, spyOn, test } from "bun:test"
import { createServer } from "node:http"
import { once } from "node:events"
import { relayRpc, writeResponse } from "./workerRelay"

const request = (body: unknown) => new Request("http://relay.test/api/workflow/rpc", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })
const valid = { repo: "ada/repo", procedure: "List", payload: { _tag: "flows" }, workspaceId: "5b0c4f7e-2d1a-4c3b-9e8f-1a2b3c4d5e6f" }
const { workspaceId: _box, ...boxless } = valid
const fixture = () => {
  const seen: { authorization: string | null; body: string }[] = []
  const server = Bun.serve({ port: 0, async fetch(req) {
    seen.push({ authorization: req.headers.get("authorization"), body: await req.text() })
    return new Response(JSON.stringify({ _tag: "Exit", requestId: "0", exit: { _tag: "Success", value: ["flow"] } }) + "\n")
  } })
  return { seen, server, url: `http://localhost:${server.port}` }
}

test.each([
  [{ ...valid, procedure: "constructor" }, "procedure_not_relayed"],
  [{ ...valid, procedure: "absent" }, "procedure_not_relayed"],
  [{ ...valid, repo: "bad" }, "request_invalid"],
  [{ ...valid, repo: "../repo" }, "request_invalid"],
  [{ ...valid, repo: "ada/.." }, "request_invalid"],
  [{ ...valid, repo: "ada/repo/path" }, "request_invalid"],
  [{ ...valid, repo: "ada/repo?secret=x" }, "request_invalid"],
  [null, "request_invalid"],
  [{ ...valid, procedure: "" }, "request_invalid"],
  [{ ...valid, workspaceId: "bad" }, "request_invalid"],
  [boxless, "request_invalid"],
  ["{not json", "request_body_not_json"]
] as const)("the relay refuses invalid requests before forwarding %j", async (body, code) => {
  const f = fixture()
  try {
    const response = await relayRpc(request(body), f.url, "fixture-credential")
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ status: "error", code })
    expect(f.seen).toHaveLength(0)
  } finally { f.server.stop(true) }
})

test("an admitted call crosses the real HTTP seam with its credential and canonical gateway frame", async () => {
  const f = fixture(), forwarded: string[] = []
  try {
    const response = await relayRpc(request(valid), f.url, "fixture-credential", name => forwarded.push(name))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, payload: ["flow"] })
    expect(forwarded).toEqual(["List"])
    expect(f.seen).toHaveLength(1)
    expect(f.seen[0]!.authorization).toBe("Bearer fixture-credential")
    expect(JSON.parse(f.seen[0]!.body)).toEqual({ _tag: "Request", id: 1, tag: "List", payload: { _tag: "flows" }, headers: [] })
  } finally { f.server.stop(true) }
})

test("an unframed upstream refusal keeps the backend RPC envelope", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("private upstream debug", { status: 503 }) })
  try {
    const response = await relayRpc(request(valid), `http://localhost:${server.port}`, "fixture-credential")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: false, error: { message: "The workspace answered HTTP 503." } })
  } finally { server.stop(true) }
})

test("the relay enforces request and upstream byte limits", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("x".repeat(4 * 1024 * 1024 + 1)) })
  try {
    const base = `http://localhost:${server.port}`
    const requestRefusal = await relayRpc(request({ ...valid, payload: "x".repeat(1024 * 1024) }), base, "fixture-credential")
    expect(requestRefusal.status).toBe(413)
    expect(await requestRefusal.json()).toMatchObject({ code: "request_body_too_large" })
    const response = await relayRpc(request(valid), base, "fixture-credential")
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ code: "upstream_malformed" })
  } finally { server.stop(true) }
})


test("a chunked request is measured in UTF-8 bytes and cancelled at the cap", async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...valid, payload: "界".repeat(400_000) })))
    },
    cancel() { cancelled = true }
  })
  const incoming = new Request("http://relay.test/api/workflow/rpc", { method: "POST", body })
  const f = fixture()
  try {
    expect((await relayRpc(incoming, f.url, "fixture-credential")).status).toBe(413)
    expect(cancelled).toBe(true)
    expect(f.seen).toEqual([])
  } finally { f.server.stop(true) }
})

test("an empty request never reaches the gateway", async () => {
  const f = fixture()
  try {
    const response = await relayRpc(new Request("http://relay.test", { method: "POST" }), f.url, "fixture-credential")
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: "request_body_not_json", origin: "local" })
    expect(f.seen).toEqual([])
  } finally { f.server.stop(true) }
})

test("UTF-8 split across streamed chunks remains intact", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...valid, repo: "Ada/project.v2-test_1", payload: "界" }))
  const split = bytes.indexOf(0xe7) + 1
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes.slice(0, split))
    controller.enqueue(bytes.slice(split))
    controller.close()
  } })
  const f = fixture()
  try {
    const incoming = new Request("http://relay.test", { method: "POST", body })
    expect((await relayRpc(incoming, f.url, "fixture-credential")).status).toBe(200)
    expect(JSON.parse(f.seen[0]!.body).payload).toBe("界")
  } finally { f.server.stop(true) }
})

test("the exact request byte limit is admitted", async () => {
  const padding = 1024 * 1024 - new TextEncoder().encode(JSON.stringify({ ...valid, payload: "" })).byteLength
  const f = fixture()
  try {
    const response = await relayRpc(request({ ...valid, payload: "x".repeat(padding) }), f.url, "fixture-credential")
    expect(response.status).toBe(200)
    expect(f.seen).toHaveLength(1)
  } finally { f.server.stop(true) }
})

test("the exact answer byte limit is admitted", async () => {
  const frame = JSON.stringify({ _tag: "Exit", exit: { _tag: "Success", value: "" } })
  const text = frame.replace('"value":""', '"value":"' + "x".repeat(4 * 1024 * 1024 - frame.length) + '"')
  const server = Bun.serve({ port: 0, fetch: () => new Response(text) })
  try {
    const response = await relayRpc(request(valid), `http://localhost:${server.port}`, "fixture-credential")
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.payload.length).toBe(4 * 1024 * 1024 - frame.length)
  } finally { server.stop(true) }
})

test("deadlines and caller cancellation settle a gateway that never answers", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
  try {
    const url = `http://localhost:${server.port}`
    const response = await relayRpc(request(valid), url, "fixture-credential", undefined, { timeoutMs: 15 })
    expect(response.status).toBe(504)
    expect(await response.json()).toMatchObject({ code: "upstream_timeout", origin: "local" })
    const controller = new AbortController()
    const incoming = new Request(request(valid), { signal: controller.signal })
    const pending = relayRpc(incoming, url, "fixture-credential")
    controller.abort()
    const cancelled = await pending
    expect(cancelled.status).toBe(502)
    expect(await cancelled.json()).toMatchObject({ code: "upstream_unreachable" })
  } finally { server.stop(true) }
})

test("redirects cannot forward the gateway credential to another origin", async () => {
  let redirected = 0
  const destination = Bun.serve({ port: 0, fetch: () => { redirected += 1; return new Response("private") } })
  const gateway = Bun.serve({ port: 0, fetch: () => Response.redirect(`http://localhost:${destination.port}/steal`, 302) })
  try {
    const response = await relayRpc(request(valid), `http://localhost:${gateway.port}`, "fixture-credential")
    expect(await response.json()).toEqual({ ok: false, error: { message: "The workspace answered HTTP 302." } })
    expect(redirected).toBe(0)
  } finally { gateway.stop(true); destination.stop(true) }
})

test("writeResponse preserves status, headers and body across a real Node HTTP server", async () => {
  const server = createServer((_request, response) => {
    void writeResponse(new Response("界", { status: 202, headers: { "x-receipt": "accepted" } }), response)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("Missing HTTP address")
    const response = await fetch(`http://127.0.0.1:${address.port}`)
    expect(response.status).toBe(202)
    expect(response.headers.get("x-receipt")).toBe("accepted")
    expect(await response.text()).toBe("界")
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

test("an unreadable request body is refused before forwarding", async () => {
  const f = fixture()
  try {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private request diagnostic")) } })
    const response = await relayRpc(new Request("http://relay.test", { method: "POST", body }), f.url, "fixture-credential")
    expect(await response.json()).toMatchObject({ code: "request_body_not_json" })
    expect(f.seen).toEqual([])
  } finally { f.server.stop(true) }
})

test("an empty gateway answer remains a readable RPC failure", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response(null) })
  try {
    const response = await relayRpc(request(valid), `http://localhost:${server.port}`, "fixture-credential")
    expect(await response.json()).toEqual({ ok: false, error: { message: "The workspace answered with nothing." } })
  } finally { server.stop(true) }
})

test("a broken gateway body produces a bounded refusal", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.write('{"private":"partial')
    setTimeout(() => response.destroy(), 15)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("Missing HTTP address")
    const response = await relayRpc(request(valid), `http://127.0.0.1:${address.port}`, "fixture-credential")
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ code: "upstream_unreachable", message: "The workspace answer broke off before it ended." })
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})


test("a request cancellation failure cannot replace the body-limit refusal", async () => {
  let cancellations = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) },
    cancel() { cancellations += 1; throw new Error("private cleanup failure") }
  })
  const f = fixture()
  try {
    const response = await relayRpc(new Request("http://relay.test", { method: "POST", body }), f.url, "fixture-credential")
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ code: "request_body_too_large" })
    expect(cancellations).toBe(1)
    expect(body.locked).toBe(false)
    expect(f.seen).toEqual([])
  } finally { f.server.stop(true) }
})

test("a refusal with an already-broken HTTP body keeps its status and drops private output", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "text/plain" })
    response.write("private upstream partial diagnostic")
    setTimeout(() => response.destroy(), 15)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const nativeFetch = globalThis.fetch
  // Hold the real HTTP response until its stream has errored. This timing
  // adapter makes the socket-close-before-cancel ordering deterministic;
  // the upstream, Response, stream and cancellation remain real.
  const fetchGate = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const response = await nativeFetch(input, init)
    const reader = response.body!.getReader()
    try { while (!(await reader.read()).done) {} }
    catch { /* The real socket closed before its response finished. */ }
    finally { reader.releaseLock() }
    return response
  })
  try {
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("Missing HTTP address")
    const response = await relayRpc(request(valid), `http://127.0.0.1:${address.port}`, "fixture-credential")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: false, error: { message: "The workspace answered HTTP 503." } })
  } finally {
    fetchGate.mockRestore()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

for (const [status, body, headers, expected] of [
  [200, new Uint8Array([0, 0xff, 0xc3, 0xa9]), { "content-type": "application/octet-stream", "x-receipt": "binary" }, [0, 0xff, 0xc3, 0xa9]],
  [503, '{"ok":false,"error":{"message":"No capacity."}}', { "content-type": "application/json", "retry-after": "30" }, Array.from(new TextEncoder().encode('{"ok":false,"error":{"message":"No capacity."}}'))],
  [204, null, { "x-receipt": "empty" }, []]
] as const) {
  test(`writeResponse forwards HTTP ${status} with exact bytes and headers`, async () => {
    const server = createServer((_request, target) => {
      void writeResponse(new Response(body, { status, headers }), target)
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    try {
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("Missing HTTP address")
      const response = await fetch(`http://127.0.0.1:${address.port}`)
      expect(response.status).toBe(status)
      for (const [name, value] of Object.entries(headers)) expect(response.headers.get(name)).toBe(value)
      expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(expected)
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
}

test("writeResponse rejects a failed response read without forwarding private bytes", async () => {
  const fault = new Error("private upstream read failure")
  let recordFailure!: (error: unknown) => void
  const failure = new Promise<unknown>(resolve => { recordFailure = resolve })
  const server = createServer((_request, target) => {
    // An errored Web Response deterministically exercises read failure;
    // status/headers/body transmission still uses a real ServerResponse.
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(fault) } })
    void writeResponse(new Response(body, { status: 503, headers: { "x-receipt": "failed-read" } }), target)
      .catch(error => { recordFailure(error); target.end() })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("Missing HTTP address")
    const response = await fetch(`http://127.0.0.1:${address.port}`)
    expect(await failure).toBe(fault)
    expect(response.status).toBe(503)
    expect(response.headers.get("x-receipt")).toBe("failed-read")
    expect(await response.text()).toBe("")
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
