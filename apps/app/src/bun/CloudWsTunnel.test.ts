import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { startLocalServer } from "./server"
import type { LocalServer } from "./server"

/*
 * The `/api/cloud-ws/` workspace-terminal tunnel (lane citc): the local
 * session capability rides the subprotocol (a browser upgrade carries no
 * custom header), only plue's terminal route shape proxies, and Bun bridges
 * frames both ways with the Bun-held bearer and plue's `terminal`
 * subprotocol attached upstream — never anything the renderer sent. A
 * refused upstream reaches the renderer as a distinct close code it never
 * redials on; signed out, the tunnel never dials; sign-out ends every bridge.
 */

let dist = ""

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-cloudws-dist-"))
  await mkdir(join(dist, "assets"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Smithers</title><div id=\"root\"></div>")
})

afterAll(async () => {
  await rm(dist, { recursive: true, force: true })
})

const TERMINAL_PATH = "/api/cloud-ws/repos/will/smithers/workspace/sessions/sess-1/terminal"
/** Lane L6: the language-server relay rides the same tunnel under plue's `lsp` route. */
const LSP_PATH = "/api/cloud-ws/repos/will/smithers/workspace/sessions/sess-2/lsp"

interface UpstreamRecord {
  protocols: string | null
  authorization: string | null
  origin: string | null
  /** Every request the upstream saw: the upgrade attempts and the tunnel's status re-reads alike. */
  hits: Array<{ readonly upgrade: boolean; readonly authorization: string | null; readonly origin: string | null }>
  /** Sockets the upstream currently holds open. */
  live: number
}

const newRecord = (): UpstreamRecord => ({ protocols: null, authorization: null, origin: null, hits: [], live: 0 })

/**
 * A cloud-API double: requires plue's subprotocol for the branch (`terminal`
 * by default, `lsp` for the relay), records the upgrade, echoes frames. With
 * `refuse`, it answers that HTTP status to every request — the upgrade and
 * the plain GET alike, as plue's pre-upgrade checks do — with plue's own body
 * and headers when the test names them.
 */
const startUpstream = (
  record: UpstreamRecord,
  received: Array<string | Buffer>,
  options: {
    readonly refuse?: number
    readonly refuseBody?: unknown
    readonly refuseHeaders?: Record<string, string>
    readonly protocol?: "terminal" | "lsp"
  } = {}
) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => {
      record.protocols = request.headers.get("sec-websocket-protocol")
      record.authorization = request.headers.get("authorization")
      record.origin = request.headers.get("origin")
      record.hits.push({
        upgrade: request.headers.get("upgrade") !== null,
        authorization: record.authorization,
        origin: record.origin
      })
      if (options.refuse !== undefined) {
        return new Response(JSON.stringify(options.refuseBody ?? { message: `refused ${options.refuse}` }), {
          status: options.refuse,
          headers: { "content-type": "application/json", ...options.refuseHeaders }
        })
      }
      const protocol = options.protocol ?? "terminal"
      if ((record.protocols ?? "").split(",").map((value) => value.trim()).includes(protocol)) {
        const upgraded = server.upgrade(request, { headers: { "sec-websocket-protocol": protocol } })
        if (upgraded) return undefined
      }
      return new Response(`${protocol} subprotocol required`, { status: 400 })
    },
    websocket: {
      // plue's lsp route accepts a 1 MiB frame; the double must not refuse below that.
      maxPayloadLength: 2 * 1024 * 1024,
      open: (socket) => {
        record.live += 1
        socket.send(new TextEncoder().encode("upstream says hello\r\n"))
      },
      close: () => {
        record.live -= 1
      },
      message: (socket, frame) => {
        received.push(frame)
        socket.send(frame)
      }
    }
  })

const startLocal = async (
  upstream: ReturnType<typeof startUpstream> | null,
  options: { readonly token?: string | undefined } = {}
): Promise<LocalServer> =>
  startLocalServer({
    port: 0,
    distDir: dist,
    ...(upstream === null
      ? {}
      : {
        cloudMode: "hybrid" as const,
        cloudApi: `http://127.0.0.1:${upstream.port}`,
        cloudAuth: {
          token: () => ("token" in options ? options.token : "smithers_test_token"),
          session: () => ({ state: "signed-in" as const, username: "will", expiresAt: null }),
          start: async () => ({ error: "already signed in" }),
          signOut: async () => {},
          stop: async () => {}
        }
      }),
    home: "/fake/home",
    log: () => {}
  })

const waitFor = async (predicate: () => boolean, attempts = 100): Promise<void> => {
  for (let index = 0; index < attempts && !predicate(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const connect = (
  local: LocalServer,
  path: string,
  options: { readonly protocol?: string; readonly headers?: Record<string, string> } = {}
): {
  readonly socket: WebSocket
  readonly opened: Promise<boolean>
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>
  readonly frames: Array<string>
} => {
  const frames: Array<string> = []
  const url = `ws://127.0.0.1:${local.port}${path}`
  const socket = options.headers !== undefined
    ? new WebSocket(url, { headers: options.headers } as never)
    : options.protocol === undefined
    ? new WebSocket(url)
    : new WebSocket(url, [options.protocol])
  const opened = new Promise<boolean>((resolve) => {
    socket.onopen = () => resolve(true)
    socket.onerror = () => resolve(false)
  })
  const closed = new Promise<{ readonly code: number; readonly reason: string }>((resolve) => {
    socket.onclose = (event) => resolve({ code: event.code, reason: event.reason })
  })
  void closed.then(() => {
    // A refusal before the handshake never opens.
    socket.onopen = null
  })
  const openedOrClosed = Promise.race([opened, closed.then(() => false)])
  socket.onmessage = (event) => {
    if (typeof event.data === "string") frames.push(event.data)
    else if (event.data instanceof ArrayBuffer) frames.push(new TextDecoder().decode(event.data))
    else if (event.data instanceof Uint8Array) frames.push(new TextDecoder().decode(event.data))
    else if (event.data instanceof Blob) void event.data.arrayBuffer().then((buffer) => frames.push(new TextDecoder().decode(buffer)))
  }
  return { socket, opened: openedOrClosed, closed, frames }
}

describe("the workspace terminal tunnel", () => {
  test("bridges frames both ways with the bearer and plue's subprotocol attached upstream, and no Origin by default", async () => {
    const record = newRecord()
    const received: Array<string | Buffer> = []
    const upstream = startUpstream(record, received)
    const previousOrigin = Bun.env.SMITHERS_CLOUD_WS_ORIGIN
    delete Bun.env.SMITHERS_CLOUD_WS_ORIGIN
    const local = await startLocal(upstream)
    try {
      const { socket, opened, frames } = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      expect(await opened).toBe(true)
      // The upstream's greeting arrives; the bearer and plue's subprotocol were attached HERE.
      await waitFor(() => frames.length > 0)
      expect(frames[0]).toBe("upstream says hello\r\n")
      expect(record.protocols).toBe("terminal")
      expect(record.authorization).toBe("Bearer smithers_test_token")
      // plue#475: a Bearer principal's upgrade is not origin-checked, so a desktop app sends none.
      expect(record.origin).toBeNull()
      // Binary keystrokes echo through the bridge; a text frame carries the resize.
      socket.send(new TextEncoder().encode("ls\r"))
      socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }))
      await waitFor(() => frames.length >= 3)
      expect(frames[1]).toBe("ls\r")
      expect(frames[2]).toBe(JSON.stringify({ type: "resize", cols: 120, rows: 40 }))
      expect(received.length).toBe(2)
      socket.close()
    } finally {
      if (previousOrigin !== undefined) Bun.env.SMITHERS_CLOUD_WS_ORIGIN = previousOrigin
      await local.stop()
      upstream.stop(true)
    }
  })

  test("SMITHERS_CLOUD_WS_ORIGIN is the only source of an upstream Origin", async () => {
    const record = newRecord()
    const upstream = startUpstream(record, [])
    const previousOrigin = Bun.env.SMITHERS_CLOUD_WS_ORIGIN
    Bun.env.SMITHERS_CLOUD_WS_ORIGIN = "https://strict.example"
    const local = await startLocal(upstream)
    try {
      const { socket, opened } = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      expect(await opened).toBe(true)
      // The renderer's side opens before the tunnel dials plue; the upstream's record fills on that dial.
      await waitFor(() => record.hits.length > 0)
      expect(record.origin).toBe("https://strict.example")
      socket.close()
    } finally {
      if (previousOrigin === undefined) delete Bun.env.SMITHERS_CLOUD_WS_ORIGIN
      else Bun.env.SMITHERS_CLOUD_WS_ORIGIN = previousOrigin
      await local.stop()
      upstream.stop(true)
    }
  })

  test("refuses a path that is not a workspace terminal", async () => {
    const upstream = startUpstream(newRecord(), [])
    const local = await startLocal(upstream)
    try {
      const refused = await fetch(`${local.origin}/api/cloud-ws/repos/will/smithers/workspace/sessions`, {
        headers: { "sec-websocket-protocol": local.websocketProtocol }
      })
      expect(refused.status).toBe(404)
      // Not even a socket attempt: the refusal is an HTTP answer.
      const { opened } = connect(local, "/api/cloud-ws/api/user/repos", { protocol: local.websocketProtocol })
      expect(await opened).toBe(false)
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test("refuses a socket without the local-session subprotocol, and a foreign origin", async () => {
    const upstream = startUpstream(newRecord(), [])
    const local = await startLocal(upstream)
    try {
      const noProtocol = connect(local, TERMINAL_PATH)
      expect(await noProtocol.opened).toBe(false)
      const foreign = connect(local, TERMINAL_PATH, {
        headers: { origin: "http://evil.example", "sec-websocket-protocol": local.websocketProtocol }
      })
      expect(await foreign.opened).toBe(false)
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test("answers 501 when the cloud seam is disabled", async () => {
    const local = await startLocal(null)
    try {
      const refused = await fetch(`${local.origin}${TERMINAL_PATH}`, {
        headers: { "sec-websocket-protocol": local.websocketProtocol }
      })
      expect(refused.status).toBe(501)
    } finally {
      await local.stop()
    }
  })

  /*
   * Critique finding 4: signed out, the tunnel used to upgrade and dial plue
   * with no bearer. Now the refusal is a local 401 and plue is never dialed.
   */
  test("signed out, the tunnel answers 401 and never dials plue", async () => {
    const record = newRecord()
    const upstream = startUpstream(record, [])
    const local = await startLocal(upstream, { token: undefined })
    try {
      const refused = await fetch(`${local.origin}${TERMINAL_PATH}`, {
        headers: { "sec-websocket-protocol": local.websocketProtocol }
      })
      expect(refused.status).toBe(401)
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("cloud_sign_in_required")
      const { opened } = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      expect(await opened).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(record.hits).toEqual([])
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test("sign-out closes every live bridge, upstream included", async () => {
    const record = newRecord()
    const upstream = startUpstream(record, [])
    const local = await startLocal(upstream)
    try {
      const first = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      const second = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      expect(await first.opened).toBe(true)
      expect(await second.opened).toBe(true)
      await waitFor(() => record.live === 2)
      const signedOut = await fetch(`${local.origin}/api/cloud-auth/sign-out`, {
        method: "POST",
        headers: { [LOCAL_SESSION_HEADER]: local.sessionToken, "content-type": "application/json" },
        body: "{}"
      })
      expect(signedOut.status).toBe(200)
      expect((await first.closed).code).toBe(4401)
      expect((await second.closed).code).toBe(4401)
      await waitFor(() => record.live === 0)
      expect(record.live).toBe(0)
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  /*
   * Critique finding 2 (tunnel half): every upstream refusal used to reach
   * the renderer as 1011, the code it retries. Bun's client hides the HTTP
   * status of a failed upgrade, so the tunnel re-reads it with one plain GET
   * of the same route (same bearer) and closes with the status's own code.
   */
  test.each([
    [401, 4401],
    [403, 4403],
    [404, 4404],
    [409, 4409],
    [425, 4409],
    [429, 4429],
    [500, 1011]
  ])("an upstream %i closes the renderer with %i after exactly one re-read, never a redial", async (status, code) => {
    const record = newRecord()
    const upstream = startUpstream(record, [], { refuse: status })
    const local = await startLocal(upstream)
    try {
      const { closed } = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      const end = await closed
      expect(end.code).toBe(code)
      expect(end.reason).toBe(code === 1011 ? "cloud terminal upstream answered 500" : `refused ${status}`)
      await new Promise((resolve) => setTimeout(resolve, 60))
      // The upgrade attempt and the one status re-read, both with the bearer; nothing after.
      expect(record.hits.map((hit) => hit.upgrade)).toEqual([true, false])
      expect(record.hits.every((hit) => hit.authorization === "Bearer smithers_test_token")).toBe(true)
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  /*
   * A going-away drop must never read as a clean close. Bun's server rewrites
   * 1001 to 1000 instead of sending it (1005 and 1006 likewise), and 1000 is
   * the renderer's "session closed, never redial"
   * (mainview/state/CloudTerminalClient.ts), so every bridge the local app
   * ends on its way out has to reach the renderer as the abnormal close it is.
   */
  test("the local app shutting down ends the bridge abnormally, never as a clean 1000", async () => {
    const record = newRecord()
    const upstream = startUpstream(record, [])
    const local = await startLocal(upstream)
    try {
      const { opened, closed } = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      expect(await opened).toBe(true)
      await waitFor(() => record.live === 1)
      await local.stop()
      const end = await closed
      expect(end.code).not.toBe(1000)
      expect([1001, 1006]).toContain(end.code)
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test("an upstream that drops after the handshake ends the renderer's socket", async () => {
    const record = newRecord()
    const upstream = startUpstream(record, [])
    const local = await startLocal(upstream)
    try {
      const { opened, closed } = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      expect(await opened).toBe(true)
      await waitFor(() => record.live === 1)
      upstream.stop(true)
      const end = await closed
      // An abnormal upstream drop cannot be relayed as a code; the renderer sees its own abnormal close and may reconnect.
      expect([1001, 1006]).toContain(end.code)
    } finally {
      await local.stop()
    }
  })
})

/*
 * Lane L6 (plue #505): the same tunnel relays the workspace language-server
 * socket. Its branch is the path's last segment — plue's `lsp` subprotocol
 * goes upstream, its 1 MiB frame cap applies to that branch alone, a
 * fragment set (`{ seq, last, data }`) crosses untouched for the renderer to
 * reassemble, and a refused upgrade maps to a 44xx code whose reason carries
 * plue's `code: message` verbatim and the `Retry-After` it named.
 */
describe("the workspace lsp tunnel", () => {
  const MIB = 1024 * 1024

  test("forwards plue's lsp subprotocol and the bearer, and relays a 1 MiB JSON-RPC frame both ways", async () => {
    const record = newRecord()
    const received: Array<string | Buffer> = []
    const upstream = startUpstream(record, received, { protocol: "lsp" })
    const local = await startLocal(upstream)
    try {
      const { socket, opened, frames, closed } = connect(local, LSP_PATH, { protocol: local.websocketProtocol })
      expect(await opened).toBe(true)
      await waitFor(() => frames.length > 0)
      expect(record.protocols).toBe("lsp")
      expect(record.authorization).toBe("Bearer smithers_test_token")
      // One JSON-RPC message per text frame, exactly at plue's cap: a hover can carry this much.
      const big = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { contents: "x".repeat(MIB - 200) } })
      const padded = big + " ".repeat(MIB - Buffer.byteLength(big))
      expect(Buffer.byteLength(padded)).toBe(MIB)
      socket.send(padded)
      await waitFor(() => frames.length >= 2, 500)
      expect(frames[1]).toBe(padded)
      expect(received.length).toBe(1)
      // The terminal's 64 KiB never bound this branch.
      socket.send("x".repeat(100 * 1024))
      await waitFor(() => frames.length >= 3, 500)
      expect(frames[2]!.length).toBe(100 * 1024)
      // One byte past the cap is refused with the branch's own reason, before it reaches plue.
      socket.send(" ".repeat(MIB + 1))
      const end = await closed
      expect(end.code).toBe(1009)
      expect(end.reason).toBe("A lsp frame is larger than the upstream accepts (1024 KiB).")
      expect(received.length).toBe(2)
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test("the terminal branch keeps plue's 64 KiB cap and its own reason", async () => {
    const record = newRecord()
    const received: Array<string | Buffer> = []
    const upstream = startUpstream(record, received)
    const local = await startLocal(upstream)
    try {
      const { socket, opened, frames, closed } = connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol })
      expect(await opened).toBe(true)
      await waitFor(() => frames.length > 0)
      socket.send(new Uint8Array(64 * 1024 + 1))
      const end = await closed
      expect(end.code).toBe(1009)
      expect(end.reason).toBe("A terminal frame is larger than the upstream accepts (64 KiB).")
      expect(received.length).toBe(0)
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test("a fragment set crosses the tunnel untouched, in order, for the renderer to reassemble", async () => {
    const record = newRecord()
    const upstream = startUpstream(record, [], { protocol: "lsp" })
    const local = await startLocal(upstream)
    try {
      const { socket, opened, frames } = connect(local, LSP_PATH, { protocol: local.websocketProtocol })
      expect(await opened).toBe(true)
      await waitFor(() => frames.length > 0)
      const fragments = [
        JSON.stringify({ seq: 1, last: false, data: "{\"jsonrpc\":\"2.0\",\"id\":7," }),
        JSON.stringify({ seq: 2, last: false, data: "\"result\":{\"contents\":\"" + "y".repeat(70 * 1024) }),
        JSON.stringify({ seq: 3, last: true, data: "\"}}" })
      ]
      for (const fragment of fragments) socket.send(fragment)
      await waitFor(() => frames.length >= 4, 500)
      expect(frames.slice(1)).toEqual(fragments)
      socket.close()
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test.each([
    [425, { code: "workspace_session_pending", message: "session pending" }, { "retry-after": "2" }, 4425, "workspace_session_pending: session pending (retry after 2 s)"],
    [503, { code: "guest_not_ready", message: "guest is activating" }, { "retry-after": "3" }, 4503, "guest_not_ready: guest is activating (retry after 3 s)"],
    [409, { code: "language_server_missing", message: "npm i -g typescript-language-server typescript", details: { language: "typescript" } }, {}, 4409, "language_server_missing: npm i -g typescript-language-server typescript"],
    [409, { code: "workspace_session_kind_mismatch", message: "session is a terminal" }, {}, 4409, "workspace_session_kind_mismatch: session is a terminal"],
    [401, { message: "unauthorized" }, {}, 4401, "unauthorized"],
    [429, { code: "rate_limited", message: "too many opens" }, {}, 4429, "rate_limited: too many opens"],
    [500, { message: "server died before ready" }, {}, 1011, "cloud lsp upstream answered 500"]
  ])("an lsp upstream %i closes the renderer with %i, plue's code and words and its Retry-After in the reason, after one re-read", async (status, body, headers, code, reason) => {
    const record = newRecord()
    const upstream = startUpstream(record, [], { protocol: "lsp", refuse: status, refuseBody: body, refuseHeaders: headers })
    const local = await startLocal(upstream)
    try {
      const { closed } = connect(local, LSP_PATH, { protocol: local.websocketProtocol })
      const end = await closed
      expect(end.code).toBe(code)
      expect(end.reason).toBe(reason)
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(record.hits.map((hit) => hit.upgrade)).toEqual([true, false])
      expect(record.hits.every((hit) => hit.authorization === "Bearer smithers_test_token")).toBe(true)
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test("the terminal branch's 425 and 503 mappings are unchanged, and a plue code never reaches a terminal's reason", async () => {
    const record = newRecord()
    const upstream = startUpstream(record, [], { refuse: 425, refuseBody: { code: "workspace_session_pending", message: "session pending" }, refuseHeaders: { "retry-after": "2" } })
    const local = await startLocal(upstream)
    try {
      const end = await connect(local, TERMINAL_PATH, { protocol: local.websocketProtocol }).closed
      expect(end).toEqual({ code: 4409, reason: "session pending" })
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })

  test("sign-out closes an lsp bridge like a terminal one", async () => {
    const record = newRecord()
    const upstream = startUpstream(record, [], { protocol: "lsp" })
    const local = await startLocal(upstream)
    try {
      const bridge = connect(local, LSP_PATH, { protocol: local.websocketProtocol })
      expect(await bridge.opened).toBe(true)
      await waitFor(() => record.live === 1)
      const signedOut = await fetch(`${local.origin}/api/cloud-auth/sign-out`, {
        method: "POST",
        headers: { [LOCAL_SESSION_HEADER]: local.sessionToken, "content-type": "application/json" },
        body: "{}"
      })
      expect(signedOut.status).toBe(200)
      expect((await bridge.closed).code).toBe(4401)
      await waitFor(() => record.live === 0)
    } finally {
      await local.stop()
      upstream.stop(true)
    }
  })
})

