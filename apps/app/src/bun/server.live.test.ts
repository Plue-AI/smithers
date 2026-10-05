import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createChatStub } from "../../e2e/support/ChatStub"
import { startLocalServer } from "./server"

test("live upgrade forwards session, origin, protocol and frames to the product backend", async () => {
  const dist = await mkdtemp(join(tmpdir(), "app08-live-"))
  await writeFile(join(dist, "index.html"), "<div></div>")
  let headers: Headers | undefined
  const backend = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (request, server) => {
      headers = request.headers
      if (server.upgrade(request, { headers: { "sec-websocket-protocol": "smithers.live.v1" } })) return
      return new Response("upgrade required", { status: 400 })
    },
    websocket: { message: (socket, raw) => { socket.send(raw) } }
  })
  const app = await startLocalServer({ port: 0, distDir: dist, agent: createChatStub, backendApi: backend.url.origin, log: () => {} })
  let socket: WebSocket | undefined
  try {
    const received = await new Promise<string>((resolve, reject) => {
      socket = new WebSocket(app.origin.replace("http:", "ws:") + "/api/live", {
        headers: { origin: app.origin, cookie: "session=fixture", authorization: "Bearer delegated-fixture", "sec-websocket-protocol": "smithers.live.v1" }
      } as never)
      socket.onopen = () => socket!.send('{"t":"sub","id":1,"topic":"home"}')
      socket.onmessage = event => resolve(event.data as string)
      socket.onerror = () => reject(new Error("live bridge failed"))
    })
    expect(received).toBe('{"t":"sub","id":1,"topic":"home"}')
    expect(headers?.get("cookie")).toBe("session=fixture")
    expect(headers?.get("authorization")).toBe("Bearer delegated-fixture")
    expect(headers?.get("origin")).toBe(app.origin)
    expect(headers?.get("sec-websocket-protocol")).toBe("smithers.live.v1")
    const forbidden = await fetch(app.origin + "/api/live", { headers: { origin: "http://outsider.invalid", "sec-websocket-protocol": "smithers.live.v1" } })
    expect(forbidden.status).toBeGreaterThanOrEqual(400)
  } finally { socket?.close(); await app.stop(); backend.stop(true); await rm(dist, { recursive: true, force: true }) }
}, 10000)

// T-COL-08 Scope In 3: exercise the shipped route, not a LiveSocket fake.
// The upstream is a transport fixture that answers like the backend's document admission:
// a TODO branch gets a snapshot, any other ref gets err unsupported.
test("production live route forwards document subs and binary frames upstream", async () => {
  const dist = await mkdtemp(join(tmpdir(), "s3-doc-"))
  await writeFile(join(dist, "index.html"), "<div></div>")
  const upstreamFrames: (string | number[])[] = []
  const backend = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (request, server) => {
      if (server.upgrade(request, { headers: { "sec-websocket-protocol": "smithers.live.v1" } })) return
      return new Response("upgrade required", { status: 400 })
    },
    websocket: { message: (socket, raw) => {
      if (typeof raw !== "string") { upstreamFrames.push([...new Uint8Array(raw)]); socket.send(raw); return }
      upstreamFrames.push(raw)
      const frame = JSON.parse(raw) as { t: string; id: number; topic: string }
      if (frame.t === "sub" && /^doc:code:T[1-9][0-9]*:/.test(frame.topic)) {
        socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: 0, data: { epoch: "00112233445566778899aabbccddeeff", client_id: 42 } }))
      } else if (frame.t === "sub" && frame.topic.startsWith("doc:code:")) socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" }))
      else socket.send(raw)
    } }
  })
  const app = await startLocalServer({ port: 0, distDir: dist, agent: createChatStub, backendApi: backend.url.origin, log: () => {} })
  let socket: WebSocket | undefined
  try {
    const frames: unknown[] = []
    await new Promise<void>((resolve, reject) => {
      socket = new WebSocket(app.origin.replace("http:", "ws:") + "/api/live", {
        headers: { origin: app.origin, "sec-websocket-protocol": "smithers.live.v1" }
      } as never)
      socket.binaryType = "arraybuffer"
      socket.onopen = () => socket!.send('{"t":"sub","id":1,"topic":"doc:code:T12:retry.ts"}')
      socket.onerror = () => reject(new Error("route failed"))
      socket.onclose = () => reject(new Error("document frames closed the shared socket"))
      socket.onmessage = event => {
        frames.push(typeof event.data === "string" ? JSON.parse(event.data) : [...new Uint8Array(event.data as ArrayBuffer)])
        if (frames.length === 1) socket!.send(Uint8Array.from([1, 0, 0, 0, 1, 0, 1, 0]))
        else if (frames.length === 2) socket!.send('{"t":"sub","id":2,"topic":"doc:code:main:retry.ts"}')
        else resolve()
      }
    })
    expect(frames).toEqual([
      { t: "snap", id: 1, cursor: 0, data: { epoch: "00112233445566778899aabbccddeeff", client_id: 42 } },
      [1, 0, 0, 0, 1, 0, 1, 0],
      { t: "err", id: 2, code: "unsupported" }
    ])
    expect(upstreamFrames).toEqual(['{"t":"sub","id":1,"topic":"doc:code:T12:retry.ts"}', [1, 0, 0, 0, 1, 0, 1, 0], '{"t":"sub","id":2,"topic":"doc:code:main:retry.ts"}'])
    // An upstream refusal of one document leaves the shared socket serving every other topic.
    expect(socket!.readyState).toBe(WebSocket.OPEN)
    const ordinary = await new Promise<string>((resolve, reject) => {
      socket!.onmessage = event => resolve(event.data as string)
      socket!.onerror = () => reject(new Error("ordinary subscription failed"))
      socket!.send('{"t":"sub","id":3,"topic":"home"}')
    })
    expect(ordinary).toBe('{"t":"sub","id":3,"topic":"home"}')
  } finally { socket?.close(); await app.stop(); backend.stop(true); await rm(dist, { recursive: true, force: true }) }
}, 10000)

test("production live route keeps its frame-size guard on document frames", async () => {
  const dist = await mkdtemp(join(tmpdir(), "s3-doc-cap-"))
  await writeFile(join(dist, "index.html"), "<div></div>")
  let received = 0
  const backend = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (request, server) => {
      if (server.upgrade(request, { headers: { "sec-websocket-protocol": "smithers.live.v1" } })) return
      return new Response("upgrade required", { status: 400 })
    },
    websocket: { message: () => { received++ } }
  })
  const app = await startLocalServer({ port: 0, distDir: dist, agent: createChatStub, backendApi: backend.url.origin, log: () => {} })
  let socket: WebSocket | undefined
  try {
    const code = await new Promise<number>((resolve, reject) => {
      socket = new WebSocket(app.origin.replace("http:", "ws:") + "/api/live", {
        headers: { origin: app.origin, "sec-websocket-protocol": "smithers.live.v1" }
      } as never)
      socket.onopen = () => socket!.send(new Uint8Array(3 * 1024 * 1024))
      socket.onerror = () => {}
      socket.onclose = event => resolve(event.code)
      setTimeout(() => reject(new Error("oversized document frame was not refused")), 8000)
    })
    expect([1006, 1009]).toContain(code)
    expect(received).toBe(0)
  } finally { socket?.close(); await app.stop(); backend.stop(true); await rm(dist, { recursive: true, force: true }) }
}, 10000)

test("production live route with no backend document route closes instead of hanging the card", async () => {
  const dist = await mkdtemp(join(tmpdir(), "s3-doc-down-"))
  await writeFile(join(dist, "index.html"), "<div></div>")
  let upgrades = 0
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { upgrades++; return new Response("unavailable", { status: 503 }) } })
  const app = await startLocalServer({ port: 0, distDir: dist, agent: createChatStub, backendApi: backend.url.origin, log: () => {} })
  let socket: WebSocket | undefined
  try {
    const frames: unknown[] = []
    await new Promise<void>((resolve, reject) => {
      socket = new WebSocket(app.origin.replace("http:", "ws:") + "/api/live", {
        headers: { origin: app.origin, "sec-websocket-protocol": "smithers.live.v1" }
      } as never)
      socket.onopen = () => socket!.send('{"t":"sub","id":1,"topic":"doc:code:T12:retry.ts"}')
      socket.onmessage = event => frames.push(event.data)
      socket.onclose = () => resolve()
      setTimeout(() => reject(new Error("renderer socket stayed open")), 8000)
    })
    // The browser channel retries; the File card never received a snapshot, so it stays read-only.
    expect(frames).toEqual([])
    expect(upgrades).toBeGreaterThanOrEqual(1)
  } finally { socket?.close(); await app.stop(); backend.stop(true); await rm(dist, { recursive: true, force: true }) }
}, 10000)
