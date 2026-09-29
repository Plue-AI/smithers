/*
 * The cloud language-server transport (lane L6, plue #505; docs/code-intel/
 * PLAN.md "Live"): one WebSocket per (workspace, language), through the Bun
 * tunnel at `/api/cloud-ws/…/lsp` (the local session capability rides the
 * subprotocol, the bearer never reaches the renderer), to the language server
 * plue runs inside the workspace. The client speaks LSP itself — `initialize`
 * with the guest checkout as root and workspace folder, `initialized`,
 * `didOpen` with the CARD's text at its checkout-relative path, then hover,
 * definition and the publications the server makes — and converts the wire
 * once, through the same @smthrs/rpc/LspWire the native host uses, so a hover
 * reads the same on either machine.
 *
 * Mirrors CloudTerminalClient's stance on the close codes (ADR 0002, plue
 * #505): 1001 and an abnormal 1006 reconnect (a fresh server: initialize and
 * every open document again), 1011 retries once with a fresh initialize,
 * 1008/1002/1003/1009 and every 44xx refusal are final — except 4425
 * `workspace_session_pending` and 4503 `guest_not_ready`, which the server
 * asked to be retried on its own `Retry-After` (bounded, the server's words
 * shown meanwhile). Pending requests receive bounded automatic reconnects.
 * Terminal and idle closes reach listeners with the reason verbatim; an
 * idle closed connection is redialed by the next act.
 */
import { Data } from "effect"
import {
  CLOUD_LSP_REASSEMBLY_CAP_BYTES,
  CLOUD_LSP_ROOT_URI,
  CLOUD_WS_NOT_READY_CLOSE_CODE,
  CLOUD_WS_PENDING_CLOSE_CODE,
  CloudLspFragmentSchema,
  CloudLspSessionSchema,
  retryAfterOf
} from "@smthrs/rpc/CloudTunnel"
import {
  LSP_DIAGNOSTICS_CAP,
  LSP_LANGUAGE_SERVER_MISSING,
  LSP_LOCATIONS_CAP,
  LSP_REQUEST_TIMEOUT_MS
} from "@smthrs/rpc/LocalLsp"
import type { LspDiagnostic, LspHover, LspLanguageId, LspLocation } from "@smthrs/rpc/LocalLsp"
import { hoverContents, LSP_CLIENT_CAPABILITIES, redactHostPaths, relativeToRoot, toDiagnostic, toWireRange } from "@smthrs/rpc/LspWire"
import type { LspDiagnosticWire, LspHoverWire, LspLocationLinkWire, LspLocationWire } from "@smthrs/rpc/LspWire"
import { refusalOf } from "@smthrs/rpc/Refusal"
import { refusalLine } from "@smthrs/rpc/RefusalCopy"
import { refusalWords } from "./seams/SeamContext"

/**
 * Why a language-server request could not be answered. `code` is the
 * machine-readable name (plue's, or `close_<code>` for a socket that ended),
 * `sentence` the product sentence the card and the model read (a server's
 * raw words ride only on the thrown error), and `install` the install line a `language_server_missing`
 * carries — printed, never run.
 */
export interface LspRefusal {
  readonly code: string
  /** One sentence in product words: the card's note and the model's text. */
  readonly sentence: string
  readonly install?: string
}

/** One language-server answer: what the server said, or why it said nothing. */
export type LspAnswer<T> = { readonly ok: T } | { readonly refusal: LspRefusal }

/** One file card's text as the workspace server should see it. */
export interface CloudLspDocument {
  /** `owner/repo`. */
  readonly repo: string
  readonly workspaceId: string
  readonly language: LspLanguageId
  /** Checkout-relative. */
  readonly path: string
  /** The card's content: what `didOpen` sends and what every answer is about. */
  readonly content: string
}

/** A 1-based position, as the flows and the wire carry it. */
export interface CloudLspPosition {
  readonly line: number
  readonly character: number
}

export interface CloudLspHoverAnswer {
  readonly hover: LspHover | null
}
export interface CloudLspDefinitionAnswer {
  readonly locations: ReadonlyArray<LspLocation>
  readonly total: number
  readonly omitted: number
}
export interface CloudLspDiagnosticsAnswer {
  /** Null when the server published nothing for the file within the wait. */
  readonly items: ReadonlyArray<LspDiagnostic> | null
  readonly total: number | null
}

interface EventScope {
  readonly repo: string
  readonly workspaceId: string
  readonly language: LspLanguageId
}

/** What the client tells its listeners without being asked (the seam patches the cards). */
export type CloudLspEvent =
  | (EventScope & {
    readonly type: "diagnostics"
    readonly path: string
    /** The text the publication is about — the seam lands it only on a card still showing this text. */
    readonly content: string
    readonly items: ReadonlyArray<LspDiagnostic>
    readonly total: number
  })
  | (EventScope & {
    readonly type: "closed"
    readonly code: number
    /** The server's or the tunnel's reason, verbatim ("" when it sent none). */
    readonly reason: string
    readonly paths: ReadonlyArray<string>
  })
  | (EventScope & {
    /** A refusal the server asked to be retried: its words, verbatim, while the bounded wait runs. */
    readonly type: "waiting"
    readonly note: string
    readonly paths: ReadonlyArray<string>
  })

export interface CloudLspClient {
  readonly hover: (document: CloudLspDocument, position: CloudLspPosition) => Promise<LspAnswer<CloudLspHoverAnswer>>
  readonly definition: (document: CloudLspDocument, position: CloudLspPosition) => Promise<LspAnswer<CloudLspDefinitionAnswer>>
  readonly diagnostics: (document: CloudLspDocument) => Promise<LspAnswer<CloudLspDiagnosticsAnswer>>
  /** Hear publications, closes and waits for every connection; the returned function detaches. */
  readonly subscribe: (listener: (event: CloudLspEvent) => void) => () => void
  /** Close every socket and forget every connection. */
  readonly dispose: () => void
}

export interface CloudLspClientOptions {
  /** The controller's bounded, tapped fetch (SeamContext.http): the session POST rides the cloud proxy. */
  readonly http: (input: string, init?: RequestInit) => Promise<Response>
  readonly baseUrl: string
  /** The tunnel URL for one session; undefined where no socket can exist (tests, server render). */
  readonly socketUrl: (repo: string, sessionId: string, language: string) => string | undefined
  /** The local-session capability subprotocol; undefined means no socket opens. */
  readonly socketProtocol?: () => string | undefined
  /** Exchanges the selected application credential for a fresh one-use socket ticket. */
  readonly authorizeSocket?: (url: string, signal?: AbortSignal) => Promise<string>
  /** Test/platform seam; production uses the browser WebSocket constructor. */
  readonly socketFactory?: (url: string, protocols?: ReadonlyArray<string>) => WebSocket
  /** One request's ceiling; default LSP_REQUEST_TIMEOUT_MS. */
  readonly requestTimeoutMs?: number
  /**
   * The bounded retry a 425 / 503 / `guest_not_ready` buys: 30 attempts, which
   * at plue's own `Retry-After: 2` is a minute — the activation window. The
   * default delay stands only when the refusal named none this app could read.
   */
  readonly retry?: { readonly maxAttempts: number; readonly defaultDelayMs: number }
  /** The delay before a 1001 / 1006 redial; default 1000 ms. */
  readonly reconnectMs?: number
}

const DEFAULT_RETRY = { maxAttempts: 30, defaultDelayMs: 2_000 }
const DEFAULT_RECONNECT_MS = 1_000
/** Abnormal drops redialed per connection before the drop is the answer; a healthy answer resets it. */
const MAX_RECONNECTS = 3
/** Close codes that reconnect: plue's 1001 "lsp client too slow" and the abnormal 1006 the tunnel turns a going-away into. */
const RECONNECT_CODES: ReadonlySet<number> = new Set([1001, 1006])
/** The tunnel's codes for a refusal plue asked to be retried (the `Retry-After` rides the reason). */
const RETRY_CODES: ReadonlySet<number> = new Set([CLOUD_WS_PENDING_CLOSE_CODE, CLOUD_WS_NOT_READY_CLOSE_CODE])
const GUEST_NOT_READY = "guest_not_ready"
/** The guest's checkout as a path, for the redaction of the server's free text. */
const ROOT_PATH = "/home/developer/workspace"

/** The same-origin tunnel URL of the page for the lsp branch, or undefined outside a browser. */
export const pageCloudLspSocketUrl = (repo: string, sessionId: string, language: string, baseUrl = ""): string | undefined => {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return undefined
  const origin = new URL(baseUrl === "" ? window.location.origin : baseUrl)
  const { protocol, host } = origin
  const [owner = "", name = ""] = repo.split("/")
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/workspace/sessions/${
    encodeURIComponent(sessionId)
  }/lsp?language=${encodeURIComponent(language)}`
}

/** The file URI of a checkout-relative path under the guest root. */
export const cloudDocumentUri = (path: string): string => `${CLOUD_LSP_ROOT_URI}/${path.split("/").map(encodeURIComponent).join("/")}`

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null


/** The `didOpen` languageId for a path, in the server's vocabulary (typescript-language-server's four). */
const TYPESCRIPT_DOCUMENT_IDS: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact"
}

export const documentLanguageId = (language: LspLanguageId, path: string): string => {
  const extension = /\.[^./]+$/.exec(path)?.[0]?.toLowerCase() ?? ""
  return language === "typescript" ? TYPESCRIPT_DOCUMENT_IDS[extension] ?? "typescript" : language
}

/** A refusal thrown through the client's own promises; every act catches it into `{ refusal }`. */
class Refused extends Data.TaggedError("CloudLspRefused")<{ readonly refusal: LspRefusal; readonly message: string }> {
  /** `detail` is the raw text behind the refusal, for diagnostics; the refusal carries only product words. */
  constructor(refusal: LspRefusal, detail?: string) {
    super({ refusal, message: detail ?? refusal.code })
  }
}

/** A close as the model and the card read it: the missing server's install line, else one sentence. */
const closeRefusal = (code: number, reason: string): LspRefusal => {
  const text = reason.trim()
  if (text.startsWith(`${LSP_LANGUAGE_SERVER_MISSING}:`)) {
    return { code: LSP_LANGUAGE_SERVER_MISSING, sentence: text, install: text.slice(LSP_LANGUAGE_SERVER_MISSING.length + 1).trim() }
  }
  /* Code 0 is this client's own close, worded here; any other reason is the relay's text. */
  if (code === 0 && text !== "") return { code: "close_0", sentence: `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/u.test(text) ? "" : "."}` }
  return { code: `close_${code}`, sentence: "The workspace language server closed." }
}

interface Pending {
  id: number
  readonly method: string
  readonly params: unknown
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Refused) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface OpenDocument {
  readonly uri: string
  version: number
  text: string
  latest: CloudLspDiagnosticsAnswer | null
  /** True from an open or change until the server publishes for it. */
  awaiting: boolean
  waiters: Array<(answer: CloudLspDiagnosticsAnswer) => void>
}

interface Connection extends EventScope {
  readonly key: string
  sessionId: string | undefined
  socket: WebSocket | undefined
  /** True once `initialize` answered on the current socket. */
  ready: boolean
  /** The dial in flight, shared by every act that arrives during it. */
  opening: Promise<void> | undefined
  failDial: ((code: number, reason: string) => void) | undefined
  nextId: number
  readonly pending: Map<number, Pending>
  readonly documents: Map<string, OpenDocument>
  /** The fragment set being reassembled, or null between sets. */
  fragments: { next: number; readonly parts: Array<string>; bytes: number } | null
  /** A 1011 is retried once with a fresh initialize; the second is the answer. */
  retried1011: boolean
  /** Abnormal drops redialed since the last healthy answer. */
  reconnects: number
  reconnect: ReturnType<typeof setTimeout> | undefined
}

export const createCloudLspClient = (options: CloudLspClientOptions): CloudLspClient => {
  const socketFactory = options.socketFactory ?? ((url: string, protocols?: ReadonlyArray<string>) =>
    protocols === undefined ? new WebSocket(url) : new WebSocket(url, [...protocols]))
  const requestTimeoutMs = options.requestTimeoutMs ?? LSP_REQUEST_TIMEOUT_MS
  const retry = options.retry ?? DEFAULT_RETRY
  const reconnectMs = options.reconnectMs ?? DEFAULT_RECONNECT_MS
  const connections = new Map<string, Connection>()
  const sockets = new Set<WebSocket>()
  const listeners = new Set<(event: CloudLspEvent) => void>()
  let disposed = false
  const lifetime = new AbortController()
  const closing: LspRefusal = { code: "disposed", sentence: "The app is closing." }
  const assertActive = (): void => {
    if (disposed) throw new Refused(closing)
  }

  /** Settle owned waits even when the injected HTTP implementation ignores abort. */
  const whileActive = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const abort = (): void => {
      lifetime.signal.removeEventListener("abort", abort)
      reject(new Refused(closing))
    }
    lifetime.signal.addEventListener("abort", abort, { once: true })
    if (disposed) abort()
    void work.then(resolve, reject).finally(() => lifetime.signal.removeEventListener("abort", abort))
  })

  const emit = (event: CloudLspEvent): void => {
    for (const listener of listeners) listener(event)
  }

  const scopeOf = (conn: Connection): EventScope => ({ repo: conn.repo, workspaceId: conn.workspaceId, language: conn.language })

  const redact = (text: string): string => redactHostPaths(text, ROOT_PATH)

  const connection = (document: CloudLspDocument): Connection => {
    const key = `${document.workspaceId}\u0000${document.language}`
    let conn = connections.get(key)
    if (conn === undefined) {
      conn = {
        key,
        repo: document.repo,
        workspaceId: document.workspaceId,
        language: document.language,
        sessionId: undefined,
        socket: undefined,
        ready: false,
        opening: undefined,
        failDial: undefined,
        nextId: 1,
        pending: new Map(),
        documents: new Map(),
        fragments: null,
        retried1011: false,
        reconnects: 0,
        reconnect: undefined
      }
      connections.set(key, conn)
    }
    return conn
  }

  const sleep = async (ms: number): Promise<void> => {
    assertActive()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await whileActive(new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) }))
      assertActive()
    } finally {
      clearTimeout(timer)
    }
  }

  /*
   * `POST …/workspace/sessions { workspace_id, kind: "lsp", language }` through
   * the cloud proxy: one session per (workspace, language), the same id on a
   * repeat. plue#504's `503 guest_not_ready` carries a `Retry-After` and is the
   * one refusal the POST retries, on the server's clock, bounded; every other
   * refusal is answered once, in plue's words.
   */
  const createSession = async (conn: Connection, attempt: { count: number }): Promise<string> => {
    const [owner = "", name = ""] = conn.repo.split("/")
    const url = `${options.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/workspace/sessions`
    for (;;) {
      assertActive()
      let response: Response
      try {
        response = await whileActive(options.http(url, {
          signal: lifetime.signal,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspace_id: conn.workspaceId, kind: "lsp", language: conn.language })
        }))
        assertActive()
      } catch {
        assertActive()
        // A thrown request's text is not copy; the tapped fetch recorded it.
        throw new Refused({ code: "unreachable", sentence: "Could not reach Smithers Cloud." })
      }
      const body: unknown = await whileActive(response.json().catch(() => null))
      assertActive()
      if (response.ok) {
        const session = CloudLspSessionSchema.safeParse(body)
        if (!session.success) throw new Refused({ code: "unreadable", sentence: "Smithers Cloud's answer for the language-server session was malformed." })
        return session.data.id
      }
      const code = isRecord(body) && typeof body.code === "string" && body.code !== "" ? body.code : null
      const fallback = "The workspace language server didn't start."
      /* plue's words only when the reader can act on them (an install line); otherwise what failed and whose fault it was. */
      const text = refusalLine(refusalOf({ body, status: response.status, message: refusalWords(body, fallback, response.status) }), fallback)
      const retryAfter = Number(response.headers.get("retry-after")?.trim())
      if (code === GUEST_NOT_READY && attempt.count < retry.maxAttempts && !disposed) {
        attempt.count += 1
        emit({ ...scopeOf(conn), type: "waiting", note: text, paths: [...conn.documents.keys()] })
        await sleep(Number.isInteger(retryAfter) && retryAfter >= 0 ? retryAfter * 1_000 : retry.defaultDelayMs)
        continue
      }
      throw new Refused({ code: code ?? `http_${response.status}`, sentence: text })
    }
  }

  const send = (conn: Connection, message: Record<string, unknown>): void => {
    assertActive()
    conn.socket?.send(JSON.stringify({ jsonrpc: "2.0", ...message }))
  }

  const notify = (conn: Connection, method: string, params: unknown): void => {
    send(conn, { method, params })
  }

  /** One request on the current socket, with its id; a close before the answer is the close handler's to settle. */
  const enqueue = (conn: Connection, method: string, params: unknown): { readonly id: number; readonly answer: Promise<unknown> } => {
    const id = conn.nextId
    conn.nextId += 1
    const answer = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(entry.id)
        reject(new Refused({ code: "language_server_timeout", sentence: `The workspace language server did not answer ${method} within ${requestTimeoutMs / 1000} s.` }))
      }, requestTimeoutMs)
      ;(timer as { unref?: () => void }).unref?.()
      const entry: Pending = { id, method, params, resolve, reject, timer }
      conn.pending.set(id, entry)
      send(conn, { id, method, params })
    })
    return { id, answer }
  }

  const request = (conn: Connection, method: string, params: unknown): Promise<unknown> => enqueue(conn, method, params).answer

  /** Reissue under the current id while keeping the original timer and absolute deadline. */
  const reissue = (conn: Connection): void => {
    const waiting = [...conn.pending.values()]
    conn.pending.clear()
    for (const entry of waiting) {
      const id = conn.nextId
      conn.nextId += 1
      entry.id = id
      conn.pending.set(id, entry)
      send(conn, { id, method: entry.method, params: entry.params })
    }
  }

  const rejectPending = (conn: Connection, refusal: LspRefusal): void => {
    for (const entry of conn.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Refused(refusal))
    }
    conn.pending.clear()
    for (const document of conn.documents.values()) {
      const waiters = document.waiters
      document.waiters = []
      for (const waiter of waiters) waiter({ items: null, total: null })
    }
  }

  const onPublishDiagnostics = (conn: Connection, params: unknown): void => {
    if (!isRecord(params) || typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) return
    const relative = relativeToRoot(params.uri, CLOUD_LSP_ROOT_URI)
    if (relative === null) return
    // A publication for a file no card opened has no card to land on: it stays with the server.
    const document = conn.documents.get(relative)
    if (document === undefined) return
    // A slow publication can arrive after didChange. Its version must match
    // the text we attribute to the card; it cannot satisfy the new read.
    if (typeof params.version === "number" && params.version !== document.version) return
    const wire = params.diagnostics as ReadonlyArray<LspDiagnosticWire>
    const items = wire.slice(0, LSP_DIAGNOSTICS_CAP).map((item) => toDiagnostic(item, redact))
    const total = wire.length
    const answer: CloudLspDiagnosticsAnswer = { items, total }
    document.latest = answer
    document.awaiting = false
    const waiters = document.waiters
    document.waiters = []
    for (const waiter of waiters) waiter(answer)
    emit({ ...scopeOf(conn), type: "diagnostics", path: relative, content: document.text, items, total })
  }

  const onMessage = (conn: Connection, message: unknown): void => {
    if (!isRecord(message)) return
    const id = message.id
    if (typeof message.method === "string") {
      if (typeof id === "number" || typeof id === "string") {
        // A server request: settings per document are none (null keeps the server's defaults); anything else answers null.
        const params = message.params
        const result = message.method === "workspace/configuration" && isRecord(params) && Array.isArray(params.items)
          ? params.items.map(() => null)
          : null
        send(conn, { id, result })
        return
      }
      if (message.method === "textDocument/publishDiagnostics") onPublishDiagnostics(conn, message.params)
      return
    }
    if (typeof id !== "number") return
    const entry = conn.pending.get(id)
    if (entry === undefined) return
    conn.pending.delete(id)
    clearTimeout(entry.timer)
    if ("error" in message && isRecord(message.error)) {
      const answered = message.error
      entry.reject(new Refused(
        { code: "language_server_error", sentence: "The language server couldn't answer that request." },
        redact(String(answered.message ?? "the language server refused the request"))
      ))
      return
    }
    entry.resolve(message.result)
  }

  /*
   * One text frame is one JSON-RPC message, or one `{ seq, last, data }`
   * fragment of a message larger than plue's frame cap: fragments run from 1,
   * in order, and are joined up to CLOUD_LSP_REASSEMBLY_CAP_BYTES. A gap or an
   * over-cap set is dropped whole (the request it carried times out), never
   * parsed in part.
   */
  const onFrame = (conn: Connection, data: string): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    const fragment = CloudLspFragmentSchema.safeParse(parsed)
    if (!fragment.success) {
      onMessage(conn, parsed)
      return
    }
    const { seq, last, data: part } = fragment.data
    if (seq === 1) conn.fragments = { next: 1, parts: [], bytes: 0 }
    const set = conn.fragments
    if (set === null || set.next !== seq) {
      conn.fragments = null
      return
    }
    set.bytes += part.length
    if (set.bytes > CLOUD_LSP_REASSEMBLY_CAP_BYTES) {
      conn.fragments = null
      return
    }
    set.parts.push(part)
    set.next += 1
    if (!last) return
    conn.fragments = null
    let whole: unknown
    try {
      whole = JSON.parse(set.parts.join(""))
    } catch {
      return
    }
    onMessage(conn, whole)
  }

  const decode = (data: unknown): string | null => {
    if (typeof data === "string") return data
    // plue sends text frames only (a binary frame is refused 1003); the tunnel relays what it got.
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
    if (typeof Uint8Array !== "undefined" && data instanceof Uint8Array) return new TextDecoder().decode(data)
    return null
  }

  /** `didOpen` for every document the connection knows, on a fresh server (its versions start over). */
  const reopenAll = (conn: Connection): void => {
    for (const [path, document] of conn.documents) {
      document.version = 1
      document.awaiting = true
      notify(conn, "textDocument/didOpen", {
        textDocument: { uri: document.uri, languageId: documentLanguageId(conn.language, path), version: 1, text: document.text }
      })
    }
  }

  const releaseSocket = (conn: Connection, socket: WebSocket): void => {
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    sockets.delete(socket)
    if (conn.socket === socket) {
      conn.socket = undefined
      conn.ready = false
      conn.fragments = null
    }
    socket.close()
  }

  /**
   * Dial one socket and run `initialize` on it. Settles `{ ok }` once the
   * server answered and `initialized` went out; `{ close }` with the code and
   * reason when the socket closed first (a refusal the tunnel classified, or a
   * server that died before ready).
   */
  const openSocket = async (
    conn: Connection,
    sessionId: string
  ): Promise<{ readonly ok: true } | { readonly close: { readonly code: number; readonly reason: string } }> => {
    assertActive()
    const rawUrl = options.socketUrl(conn.repo, sessionId, conn.language)
    const protocol = options.socketProtocol?.()
    if (rawUrl === undefined || (options.authorizeSocket === undefined && protocol === undefined)) {
      return { close: { code: 0, reason: "no cloud socket can open from here" } }
    }
    let url: string
    try {
      url = options.authorizeSocket === undefined
        ? rawUrl
        : await whileActive(options.authorizeSocket(rawUrl, lifetime.signal))
    } catch {
      assertActive()
      return { close: { code: 0, reason: "the code intelligence connection could not be authorized" } }
    }
    assertActive()
    return new Promise((resolve, reject) => {
      let socket: WebSocket
      try {
        socket = socketFactory(url, protocol === undefined ? undefined : [protocol])
      } catch {
        resolve({ close: { code: 0, reason: "the code intelligence connection could not open" } })
        return
      }
      conn.socket = socket
      conn.ready = false
      conn.fragments = null
      sockets.add(socket)
      let settled = false
      let initializeId: number | undefined
      // The request timer starts only after onopen; bound the upgrade separately.
      const openingTimer = setTimeout(() => {
        if (settled || conn.socket !== socket) return
        settled = true
        conn.failDial = undefined
        releaseSocket(conn, socket)
        reject(new Refused({
          code: "language_server_timeout",
          sentence: `The workspace language server did not open within ${requestTimeoutMs / 1000} s.`
        }))
      }, requestTimeoutMs)
      ;(openingTimer as { unref?: () => void }).unref?.()
      const failDial = (code: number, reason: string): void => {
        if (settled) return
        settled = true
        clearTimeout(openingTimer)
        conn.failDial = undefined
        releaseSocket(conn, socket)
        if (initializeId !== undefined) {
          const entry = conn.pending.get(initializeId)
          if (entry !== undefined) {
            clearTimeout(entry.timer)
            conn.pending.delete(initializeId)
            entry.reject(new Refused(disposed ? closing : closeRefusal(code, reason)))
          }
        }
        resolve({ close: { code, reason } })
      }
      conn.failDial = failDial
      socket.onopen = () => {
        if (conn.socket !== socket || settled) return
        clearTimeout(openingTimer)
        const initialize = enqueue(conn, "initialize", {
          processId: null,
          clientInfo: { name: "smithers" },
          rootUri: CLOUD_LSP_ROOT_URI,
          workspaceFolders: [{ uri: CLOUD_LSP_ROOT_URI, name: "workspace" }],
          capabilities: LSP_CLIENT_CAPABILITIES
        })
        initializeId = initialize.id
        void initialize.answer.then(() => {
          if (conn.socket !== socket || settled) return
          notify(conn, "initialized", {})
          conn.ready = true
          reopenAll(conn)
          settled = true
          conn.failDial = undefined
          resolve({ ok: true })
        }, () => {
          if (conn.socket !== socket || settled) return
          failDial(0, "the workspace language server did not answer initialize")
        })
      }
      socket.onmessage = (event: MessageEvent) => {
        if (conn.socket !== socket) return
        const text = decode(event.data)
        if (text !== null) onFrame(conn, text)
      }
      socket.onerror = () => {
        // onclose follows; the policy lives there.
      }
      socket.onclose = (event: CloseEvent) => {
        if (conn.socket !== socket) return
        if (!settled) {
          failDial(event.code, event.reason)
          return
        }
        releaseSocket(conn, socket)
        if (disposed) return
        onClosed(conn, event.code, event.reason)
      }
    })
  }

  /*
   * A close after `initialize` answered. 1011 (the server exited or broke the
   * protocol) is redialed once with a fresh initialize; 1001 and an abnormal
   * 1006 are redialed, bounded; both only while a request waits — a close with
   * nothing in flight is stated to the listeners and the NEXT act redials.
   * Everything else — 1000 with plue's reason, 1008, 1002/1003/1009 — is the
   * answer: every waiting request reads the reason, verbatim, and so do the
   * listeners. Never a silent close.
   */
  const onClosed = (conn: Connection, code: number, reason: string): void => {
    const redialable = code === 1011 ? !conn.retried1011 : RECONNECT_CODES.has(code) && conn.reconnects < MAX_RECONNECTS
    if (redialable && conn.pending.size > 0) {
      if (code === 1011) conn.retried1011 = true
      else conn.reconnects += 1
      conn.reconnect = setTimeout(() => {
        conn.reconnect = undefined
        void ensureReady(conn).then(
          () => reissue(conn),
          (error: unknown) => {
            const refusal = error instanceof Refused ? error.refusal : { code: "unreachable", sentence: "the workspace language server could not restart" }
            rejectPending(conn, refusal)
            emit({ ...scopeOf(conn), type: "closed", code, reason, paths: [...conn.documents.keys()] })
          }
        )
      }, code === 1011 ? 0 : reconnectMs)
      ;(conn.reconnect as { unref?: () => void }).unref?.()
      return
    }
    rejectPending(conn, closeRefusal(code, reason))
    emit({ ...scopeOf(conn), type: "closed", code, reason, paths: [...conn.documents.keys()] })
  }

  /*
   * The socket and its server, ready: the session POST, the dial through the
   * tunnel, `initialize`. A 4425 / 4503 close is plue asking to be retried on
   * its `Retry-After`, honored bounded with its words shown meanwhile; a 1011
   * before ready is retried once; every other close before ready is the
   * refusal, verbatim. Concurrent acts share one dial.
   */
  const ensureReady = (conn: Connection): Promise<void> => {
    if (disposed) return Promise.reject(new Refused(closing))
    if (conn.socket !== undefined && conn.ready && conn.socket.readyState === WebSocket.OPEN) return Promise.resolve()
    if (conn.opening !== undefined) return conn.opening
    const dial = (async () => {
      const attempt = { count: 0 }
      let lastNote = ""
      for (;;) {
        assertActive()
        if (conn.sessionId === undefined) {
          const sessionId = await createSession(conn, attempt)
          assertActive()
          conn.sessionId = sessionId
        }
        const outcome = await openSocket(conn, conn.sessionId)
        assertActive()
        if ("ok" in outcome) return
        const { code, reason } = outcome.close
        // A session plue asked to wait for still stands; any other refusal drops it, and the next dial asks plue again (the same id when it still exists).
        if (!RETRY_CODES.has(code)) conn.sessionId = undefined
        if (RETRY_CODES.has(code) && attempt.count < retry.maxAttempts) {
          attempt.count += 1
          lastNote = reason
          emit({ ...scopeOf(conn), type: "waiting", note: reason, paths: [...conn.documents.keys()] })
          const seconds = retryAfterOf(reason)
          await sleep(seconds === null ? retry.defaultDelayMs : seconds * 1_000)
          continue
        }
        if (code === 1011 && !conn.retried1011) {
          conn.retried1011 = true
          continue
        }
        if (RETRY_CODES.has(code)) throw new Refused({ code: `close_${code}`, sentence: `The workspace language server still wasn't ready after ${retry.maxAttempts} tries.` }, `${lastNote || reason} (${code})`)
        // The act that dialed carries this refusal to the card and the model; no second telling.
        throw new Refused(closeRefusal(code, reason))
      }
    })()
    conn.opening = dial.finally(() => {
      conn.opening = undefined
    })
    return conn.opening
  }

  /** The document as the server should see it: opened on first use, re-sent in full when the card's text changed since. */
  const sync = (conn: Connection, document: CloudLspDocument): OpenDocument => {
    const existing = conn.documents.get(document.path)
    if (existing === undefined) {
      const opened: OpenDocument = { uri: cloudDocumentUri(document.path), version: 1, text: document.content, latest: null, awaiting: true, waiters: [] }
      conn.documents.set(document.path, opened)
      notify(conn, "textDocument/didOpen", {
        textDocument: { uri: opened.uri, languageId: documentLanguageId(conn.language, document.path), version: 1, text: opened.text }
      })
      return opened
    }
    if (existing.text !== document.content) {
      existing.version += 1
      existing.text = document.content
      existing.awaiting = true
      notify(conn, "textDocument/didChange", { textDocument: { uri: existing.uri, version: existing.version }, contentChanges: [{ text: existing.text }] })
    }
    return existing
  }

  const positioned = async <T>(document: CloudLspDocument, position: CloudLspPosition, method: string): Promise<T> => {
    const conn = connection(document)
    await ensureReady(conn)
    assertActive()
    const opened = sync(conn, document)
    const answer = await request(conn, method, { textDocument: { uri: opened.uri }, position: { line: position.line - 1, character: position.character - 1 } })
    // A healthy answer earns a fresh redial budget.
    conn.reconnects = 0
    conn.retried1011 = false
    return answer as T
  }

  const answer = async <T>(work: () => Promise<T>): Promise<LspAnswer<T>> => {
    try {
      return { ok: await work() }
    } catch (error) {
      return { refusal: error instanceof Refused ? error.refusal : { code: "failed", sentence: "Code intelligence hit an unexpected error." } }
    }
  }

  const hover: CloudLspClient["hover"] = (document, position) =>
    answer(async () => {
      const wire = await positioned<LspHoverWire | null>(document, position, "textDocument/hover")
      if (wire === null || !isRecord(wire) || wire.contents === undefined) return { hover: null }
      const { contents, truncated } = hoverContents(wire.contents, redact)
      if (contents.trim() === "") return { hover: null }
      return { hover: { contents, truncated, ...(wire.range === undefined ? {} : { range: toWireRange(wire.range) }) } }
    })

  const definition: CloudLspClient["definition"] = (document, position) =>
    answer(async () => {
      const wire = await positioned<LspLocationWire | ReadonlyArray<LspLocationWire | LspLocationLinkWire> | null>(document, position, "textDocument/definition")
      const list = wire === null ? [] : Array.isArray(wire) ? wire : [wire as LspLocationWire]
      const locations: Array<LspLocation> = []
      let omitted = 0
      for (const entry of list) {
        const uri = "targetUri" in entry ? entry.targetUri : entry.uri
        const range = "targetUri" in entry ? entry.targetSelectionRange ?? entry.targetRange : entry.range
        const relative = relativeToRoot(uri, CLOUD_LSP_ROOT_URI)
        // A target outside the checkout (a store path, a lib.d.ts) is not a file card the renderer can open; it is counted, never invented away.
        if (relative === null) {
          omitted += 1
          continue
        }
        if (locations.length < LSP_LOCATIONS_CAP) locations.push({ path: relative, ...toWireRange(range) })
      }
      return { locations, total: list.length, omitted }
    })

  const diagnostics: CloudLspClient["diagnostics"] = (document) =>
    answer(async () => {
      const conn = connection(document)
      await ensureReady(conn)
      assertActive()
      const opened = sync(conn, document)
      if (!opened.awaiting && opened.latest !== null) return opened.latest
      return new Promise<CloudLspDiagnosticsAnswer>((resolve) => {
        const timer = setTimeout(() => {
          opened.waiters = opened.waiters.filter((waiter) => waiter !== settle)
          resolve({ items: null, total: null })
        }, requestTimeoutMs)
        ;(timer as { unref?: () => void }).unref?.()
        const settle = (published: CloudLspDiagnosticsAnswer): void => {
          clearTimeout(timer)
          resolve(published)
        }
        opened.waiters.push(settle)
      })
    })

  const subscribe: CloudLspClient["subscribe"] = (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const dispose = (): void => {
    disposed = true
    lifetime.abort()
    for (const conn of connections.values()) {
      if (conn.reconnect !== undefined) clearTimeout(conn.reconnect)
      conn.reconnect = undefined
      conn.failDial?.(0, closing.sentence)
      rejectPending(conn, closing)
      if (conn.socket !== undefined) releaseSocket(conn, conn.socket)
      conn.sessionId = undefined
    }
    connections.clear()
    listeners.clear()
    sockets.clear()
  }

  return { hover, definition, diagnostics, subscribe, dispose }
}
