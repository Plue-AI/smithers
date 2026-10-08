import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  const app = await startLocalServer({ port: 0, distDir: dist, backendApi: backend.url.origin, log: () => {} })
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

// T-COL-08: the shipped route forwards code documents; the backend decides.
// The upstream fixture answers like a dark install, not a document provider.
test("live route forwards code document subscriptions to the backend gate", async () => {
  const dist = await mkdtemp(join(tmpdir(), "col08-forward-"))
  await writeFile(join(dist, "index.html"), "<div></div>")
  const forwarded: unknown[] = []
  const backend = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (request, server) => {
      if (server.upgrade(request, { headers: { "sec-websocket-protocol": "smithers.live.v1" } })) return
      return new Response("upgrade required", { status: 400 })
    },
    websocket: { message: (socket, raw) => {
      const frame = JSON.parse(String(raw)) as { t: string; id: number; topic: string }
      forwarded.push(frame)
      socket.send(frame.topic.startsWith("doc:code:") ? JSON.stringify({ t: "err", id: frame.id, code: "unsupported" }) : String(raw))
    } }
  })
  const app = await startLocalServer({ port: 0, distDir: dist, backendApi: backend.url.origin, log: () => {} })
  let socket: WebSocket | undefined
  try {
    const frames: unknown[] = []
    await new Promise<void>((resolve, reject) => {
      socket = new WebSocket(app.origin.replace("http:", "ws:") + "/api/live", {
        headers: { origin: app.origin, "sec-websocket-protocol": "smithers.live.v1" }
      } as never)
      socket.onopen = () => socket!.send('{"t":"sub","id":1,"topic":"doc:code:12:retry.ts"}')
      socket.onerror = () => reject(new Error("route failed"))
      socket.onclose = () => reject(new Error("document refusal closed shared socket"))
      socket.onmessage = event => {
        frames.push(JSON.parse(event.data as string))
        if (frames.length === 1) socket!.send('{"t":"sub","id":2,"topic":"home"}')
        else resolve()
      }
    })
    expect(forwarded).toEqual([{ t: "sub", id: 1, topic: "doc:code:12:retry.ts" }, { t: "sub", id: 2, topic: "home" }])
    expect(frames).toEqual([{ t: "err", id: 1, code: "unsupported" }, { t: "sub", id: 2, topic: "home" }])
    expect(socket!.readyState).toBe(WebSocket.OPEN)
  } finally { socket?.close(); await app.stop(); backend.stop(true); await rm(dist, { recursive: true, force: true }) }
}, 10000)
