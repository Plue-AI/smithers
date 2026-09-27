import { CLOUD_WS_ROUTE_PREFIX } from "@smthrs/rpc/CloudTunnel"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import { ServerConfig } from "./Config"
import { cloudTokenRefusal, fetchCloudToken } from "./cloudToken"
import { discardBody, fetchWithDeadline } from "./Http"
import { validateSession } from "./identity"
import { ISOLATION_HEADERS, methodNotAllowed, notFound, refuse } from "./Responses"

/** The small workerd socket surface; binaryType is explicit across compatibility dates. */
export interface RelaySocket {
  binaryType: string
  accept(): void
  send(data: string | ArrayBuffer): void
  close(code?: number, reason?: string): void
  addEventListener(type: "message", listener: (event: MessageEvent<string | ArrayBuffer>) => void): void
  addEventListener(type: "close", listener: (event: CloseEvent) => void): void
  addEventListener(type: "error", listener: (event: Event) => void): void
  removeEventListener(type: "message", listener: (event: MessageEvent<string | ArrayBuffer>) => void): void
  removeEventListener(type: "close", listener: (event: CloseEvent) => void): void
  removeEventListener(type: "error", listener: (event: Event) => void): void
}

/** Inject the platform pair, just as Transport injects fetch in Worker tests. */
export class TerminalSockets extends Context.Service<TerminalSockets, {
  readonly pair: Effect.Effect<{ readonly server: RelaySocket; readonly response: Response }>
}>()("smithers-server/TerminalSockets") {}

export const terminalSocketsLayer = Layer.succeed(TerminalSockets, {
  pair: Effect.sync(() => {
    const { WebSocketPair } = globalThis as typeof globalThis & {
      WebSocketPair: new () => { 0: RelaySocket; 1: RelaySocket }
    }
    const pair = new WebSocketPair()
    const init: ResponseInit & { webSocket: RelaySocket } = {
      status: 101,
      webSocket: pair[0],
      headers: { ...ISOLATION_HEADERS, "cache-control": "no-store" }
    }
    return { server: pair[1], response: new Response(null, init) }
  })
})

const MAX_FRAME_BYTES = 64 * 1024
// ADR 0002 and the native tunnel's CLOUD_WS_REFUSAL_CODES. Fetch exposes the
// original upgrade refusal here, so no second status-recovery GET is needed.
const REFUSALS: Readonly<Record<number, readonly [number, string]>> = {
  401: [4401, "cloud sign-in required"],
  403: [4403, "forbidden"],
  404: [4404, "session gone"],
  409: [4409, "session not running"],
  425: [4409, "session not running"],
  429: [4429, "rate limited"]
}

const closeSocket = (socket: RelaySocket, code: number, reason: string): void => {
  // 1005/1006/1015 are observations, never wire codes. 1001 has the same
  // reconnect behavior in CloudTerminalClient as an abnormal 1006 drop.
  const wireCode = code === 1005 || code === 1006 || code === 1015 ? 1001 : code
  try { socket.close(wireCode, reason) } catch { /* The peer already left. */ }
}

/** A socket-lifetime Effect: completion or interruption releases both peers and listeners. */
const pump = (downstream: RelaySocket, upstream: RelaySocket): Effect.Effect<void> => Effect.callback<void>((resume) => {
  let ended = false
  const cleanups: Array<() => void> = []
  const end = (code: number, reason: string): void => {
    if (ended) return
    ended = true
    for (const cleanup of cleanups) cleanup()
    closeSocket(downstream, code, reason)
    closeSocket(upstream, code, reason)
    resume(Effect.void)
  }
  const wire = (from: RelaySocket, to: RelaySocket): void => {
    from.binaryType = "arraybuffer"
    const message = (event: MessageEvent<string | ArrayBuffer>): void => {
      if (ended) return
      const data = event.data
      const bytes = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength
      if (bytes > MAX_FRAME_BYTES) {
        end(1009, "A terminal frame is larger than the upstream accepts (64 KiB).")
        return
      }
      try { to.send(data) } catch { end(1011, "cloud terminal upstream failed") }
    }
    const close = (event: CloseEvent): void => end(event.code, event.reason)
    const error = (): void => end(1011, "cloud terminal upstream failed")
    from.addEventListener("message", message)
    from.addEventListener("close", close)
    from.addEventListener("error", error)
    cleanups.push(() => {
      from.removeEventListener("message", message)
      from.removeEventListener("close", close)
      from.removeEventListener("error", error)
    })
  }
  wire(downstream, upstream)
  wire(upstream, downstream)
  try {
    downstream.accept()
    upstream.accept()
  } catch {
    end(1011, "cloud terminal upstream failed")
  }
  return Effect.sync(() => end(1001, "terminal relay interrupted"))
})

export const handleTerminalRelay = (request: Request, url: URL) => Effect.gen(function* () {
  const rest = url.pathname.slice(CLOUD_WS_ROUTE_PREFIX.length)
  if (!/^repos\/[^/]+\/[^/]+\/workspace\/sessions\/[^/]+\/terminal$/.test(rest)) return notFound()
  // Do not let encoded path separators or dot segments escape the native route.
  try {
    if (rest.split("/").some((part) => {
      const decoded = decodeURIComponent(part)
      return decoded === "." || decoded === ".." || /[/\\]/.test(decoded)
    })) return notFound()
  } catch { return notFound() }
  if (request.method !== "GET") return methodNotAllowed()
  const origin = request.headers.get("origin")
  if (origin !== null && origin !== url.origin) return refuse("cross_origin_blocked", "WebSocket origin does not match the app.")
  if (!request.headers.get("cookie")?.trim()) return refuse("sign_in_required", "Sign in to open a workspace terminal.")
  // Session semantics, without the turn allowlist or its offline bypass.
  const identity = yield* validateSession(request)
  if (identity.status === "invalid") return refuse("sign_in_required", "Sign in to open a workspace terminal.")
  if (identity.status === "unavailable") return identity.response
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return refuse("request_invalid", "Expected a WebSocket upgrade.")
  const token = yield* fetchCloudToken(identity.identity.login)
  if (token.status !== "ok") {
    const refusal = cloudTokenRefusal(token, "Smithers Cloud isn't reachable for your account right now.")
    return refuse(refusal.code, refusal.message)
  }
  const config = yield* ServerConfig
  // Worker fetch performs a WebSocket handshake over HTTP(S). Only these
  // headers leave the Worker: no page cookie, Origin, token protocol or query.
  const result = yield* Effect.result(fetchWithDeadline(
    "The cloud terminal",
    new URL(`/api/${rest}`, config.cloudApiBaseUrl).toString(),
    {
      headers: { upgrade: "websocket", authorization: `Bearer ${token.token}`, "sec-websocket-protocol": "terminal" },
      redirect: "manual"
    },
    config.upstreamTimeoutMs
  ))
  const upstreamResponse = Result.isSuccess(result) ? result.success : undefined
  const upstream = (upstreamResponse as (Response & { webSocket?: RelaySocket }) | undefined)?.webSocket
  if (upstreamResponse?.status !== 101 || upstream === undefined) {
    if (upstreamResponse !== undefined) yield* discardBody(upstreamResponse)
    const [code, reason] = REFUSALS[upstreamResponse?.status ?? 0] ?? [1011, "failed to attach terminal"]
    const pair = yield* TerminalSockets.use((sockets) => sockets.pair)
    yield* Effect.sync(() => {
      pair.server.accept()
      closeSocket(pair.server, code, reason)
    })
    return pair.response
  }
  const pair = yield* TerminalSockets.use((sockets) => sockets.pair)
  // The accepted socket keeps the Worker alive. Its fiber must outlive the
  // HTTP handler; start immediately so listeners exist before returning 101.
  yield* Effect.forkDetach(pump(pair.server, upstream), { startImmediately: true })
  return pair.response
})
