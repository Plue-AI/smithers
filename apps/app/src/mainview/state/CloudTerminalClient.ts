/*
 * The cloud-workspace terminal transport (lane citc): one WebSocket per
 * workspace session, through the same-origin tunnel at `/api/cloud-ws/`.
 * Native authenticates with its local-session subprotocol; web uses its
 * cookie. The cloud bearer stays in the host. On plue's terminal socket,
 * binary frames are stdin/stdout,
 * a text JSON frame resizes. Mirrors PtyClient's stance: keystrokes and the
 * terminal's fit sent before the socket opens are queued, and the socket reconnects while
 * attachments exist — and only while they exist: detaching the last one
 * closes the socket for good, and a refusal never redials.
 */

export interface CloudTerminalAttachment {
  readonly onOutput: (data: string) => void
}

export interface CloudTerminalClient {
  /** Subscribe to one workspace session's output; the returned function detaches. */
  readonly attach: (repo: string, sessionId: string, attachment: CloudTerminalAttachment) => () => void
  /** Text typed into the session's stdin as a binary frame; typed before any view attaches, it waits for the attach. */
  readonly input: (sessionId: string, data: string) => void
  /** A resize control frame; sent before the socket opens it waits with the keystrokes. */
  readonly resize: (sessionId: string, cols: number, rows: number) => void
  /** Close every socket and forget every attachment. */
  readonly dispose: () => void
}

export interface CloudTerminalClientOptions {
  /** The tunnel URL for one session; undefined where no socket can exist (tests, server render). */
  readonly socketUrl: (repo: string, sessionId: string) => string | undefined
  /** Native uses its local capability; the web host authenticates the same-origin cookie. */
  readonly auth: "subprotocol" | "cookie" | "ticket"
  /** The local-session capability; required only in subprotocol mode. */
  readonly socketProtocol?: () => string | undefined
  /** Exchanges the selected application credential for a fresh one-use socket ticket. */
  readonly authorizeSocket?: (url: string, signal?: AbortSignal) => Promise<string>
  /** Test/platform seam; production uses the browser WebSocket constructor. */
  readonly openSocket?: (url: string, protocols?: ReadonlyArray<string>) => WebSocket
  /** The first reconnect delay; every later one doubles, up to maxReconnectMs. */
  readonly reconnectMs?: number
  readonly maxReconnectMs?: number
  /**
   * Reconnect dials the whole client may make per rolling minute, every
   * session together. plue admits 20 terminal opens per user per minute
   * (internal/middleware/rate_limit.go), and a refused upgrade's status-recovery
   * GET counts the same, so the client's redials stay well under half of it
   * and the user's own opens are never the ones refused.
   */
  readonly maxReconnectsPerMinute?: number
  /** A socket that stayed open this long was healthy: its drop redials promptly instead of continuing the backoff. */
  readonly healthyMs?: number
  /**
   * How soon after a socket opens a normal close still counts as a STARTUP
   * failure (plue#504). A shell that ran longer than this died of something
   * else and is never redialed.
   */
  readonly earlyExitMs?: number
}

/** Frames queued per session before its socket opens. */
const MAX_PENDING = 256
/** How long keystrokes typed before any view attached wait for one: a terminal view loads in seconds. */
const EARLY_INPUT_MS = 30_000

/**
 * A frame written before the socket opened. Its kind survives the wait: stdin
 * goes out binary, a resize goes out as the text control frame, and flushing
 * cannot turn one into the other.
 */
type PendingFrame =
  | { readonly kind: "input"; readonly data: string }
  | { readonly kind: "control"; readonly frame: string }

const DEFAULT_RECONNECT_MS = 1000
const DEFAULT_MAX_RECONNECT_MS = 30_000
// Each refused upgrade also costs one status-recovery GET against the SAME 20/min per-user budget, so 6 dials + 6 recoveries leaves headroom for the human's own opens.
const DEFAULT_MAX_RECONNECTS_PER_MINUTE = 6
const DEFAULT_HEALTHY_MS = 30_000
/*
 * plue#504: while a vm or desktop guest finishes its NixOS activation the
 * login shell is missing, so the PTY exits 127 within a second or two and
 * plue closes the durable session NORMALLY (1000) with its own reason,
 * `session exited: Process exited with status 127`. plue retries that once on
 * its own (its startup watch is 2 s, its retry delay 3 s); this window is the
 * renderer's half of the same instruction, and 5 s covers plue's own pair.
 */
const DEFAULT_EARLY_EXIT_MS = 5_000
const MINUTE_MS = 60_000

/*
 * plue's close codes (internal/routes/workspace_terminal.go, ADR 0002
 * "Terminal attach contract") and the tunnel's translations of its
 * pre-upgrade refusals (src/bun/server.ts): 1001 "terminal client too slow"
 * and an abnormal 1006 drop reconnect; 1011 "failed to attach terminal"
 * retries once; everything here is final — the listeners hear the note once
 * and no redial ever starts.
 */
const FINAL_NOTES: Readonly<Record<number, string>> = {
  1000: "session closed",
  1008: "access revoked",
  4401: "not attached — sign in to Smithers Cloud first (/cloud.sign-in)",
  4403: "not attached — this account can't open the workspace terminal",
  4404: "not attached — the session is gone",
  4409: "not attached — the session isn't running",
  4429: "not attached — Smithers Cloud is rate limiting terminal opens; try again in a minute"
}

const RECONNECT_CODES: ReadonlySet<number> = new Set([1001, 1006])

/**
 * plue's own close reason for a guest whose login shell is not there yet:
 * `session exited: Process exited with status 127` (the SSH `ExitError` under
 * `terminalSession.markDead`'s `session exited: %w`). Matched on the status
 * alone so the sentence around it stays the server's to word.
 */
export const namesMissingShellExit = (reason: string): boolean => /(^|\s)status 127(\s|$)/.test(reason.trim())

/** The same-origin tunnel URL of the page, or undefined outside a browser. */
export const pageCloudSocketUrl = (repo: string, sessionId: string, baseUrl = ""): string | undefined => {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return undefined
  const origin = new URL(baseUrl === "" ? window.location.origin : baseUrl)
  const { protocol, host } = origin
  const [owner = "", name = ""] = repo.split("/")
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/workspace/sessions/${encodeURIComponent(sessionId)}/terminal`
}

interface Connection {
  socket: WebSocket | undefined
  opening: AbortController | undefined
  readonly listeners: Set<CloudTerminalAttachment>
  readonly pending: Array<PendingFrame>
  reconnect: ReturnType<typeof setTimeout> | undefined
  /** Reconnects since the last healthy open; drives the backoff exponent. */
  attempts: number
  /** A 1011 attach failure is retried once; the second is surfaced. */
  retriedAttach: boolean
  /** plue#504: an exit-127 startup failure is retried once; the second is surfaced. */
  retriedEarlyExit: boolean
}

interface Entry {
  readonly repo: string
  readonly conn: Connection
}

export const createCloudTerminalClient = (options: CloudTerminalClientOptions): CloudTerminalClient => {
  const connections = new Map<string, Entry>()
  /** Every socket this client opened and has not seen close: dispose reaches each one, attached or not. */
  const sockets = new Set<WebSocket>()
  /** Reconnect dials reserved in the rolling minute (planned times, so simultaneous schedulers see each other). */
  const reconnectDials: Array<number> = []
  let disposed = false
  const openSocket = options.openSocket ?? ((url: string, protocols?: ReadonlyArray<string>) =>
    protocols === undefined ? new WebSocket(url) : new WebSocket(url, [...protocols]))

  const reconnectMs = options.reconnectMs ?? DEFAULT_RECONNECT_MS
  const maxReconnectMs = Math.max(options.maxReconnectMs ?? DEFAULT_MAX_RECONNECT_MS, reconnectMs)
  const maxReconnectsPerMinute = options.maxReconnectsPerMinute ?? DEFAULT_MAX_RECONNECTS_PER_MINUTE
  const healthyMs = options.healthyMs ?? DEFAULT_HEALTHY_MS
  const earlyExitMs = options.earlyExitMs ?? DEFAULT_EARLY_EXIT_MS

  const decode = (data: unknown, decoder: TextDecoder): Promise<string | null> => {
    if (typeof data === "string") return Promise.resolve(data)
    if (data instanceof ArrayBuffer) return Promise.resolve(decoder.decode(data, { stream: true }))
    /* Bun's client delivers binary frames as Buffer (a Uint8Array); a browser as Blob/ArrayBuffer. */
    if (typeof Uint8Array !== "undefined" && data instanceof Uint8Array) {
      return Promise.resolve(decoder.decode(data, { stream: true }))
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return data.arrayBuffer().then((buffer) => decoder.decode(buffer, { stream: true })).catch(() => null)
    }
    return Promise.resolve(null)
  }

  const say = (conn: Connection, note: string): void => {
    for (const listener of conn.listeners) listener.onOutput(`\r\n[${note}]\r\n`)
  }

  /** The wait until the rolling-minute reconnect budget admits one more dial; reserves the slot. */
  const reserveReconnectDial = (earliest: number): number => {
    const now = Date.now()
    while (reconnectDials.length > 0 && reconnectDials[0]! <= now - MINUTE_MS) reconnectDials.shift()
    let at = earliest
    if (reconnectDials.length >= maxReconnectsPerMinute) {
      const frees = reconnectDials[reconnectDials.length - maxReconnectsPerMinute]! + MINUTE_MS
      at = Math.max(at, frees)
    }
    reconnectDials.push(at)
    reconnectDials.sort((left, right) => left - right)
    return at
  }

  /*
   * Only a connection somebody still listens to redials: the last detach
   * closes the socket for good, and the closing socket's own onclose is
   * silenced first, so a deliberate close never schedules anything.
   */
  const scheduleReconnect = (sessionId: string, entry: Entry): void => {
    const { conn } = entry
    if (disposed || conn.reconnect !== undefined || conn.listeners.size === 0) return
    conn.attempts += 1
    const backoff = Math.min(reconnectMs * 2 ** (conn.attempts - 1), maxReconnectMs)
    const at = reserveReconnectDial(Date.now() + backoff)
    conn.reconnect = setTimeout(() => {
      conn.reconnect = undefined
      if (disposed || conn.listeners.size === 0) return
      ensureSocket(sessionId, entry)
    }, Math.max(0, at - Date.now()))
    ;(conn.reconnect as { unref?: () => void }).unref?.()
  }

  const ensureSocket = (sessionId: string, entry: Entry): void => {
    const { conn } = entry
    if (disposed || conn.socket !== undefined || conn.opening !== undefined) return
    const rawUrl = options.socketUrl(entry.repo, sessionId)
    const protocol = options.auth === "subprotocol" ? options.socketProtocol?.() : undefined
    if (rawUrl === undefined || (options.auth === "subprotocol" && protocol === undefined)) return
    if (options.auth === "ticket" && options.authorizeSocket === undefined) return
    const opening = new AbortController()
    conn.opening = opening
    void (async () => {
      let url: string
      try {
        url = options.authorizeSocket === undefined
          ? rawUrl
          : await options.authorizeSocket(rawUrl, opening.signal)
      } catch {
        if (conn.opening !== opening || opening.signal.aborted || disposed) return
        conn.opening = undefined
        say(conn, "the terminal connection could not be authorized")
        scheduleReconnect(sessionId, entry)
        return
      }
      if (conn.opening !== opening || opening.signal.aborted || disposed || conn.listeners.size === 0) return
      conn.opening = undefined
      let opened: WebSocket
      try {
        opened = openSocket(url, protocol === undefined ? undefined : [protocol])
      } catch {
        say(conn, "the terminal connection could not open")
        scheduleReconnect(sessionId, entry)
        return
      }
    // PTY frames are arbitrary byte chunks, not complete UTF-8 strings.
    // One decoder belongs to this socket so partial characters survive a
    // frame boundary without leaking into another session or reconnect.
    opened.binaryType = "arraybuffer"
    const decoder = new TextDecoder()
    let output = Promise.resolve()
    conn.socket = opened
    sockets.add(opened)
    let openedAt: number | undefined
    /* The keystrokes this socket flushed on open: a shell that never came up never read them. */
    let flushed: Array<PendingFrame> = []
    opened.onopen = () => {
      if (conn.socket !== opened) return
      openedAt = Date.now()
      for (const frame of conn.pending) {
        opened.send(frame.kind === "input" ? new TextEncoder().encode(frame.data) : frame.frame)
      }
      flushed = conn.pending.filter((frame) => frame.kind === "input")
      conn.pending.length = 0
    }
    /* The two redials a shell that was never up earns hand its flushed keystrokes to the next socket. */
    const requeue = () => { conn.pending.unshift(...flushed); flushed = [] }
    opened.onmessage = (event: MessageEvent) => {
      // Text frames carry transport control, while terminal bytes are binary.
      // Never paint the replay handshake into the user's shell output.
      if (typeof event.data === "string") return
      output = output.then(async () => {
        const text = await decode(event.data, decoder)
        if (text === null || text === "" || disposed) return
        for (const listener of conn.listeners) listener.onOutput(text)
      })
    }
    opened.onclose = (event: CloseEvent) => {
      sockets.delete(opened)
      if (conn.socket === opened) conn.socket = undefined
      if (disposed) return
      /*
       * A socket that lived past healthyMs was fine: its drop starts the
       * backoff over and earns a fresh single 1011 retry. (plue's 1011
       * arrives right after the 101, so an open alone proves nothing.)
       */
      if (openedAt !== undefined && Date.now() - openedAt >= healthyMs) {
        conn.attempts = 0
        conn.retriedAttach = false
        conn.retriedEarlyExit = false
      }
      if (event.code === 1011 && !conn.retriedAttach) {
        conn.retriedAttach = true
        requeue()
        scheduleReconnect(sessionId, entry)
        return
      }
      /*
       * plue#504: the guest's login shell was not there yet. plue closes the
       * durable session normally and removes it, so one more attach opens a
       * new shell on the same session — the server's own retry, once. The
       * second such close is the person's to read, in plue's words.
       */
      if (
        event.code === 1000
        && namesMissingShellExit(event.reason)
        && openedAt !== undefined
        && Date.now() - openedAt < earlyExitMs
        && !conn.retriedEarlyExit
      ) {
        conn.retriedEarlyExit = true
        requeue()
        scheduleReconnect(sessionId, entry)
        return
      }
      if (RECONNECT_CODES.has(event.code)) {
        scheduleReconnect(sessionId, entry)
        return
      }
      const known = FINAL_NOTES[event.code]
      const reason = event.reason.trim()
      /*
       * plue#504: a normal close carries the session's own last words
       * (`session exited: …`). They were dropped before — a person was told
       * only "session closed" — so a 1000 now reads its reason the way an
       * unrecognized code always has.
       */
      const note = event.code === 1008
        ? `access revoked${reason ? `: ${reason.replace(/^access revoked:\s*/, "")}` : ""}`
        : known !== undefined && event.code !== 1000
        ? `${known}${reason && event.code >= 4400 ? ` (${reason})` : ""}`
        : `session closed${reason ? `: ${reason}` : ""}`
      say(conn, note)
    }
      opened.onerror = () => {
        // onclose follows; the reconnect is its job.
      }
    })()
  }

  /*
   * Keystrokes a program typed for a session no view has attached yet (a
   * take-over types its resume line the moment the box terminal opens, while
   * the terminal view is still loading). They wait here and lead the session's
   * queue once it attaches, instead of being dropped.
   */
  const early = new Map<string, { readonly at: number; readonly frames: Array<{ readonly kind: "input"; readonly data: string }> }>()

  const attach: CloudTerminalClient["attach"] = (repo, sessionId, attachment) => {
    let entry = connections.get(sessionId)
    if (entry === undefined) {
      /* Keystrokes older than the wait for a view to load are not typed into whatever runs there now. */
      const held = early.get(sessionId)
      const waiting = held !== undefined && Date.now() - held.at <= EARLY_INPUT_MS ? held.frames : []
      early.delete(sessionId)
      entry = {
        repo,
        conn: {
          socket: undefined,
          opening: undefined,
          listeners: new Set(),
          pending: [...waiting],
          reconnect: undefined,
          attempts: 0,
          retriedAttach: false,
          retriedEarlyExit: false
        }
      }
      connections.set(sessionId, entry)
    }
    entry.conn.listeners.add(attachment)
    ensureSocket(sessionId, entry)
    return () => {
      const current = connections.get(sessionId)
      if (current === undefined) return
      current.conn.listeners.delete(attachment)
      if (current.conn.listeners.size > 0) return
      connections.delete(sessionId)
      current.conn.pending.length = 0
      current.conn.opening?.abort()
      current.conn.opening = undefined
      if (current.conn.reconnect !== undefined) {
        clearTimeout(current.conn.reconnect)
        current.conn.reconnect = undefined
      }
      const closing = current.conn.socket
      current.conn.socket = undefined
      if (closing !== undefined) {
        // The deliberate close: nobody listens, so nothing may redial from it.
        closing.onclose = null
        sockets.delete(closing)
        closing.close()
      }
    }
  }

  const input: CloudTerminalClient["input"] = (sessionId, data) => {
    const entry = connections.get(sessionId)
    if (entry === undefined) {
      const now = Date.now()
      for (const [id, held] of early) if (now - held.at > EARLY_INPUT_MS) early.delete(id)
      const held = early.get(sessionId)
      if (!disposed && (held?.frames.length ?? 0) < MAX_PENDING) {
        early.set(sessionId, { at: held?.at ?? now, frames: [...held?.frames ?? [], { kind: "input", data }] })
      }
      return
    }
    const socket = entry.conn.socket
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.send(new TextEncoder().encode(data))
      return
    }
    if (entry.conn.pending.length < MAX_PENDING) entry.conn.pending.push({ kind: "input", data })
    else ensureSocket(sessionId, entry)
  }

  const resize: CloudTerminalClient["resize"] = (sessionId, cols, rows) => {
    const entry = connections.get(sessionId)
    if (entry === undefined) return
    const frame = JSON.stringify({ type: "resize", cols, rows })
    const socket = entry.conn.socket
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.send(frame)
      return
    }
    /*
     * The terminal's first fit runs before the socket opens. Dropping it left
     * the session at the upstream's default geometry until the human resized
     * the window by hand, so the control frame waits beside the keystrokes.
     * Only the newest size means anything: an already queued resize is
     * replaced where it stands rather than stacked behind the next one.
     */
    const queued = entry.conn.pending.findIndex((pending) => pending.kind === "control")
    if (queued >= 0) entry.conn.pending[queued] = { kind: "control", frame }
    else if (entry.conn.pending.length < MAX_PENDING) entry.conn.pending.push({ kind: "control", frame })
  }

  const dispose = (): void => {
    disposed = true
    early.clear()
    for (const entry of connections.values()) {
      if (entry.conn.reconnect !== undefined) clearTimeout(entry.conn.reconnect)
      entry.conn.opening?.abort()
      entry.conn.opening = undefined
      entry.conn.pending.length = 0
      entry.conn.socket = undefined
    }
    connections.clear()
    for (const socket of sockets) {
      socket.onclose = null
      socket.close()
    }
    sockets.clear()
  }

  return { attach, input, resize, dispose }
}
