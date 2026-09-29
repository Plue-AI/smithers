/* The cloud-workspace terminal transport against a real WebSocket server. */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { createCloudTerminalClient, pageCloudSocketUrl } from "./CloudTerminalClient"
import type { CloudTerminalClient } from "./CloudTerminalClient"

// Real sockets on a loaded CI runner: the per-test ceiling follows the wait helper's.
setDefaultTimeout(60_000)

interface Harness {
  readonly url: string
  readonly seen: Array<string | Buffer>
  readonly protocols: Array<string | null>
  /** Sockets the server currently holds open. */
  readonly live: () => number
  readonly output: (data: string) => void
  readonly outputBytes: (data: Uint8Array) => void
  readonly stop: () => void
}

/*
 * A Bun server cannot put 1001, 1005 or 1006 on the wire: `close(1001, …)`
 * arrives at the client as 1000 (verified on Bun 1.3.14 and 1.4.0, Linux and
 * macOS alike), which is the client's "session closed, never redial". So the
 * reconnect path is driven the way a real drop reaches a renderer — by
 * `terminate()`, the abnormal 1006 close — and the tunnel translates plue's
 * 1001 into exactly that (src/bun/server.ts, `closeRenderer`).
 */
interface ServeOptions {
  /** What the server does to each socket as it opens (close it with a code, say). */
  readonly onOpen?: (socket: { send: (data: string | Uint8Array) => void; close: (code?: number, reason?: string) => void; terminate: () => void }) => void
}

const harnesses: Array<Harness> = []

const serve = (options: ServeOptions = {}): Harness => {
  const seen: Array<string | Buffer> = []
  const protocols: Array<string | null> = []
  const open = new Set<
    { send: (data: string | ArrayBuffer) => void; close: (code?: number, reason?: string) => void; terminate: () => void }
  >()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, self) => {
      protocols.push(request.headers.get("sec-websocket-protocol"))
      return self.upgrade(request) ? undefined : new Response("no")
    },
    websocket: {
      open: (socket) => {
        open.add(socket as never)
        options.onOpen?.(socket as never)
      },
      close: (socket) => void open.delete(socket as never),
      message: (_socket, message) => {
        seen.push(message)
      }
    }
  })
  const harness: Harness = {
    url: `ws://127.0.0.1:${server.port}/tunnel`,
    seen,
    protocols,
    live: () => open.size,
    output: (data) => {
      for (const socket of open) socket.send(new TextEncoder().encode(data) as never)
    },
    outputBytes: (data) => {
      for (const socket of open) socket.send(data as never)
    },
    stop: () => server.stop(true)
  }
  harnesses.push(harness)
  return harness
}

/*
 * Every wait here is on a real loopback WebSocket server, so the ceiling is
 * generous: a two-core CI runner under load takes 7-10x longer to spawn and
 * upgrade than this Mac (the "apps e2e" job timed three of these tests out at
 * exactly 4 s in run 33651343176). A passing test never waits longer than it
 * needs; only a failing one pays the ceiling.
 */
const until = async (predicate: () => boolean, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not pass")
    await Bun.sleep(5)
  }
}

/*
 * Every client this file makes, disposed after the test whether or not it got
 * that far. A test that throws before its own `dispose()` used to leave a
 * client redialing a dead port for the rest of `bun test src` — 165 files of
 * background churn out of one failed wait.
 */
const clients: Array<CloudTerminalClient> = []

afterEach(() => {
  for (const terminal of clients.splice(0)) terminal.dispose()
  for (const harness of harnesses.splice(0)) harness.stop()
})

const track = (terminal: CloudTerminalClient): CloudTerminalClient => {
  clients.push(terminal)
  return terminal
}

const client = (
  server: Harness,
  reconnectMs = 20,
  extra: { readonly maxReconnectMs?: number; readonly maxReconnectsPerMinute?: number; readonly earlyExitMs?: number } = {}
) =>
  track(createCloudTerminalClient({
    auth: "subprotocol",
    socketUrl: () => server.url,
    socketProtocol: () => "smithers.local.test",
    reconnectMs,
    ...extra
  }))

const text = (frame: string | Buffer): string => typeof frame === "string" ? frame : new TextDecoder().decode(frame)

test("output reaches every attachment; input goes out binary; resize goes out as the control frame", async () => {
  const server = serve()
  const terminal = client(server)
  const first: Array<string> = []
  const second: Array<string> = []
  terminal.attach("will/smithers", "sess-1", { onOutput: (data) => first.push(data) })
  terminal.attach("will/smithers", "sess-1", { onOutput: (data) => second.push(data) })
  // The local-session capability rides the subprotocol (the tunnel's authorization).
  await until(() => server.protocols.length > 0)
  expect(server.protocols[0]).toBe("smithers.local.test")

  terminal.input("sess-1", "ls\r")
  terminal.resize("sess-1", 120, 40)
  await until(() => server.seen.length >= 2)
  expect(text(server.seen[0]!)).toBe("ls\r")
  expect(typeof server.seen[0]).not.toBe("string")
  expect(server.seen[1]).toBe(JSON.stringify({ type: "resize", cols: 120, rows: 40 }))

  server.output("total 0\r\n")
  await until(() => first.length === 1 && second.length === 1)
  expect(first).toEqual(["total 0\r\n"])
  expect(second).toEqual(first)
  terminal.dispose()
})

test("cookie auth opens without a token protocol and preserves input and resize frames", async () => {
  const server = serve()
  const terminal = track(createCloudTerminalClient({
    auth: "cookie",
    socketUrl: () => server.url,
    socketProtocol: () => { throw new Error("cookie mode must never read the local capability") }
  }))
  const output: string[] = []
  terminal.attach("will/smithers", "sess-cookie", { onOutput: (data) => output.push(data) })
  terminal.input("sess-cookie", "pwd\r")
  terminal.resize("sess-cookie", 80, 24)
  await until(() => server.seen.length === 2)
  expect(server.protocols).toEqual([null])
  expect(typeof server.seen[0]).not.toBe("string")
  expect(text(server.seen[0]!)).toBe("pwd\r")
  expect(server.seen[1]).toBe(JSON.stringify({ type: "resize", cols: 80, rows: 24 }))
  server.output("/workspace\r\n")
  await until(() => output.length > 0)
  expect(output.join("")).toBe("/workspace\r\n")
})

test("subprotocol auth does not dial without its local capability", async () => {
  const server = serve()
  const terminal = track(createCloudTerminalClient({
    auth: "subprotocol", socketUrl: () => server.url, socketProtocol: () => undefined
  }))
  terminal.attach("will/smithers", "sess-native", { onOutput: () => {} })
  await Bun.sleep(30)
  expect(server.protocols).toEqual([])
})

test("keystrokes sent before the socket opens flush on open", async () => {
  const server = serve()
  const terminal = client(server)
  terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  // Same tick as the attach: the socket cannot be open yet, so the input queues.
  terminal.input("sess-1", "early\r")
  await until(() => server.seen.length >= 1)
  expect(text(server.seen[0]!)).toBe("early\r")
  terminal.dispose()
})

test("keystrokes typed before any view attaches wait for the attach, then lead the session's queue", async () => {
  const server = serve()
  const terminal = client(server)
  // A take-over types its resume line while the terminal view is still loading.
  terminal.input("sess-1", "claude --resume sess-7\r")
  await Bun.sleep(20)
  expect(server.seen).toHaveLength(0)
  terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  terminal.input("sess-1", "ls\r")
  await until(() => server.seen.length >= 2)
  expect(server.seen.map((frame) => text(frame))).toEqual(["claude --resume sess-7\r", "ls\r"])
  terminal.dispose()
})

test("UTF-8 characters survive arbitrary binary frame boundaries", async () => {
  const server = serve()
  const terminal = client(server)
  const output: Array<string> = []
  terminal.attach("will/smithers", "sess-1", { onOutput: (data) => output.push(data) })
  await until(() => server.live() === 1)
  const bytes = new TextEncoder().encode("héllo 😀 世界\r\n")
  for (const byte of bytes) server.outputBytes(new Uint8Array([byte]))
  await until(() => output.join("").endsWith("\r\n"))
  expect(output.join("")).toBe("héllo 😀 世界\r\n")
})

/*
 * The terminal's first fit runs in the same tick as the attach, before any
 * socket can be open. The control frame used to be dropped there, so a cloud
 * session stayed at the upstream's default geometry until the human resized
 * the window — and on a slow runner the same race swallowed the resize the
 * test above sends, timing it out at the wait's own ceiling.
 */
test("the fit sent before the socket opens flushes on open, still as the control frame", async () => {
  const server = serve()
  const terminal = client(server)
  terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  // Same tick as the attach: the socket cannot be open yet.
  terminal.resize("sess-1", 120, 40)
  // A second fit supersedes the first rather than stacking behind it.
  terminal.resize("sess-1", 100, 30)
  terminal.input("sess-1", "ls\r")
  await until(() => server.seen.length >= 2)
  await Bun.sleep(50)
  expect(server.seen.map(text)).toEqual([JSON.stringify({ type: "resize", cols: 100, rows: 30 }), "ls\r"])
  expect(typeof server.seen[0]).toBe("string")
  expect(typeof server.seen[1]).not.toBe("string")
  terminal.dispose()
})

test("a closed socket reconnects while an attachment lives", async () => {
  const first = serve()
  let url = first.url
  const terminal = track(createCloudTerminalClient({
    auth: "subprotocol",
    socketUrl: () => url,
    socketProtocol: () => "smithers.local.test",
    reconnectMs: 20
  }))
  const output: Array<string> = []
  terminal.attach("will/smithers", "sess-1", { onOutput: (data) => output.push(data) })
  // An HTTP upgrade request is not an open socket. Drop only after the
  // connection exists; a transient handshake retry is not the behavior under test.
  await until(() => first.live() === 1)
  first.stop()
  const second = serve()
  url = second.url
  // Wait for the actual socket before sending output, not just the HTTP request.
  await until(() => second.live() === 1)
  second.output("back\r\n")
  await until(() => output.includes("back\r\n"))
  terminal.dispose()
})

/*
 * Critique finding 1: the last detach closed the socket, whose own onclose
 * redialed a tunnel nobody listened to and dispose could not reach.
 */
test("detaching the last attachment closes the socket for good: no redial, nothing left for dispose", async () => {
  const server = serve()
  const terminal = client(server, 10)
  const detach = terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  await until(() => server.protocols.length === 1 && server.live() === 1)
  detach()
  await until(() => server.live() === 0)
  await Bun.sleep(200)
  expect(server.protocols.length).toBe(1)
  terminal.dispose()
  await Bun.sleep(50)
  expect(server.protocols.length).toBe(1)
  expect(server.live()).toBe(0)
})

test("detaching while the socket is still connecting aborts it and never redials (the abort reads as 1006)", async () => {
  const server = serve()
  const terminal = client(server, 10)
  const detach = terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  // Same tick: the handshake is in flight, and closing a CONNECTING socket surfaces as an abnormal 1006 close.
  detach()
  await Bun.sleep(200)
  expect(server.protocols.length).toBeLessThanOrEqual(1)
  expect(server.live()).toBe(0)
  terminal.dispose()
})

test("a drop the server forces while nobody listens never redials either", async () => {
  // The server drops the socket the instant it opens (the abnormal 1006 a "too slow" close reaches the renderer as) — a redial would loop.
  const server = serve({ onOpen: (socket) => socket.terminate() })
  const terminal = client(server, 10)
  const detach = terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  await until(() => server.protocols.length >= 1)
  detach()
  const dials = server.protocols.length
  await Bun.sleep(150)
  // At most the one redial already in flight when the detach landed; never a stream of them.
  expect(server.protocols.length).toBeLessThanOrEqual(dials + 1)
  terminal.dispose()
})

test("dispose closes every socket, attached or reconnecting", async () => {
  const server = serve()
  const terminal = client(server, 10)
  terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  terminal.attach("will/smithers", "sess-2", { onOutput: () => {} })
  await until(() => server.live() === 2)
  terminal.dispose()
  await until(() => server.live() === 0)
  await Bun.sleep(100)
  expect(server.protocols.length).toBe(2)
})

/*
 * Critique finding 2 (renderer half): a refusal the tunnel translated
 * (4401 … 4429), plue's 1008 and 1000 are final; 1011 retries once; 1001
 * and 1006 reconnect with a doubling, capped backoff under a client-wide
 * per-minute budget.
 */
test.each([
  [4401, "sign in to Smithers Cloud"],
  [4403, "this account can't open"],
  [4404, "the session is gone"],
  [4409, "isn't running"],
  [4429, "rate limiting"],
  [1008, "access revoked"],
  [1000, "session closed"]
])("close %i is final: no redial, the listener hears why", async (code, wording) => {
  const server = serve({ onOpen: (socket) => socket.close(code, code === 1008 ? "access revoked: token expired" : "") })
  const terminal = client(server, 10)
  const output: Array<string> = []
  terminal.attach("will/smithers", "sess-1", { onOutput: (data) => output.push(data) })
  await until(() => output.length === 1)
  expect(output[0]).toContain(wording)
  await Bun.sleep(120)
  expect(server.protocols.length).toBe(1)
  terminal.dispose()
})

test("1011 retries once, then is final", async () => {
  const server = serve({ onOpen: (socket) => socket.close(1011, "failed to attach terminal") })
  const terminal = client(server, 10)
  const output: Array<string> = []
  terminal.attach("will/smithers", "sess-1", { onOutput: (data) => output.push(data) })
  await until(() => output.length === 1)
  expect(output[0]).toContain("failed to attach terminal")
  await Bun.sleep(120)
  expect(server.protocols.length).toBe(2)
  terminal.dispose()
})

test("keystrokes flushed into a socket that 1011s right after the upgrade reach the redialed one", async () => {
  let opens = 0
  const server = serve({ onOpen: (socket) => { opens += 1; if (opens === 1) setTimeout(() => socket.close(1011, "failed to attach terminal"), 20) } })
  const terminal = client(server, 10)
  terminal.input("sess-1", "claude --resume sess-7\r")
  terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  // The first socket read the line before it closed; the second, whose shell is up, reads it again.
  await until(() => opens === 2 && server.seen.length >= 2)
  expect(server.seen.map((frame) => text(frame))).toEqual(["claude --resume sess-7\r", "claude --resume sess-7\r"])
  terminal.dispose()
})

/*
 * plue#504: a guest whose NixOS activation has not finished answers the login
 * shell with exit 127, and the durable session closes NORMALLY (1000) carrying
 * plue's own reason. plue retries that once itself; the client's redial is the
 * renderer's half of the same instruction, and the reason is the person's only
 * account of what happened, so it is never swallowed.
 */
test("an early exit-127 close redials once, then reads plue's own reason (plue#504)", async () => {
  const server = serve({ onOpen: (socket) => socket.close(1000, "session exited: Process exited with status 127") })
  const terminal = client(server, 10)
  const output: Array<string> = []
  terminal.attach("will/smithers", "sess-1", { onOutput: (data) => output.push(data) })
  await until(() => output.length === 1)
  /* plue's sentence, verbatim — never "session closed" in its place. */
  expect(output[0]).toContain("session exited: Process exited with status 127")
  await Bun.sleep(120)
  /* Exactly one redial: the first dial and its retry, and no third. */
  expect(server.protocols.length).toBe(2)
  terminal.dispose()
})

test("an exit-127 close after the startup window is final: the reason still reads verbatim", async () => {
  const server = serve({
    onOpen: (socket) => {
      setTimeout(() => socket.close(1000, "session exited: Process exited with status 127"), 30)
    }
  })
  const terminal = client(server, 10, { earlyExitMs: 5 })
  const output: Array<string> = []
  terminal.attach("will/smithers", "sess-1", { onOutput: (data) => output.push(data) })
  await until(() => output.length === 1)
  expect(output[0]).toContain("session exited: Process exited with status 127")
  await Bun.sleep(120)
  /* A shell that ran past the startup window died of something else; nothing redials. */
  expect(server.protocols.length).toBe(1)
  terminal.dispose()
})

test("a normal close carrying another reason reads it verbatim and never redials", async () => {
  const server = serve({ onOpen: (socket) => socket.close(1000, "session exited: Process exited with status 1") })
  const terminal = client(server, 10)
  const output: Array<string> = []
  terminal.attach("will/smithers", "sess-1", { onOutput: (data) => output.push(data) })
  await until(() => output.length === 1)
  expect(output[0]).toContain("session closed: session exited: Process exited with status 1")
  await Bun.sleep(120)
  expect(server.protocols.length).toBe(1)
  terminal.dispose()
})

test("an abnormal drop reconnects with a doubling backoff capped at maxReconnectMs", async () => {
  const server = serve({ onOpen: (socket) => socket.terminate() })
  const terminal = client(server, 25, { maxReconnectMs: 100, maxReconnectsPerMinute: 100 })
  terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  await until(() => server.protocols.length >= 2)
  await Bun.sleep(400)
  // Fixed 25 ms redials would have made ~16; 25 → 50 → 100 → 100 → 100 makes at most six (the first dial included).
  expect(server.protocols.length).toBeGreaterThanOrEqual(3)
  expect(server.protocols.length).toBeLessThanOrEqual(7)
  terminal.dispose()
})

test("reconnect dials across every session stay under the per-minute budget", async () => {
  const server = serve({ onOpen: (socket) => socket.terminate() })
  const terminal = client(server, 5, { maxReconnectMs: 5, maxReconnectsPerMinute: 2 })
  terminal.attach("will/smithers", "sess-1", { onOutput: () => {} })
  terminal.attach("will/smithers", "sess-2", { onOutput: () => {} })
  // Two first dials (the user's opens), then exactly two redials this minute; the third waits for the window.
  await until(() => server.protocols.length >= 4)
  await Bun.sleep(200)
  expect(server.protocols.length).toBe(4)
  terminal.dispose()
})

test("pageCloudSocketUrl is undefined outside a browser", () => {
  expect(pageCloudSocketUrl("will/smithers", "sess-1")).toBeUndefined()
})

test("replay control frames are not printed but identical binary shell output is preserved", async () => {
 const marker = '{"type":"replay-complete"}'
 const server = serve({ onOpen: socket => { socket.send(marker); socket.send(new TextEncoder().encode(marker)) } })
 const terminal = client(server)
 const output: string[] = []
 terminal.attach("will/smithers", "sess-1", { onOutput: data => output.push(data) })
 await until(() => output.length > 0)
 expect(output.join("")).toBe(marker)
})
