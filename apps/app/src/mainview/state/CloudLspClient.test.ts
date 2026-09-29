/*
 * The cloud language-server transport against a REAL loopback WebSocket
 * server speaking the wire plue #505 recorded (docs/code-intel/PLAN.md
 * "Live"): `initialize` → `initialized` → `didOpen` with the card's text at
 * its checkout-relative path → hover / definition / publishDiagnostics, one
 * JSON-RPC message per text frame or `{ seq, last, data }` fragments. The
 * session POST is a double of plue's route in its own shape. The close-code
 * policy is driven the way it reaches a renderer: the server closes with the
 * code (a Bun server cannot put 1001 or 1006 on the wire, so the reconnect
 * path is driven by `terminate()`, the abnormal 1006 the tunnel turns a
 * going-away into).
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { CLOUD_LSP_ROOT_URI, withRetryAfter } from "@smthrs/rpc/CloudTunnel"
import { LSP_LANGUAGE_SERVER_MISSING } from "@smthrs/rpc/LocalLsp"
import { cloudDocumentUri, createCloudLspClient, documentLanguageId, pageCloudLspSocketUrl } from "./CloudLspClient"
import type { CloudLspClient, CloudLspDocument, CloudLspEvent } from "./CloudLspClient"

setDefaultTimeout(60_000)

const INSTALL = "npm i -g typescript-language-server typescript"
const HOVER_MARKDOWN = "```typescript\nconst message: string\n```\nThe greeting."

interface ServerSocket {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  terminate: () => void
}

interface Harness {
  readonly url: string
  /** Every JSON-RPC message the server received, in order, per socket generation. */
  readonly received: Array<Record<string, unknown>>
  readonly protocols: Array<string | null>
  readonly initializes: () => number
  readonly live: () => number
  readonly sockets: () => ReadonlyArray<ServerSocket>
  readonly stop: () => void
}

interface ServeOptions {
  /** What the server does to each socket as it opens (before any message); returns true to leave the LSP unanswered. */
  readonly onOpen?: (socket: ServerSocket, generation: number) => boolean | void
  readonly silentInitialize?: boolean
  /** Answers the hover as fragments of this many characters instead of one frame. */
  readonly fragmentHover?: number
  /** A publication for every didOpen; default one error. */
  readonly publish?: boolean
  /** Close with this code and reason when a hover arrives (a request in flight), on the given generations. */
  readonly closeOnHover?: { readonly code: number; readonly reason: string; readonly generations: ReadonlyArray<number> }
  /** Drop the socket abnormally when the hover arrives, on the given generations. */
  readonly dropOnHover?: ReadonlyArray<number>
  /** Hovers on these document URIs are left unanswered (the test answers them by hand). */
  readonly silentHoverUris?: ReadonlyArray<string>
}

const harnesses: Array<Harness> = []

const serve = (options: ServeOptions = {}): Harness => {
  const received: Array<Record<string, unknown>> = []
  const protocols: Array<string | null> = []
  const open = new Set<ServerSocket>()
  let initializes = 0
  let generation = 0
  const server = Bun.serve<{ generation: number }>({
    // The client dials 127.0.0.1, so bind there too. A wildcard bind lets a
    // peer process that already holds this port number on loopback answer the
    // upgrade instead, and the socket never arrives.
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, self) => {
      protocols.push(request.headers.get("sec-websocket-protocol"))
      generation += 1
      return self.upgrade(request, { data: { generation } }) ? undefined : new Response("no")
    },
    websocket: {
      maxPayloadLength: 2 * 1024 * 1024,
      open: (socket) => {
        open.add(socket as never)
        if (options.onOpen?.(socket as never, socket.data.generation) === true) return
      },
      close: (socket) => void open.delete(socket as never),
      message: (socket, raw) => {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
        const message = JSON.parse(text) as Record<string, unknown>
        received.push(message)
        const reply = (result: unknown): void => {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
        }
        switch (message.method) {
          case "initialize": {
            initializes += 1
            if (options.silentInitialize) return
            reply({
              capabilities: { textDocumentSync: 1, hoverProvider: true, definitionProvider: true },
              serverInfo: { name: "typescript-language-server", version: "5.3.0" }
            })
            return
          }
          case "textDocument/didOpen": {
            const document = (message.params as { textDocument: { uri: string } }).textDocument
            if (options.publish === false) return
            socket.send(JSON.stringify({
              jsonrpc: "2.0",
              method: "textDocument/publishDiagnostics",
              params: {
                uri: document.uri,
                version: 1,
                diagnostics: [{
                  range: { start: { line: 3, character: 23 }, end: { line: 3, character: 29 } },
                  severity: 1,
                  code: 2551,
                  source: "typescript",
                  message: "Property 'lenght' does not exist on type 'string'. Did you mean 'length'? See /home/developer/workspace/src/index.ts"
                }]
              }
            }))
            return
          }
          case "textDocument/hover": {
            if (options.dropOnHover?.includes(socket.data.generation)) {
              socket.terminate()
              return
            }
            const closing = options.closeOnHover
            if (closing !== undefined && closing.generations.includes(socket.data.generation)) {
              socket.close(closing.code, closing.reason)
              return
            }
            if (options.silentHoverUris?.includes((message.params as { textDocument: { uri: string } }).textDocument.uri)) return
            const frame = JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                contents: { kind: "markdown", value: HOVER_MARKDOWN },
                range: { start: { line: 2, character: 6 }, end: { line: 2, character: 13 } }
              }
            })
            if (options.fragmentHover === undefined) {
              socket.send(frame)
              return
            }
            const size = options.fragmentHover
            const parts = Array.from({ length: Math.ceil(frame.length / size) }, (_part, index) => frame.slice(index * size, (index + 1) * size))
            parts.forEach((data, index) => {
              socket.send(JSON.stringify({ seq: index + 1, last: index === parts.length - 1, data }))
            })
            return
          }
          case "textDocument/definition": {
            reply([
              { uri: `${CLOUD_LSP_ROOT_URI}/src/greet.ts`, range: { start: { line: 5, character: 13 }, end: { line: 5, character: 18 } } },
              { uri: "file:///nix/store/abc-typescript/lib/lib.es5.d.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }
            ])
            return
          }
          case "shutdown":
            reply(null)
            return
          default:
            return
        }
      }
    }
  })
  const harness: Harness = {
    url: `ws://127.0.0.1:${server.port}/lsp`,
    received,
    protocols,
    initializes: () => initializes,
    live: () => open.size,
    sockets: () => [...open],
    stop: () => server.stop(true)
  }
  harnesses.push(harness)
  return harness
}

const until = async (predicate: () => boolean, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not pass")
    await Bun.sleep(5)
  }
}

const clients: Array<CloudLspClient> = []

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
  for (const harness of harnesses.splice(0)) harness.stop()
})

/** plue's session POST as a double: the 201 row, or the refusals a test names, in order. */
const sessionRoute = (answers: ReadonlyArray<Response> = []) => {
  const posts: Array<{ readonly url: string; readonly body: unknown }> = []
  const queue = [...answers]
  const http = async (input: string, init?: RequestInit): Promise<Response> => {
    posts.push({ url: input, body: typeof init?.body === "string" ? JSON.parse(init.body) : null })
    const next = queue.shift()
    if (next !== undefined) return next
    return new Response(JSON.stringify({ id: "lsps-1", workspace_id: "ws-1", status: "running", kind: "lsp", language: "typescript", idle_timeout_secs: 600 }), {
      status: 201,
      headers: { "content-type": "application/json" }
    })
  }
  return { http, posts }
}

const client = (
  server: Harness,
  extra: { readonly http?: (input: string, init?: RequestInit) => Promise<Response>; readonly requestTimeoutMs?: number; readonly retry?: { maxAttempts: number; defaultDelayMs: number } } = {}
): { readonly lsp: CloudLspClient; readonly events: Array<CloudLspEvent>; readonly posts: ReturnType<typeof sessionRoute>["posts"]; readonly dials: Array<string> } => {
  const route = sessionRoute()
  const dials: Array<string> = []
  const lsp = createCloudLspClient({
    http: extra.http ?? route.http,
    baseUrl: "http://local.invalid",
    socketUrl: (repo, sessionId, language) => {
      dials.push(`${repo} ${sessionId} ${language}`)
      return server.url
    },
    socketProtocol: () => "smithers.local.test",
    requestTimeoutMs: extra.requestTimeoutMs ?? 5_000,
    retry: extra.retry ?? { maxAttempts: 3, defaultDelayMs: 10 },
    reconnectMs: 10
  })
  clients.push(lsp)
  const events: Array<CloudLspEvent> = []
  lsp.subscribe((event) => events.push(event))
  return { lsp, events, posts: route.posts, dials }
}

const DOC: CloudLspDocument = {
  repo: "will/flows",
  workspaceId: "ws-1",
  language: "typescript",
  path: "src/index.ts",
  content: "import { greet } from \"./greet\"\n\nconst message = greet(\"world\")\nconsole.log(message.lenght)\n"
}

test("the recorded transcript: session POST, initialize with the guest root, initialized, didOpen with the card's text, then the hover", async () => {
  const server = serve()
  const { lsp, posts, dials } = client(server)
  const answer = await lsp.hover(DOC, { line: 3, character: 7 })
  expect(answer).toEqual({
    ok: {
      hover: {
        contents: HOVER_MARKDOWN,
        truncated: false,
        range: { line: 3, character: 7, endLine: 3, endCharacter: 14 }
      }
    }
  })
  // The session: one POST with plue's body, its id in the socket URL, the local capability as the subprotocol.
  expect(posts).toEqual([{
    url: "http://local.invalid/api/repos/will/flows/workspace/sessions",
    body: { workspace_id: "ws-1", kind: "lsp", language: "typescript" }
  }])
  expect(dials).toEqual(["will/flows lsps-1 typescript"])
  expect(server.protocols).toEqual(["smithers.local.test"])
  // The wire, in order: initialize (root + folder + capabilities), initialized, didOpen (the card's text, its languageId), hover (0-based).
  expect(server.received.map((message) => message.method)).toEqual(["initialize", "initialized", "textDocument/didOpen", "textDocument/hover"])
  expect(server.received[0]!.params).toEqual({
    processId: null,
    clientInfo: { name: "smithers" },
    rootUri: "file:///home/developer/workspace",
    workspaceFolders: [{ uri: "file:///home/developer/workspace", name: "workspace" }],
    capabilities: {
      textDocument: {
        synchronization: { dynamicRegistration: false, didSave: false },
        hover: { contentFormat: ["markdown", "plaintext"] },
        publishDiagnostics: { relatedInformation: false, versionSupport: true }
      },
      workspace: { configuration: true, workspaceFolders: true }
    }
  })
  expect(server.received[2]!.params).toEqual({
    textDocument: { uri: "file:///home/developer/workspace/src/index.ts", languageId: "typescript", version: 1, text: DOC.content }
  })
  expect(server.received[3]!.params).toEqual({ textDocument: { uri: "file:///home/developer/workspace/src/index.ts" }, position: { line: 2, character: 6 } })
  // A second hover reuses the socket and the open document: no second session, dial, initialize or didOpen.
  await lsp.hover(DOC, { line: 3, character: 7 })
  expect(posts).toHaveLength(1)
  expect(dials).toHaveLength(1)
  expect(server.initializes()).toBe(1)
  expect(server.received.filter((message) => message.method === "textDocument/didOpen")).toHaveLength(1)
  // The card's text changed (a re-read): the document is re-sent in full, versioned.
  await lsp.hover({ ...DOC, content: `${DOC.content}// more\n` }, { line: 3, character: 7 })
  const change = server.received.find((message) => message.method === "textDocument/didChange")
  expect(change?.params).toEqual({
    textDocument: { uri: "file:///home/developer/workspace/src/index.ts", version: 2 },
    contentChanges: [{ text: `${DOC.content}// more\n` }]
  })
})

test("a thrown session request or socket answers a product sentence, never the thrown text", async () => {
  const server = serve()
  const dropped = client(server, { http: async () => { throw new TypeError("ECONNRESET secret-socket-detail") } })
  expect(await dropped.lsp.hover(DOC, { line: 3, character: 7 })).toEqual({ refusal: { code: "unreachable", message: "Could not reach Smithers Cloud." } })
  const route = sessionRoute()
  for (const failure of ["authorize", "open"] as const) {
    const lsp = createCloudLspClient({
      http: route.http,
      baseUrl: "http://local.invalid",
      socketUrl: () => server.url,
      ...(failure === "authorize"
        ? { authorizeSocket: async () => { throw new Error("secret-authorize-detail") } }
        : { socketProtocol: () => "smithers.local.test", socketFactory: () => { throw new Error("secret-open-detail") } }),
      requestTimeoutMs: 1_000,
      retry: { maxAttempts: 1, defaultDelayMs: 10 },
      reconnectMs: 10
    })
    clients.push(lsp)
    const answer = await lsp.hover(DOC, { line: 3, character: 7 })
    expect(JSON.stringify(answer)).not.toContain("secret-")
    expect(JSON.stringify(answer)).toContain(failure === "authorize" ? "could not be authorized" : "could not open")
  }
})

test("a message plue split into { seq, last, data } fragments is reassembled in order; a gap drops the set whole", async () => {
  const server = serve({ fragmentHover: 40, silentHoverUris: [cloudDocumentUri("src/other.ts")] })
  const { lsp } = client(server, { requestTimeoutMs: 400 })
  const answer = await lsp.hover(DOC, { line: 3, character: 7 })
  expect("ok" in answer && answer.ok.hover?.contents).toBe(HOVER_MARKDOWN)
  // The server skips seq 2: nothing is parsed in part, the request times out with its own refusal.
  const [socket] = server.sockets()
  const pending = lsp.hover({ ...DOC, path: "src/other.ts" }, { line: 1, character: 1 })
  await until(() => server.received.filter((message) => message.method === "textDocument/hover").length === 2)
  const last = server.received.at(-1)!
  socket!.send(JSON.stringify({ seq: 1, last: false, data: `{"jsonrpc":"2.0","id":${String(last.id)},` }))
  socket!.send(JSON.stringify({ seq: 3, last: true, data: "\"result\":null}" }))
  const refused = await pending
  expect("refusal" in refused && refused.refusal.code).toBe("language_server_timeout")
})

test("a publication after didOpen answers diagnostics, reaches the listeners with the text it is about, and the next call reads the latest without waiting", async () => {
  const server = serve()
  const { lsp, events } = client(server)
  const answer = await lsp.diagnostics(DOC)
  expect(answer).toEqual({
    ok: {
      items: [{
        line: 4,
        character: 24,
        endLine: 4,
        endCharacter: 30,
        severity: "error",
        // The guest's absolute path is made checkout-relative before anyone reads it.
        message: "Property 'lenght' does not exist on type 'string'. Did you mean 'length'? See src/index.ts",
        source: "typescript",
        code: "2551"
      }],
      total: 1
    }
  })
  const published = events.find((event) => event.type === "diagnostics")
  expect(published).toMatchObject({ type: "diagnostics", repo: "will/flows", workspaceId: "ws-1", language: "typescript", path: "src/index.ts", content: DOC.content, total: 1 })
  const before = server.received.length
  expect(await lsp.diagnostics(DOC)).toEqual(answer)
  expect(server.received.length).toBe(before)
})

test("a server that publishes nothing within the wait answers null items, never a false zero", async () => {
  const server = serve({ publish: false })
  const { lsp } = client(server, { requestTimeoutMs: 100 })
  expect(await lsp.diagnostics(DOC)).toEqual({ ok: { items: null, total: null } })
})

test("a delayed publication for the previous document version cannot settle or overwrite the current diagnostics", async () => {
  const server = serve({ publish: false })
  const { lsp, events } = client(server)
  await lsp.hover(DOC, { line: 1, character: 1 })
  const changed = { ...DOC, content: `${DOC.content}// changed\n` }
  await lsp.hover(changed, { line: 1, character: 1 })
  let settled = false
  const pending = lsp.diagnostics(changed).then((answer) => { settled = true; return answer })
  const publish = (version: number, message: string): void => server.sockets()[0]!.send(JSON.stringify({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri: cloudDocumentUri(DOC.path), version,
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message }]
    }
  }))
  publish(1, "stale")
  await Bun.sleep(30)
  expect(settled).toBe(false)
  expect(events.filter((event) => event.type === "diagnostics")).toEqual([])
  publish(2, "current")
  const result = await pending
  expect("ok" in result && result.ok.items?.[0]?.message).toBe("current")
  publish(1, "late stale")
  await Bun.sleep(30)
  expect(await lsp.diagnostics(changed)).toEqual(result)
  expect(events.filter((event) => event.type === "diagnostics")).toHaveLength(1)
})

test("a definition inside the checkout is a relative location; one in the store is counted as omitted, never listed", async () => {
  const server = serve()
  const { lsp } = client(server)
  expect(await lsp.definition(DOC, { line: 3, character: 17 })).toEqual({
    ok: { locations: [{ path: "src/greet.ts", line: 6, character: 14, endLine: 6, endCharacter: 19 }], total: 2, omitted: 1 }
  })
})

test("a 503 guest_not_ready on the session POST is retried on its Retry-After, plue's words shown meanwhile", async () => {
  const server = serve()
  const refusal = () =>
    new Response(JSON.stringify({ code: "guest_not_ready", message: "guest is still activating" }), {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "0" }
    })
  const route = sessionRoute([refusal(), refusal()])
  const { lsp, events } = client(server, { http: route.http })
  const answer = await lsp.hover(DOC, { line: 3, character: 7 })
  expect("ok" in answer).toBe(true)
  expect(route.posts).toHaveLength(3)
  expect(events.filter((event) => event.type === "waiting").map((event) => event.type === "waiting" ? event.note : "")).toEqual([
    "guest_not_ready: guest is still activating",
    "guest_not_ready: guest is still activating"
  ])
})

test("a guest_not_ready that never clears gives up at the bound with plue's words; any other POST refusal is answered once", async () => {
  const server = serve()
  const notReady = () =>
    new Response(JSON.stringify({ code: "guest_not_ready", message: "guest is still activating" }), {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "0" }
    })
  const bounded = sessionRoute([notReady(), notReady(), notReady(), notReady()])
  const { lsp } = client(server, { http: bounded.http, retry: { maxAttempts: 2, defaultDelayMs: 10 } })
  expect(await lsp.hover(DOC, { line: 3, character: 7 })).toEqual({ refusal: { code: "guest_not_ready", message: "guest_not_ready: guest is still activating" } })
  expect(bounded.posts).toHaveLength(3)
  const unknown = sessionRoute([
    new Response(JSON.stringify({ code: "invalid_request", message: "language is required for kind lsp; one of: typescript" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    })
  ])
  const second = client(serve(), { http: unknown.http })
  expect(await second.lsp.hover(DOC, { line: 3, character: 7 })).toEqual({
    refusal: { code: "invalid_request", message: "invalid_request: language is required for kind lsp; one of: typescript" }
  })
  expect(unknown.posts).toHaveLength(1)
})

test("a pre-upgrade 4425 (session pending) is redialed after the Retry-After the reason names, its words shown meanwhile; the session stands", async () => {
  const server = serve({
    onOpen: (socket, generation) => {
      if (generation === 1) {
        socket.close(4425, withRetryAfter("workspace_session_pending: session pending", 0))
        return true
      }
    }
  })
  const { lsp, events, posts, dials } = client(server)
  const answer = await lsp.hover(DOC, { line: 3, character: 7 })
  expect("ok" in answer && answer.ok.hover?.contents).toBe(HOVER_MARKDOWN)
  expect(events.filter((event) => event.type === "waiting")).toEqual([
    { type: "waiting", repo: "will/flows", workspaceId: "ws-1", language: "typescript", note: "workspace_session_pending: session pending (retry after 0 s)", paths: [] }
  ])
  expect(dials).toHaveLength(2)
  expect(posts).toHaveLength(1)
})

test("a pre-upgrade 4503 that never clears is the refusal, in plue's words, after the bound", async () => {
  const server = serve({
    onOpen: (socket) => {
      socket.close(4503, withRetryAfter("guest_not_ready: guest is activating", 0))
      return true
    }
  })
  const { lsp, dials } = client(server, { retry: { maxAttempts: 2, defaultDelayMs: 10 } })
  const answer = await lsp.hover(DOC, { line: 3, character: 7 })
  expect("refusal" in answer && answer.refusal.message).toBe("guest_not_ready: guest is activating (retry after 0 s) — still not ready after 2 tries (4503)")
  expect(dials).toHaveLength(3)
})

test("a 409 language_server_missing renders the install line verbatim and never redials", async () => {
  const server = serve({
    onOpen: (socket) => {
      socket.close(4409, `${LSP_LANGUAGE_SERVER_MISSING}: ${INSTALL}`)
      return true
    }
  })
  const { lsp, dials } = client(server)
  expect(await lsp.hover(DOC, { line: 3, character: 7 })).toEqual({
    refusal: { code: LSP_LANGUAGE_SERVER_MISSING, message: `${LSP_LANGUAGE_SERVER_MISSING}: ${INSTALL}`, install: INSTALL }
  })
  await Bun.sleep(50)
  expect(dials).toHaveLength(1)
})

test("a 1011 is retried once with a fresh initialize; the second is the answer, verbatim, and the listeners hear it", async () => {
  const server = serve({ closeOnHover: { code: 1011, reason: "language_server_exited: 137", generations: [1, 2] } })
  const { lsp, events, dials } = client(server)
  const first = lsp.hover(DOC, { line: 3, character: 7 })
  const answer = await first
  expect(answer).toEqual({ refusal: { code: "close_1011", message: "language_server_exited: 137 (1011)" } })
  expect(server.initializes()).toBe(2)
  expect(dials).toHaveLength(2)
  expect(events.filter((event) => event.type === "closed")).toEqual([
    { type: "closed", repo: "will/flows", workspaceId: "ws-1", language: "typescript", code: 1011, reason: "language_server_exited: 137", paths: ["src/index.ts"] }
  ])
  // The next act dials anew and, on a server that stays up, answers.
  const third = await lsp.hover(DOC, { line: 3, character: 7 })
  expect("ok" in third && third.ok.hover?.contents).toBe(HOVER_MARKDOWN)
  expect(server.initializes()).toBe(3)
})

test("a 1011 on the first generation only: the retry answers, and the open document was re-sent to the fresh server", async () => {
  const server = serve({ closeOnHover: { code: 1011, reason: "language_server_exited: 1", generations: [1] } })
  const { lsp } = client(server)
  const answer = await lsp.hover(DOC, { line: 3, character: 7 })
  expect("ok" in answer && answer.ok.hover?.contents).toBe(HOVER_MARKDOWN)
  expect(server.initializes()).toBe(2)
})

test("an abnormal drop mid-request reconnects: a fresh initialize, the document opened again, the request re-issued", async () => {
  const server = serve({ dropOnHover: [1] })
  const { lsp, events } = client(server)
  const answer = await lsp.hover(DOC, { line: 3, character: 7 })
  expect("ok" in answer && answer.ok.hover?.contents).toBe(HOVER_MARKDOWN)
  expect(server.initializes()).toBe(2)
  const opens = server.received.filter((message) => message.method === "textDocument/didOpen")
  expect(opens).toHaveLength(2)
  expect(server.received.filter((message) => message.method === "textDocument/hover")).toHaveLength(2)
  expect(events.filter((event) => event.type === "closed")).toEqual([])
})

test.each([
  [1008, "access revoked: token expired"],
  [1002, "protocol error"],
  [1003, "binary frames are not accepted"],
  [1009, "message too big"]
])("close %i is final: the waiting request reads the reason verbatim, the listeners hear it, nothing redials", async (code, reason) => {
  const server = serve({ closeOnHover: { code, reason, generations: [1, 2, 3] } })
  const { lsp, events, dials } = client(server)
  expect(await lsp.hover(DOC, { line: 3, character: 7 })).toEqual({ refusal: { code: `close_${code}`, message: `${reason} (${code})` } })
  await Bun.sleep(60)
  expect(dials).toHaveLength(1)
  expect(events.filter((event) => event.type === "closed")).toEqual([
    { type: "closed", repo: "will/flows", workspaceId: "ws-1", language: "typescript", code, reason, paths: ["src/index.ts"] }
  ])
})

test("a normal close with plue's reason and nothing in flight is stated to the listeners, never silent; the next act dials anew", async () => {
  const server = serve()
  const { lsp, events, dials } = client(server)
  expect("ok" in (await lsp.hover(DOC, { line: 3, character: 7 }))).toBe(true)
  for (const socket of server.sockets()) socket.close(1000, "language_server_idle")
  await until(() => events.some((event) => event.type === "closed"))
  expect(events.filter((event) => event.type === "closed")).toEqual([
    { type: "closed", repo: "will/flows", workspaceId: "ws-1", language: "typescript", code: 1000, reason: "language_server_idle", paths: ["src/index.ts"] }
  ])
  await Bun.sleep(40)
  expect(dials).toHaveLength(1)
  const again = await lsp.hover(DOC, { line: 3, character: 7 })
  expect("ok" in again && again.ok.hover?.contents).toBe(HOVER_MARKDOWN)
  expect(dials).toHaveLength(2)
  expect(server.initializes()).toBe(2)
})

test("dispose closes every socket and answers nothing after", async () => {
  const server = serve()
  const { lsp } = client(server)
  expect("ok" in (await lsp.hover(DOC, { line: 3, character: 7 }))).toBe(true)
  await until(() => server.live() === 1)
  lsp.dispose()
  await until(() => server.live() === 0)
  expect(await lsp.hover(DOC, { line: 3, character: 7 })).toEqual({ refusal: { code: "disposed", message: "The app is closing." } })
})

const closing = { refusal: { code: "disposed", message: "The app is closing." } }

/** Bound settlement checks without leaving a timer behind on success. */
const promptly = async <T>(promise: Promise<T>): Promise<T | "still pending"> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<"still pending">((resolve) => {
      timer = setTimeout(() => resolve("still pending"), 300)
    })])
  } finally {
    clearTimeout(timer)
  }
}

test("dispose settles an in-flight hover and diagnostic waiters", async () => {
  const server = serve({ silentHoverUris: [cloudDocumentUri(DOC.path)], publish: false })
  const { lsp } = client(server)
  const hover = lsp.hover(DOC, { line: 1, character: 1 })
  const diagnostics = lsp.diagnostics(DOC)
  await until(() => server.received.some((message) => message.method === "textDocument/hover"))
  lsp.dispose()
  expect(await promptly(hover)).toEqual(closing)
  expect(await promptly(diagnostics)).toEqual({ ok: { items: null, total: null } })
  await until(() => server.live() === 0)
})

test("dispose during initialize settles every act sharing the dial", async () => {
  const server = serve({ silentInitialize: true })
  const { lsp } = client(server)
  const hover = lsp.hover(DOC, { line: 1, character: 1 })
  const definition = lsp.definition(DOC, { line: 1, character: 1 })
  await until(() => server.initializes() === 1)
  lsp.dispose()
  expect(await promptly(Promise.all([hover, definition]))).toEqual([closing, closing])
  await until(() => server.live() === 0)
})

test("dispose during session acquisition settles immediately and a late session opens no socket", async () => {
  const server = serve()
  const route = sessionRoute()
  const response = Promise.withResolvers<Response>()
  let signal: AbortSignal | null | undefined
  const { lsp, dials } = client(server, { http: async (_input, init) => {
    signal = init?.signal
    return response.promise
  } })
  const hover = lsp.hover(DOC, { line: 1, character: 1 })
  lsp.dispose()
  const result = await promptly(hover)
  response.resolve(await route.http("session"))
  await Bun.sleep(30)
  expect(dials).toHaveLength(0)
  expect(result).toEqual(closing)
  expect(signal?.aborted).toBe(true)
})

test("dispose cancels the session retry wait", async () => {
  const server = serve()
  const route = sessionRoute([new Response(JSON.stringify({ code: "guest_not_ready", message: "activating" }), {
    status: 503, headers: { "retry-after": "1" }
  })])
  const { lsp, events, dials } = client(server, { http: route.http })
  const hover = lsp.hover(DOC, { line: 1, character: 1 })
  await until(() => events.some((event) => event.type === "waiting"))
  lsp.dispose()
  expect(await promptly(hover)).toEqual(closing)
  await Bun.sleep(1_050)
  expect(route.posts).toHaveLength(1)
  expect(dials).toHaveLength(0)
})

test("each unanswered initialize releases its socket before the next attempt", async () => {
  const server = serve({ silentInitialize: true })
  const { lsp } = client(server, { requestTimeoutMs: 100 })
  const liveAfterFailure: Array<number> = []
  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect(await lsp.hover(DOC, { line: 1, character: 1 })).toEqual({
      refusal: { code: "close_0", message: "the workspace language server did not answer initialize (0)" }
    })
    await Bun.sleep(30)
    liveAfterFailure.push(server.live())
  }
  expect(server.initializes()).toBe(3)
  expect(liveAfterFailure).toEqual([0, 0, 0])
})

test("a request that times out after reissue is absent from the next reconnect", async () => {
  const other = { ...DOC, path: "src/other.ts" }
  const server = serve({ silentHoverUris: [cloudDocumentUri(DOC.path), cloudDocumentUri(other.path)] })
  const { lsp } = client(server, { requestTimeoutMs: 500 })
  const hovers = () => server.received.filter((message) => message.method === "textDocument/hover")
  const expired = lsp.hover(DOC, { line: 1, character: 1 })
  await until(() => hovers().length === 1)
  server.sockets()[0]!.terminate()
  await until(() => hovers().length === 2)
  expect(await expired).toMatchObject({ refusal: { code: "language_server_timeout" } })
  const pending = lsp.hover(other, { line: 1, character: 1 })
  await until(() => hovers().length === 3)
  server.sockets()[0]!.terminate()
  await until(() => server.initializes() === 3 && hovers().length >= 4)
  expect(hovers().filter((message) =>
    (message.params as { textDocument: { uri: string } }).textDocument.uri === cloudDocumentUri(DOC.path)
  )).toHaveLength(2)
  const current = hovers().filter((message) =>
    (message.params as { textDocument: { uri: string } }).textDocument.uri === cloudDocumentUri(other.path)
  ).at(-1)!
  server.sockets()[0]!.send(JSON.stringify({ jsonrpc: "2.0", id: current.id, result: null }))
  expect(await pending).toEqual({ ok: { hover: null } })
})

test("the page URL, the document URI and the languageId follow plue's route and typescript-language-server's vocabulary", () => {
  expect(pageCloudLspSocketUrl("will/flows", "lsps-1", "typescript")).toBeUndefined()
  expect(cloudDocumentUri("src/a b/index.ts")).toBe("file:///home/developer/workspace/src/a%20b/index.ts")
  expect(documentLanguageId("typescript", "src/App.tsx")).toBe("typescriptreact")
  expect(documentLanguageId("typescript", "lib/x.mjs")).toBe("javascript")
  expect(documentLanguageId("typescript", "noext")).toBe("typescript")
})
