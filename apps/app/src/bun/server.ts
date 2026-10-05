/*
 * The local origin (LOCAL-APP.md, "Runtime topology"): one Bun.serve on
 * 127.0.0.1 that serves the built SPA, the chat boundary, the cloud
 * WebSocket tunnels, and the handful of HTTP routes this host still owns.
 * It imports nothing from Electrobun, so `serve.ts` can run it without a
 * window and Playwright can drive it in plain Chromium.
 */
import type { Server, ServerWebSocket } from "bun"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { join, normalize, resolve } from "node:path"
import { Effect, Fiber } from "effect"
import {
  AUTH_CALLBACK_PATH,
  AUTH_NATIVE_CLAIM_PATH,
  AUTH_ROUTE_PREFIX,
  AUTH_SIGN_IN_PATH,
  CANCEL_PATH,
  CHAT_CANCEL_PATH,
  CHAT_TURN_PATH,
  EXTERNAL_CODEX_PATH,
  HEALTH_PATH,
  IDENTITY_ROUTE_PREFIX,
  MODEL_CATALOG_PATH,
  MODEL_STREAM_PATH,
  TURN_PATH,
  TURN_REPLAY_PATH,
  TURN_RETIRE_PATH,
  TURN_ERASE_PATH
} from "@smthrs/rpc/AgentApiRoutes"
import { AUTHENTICATED_USER_PATH } from "@smthrs/rpc/ApplicationAuth"
import * as Redaction from "@smthrs/journal/Redaction"
import { APP_API_VERSION, APP_BOOTSTRAP_PATH } from "@smthrs/rpc/AppBootstrap"
import { AgentRuntimeContextSchema } from "@smthrs/rpc/AgentContext"
import { modelFailureRefusalCode } from "@smthrs/rpc/ConfiguredModel"
import type { ModelCredentialEnv } from "@smthrs/rpc/ConfiguredModel"
import { localCapabilities } from "@smthrs/rpc/HostCapabilities"
import {
  CLOUD_AUTH_SESSION_PATH,
  CLOUD_AUTH_SIGN_OUT_PATH,
  CLOUD_AUTH_START_PATH,
  CLOUD_LSP_FRAME_CAP_BYTES,
  CLOUD_ROUTE_PREFIX,
  CLOUD_TERMINAL_FRAME_CAP_BYTES,
  CLOUD_WS_NOT_READY_CLOSE_CODE,
  CLOUD_WS_PENDING_CLOSE_CODE,
  CLOUD_WS_ROUTE_PREFIX,
  withRetryAfter
} from "@smthrs/rpc/CloudTunnel"
import type { CloudWsSessionKind } from "@smthrs/rpc/CloudTunnel"
import {
  isLocalSessionToken,
  localSessionProtocol,
  LOCAL_SESSION_HEADER,
  LOCAL_SESSION_META
} from "@smthrs/rpc/LocalSession"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { AgentTurnJournalRequestSchema } from "@smthrs/rpc/AgentTurnJournal"
import { handleBrowserFetch } from "./BrowserFetch"
import { CLOUD_CHAT_SIGN_IN } from "./CloudAgent"
import type { CloudAgent } from "./CloudAgent"
import { createCloudAuth } from "./CloudAuth"
import type { CloudAuth, CloudKeychain } from "./CloudAuth"
import { createModelCredentials } from "./ModelCredentials"
import { nativeStateDirectory } from "./NativeState"
import { modelFailureLine, sealedMessages, sealedTurn } from "./ConfiguredModelHost"
import { planOnLocal } from "@smthrs/model-host/LocalModel"
import { createModelProbe } from "@smthrs/model-host/ModelProbe"
import { machineReadableRefusal, upstreamRefusalMessage } from "@smthrs/rpc/UpstreamProse"
import { decodePath, invalidPath, json, jsonError, readJson, refuse, Router } from "./routes"
import type { RouteHandler } from "./routes"
import { externalSessions } from "./ExternalSessions"

/** The deployed identity seam the sign-in device flow talks to. */
export const DEFAULT_IDENTITY_UPSTREAM = "https://canary.smithers.sh"
/** The Smithers Cloud API `/api/cloud/*` forwards to (SMITHERS_CLOUD_API overrides). */
export const DEFAULT_CLOUD_API = "https://api.jjhub.tech"
/**
 * How long an upstream has to answer with HEADERS before this host gives up,
 * in milliseconds. The Worker's own default for the same upstreams
 * (apps/server/src/Http.ts DEFAULT_UPSTREAM_TIMEOUT_MS), so a request that
 * times out on one host times out on the other; ProxyDeadline.test.ts pins
 * that the two agree.
 */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 20_000
export const APP_VERSION = "0.0.1"
/** Where the SPA posts uncaught errors; the client half is state/ClientErrors.ts. */
export const CLIENT_ERRORS_PATH = "/api/telemetry/errors"

/**
 * Constant-time comparison for the local session capability, the same
 * discipline PackagedE2EBridge and CloudAuth apply to their secrets. Hashing
 * both sides first gives timingSafeEqual equal lengths, so it never throws.
 */
const sameSecret = (supplied: string, expected: string): boolean =>
  timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(expected).digest())

/** Renderer error text can carry tokens from the failing call; the diagnostic rules strip them before the log. */
const redactClientError = (text: string): string => String(Redaction.redactDiagnostic(text))
/** Bytes on the wire, the unit the client bounds its report in. */
export const CLIENT_ERROR_MAX_BODY = 16 * 1024

/** Long conversations are replayed on every turn, so the cap is generous, not tight. */
const MAX_BODY_BYTES = 1024 * 1024
/*
 * What one renderer frame may carry per branch: a cloud terminal bridge
 * plue's 64 KiB, a cloud lsp bridge plue's 1 MiB (lane L6). The server's own
 * ceiling sits at twice the larger so every branch refuses an over-cap frame
 * with its own reason (a frame past the ceiling is Bun's to drop, as an
 * abnormal close).
 */
const MAX_CLOUD_WS_FRAME_BYTES: Readonly<Record<CloudWsSessionKind, number>> = {
  terminal: CLOUD_TERMINAL_FRAME_CAP_BYTES,
  lsp: CLOUD_LSP_FRAME_CAP_BYTES
}
const MAX_ANY_WS_FRAME_BYTES = 2 * Math.max(...Object.values(MAX_CLOUD_WS_FRAME_BYTES))
/** Frames a cloud-terminal tunnel queues before its upstream opens. */
const MAX_CLOUD_WS_PENDING = 256
/** Renderer→upstream bytes the tunnel may hold before it closes the renderer's socket. */
const MAX_CLOUD_WS_UPSTREAM_BUFFER = 1024 * 1024
/** Upstream→renderer bytes Bun may hold per socket; one lsp frame at its cap must fit with room to spare. */
const MAX_WS_BACKPRESSURE_BYTES = 4 * 1024 * 1024

export interface LocalServerOptions {
  /** 0 (the default) picks a free port. */
  readonly port?: number
  /** The built SPA: index.html plus assets/. */
  readonly distDir: string
  /**
   * The agent behind the chat boundary, built with the frame publisher this
   * host owns. Injected, never selected here: hybrid with none gets the
   * Smithers Cloud agent (the backend's `/api/agent/turn`, as the signed-in
   * Cloud user), and a test tier passes its own double
   * (e2e/support/ChatStub.ts). Offline with none is a host with no agent.
   */
  readonly agent?: (publish: (frame: AgentTurnFrame) => void) => CloudAgent
  /** Test-only journal transport, injected by the deterministic host. */
  readonly fixtureJournal?: {
    start: (body: StartAgentTurnRequest, start: () => Response) => Promise<Response>
    access: (request: Request) => Promise<Response>
  }
  /** Offline has no network egress; hybrid explicitly enables Smithers Cloud. */
  readonly cloudMode?: "offline" | "hybrid"
  /**
   * Where `/api/auth/*` and `/api/identity/*` are forwarded so the sign-in
   * device flow reaches a real identity seam. `null` disables the proxy; the
   * stub mode never proxies.
   */
  readonly identityUpstream?: string | null
  /** Self-hosted product backend for the live channel; independent of cloud mode. */
  readonly backendApi?: string | null
  /** Codex sessions on this machine (M-38); tests pass their own Codex homes. */
  readonly externalSessions?: ReturnType<typeof externalSessions>
  /** Who ran those sessions; defaults to this machine's jj user, then the OS user. */
  readonly externalOwner?: { readonly login: string; readonly name: string }
  /**
   * Where `/api/cloud/*` forwards (the Smithers Cloud API) and where the
   * `/api/cloud-auth/*` login points. `undefined` reads SMITHERS_CLOUD_API,
   * defaulting to DEFAULT_CLOUD_API; `null` disables the seam. Offline mode
   * disables it either way.
   */
  readonly cloudApi?: string | null
  /**
   * How long an upstream has to send HEADERS before this host gives up on it,
   * in milliseconds. Bounds the wait for headers only, so a streaming answer
   * is never cut off mid-body. Defaults to DEFAULT_UPSTREAM_TIMEOUT_MS.
   */
  readonly upstreamTimeoutMs?: number
  /** Test/replay override for the Cloud sign-in manager; the default stores in the OS keychain. */
  readonly cloudAuth?: CloudAuth
  /** Test override for the keychain behind the default Cloud sign-in manager. */
  readonly cloudKeychain?: CloudKeychain
  readonly version?: string
  readonly buildSha?: string
  /**
   * Test fixture state directory. The
   * local host uses its application-support directory; a
   * test passes a temp dir or nothing.
   */
  readonly modelKeychain?: CloudKeychain
  readonly stateDir?: string
  /** The home directory reported by `/api/health`. */
  readonly home?: string
  readonly log?: (line: string) => void
  /** Test/replay override; production generates 256 fresh random bits. */
  readonly sessionToken?: string
  /**
   * The environment model credentials are read from, by name (R4). Defaults to
   * Bun.env; a test passes its own record, and nothing else reads a model key.
   */
  readonly env?: ModelCredentialEnv
  /** Test override for the one deadline a model test runs under. */
  /** Test override for the transport a configured model is reached through. */
  readonly modelFetch?: typeof globalThis.fetch
}

export type WsSocketData = { readonly live: LiveBridge } | {
  /**
   * Lane citc: a `/api/cloud-ws/` tunnel's bridge to the cloud terminal or
   * language-server WebSocket. Frames the renderer sends before the upstream
   * opens queue in `pending` (bounded) and flush on open.
   */
  readonly cloud: CloudWsBridge
}

interface LiveBridge {
  connect?: () => void
  readonly target: string
  readonly headers: Record<string, string>
  upstream?: WebSocket
  readonly pending: Array<string | Buffer>
  pendingBytes: number
}

export interface CloudWsBridge {
  /** Which plue socket this bridges: the terminal (binary PTY bytes) or the language-server relay (JSON-RPC text frames, lane L6). */
  readonly kind: CloudWsSessionKind
  readonly target: string
  readonly token: string | undefined
  upstream: WebSocket | undefined
  readonly pending: Array<string | Buffer>
  /** True once the upstream handshake completed; a close before it is a refusal the tunnel classifies. */
  opened: boolean
}

/*
 * plue's pre-upgrade refusals as the close codes the renderer sees (ADR 0002
 * "Terminal attach contract"): the renderer stops redialing on every one of
 * them. For the terminal, 425 is plue's "session still provisioning", the
 * same fact as 409. The lsp branch (lane L6, plue #505) keeps 425
 * `workspace_session_pending` and 503 `guest_not_ready` apart from 409: both
 * carry a `Retry-After`, and the renderer's client retries them on the
 * server's clock while it shows the server's words.
 */
const CLOUD_WS_REFUSAL_CODES: Readonly<Record<CloudWsSessionKind, Readonly<Record<number, number>>>> = {
  terminal: {
    401: 4401,
    403: 4403,
    404: 4404,
    409: 4409,
    425: 4409,
    429: 4429
  },
  lsp: {
    401: 4401,
    403: 4403,
    404: 4404,
    409: 4409,
    425: CLOUD_WS_PENDING_CLOSE_CODE,
    429: 4429,
    503: CLOUD_WS_NOT_READY_CLOSE_CODE
  }
}

const CLOUD_WS_REFUSAL_REASONS: Readonly<Record<number, string>> = {
  4401: "cloud sign-in required",
  4403: "forbidden",
  4404: "session gone",
  4409: "session not running",
  [CLOUD_WS_PENDING_CLOSE_CODE]: "session pending",
  4429: "rate limited",
  [CLOUD_WS_NOT_READY_CLOSE_CODE]: "guest not ready"
}

/** A WebSocket close reason is at most 123 UTF-8 bytes; anything longer is refused by the socket, so it is cut here. */
const closeReasonOf = (text: string): string => {
  const encoder = new TextEncoder()
  let reason = text.replace(/\s+/g, " ").trim()
  while (encoder.encode(reason).byteLength > 123) reason = reason.slice(0, -1)
  return reason
}

/** The headers the tunnel dials the cloud socket with: the bearer, and an Origin only where an environment still enforces one. */
const cloudWsUpstreamHeaders = (token: string | undefined): Record<string, string> => {
  const headers: Record<string, string> = {}
  // plue#475: the terminal upgrade skips the Origin check for Bearer principals, so the local host sends none — SMITHERS_CLOUD_WS_ORIGIN is the knob for an environment that still enforces it.
  const origin = Bun.env.SMITHERS_CLOUD_WS_ORIGIN
  if (origin !== undefined && origin !== "") headers["origin"] = origin
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`
  return headers
}

/*
 * Bun's WebSocket client hides the HTTP status of a refused upgrade: every
 * non-101 answer closes 1002 "Expected 101 status code" (verified on Bun
 * 1.4.0), so the refusal is re-read with one plain GET of the same route,
 * same bearer, same Origin policy. plue runs every pre-upgrade check (auth,
 * scope, repo permission, the open-rate limit, the session lookup and its
 * state) before it ever upgrades, so the GET answers the status the
 * handshake got. An answer this table does not know stays 1011, the code
 * the renderer retries once.
 *
 * On the lsp branch the reason carries plue's machine-readable `code` before
 * its message (`language_server_missing: npm i -g …`, the install line
 * verbatim) — three different 409s reach the renderer as one close code, and
 * the code is what tells them apart — and the `Retry-After` a 425 or 503
 * named, in words at the end, so the renderer retries on the server's clock.
 */
const classifyCloudWsRefusal = async (
  bridge: CloudWsBridge,
  fetchImpl: typeof fetch
): Promise<{ readonly code: number; readonly reason: string }> => {
  const url = new URL(bridge.target)
  url.protocol = url.protocol === "wss:" ? "https:" : "http:"
  let response: Response
  try {
    response = await fetchImpl(url, { headers: cloudWsUpstreamHeaders(bridge.token), redirect: "manual" })
  } catch {
    return { code: 1011, reason: `cloud ${bridge.kind} upstream failed` }
  }
  const code = CLOUD_WS_REFUSAL_CODES[bridge.kind][response.status]
  let message: string | undefined
  let plueCode: string | undefined
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown; code?: unknown }
    if (typeof body.message === "string" && body.message !== "") message = body.message
    else if (typeof body.error === "string" && body.error !== "") message = body.error
    else if (typeof body.error === "object" && body.error !== null && typeof (body.error as { message?: unknown }).message === "string") {
      message = (body.error as { message: string }).message
    }
    if (typeof body.code === "string" && body.code !== "") plueCode = body.code
  } catch {
    // A body that is not JSON is plumbing, never copy.
  }
  if (code === undefined) return { code: 1011, reason: closeReasonOf(`cloud ${bridge.kind} upstream answered ${response.status}`) }
  let reason = message ?? CLOUD_WS_REFUSAL_REASONS[code] ?? "refused"
  if (bridge.kind === "lsp") {
    if (plueCode !== undefined && !reason.startsWith(`${plueCode}:`)) reason = `${plueCode}: ${reason}`
    const retryAfter = Number(response.headers.get("retry-after")?.trim())
    if (Number.isInteger(retryAfter) && retryAfter >= 0) reason = withRetryAfter(reason, retryAfter)
  }
  return { code, reason: closeReasonOf(reason) }
}

export type WsSocket = ServerWebSocket<WsSocketData>

/*
 * Close codes a Bun server cannot put on the wire. 1005 and 1006 are
 * unsendable by the protocol, but Bun also rewrites 1001 "going away" to
 * 1000 — verified on Bun 1.3.14 and 1.4.0, Linux and macOS alike. 1000 is
 * exactly the renderer's "session closed, never redial"
 * (mainview/state/CloudTerminalClient.ts), so a bridge that closed 1001
 * silently told every terminal to give up instead of to reconnect.
 */
const UNSENDABLE_CLOSE_CODES: ReadonlySet<number> = new Set([1001, 1005, 1006])

/** Ends a renderer's socket so the code it reads carries the meaning the caller sent. */
const closeRenderer = (socket: WsSocket, code: number, reason: string): void => {
  // An abnormal close is what the renderer reconnects on, so a going-away drop arrives as one.
  if (UNSENDABLE_CLOSE_CODES.has(code)) socket.terminate()
  else socket.close(code, closeReasonOf(reason))
}

export interface LocalServer {
  readonly origin: string
  readonly port: number
  readonly sessionToken: string
  readonly websocketProtocol: string
  readonly server: Server<WsSocketData>
  readonly stop: () => Promise<void>
}

/**
 * The SPA directory for a caller in `fromDir`. SMITHERS_DIST_DIR wins; a
 * packaged app finds the copied views next to its main bundle; a source
 * checkout falls back to apps/app/dist.
 */
export const defaultDistDir = (fromDir: string, env: Readonly<Record<string, string | undefined>> = Bun.env): string => {
  const explicit = env.SMITHERS_DIST_DIR?.trim()
  if (explicit !== undefined && explicit !== "") return resolve(explicit)
  const candidates = [
    resolve(fromDir, "..", "views", "mainview"),
    resolve(fromDir, "..", "..", "dist")
  ]
  return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? candidates[candidates.length - 1]!
}

const isStartTurnRequest = (value: unknown): value is StartAgentTurnRequest =>
  typeof value === "object" &&
  value !== null &&
  "runId" in value &&
  typeof value.runId === "string" &&
  value.runId !== "" &&
  "messages" in value &&
  Array.isArray(value.messages) &&
  "instructions" in value &&
  typeof value.instructions === "string" &&
  (!("tools" in value) || value.tools === undefined || Array.isArray(value.tools)) &&
  (!("context" in value) ||
    value.context === undefined ||
    AgentRuntimeContextSchema.safeParse(value.context).success)

/** A live turn's open NDJSON response. `end` is idempotent so a disconnect, a cancel and a `done` can race. */
interface TurnWriter {
  readonly write: (frame: AgentTurnFrame) => void
  readonly end: () => void
}

const encoder = new TextEncoder()

/*
 * The product-API families the local origin forwards to the Worker (the
 * identity upstream), mirroring apps/server's PLATFORM_PROXY_RULES plus the
 * Worker's own billing and admin seams. Local routes match first; `/api/cloud/*`
 * is the bearer proxy straight to plue and never forwards here.
 */
const PRODUCT_PROXY_PREFIXES: ReadonlyArray<string> = [
  /* Flows and runs: provision + RPC live on the Worker (web-mode plan R6); the local origin forwarded neither. */
  "/api/workflow/",
  
  "/api/repos/",
  "/api/github/",
  "/api/user/",
  "/api/notifications/",
  "/api/billing/",
  "/api/admin/",
  /* The decision model's command selection (state/CommandSelection.ts); the turn's own admission. */
  "/api/commands/"
]

/** The identity routes are the Worker's too, so an offline refusal uses its vocabulary. */
const stubIdentity = (): Response =>
  refuse("feature_unavailable_here", "The identity seam is stubbed in this build.")

/*
 * Re-scope an upstream Set-Cookie to this origin. The identity seam serves
 * https, so its session cookie arrives `Domain=<seam>; Secure`. This origin is
 * plain http on loopback: `Domain` would keep the cookie off it, and WebKit
 * (the native renderer) refuses a `Secure` cookie set over http://127.0.0.1
 * or http://localhost, where Chromium accepts one. That difference is why the
 * headless T1 tier signed in while the native app answered "the sign-in
 * cookie never reached it". Both attributes go; the rest travel unchanged.
 */
export const rescopeCookie = (cookie: string): string =>
  cookie.replace(/;\s*domain=[^;]*/gi, "").replace(/;\s*secure(?=\s*(?:;|$))/gi, "")

/** A Set-Cookie for the trail: its name and attributes, never its value. */
export const describeCookie = (cookie: string): string => {
  const [pair = "", ...attributes] = cookie.split(";")
  const name = pair.split("=")[0]?.trim() ?? ""
  return [`${name}=<redacted>`, ...attributes.map((attribute) => attribute.trim())]
    .filter((part) => part !== "")
    .join("; ")
}

/** The seams this host forwards to, named in the sentence a reader gets when one refuses. */
const IDENTITY_SEAM = "The Smithers identity service"
const CLOUD_SEAM = "Smithers Cloud"

/** What one forwarded request came back as: an answer, or the two ways it did not. */
type UpstreamAnswer =
  | { readonly response: Response }
  | { readonly failure: "timeout" }
  | { readonly failure: "unreachable"; readonly cause: unknown }

type UpstreamFailure = Extract<UpstreamAnswer, { failure: string }>

/**
 * `fetch` under a deadline: the Worker's `fetchWithDeadline`
 * (apps/server/src/Http.ts) on this host.
 *
 * The timer covers the HEADERS only. Once the upstream has answered it is
 * cleared, so a streaming body is never cut off mid-flight. The caller's own
 * signal travels with it, so a renderer that goes away aborts the socket
 * instead of leaking it.
 */
const fetchWithDeadline = async (
  target: URL,
  init: RequestInit,
  timeoutMs: number,
  incoming?: AbortSignal
): Promise<UpstreamAnswer> => {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  try {
    const response = await fetch(target, {
      ...init,
      signal: incoming === undefined ? deadline.signal : AbortSignal.any([incoming, deadline.signal])
    })
    return { response }
  } catch (error) {
    return deadline.signal.aborted ? { failure: "timeout" } : { failure: "unreachable", cause: error }
  } finally {
    clearTimeout(timer)
  }
}

/** The body of a request whose handler threw; the raw error goes to the trail only. */
const LOCAL_INTERNAL_FAILURE = "The local app hit an unexpected error. Try again."

/**
 * The refusal a forwarded request earns when nothing answered it, in the two
 * codes the Worker uses for the same two events. `upstream_timeout` is the leg
 * this host had no way to reach before it had a deadline at all.
 */
const upstreamRefusal = (seam: string, failure: UpstreamFailure, timeoutMs: number, log?: (line: string) => void): Response => {
  if (failure.failure === "timeout") return refuse("upstream_timeout", `${seam} did not answer within ${timeoutMs}ms. Try again in a moment.`)
  // The thrown text is for the trail; the body a person reads names only the seam.
  log?.(`${seam} is unreachable: ${failure.cause instanceof Error ? failure.cause.stack ?? failure.cause.message : String(failure.cause)}`)
  return refuse("upstream_unreachable", `${seam} is unreachable right now. Try again in a moment.`)
}

/**
 * A request a PERSON is looking at in a browser, rather than a seam's fetch.
 *
 * The native sign-in handoff opens `/api/auth/sign-in?handoff=…` on THIS
 * origin in the system browser, and the upstream answers a failed navigation
 * with a branded page written for a reader (apps/server/src/identity.ts).
 * Restating that as JSON would leave a blob of it in a browser window, so a
 * document navigation keeps whatever the upstream wrote; every seam's fetch —
 * which is what renders refusals into the transcript — is restated.
 */
const wantsPage = (request: Request): boolean => {
  const accept = request.headers.get("accept") ?? ""
  return accept.includes("text/html") && !accept.includes("application/json")
}

/**
 * An upstream refusal restated in this host's own envelope, the way
 * apps/server/src/proxies.ts restates one.
 *
 * A failure's PROSE never passes through: the upstream's body is written for
 * its own callers and the product renders whatever comes back straight to the
 * reader, so a router's plain `404 page not found` or an HTML error page
 * reached the transcript verbatim. The machine-readable facts beside the prose
 * — `code`, `retry_after` and the `Retry-After` header — are kept, because
 * they are what a client acts on and the code is what names WHICH refusal this
 * is. The status stays the upstream's, and a Set-Cookie it sent still travels,
 * re-scoped: a refusal may still be clearing a session.
 */
const restateUpstreamFailure = async (
  seam: string,
  response: Response,
  cookies: ReadonlyArray<string>
): Promise<Response> => {
  const detail = await response.text().catch(() => "")
  const restated = json({
    status: "error",
    message: upstreamRefusalMessage(seam, response.status, detail),
    ...machineReadableRefusal(detail)
  }, response.status)
  const retryAfter = response.headers.get("retry-after")
  if (retryAfter !== null) restated.headers.set("retry-after", retryAfter)
  for (const cookie of cookies) restated.headers.append("set-cookie", cookie)
  return restated
}

/**
 * Forwards an identity request to the deployed seam. The upstream refuses
 * cross-origin writes, so the Origin header follows the upstream (the same
 * rewrite the old Vite dev proxy did), and a session cookie it sets is
 * re-scoped to this origin (rescopeCookie).
 */
const proxyIdentity = async (
  request: Request,
  url: URL,
  upstream: string,
  timeoutMs: number,
  log?: (line: string) => void
): Promise<Response> => {
  const target = new URL(url.pathname + url.search, upstream)
  const headers = new Headers(request.headers)
  headers.set("host", target.host)
  headers.set("origin", new URL(upstream).origin)
  headers.delete("content-length")
  // The per-launch local capability authorizes THIS origin; the seam has no use for it.
  headers.delete(LOCAL_SESSION_HEADER)
  const answer = await fetchWithDeadline(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    redirect: "manual"
  }, timeoutMs, request.signal)
  if (!("response" in answer)) return upstreamRefusal(IDENTITY_SEAM, answer, timeoutMs, log)
  const response = answer.response
  const out = new Headers(response.headers)
  out.delete("content-encoding")
  out.delete("content-length")
  const cookies = response.headers.getSetCookie().map(rescopeCookie)
  if (cookies.length > 0) {
    out.delete("set-cookie")
    for (const cookie of cookies) out.append("set-cookie", cookie)
  }
  /*
   * The native handoff's session travels ONLY as the claim's Set-Cookie. A
   * ready claim without one is the exact failure the app cannot see from
   * JavaScript, so the trail states it here, where the header is visible,
   * with the attributes the WebView was handed (never the value): an
   * attribute the WebView refuses is the same invisible failure.
   */
  if (url.pathname === AUTH_NATIVE_CLAIM_PATH && log !== undefined) {
    const shape = cookies.map((cookie) => describeCookie(cookie)).join(" | ")
    log(`${AUTH_NATIVE_CLAIM_PATH} -> ${response.status}, set-cookie ${cookies.length > 0 ? `present: ${shape}` : "absent"}`)
  }
  // A refusal is restated in this host's envelope; only a page a person
  // navigated to keeps the upstream's own body (wantsPage).
  if (response.status >= 400 && !wantsPage(request)) {
    return restateUpstreamFailure(IDENTITY_SEAM, response, cookies)
  }
  return new Response(response.body, { status: response.status, headers: out })
}

/**
 * Forwards a Smithers Cloud request (`/api/cloud/*`) to the cloud API, following
 * proxyIdentity: Host and Origin follow the upstream, `content-length` and
 * the local session header are dropped, Set-Cookie is re-scoped, and the
 * request leaves one trail line (the shared `/api/*` trail). The bearer is
 * attached HERE, from the Bun-held credential — a renderer-supplied
 * Authorization header is deleted, because the token never reaches the
 * renderer (ADR 0001).
 */
const proxyCloud = async (
  request: Request,
  url: URL,
  upstream: string,
  token: string | undefined,
  timeoutMs: number,
  log?: (line: string) => void
): Promise<Response> => {
  /*
   * The path after the prefix is joined as a plain path, never as a URL:
   * `/api/cloud//evil.example/x` sliced naively is scheme-relative and the
   * WHATWG parser would send the bearer to evil.example. A leading slash
   * (or an empty rest) is refused, and the constructed origin must be the
   * upstream's, or the request never leaves this process.
   */
  const upstreamOrigin = new URL(upstream).origin
  const rest = url.pathname.slice(CLOUD_ROUTE_PREFIX.length)
  if (rest === "" || rest.startsWith("/") || rest.includes("\\")) {
    return refuse("request_invalid", "A cloud path is /api/cloud/<path> with a non-empty, single-slash path.")
  }
  const target = new URL(`/${rest}${url.search}`, upstreamOrigin)
  if (target.origin !== upstreamOrigin) {
    return refuse("request_invalid", "The cloud path resolved outside the cloud API origin.")
  }
  const headers = new Headers(request.headers)
  headers.set("host", target.host)
  headers.set("origin", upstreamOrigin)
  headers.delete("content-length")
  headers.delete(LOCAL_SESSION_HEADER)
  headers.delete("authorization")
  // The identity seam's session cookie is re-scoped onto this origin, so the
  // WebView attaches it to every same-origin call; it is not the cloud API's.
  headers.delete("cookie")
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`)
  const answer = await fetchWithDeadline(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    redirect: "manual"
  }, timeoutMs, request.signal)
  if (!("response" in answer)) return upstreamRefusal(CLOUD_SEAM, answer, timeoutMs, log)
  const response = answer.response
  const out = new Headers(response.headers)
  out.delete("content-encoding")
  out.delete("content-length")
  const cookies = response.headers.getSetCookie().map(rescopeCookie)
  if (cookies.length > 0) {
    out.delete("set-cookie")
    for (const cookie of cookies) out.append("set-cookie", cookie)
  }
  if (response.status >= 400 && !wantsPage(request)) {
    return restateUpstreamFailure(CLOUD_SEAM, response, cookies)
  }
  return new Response(response.body, { status: response.status, headers: out })
}

/** The person at this machine: jj's configured name, else the OS account. */
const machineOwner = (): { readonly login: string; readonly name: string } => {
  const login = userInfo().username
  let name = ""
  try {
    const jj = Bun.spawnSync(["jj", "config", "get", "user.name"], { stdout: "pipe", stderr: "ignore" })
    if (jj.success) name = jj.stdout.toString().trim()
  } catch { /* no jj on this machine: the OS account names the person */ }
  return { login, name: name || login }
}

export const startLocalServer = async (options: LocalServerOptions): Promise<LocalServer> => {
  const log = options.log ?? ((line: string) => console.log(line))
  const distDir = resolve(options.distDir)
  const version = options.version ?? APP_VERSION
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS
  const remoteEnabled = options.cloudMode === "hybrid"
  const identityUpstream = !remoteEnabled
    ? null
    : options.identityUpstream === undefined
    ? DEFAULT_IDENTITY_UPSTREAM
    : options.identityUpstream
  /*
   * The Smithers Cloud seam (lane piper): offline performs no egress, so the
   * proxy and the login answer 501 like the identity stub. Hybrid forwards
   * to SMITHERS_CLOUD_API (default DEFAULT_CLOUD_API).
   */
  const cloudUpstream = !remoteEnabled
    ? null
    : options.cloudApi === undefined
    ? Bun.env.SMITHERS_CLOUD_API ?? DEFAULT_CLOUD_API
    : options.cloudApi
  const cloudAuth: CloudAuth | undefined = cloudUpstream === null
    ? undefined
    : options.cloudAuth ?? await createCloudAuth({
      api: cloudUpstream,
      envToken: Bun.env.SMITHERS_CLOUD_TOKEN,
      ...(options.cloudKeychain === undefined ? {} : { keychain: options.cloudKeychain }),
      log
    })
  const home = options.home ?? homedir()
  const sessionToken = options.sessionToken ?? randomBytes(32).toString("base64url")
  if (!isLocalSessionToken(sessionToken)) throw new Error("Local server session token must be 256-bit base64url.")
  const websocketProtocol = localSessionProtocol(sessionToken)

  const writers = new Map<string, TurnWriter>()
  const publishFrame = (frame: AgentTurnFrame): void => writers.get(frame.runId)?.write(frame)
  const agent = options.agent?.(publishFrame)
  const finish = (runId: string, writer: TurnWriter): void => {
    if (writers.get(runId) === writer) writers.delete(runId)
    writer.end()
  }

  const router = new Router()
  router.add("POST", "/api/tools/browser-fetch", ({ request }) => remoteEnabled
    ? handleBrowserFetch(request)
    // Shared with the Worker (apps/server/src/proxies.ts handleBrowserFetch),
    // so it refuses in the Worker's vocabulary.
    : refuse("feature_unavailable_here", "The browser reader is disabled in offline mode."))

  router.add("GET", APP_BOOTSTRAP_PATH, () =>
    json({
      apiVersion: APP_API_VERSION,
      host: "local",
      version,
      buildSha: options.buildSha ?? Bun.env.SMITHERS_BUILD_SHA ?? "unknown",
      // The shared table the Worker and the parity matrix read; both cloud
      // doors (`cloud.terminal`, `cloud.pat`) ride the Smithers Cloud upstream.
      capabilities: localCapabilities({
        agent: agent !== undefined || cloudUpstream !== null,
        identity: identityUpstream !== null,
        balance: identityUpstream !== null,
        overview: identityUpstream !== null,
        plans: identityUpstream !== null,
        cloud: cloudUpstream !== null,
        browser: remoteEnabled,
      }),
      authFlow: identityUpstream === null ? "none" : "both",
      // Required by `AppBootstrapSchema`, and omitting it stopped the app
      // booting against its own origin: the client validates the bootstrap and
      // a missing `sandbox` is a contract break, not a default. This host
      // wraps no child process — the seatbelt and bubblewrap mechanisms live
      // in `@smthrs/build` `ExecSandbox` and nothing here selects one — so it
      // says so rather than claiming an enforcement it does not perform.
      sandbox: {
        platform: process.platform,
        mode: "unavailable",
        policies: { loader: "unenforced", targetRun: "unenforced" }
      }
    }))

  router.add("GET", HEALTH_PATH, () =>
    json({
      ok: true,
      version,
      pid: process.pid,
      home
    }))

  /*
   * M-38: a Codex session run on this machine, read-only, for the
   * conversation. `since` is the `next` of the previous read, so a running
   * session is polled for what it appended.
   */
  const readSession = options.externalSessions ?? externalSessions()
  let owner = options.externalOwner
  router.add("GET", EXTERNAL_CODEX_PATH, async ({ url }) => {
    owner ??= machineOwner()
    const id = url.searchParams.get("session") ?? ""
    if (!/^[0-9a-f-]{4,36}$/.test(id)) return jsonError("invalid_request", "A Codex session id or a prefix of at least four characters is required.")
    const read = await readSession(id, Number(url.searchParams.get("since") ?? 0) || 0)
    if ("error" in read && !("entries" in read)) return jsonError(read.error === "unknown" ? "source_not_found" : "invalid_request", read.message)
    return json({ ...read, owner })
  })

  const modelEnv: ModelCredentialEnv = options.env ?? Bun.env
  const modelCredentials = await createModelCredentials({ env: modelEnv, scope: resolve(options.stateDir ?? nativeStateDirectory()), ...(options.modelKeychain ? { keychain: options.modelKeychain } : {}) })
  /** Offline performs no egress, so a configured model may be reached on loopback only. */
  const modelEgress = remoteEnabled ? {} : { egress: false }
  /** Live configured-model turns by runId: what a cancel interrupts. */
  const sealedTurns = new Map<string, () => void>()

  /**
   * One turn's open response. The writer exists before its producer starts, so
   * a frame published before the response stream opens is queued, never lost.
   * `cancel` is the producer's own stop, run when the reader goes away.
   */
  const openTurn = (runId: string, cancel: () => void): () => Response => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const queue: Array<Uint8Array> = []
    let ended = false
    const writer: TurnWriter = {
      write: (frame) => {
        if (ended) return
        const chunk = encoder.encode(`${JSON.stringify(frame)}\n`)
        if (controller === undefined) queue.push(chunk)
        else controller.enqueue(chunk)
        if (frame.type === "done") finish(runId, writer)
      },
      end: () => {
        if (ended) return
        ended = true
        try {
          controller?.close()
        } catch {
          // Already closed by the client.
        }
      }
    }
    writers.set(runId, writer)
    return () => {
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController
          for (const chunk of queue) streamController.enqueue(chunk)
          queue.length = 0
          if (ended) {
            try {
              streamController.close()
            } catch {
              // Nothing to close twice.
            }
          }
        },
        cancel() {
          // Only this response's own writer may cancel: a later turn reusing
          // the runId must survive this one's teardown.
          if (writers.get(runId) !== writer) return
          writers.delete(runId)
          ended = true
          cancel()
        }
      })
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" }
      })
    }
  }

  /**
   * The configured model (R6): a turn that names a model is answered by THAT
   * model through its decoded Route, or refused. It never reaches the agent
   * below, so no failure here can fall back to the default upstream.
   */
  const startConfiguredTurn = (body: StartAgentTurnRequest, model: unknown): Response => {
    if (body.tools !== undefined && body.tools.length > 0) {
      return refuse("tools_not_supported", "A configured model runs no tools; send this turn without tools.")
    }
    const messages = sealedMessages(body.messages)
    if (messages === undefined) {
      return refuse("tools_not_supported", "A configured model runs no tools, so it cannot continue a tool call.")
    }
    const planned = planOnLocal(model, modelEnv, { kind: "generation", ...modelEgress }, modelCredentials)
    if (!planned.ok) return refuse(modelFailureRefusalCode(planned.failure), modelFailureLine(planned.failure))
    const runId = body.runId
    if (writers.has(runId)) return jsonError("turn_running", "That Smithers turn is already running.")
    let interrupt = (): void => {}
    const respond = openTurn(runId, () => interrupt())
    const fiber = Effect.runFork(
      sealedTurn(
        planned,
        { runId, instructions: body.instructions, messages, ...(body.context === undefined ? {} : { context: body.context }) },
        publishFrame,
        options.modelFetch
      ).pipe(Effect.ensuring(Effect.sync(() => sealedTurns.delete(runId))))
    )
    interrupt = () => Effect.runFork(Fiber.interrupt(fiber))
    sealedTurns.set(runId, interrupt)
    return respond()
  }

  const startChatTurn = (body: StartAgentTurnRequest): Response => {
    /*
     * The binding stays untrusted until the planner has judged it: a malformed
     * one is refused by name, never dropped, because a dropped binding is the
     * silent fallback R6 forbids.
     */
    const model: unknown = "model" in body ? body.model : undefined
    if (model !== undefined) return startConfiguredTurn(body, model)
    if (agent === undefined) return jsonError("agent_unavailable", "No agent provider is configured in local-only mode.")
    const runId = body.runId
    if (writers.has(runId)) return jsonError("turn_running", "That Smithers turn is already running.")
    const respond = openTurn(runId, () => agent.cancel(runId))
    const started = agent.start(body)
    if (started.status === "error") {
      writers.delete(runId)
      return jsonError(started.refusal?.code === "sign_in_required" ? "cloud_sign_in_required" : "turn_running", started.message)
    }
    return respond()
  }
  // The backend owns admission, delivery and retirement. Keep the renderer
  // identity and sealed bytes intact; a disconnect ends delivery only.
  const relayTurn = async (request: Request, path: string, body: unknown): Promise<Response> => {
    if (cloudUpstream === null || cloudAuth === undefined) return jsonError("agent_unavailable", "No agent provider is configured in local-only mode.")
    const bearer = cloudAuth.token()
    if (bearer === undefined && path !== TURN_ERASE_PATH) return jsonError("cloud_sign_in_required", CLOUD_CHAT_SIGN_IN)
    const answer = await fetchWithDeadline(new URL(path, new URL(cloudUpstream).origin), {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/json", ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) },
      body: JSON.stringify(body)
    }, upstreamTimeoutMs, request.signal)
    if ("failure" in answer) return upstreamRefusal(CLOUD_SEAM, answer, upstreamTimeoutMs, log)
    if (answer.response.status >= 300 && answer.response.status < 400) {
      await answer.response.body?.cancel()
      return refuse("upstream_malformed", "Smithers Cloud chat refused a redirect.")
    }
    const headers = new Headers(answer.response.headers)
    headers.delete("set-cookie")
    return new Response(answer.response.body, { status: answer.response.status, headers })
  }
  const handleChatTurn: RouteHandler = async ({ request }) => {
    // Bound actual bytes; a chunked request carries no Content-Length.
    const parsed = await readJson(request, MAX_BODY_BYTES)
    if ("error" in parsed) return parsed.error
    if (!isStartTurnRequest(parsed.body)) {
      return jsonError("invalid_request", "Body must be { runId, messages, instructions } with optional tools and context.")
    }
    const body = parsed.body
    if ("model" in body) await modelCredentials.refresh()
    if (body.journal !== undefined && !AgentTurnJournalRequestSchema.safeParse(body.journal).success) {
      return jsonError("invalid_request", "The recorded turn identity is invalid.")
    }
    if (options.agent === undefined && !("model" in body)) return relayTurn(request, TURN_PATH, body)
    if (body.journal !== undefined) {
      if (options.fixtureJournal !== undefined) return options.fixtureJournal.start(body, () => startChatTurn(body))
      return refuse("feature_unavailable_here", "Recorded chat requires the shared backend.")
    }
    return startChatTurn(body)
  }
  router.add("POST", TURN_PATH, handleChatTurn)
  router.add("POST", CHAT_TURN_PATH, handleChatTurn)
  /*
   * The shared backend's one-off model answer (`model.turn`), such as the fast model's timeline titles (#3732): a
   * turn's request and frames, with no tools and no turn record. A named model answers through its Route; otherwise
   * this host's agent does, and with neither it is refused, as a turn is.
   */
  router.add("POST", MODEL_STREAM_PATH, async ({ request }) => {
    const parsed = await readJson(request, MAX_BODY_BYTES)
    if ("error" in parsed) return parsed.error
    if (!isStartTurnRequest(parsed.body) || parsed.body.journal !== undefined) {
      return jsonError("invalid_request", "Body must be { runId, messages, instructions } with optional context and no journal.")
    }
    const body = parsed.body
    if (body.tools !== undefined && body.tools.length > 0) return refuse("tools_not_supported", "A model answer runs no tools; send it without tools.")
    if ("model" in body) await modelCredentials.refresh()
    return startChatTurn(body)
  })
  for (const path of [TURN_REPLAY_PATH, TURN_RETIRE_PATH, TURN_ERASE_PATH]) {
    router.add("POST", path, async ({ request }) => {
      if (options.fixtureJournal !== undefined) return options.fixtureJournal.access(request)
      const parsed = await readJson(request, MAX_BODY_BYTES)
      return "error" in parsed ? parsed.error : relayTurn(request, path, parsed.body)
    })
  }

  const handleChatCancel: RouteHandler = async ({ request }) => {
    if (options.agent === undefined && cloudUpstream !== null && sealedTurns.size === 0) {
      const parsed = await readJson(request)
      return "error" in parsed ? parsed.error : relayTurn(request, CANCEL_PATH, parsed.body)
    }
    // A configured-model fixture owns its fiber; other fixture turns use the injected agent.
    if (agent === undefined && sealedTurns.size === 0) {
      return jsonError("agent_unavailable", "No agent provider is configured in local-only mode.")
    }
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const runId = typeof parsed.body === "object" && parsed.body !== null && "runId" in parsed.body ? parsed.body.runId : undefined
    if (typeof runId !== "string" || runId === "") return jsonError("invalid_request", "runId is required.")
    const interruptSealed = sealedTurns.get(runId)
    interruptSealed?.()
    const result: { readonly status: "cancelled" | "not-found" } = interruptSealed !== undefined
      ? { status: "cancelled" }
      : agent?.cancel(runId) ?? { status: "not-found" }
    // Cancelling aborts upstream without a frame, so the stream closes here
    // or the SPA would keep reading a response that can never complete.
    const writer = writers.get(runId)
    if (writer !== undefined) finish(runId, writer)
    return json({ ok: true, status: result.status })
  }
  router.add("POST", CANCEL_PATH, handleChatCancel)
  router.add("POST", CHAT_CANCEL_PATH, handleChatCancel)

  /*
   * The Models surface. This host answers both routes itself and proxies
   * neither: the credentials are this machine's own, read by name from the
   * environment it was started with, so no sign-in stands in front of them
   * (R8). The catalog carries names and presence, never a value.
   */
  const modelProbe = createModelProbe({
    credentials: modelCredentials,
    env: modelEnv,
    egress: remoteEnabled,
    ...(options.modelFetch === undefined ? {} : { fetch: options.modelFetch })
  })
  router.add("GET", MODEL_CATALOG_PATH, async () => { await modelCredentials.refresh(); return json(modelProbe.catalog()) })
  /*
   * The Smithers Cloud login (lane piper, ADR 0001): start answers the URL the
   * renderer opens in the system browser; the session answer never carries
   * the token; sign-out forgets it. Offline answers 501 like the identity
   * stub.
   */
  router.add("POST", CLOUD_AUTH_START_PATH, async () => {
    if (cloudAuth === undefined) return jsonError("not_implemented", "The cloud seam is disabled in this build.")
    const started = await cloudAuth.start()
    return "error" in started ? jsonError("cloud_auth_unavailable", started.error) : json(started)
  })
  router.add("GET", CLOUD_AUTH_SESSION_PATH, () =>
    cloudAuth === undefined
      ? json({ state: "signed-out", username: null, expiresAt: null })
      : json(cloudAuth.session()))
  /*
   * Lane citc: every live workspace-terminal bridge, so sign-out (and
   * shutdown) can end them — the bearer was read at upgrade, and a bridge
   * would otherwise outlive the credential it was opened with.
   */
  const cloudBridges = new Set<WsSocket>()
  const closeCloudBridges = (code: number, reason: string): void => {
    for (const socket of [...cloudBridges]) {
      cloudBridges.delete(socket)
      try {
        closeRenderer(socket, code, reason)
      } catch {
        // Already gone; its close handler released the upstream.
      }
    }
  }
  router.add("POST", CLOUD_AUTH_SIGN_OUT_PATH, async () => {
    if (cloudAuth === undefined) return jsonError("not_implemented", "The cloud seam is disabled in this build.")
    await cloudAuth.signOut()
    closeCloudBridges(4401, "signed out of Smithers Cloud")
    return json({ ok: true })
  })

  // The runtime error ingest the SPA posts to (state/ClientErrors.ts holds
  // the client half of this contract): logged, never persisted.
  router.add("POST", CLIENT_ERRORS_PATH, async ({ request }) => {
    const body = new Uint8Array(await request.arrayBuffer())
    if (body.byteLength > CLIENT_ERROR_MAX_BODY) {
      return jsonError("body_too_large", `Client error reports are capped at ${CLIENT_ERROR_MAX_BODY} bytes.`)
    }
    log(`client-error: ${redactClientError(new TextDecoder().decode(body))}`)
    return json({ status: "accepted" }, 202)
  })

  const serveStatic = async (pathname: string): Promise<Response> => {
    const index = join(distDir, "index.html")
    const decoded = decodePath(pathname)
    if (decoded === undefined) return invalidPath()
    const relative = normalize(decoded).replace(/^\/+/, "")
    const candidate = resolve(distDir, relative)
    // Only a regular file is a body: `Bun.file(<directory>)` throws EISDIR,
    // and a dotted directory name passes the `relative.includes(".")` test.
    if (relative !== "" && candidate.startsWith(distDir + "/") && statSync(candidate, { throwIfNoEntry: false })?.isFile() === true) {
      const file = Bun.file(candidate)
      if ((await file.exists()) && file.size > 0 || relative.includes(".")) {
        return new Response(file, {
          headers: relative.startsWith("assets/")
            ? { "cache-control": "public, max-age=31536000, immutable" }
            : { "cache-control": "no-store" }
        })
      }
    }
    if (!existsSync(index)) {
      return jsonError("spa_missing", `No built SPA at ${distDir}. Run \`vite build\` first.`)
    }
    // SPA fallback: every route the page owns renders index.html. Only this
    // response receives the per-launch capability; static assets never do.
    const html = await Bun.file(index).text()
    const sessionMeta = `<meta name="${LOCAL_SESSION_META}" content="${sessionToken}">`
    const injected = /<head(?:\s[^>]*)?>/i.test(html)
      ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${sessionMeta}`)
      : `${sessionMeta}${html}`
    return new Response(injected, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
    })
  }

  /* Filled immediately after Bun chooses the port, before callers can reach it. */
  let origin = ""
  let expectedHost = ""
  const handle = async (request: Request, bunServer: Server<WsSocketData>): Promise<Response | undefined> => {
    const url = new URL(request.url)
    const { pathname } = url
    if (request.headers.get("host") !== expectedHost) {
      return jsonError("invalid_host", "This local server accepts only its loopback origin.")
    }
    if (pathname === "/api/live") {
      if (request.headers.get("origin") !== origin) return jsonError("invalid_origin", "WebSocket origin does not match the local app.")
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map(value => value.trim())
      if (!protocols.includes("smithers.live.v1")) return jsonError("invalid_request", "Expected smithers.live.v1.")
      const backend = options.backendApi === undefined ? Bun.env.SMITHERS_BACKEND_API : options.backendApi
      if (!backend) return jsonError("not_implemented", "The live backend is not configured.")
      const target = new URL("/api/live", backend)
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:"
      const headers: Record<string, string> = { "sec-websocket-protocol": "smithers.live.v1", origin }
      for (const name of ["cookie", "authorization"]) {
        const value = request.headers.get(name)
        if (value !== null) headers[name] = value
      }
      const upgraded = bunServer.upgrade(request, {
        data: { live: { target: target.toString(), headers, pending: [], pendingBytes: 0 } },
        headers: { "sec-websocket-protocol": "smithers.live.v1" }
      })
      return upgraded ? undefined : jsonError("upgrade_failed", "Expected a WebSocket upgrade.")
    }
    if (pathname.startsWith(CLOUD_WS_ROUTE_PREFIX)) {
      /*
       * Lane citc: the workspace-terminal tunnel; lane L6: the workspace
       * language-server tunnel beside it. Origin and the local-session
       * subprotocol authorize the upgrade, because a browser upgrade
       * carries no custom headers. The path mirrors the cloud API's two
       * socket routes exactly (`repos/{o}/{r}/workspace/sessions/{id}/
       * terminal` and `…/lsp`, nothing else), and the bearer attaches HERE
       * from the Bun-held credential, never from the renderer.
       */
      const requestOrigin = request.headers.get("origin")
      if (requestOrigin !== null && requestOrigin !== origin) {
        return jsonError("invalid_origin", "WebSocket origin does not match the local app.")
      }
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((value) => value.trim())
      if (!protocols.some((protocol) => sameSecret(protocol, websocketProtocol))) {
        return jsonError("local_session_required", "The local session capability is required.")
      }
      if (cloudUpstream === null) {
        return jsonError("not_implemented", "The cloud seam is disabled in this build.")
      }
      const rest = pathname.slice(CLOUD_WS_ROUTE_PREFIX.length)
      // `[^/]+` admits `.` and `..`; a segment-wise check keeps the joined target under /api/repos/ (WHATWG normalizes dot segments).
      const segments = rest.split("/")
      const branch = /^repos\/[^/]+\/[^/]+\/workspace\/sessions\/[^/]+\/(terminal|lsp)$/.exec(rest)
      if (
        branch === null ||
        segments.some((segment) => segment === "." || segment === ".." || segment.includes("%2F") || segment.includes("%2f") || segment.includes("\\"))
      ) {
        return jsonError("not_found", "The cloud WebSocket tunnel serves only workspace terminal and lsp sessions.")
      }
      const kind: CloudWsSessionKind = branch[1] === "lsp" ? "lsp" : "terminal"
      const upstreamWs = cloudUpstream.startsWith("https:")
        ? `wss:${cloudUpstream.slice("https:".length)}`
        : `ws:${cloudUpstream.slice("http:".length)}`
      const tunnelTarget = new URL(`/api/${rest}${url.search}`, upstreamWs)
      if (tunnelTarget.origin !== new URL(upstreamWs).origin || !tunnelTarget.pathname.startsWith("/api/repos/")) {
        return jsonError("not_found", "The cloud WebSocket tunnel serves only workspace terminal and lsp sessions.")
      }
      // Signed out, the tunnel never dials plue: an anonymous attach would only be refused there.
      const token = cloudAuth?.token()
      if (token === undefined) {
        return jsonError("cloud_sign_in_required", "Sign in to Smithers Cloud first — /cloud.sign-in.")
      }
      const upgraded = bunServer.upgrade(request, {
        data: {
          cloud: {
            kind,
            target: tunnelTarget.toString(),
            token,
            upstream: undefined,
            pending: [],
            opened: false
          }
        },
        headers: { "sec-websocket-protocol": websocketProtocol }
      })
      return upgraded ? undefined : jsonError("upgrade_failed", "Expected a WebSocket upgrade.")
    }
    if (pathname.startsWith("/api/")) {
      /*
       * Health remains public for process-supervisor readiness probes. The
       * two OAuth legs are top-level NAVIGATIONS (window.location or the
       * system browser opened by the native handoff) and a navigation can
       * carry no custom header, so gating them on the session header made
       * every GitHub sign-in from this origin answer 401 before the
       * identity seam ever saw it. They carry no local privilege — the
       * proxy forwards them to the identity upstream and back.
       */
      const oauthNavigation = request.method === "GET" &&
        (pathname === AUTH_SIGN_IN_PATH || pathname === AUTH_CALLBACK_PATH)
      if (pathname !== HEALTH_PATH && !oauthNavigation) {
        if (!sameSecret(request.headers.get(LOCAL_SESSION_HEADER) ?? "", sessionToken)) {
          return jsonError("local_session_required", "The local session capability is required.")
        }
        const requestOrigin = request.headers.get("origin")
        if (requestOrigin !== null && requestOrigin !== origin) {
          return jsonError("invalid_origin", "Request origin does not match the local app.")
        }
      }
      const handler = router.match(request.method, pathname)
      if (handler !== undefined) {
        try {
          return await handler({ request, url })
        } catch (error) {
          log(`${request.method} ${pathname} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
          return jsonError("internal", LOCAL_INTERNAL_FAILURE)
        }
      }
      if (router.knows(pathname)) return jsonError("method_not_allowed", `${request.method} is not allowed on ${pathname}.`)
      if (/^\/(?:api\/cloud\/)?api\/(?:linear(?:\/|$)|integrations\/linear(?:\/|$)|auth\/linear(?:\/|$))/.test(pathname) || /\/issues\/[^/]+\/linear-link(?:\/|$)/.test(pathname)) return jsonError("not_found", "Not found.")
      if (pathname.startsWith(CLOUD_ROUTE_PREFIX)) {
        return cloudUpstream === null
          ? refuse("feature_unavailable_here", "The cloud seam is disabled in this build.")
          : proxyCloud(request, url, cloudUpstream, cloudAuth?.token(), upstreamTimeoutMs, log)
      }
      if (pathname === "/api/auth/session") return jsonError("not_found", `No route for ${request.method} ${pathname}.`)
      if (pathname.startsWith(AUTH_ROUTE_PREFIX) || pathname.startsWith(IDENTITY_ROUTE_PREFIX)) {
        return identityUpstream === null ? stubIdentity() : proxyIdentity(request, url, identityUpstream, upstreamTimeoutMs, log)
      }
      /*
       * The product API. The cloud client is served BY the Worker, so every
       * repo, issue, landing, file, notification, and billing seam calls
       * `/api/…` on its own origin and the Worker bridges the GitHub session
       * to a Smithers Cloud token per login (apps/server PLATFORM_PROXY_RULES).
       * This local origin is that client's stand-in: the same families
       * forward to the same Worker with the same re-scoped session cookie,
       * or every one of those seams answers a local 404 in 0 ms — which is
       * exactly what "Listing issues for smithersai/smithers failed (404)"
       * was on 2026-09-02. An allowlist, mirroring the Worker's, never a
       * wildcard.
       */
      if (pathname === AUTHENTICATED_USER_PATH || (pathname === "/api/billing" && request.method === "GET") || PRODUCT_PROXY_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
        return identityUpstream === null
          ? refuse("feature_unavailable_here", "Smithers Cloud is not reachable from this build (offline mode).")
          : proxyIdentity(request, url, identityUpstream, upstreamTimeoutMs, log)
      }
      return jsonError("not_found", `No route for ${request.method} ${pathname}.`)
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonError("method_not_allowed", `${request.method} is not allowed on ${pathname}.`)
    }
    return serveStatic(pathname)
  }
  const server = Bun.serve<WsSocketData>({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: 255,
    /*
     * Every "/" and "/api/*" request leaves one trail line with its status
     * and duration, written after the handler answers. A sign-in that fails
     * silently inside the WebView is visible here as the sequence of answers
     * the page got; a WebSocket upgrade answers nothing and leaves no line.
     */
    fetch: async (request, bunServer) => {
      const started = performance.now()
      const { pathname } = new URL(request.url)
      /*
       * The line is written in `finally`, and a throw past `handle` answers
       * the error envelope routes.ts promises: a request that fails outside
       * a matched handler still leaves its trail line instead of Bun's
       * default HTML 500 and silence.
       */
      let answered: Response | undefined
      try {
        answered = await handle(request, bunServer)
        return answered
      } catch (error) {
        log(`${request.method} ${pathname} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        answered = jsonError("internal", LOCAL_INTERNAL_FAILURE)
        return answered
      } finally {
        if (answered !== undefined && (pathname === "/" || pathname.startsWith("/api/"))) {
          log(`${request.method} ${pathname} -> ${answered.status} in ${Math.round(performance.now() - started)}ms`)
        }
      }
    },
    websocket: {
      maxPayloadLength: MAX_ANY_WS_FRAME_BYTES,
      backpressureLimit: MAX_WS_BACKPRESSURE_BYTES,
      closeOnBackpressureLimit: true,
      open: (socket) => {
        if ("live" in socket.data) {
          const bridge = socket.data.live
          // Dark documents refuse locally even when the backend route is absent.
          // Open the shared upstream only after an ordinary frame needs it.
          bridge.connect = () => {
            if (bridge.upstream) return
            const upstream = new WebSocket(bridge.target, { headers: bridge.headers } as never)
            bridge.upstream = upstream
            upstream.binaryType = "arraybuffer"
            upstream.addEventListener("open", () => {
              for (const frame of bridge.pending) upstream.send(frame)
              bridge.pending.length = 0
              bridge.pendingBytes = 0
            })
            upstream.addEventListener("message", event => socket.send(event.data as string | ArrayBuffer))
            upstream.addEventListener("close", event => closeRenderer(socket, event.code, event.reason))
            upstream.addEventListener("error", () => socket.close(1011, "live upstream failed"))
          }
          return
        }
        const bridge = socket.data.cloud
        /*
         * Lane citc: connect the cloud socket. plue requires its own
         * subprotocol at upgrade — `terminal` for the PTY, `lsp` for the
         * language-server relay (lane L6) — and the branch IS the kind; Bun's
         * client carries it (and the bearer) as headers. Frames that arrived
         * first flush on open.
         */
        cloudBridges.add(socket)
        const headers: Record<string, string> = { "sec-websocket-protocol": bridge.kind, ...cloudWsUpstreamHeaders(bridge.token) }
        const upstream = new WebSocket(bridge.target, { headers } as never)
        bridge.upstream = upstream
        upstream.binaryType = "arraybuffer"
        const end = (code: number, reason: string): void => {
          cloudBridges.delete(socket)
          try {
            // 1001/1005/1006 cannot be relayed as a code; the renderer learns of an abnormal drop by getting one.
            closeRenderer(socket, code, reason)
          } catch {
            // The renderer's socket already left; the bridge is done either way.
          }
        }
        let refusing = false
        /*
         * A close before the handshake completed is a refusal: classified
         * from the upstream's own HTTP answer into a distinct code the
         * renderer never redials on (4401 … 4429), 1011 only when unknown.
         */
        const refuse = (): void => {
          if (refusing) return
          refusing = true
          void classifyCloudWsRefusal(bridge, fetch).then(({ code, reason }) => end(code, reason))
        }
        upstream.addEventListener("open", () => {
          bridge.opened = true
          for (const frame of bridge.pending) upstream.send(frame)
          bridge.pending.length = 0
        })
        upstream.addEventListener("message", (event) => {
          socket.send(event.data as string | ArrayBuffer)
        })
        upstream.addEventListener("close", (event) => {
          if (!bridge.opened) {
            refuse()
            return
          }
          end(event.code, event.reason)
        })
        upstream.addEventListener("error", () => {
          if (!bridge.opened) {
            refuse()
            return
          }
          end(1011, `cloud ${bridge.kind} upstream failed`)
        })
      },
      message: (socket, raw) => {
        if ("live" in socket.data) {
          const bridge = socket.data.live
          const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength
          if (bytes > MAX_ANY_WS_FRAME_BYTES) { socket.close(1009, "live frame too large"); return }
          if (typeof raw === "string") {
            let frame: unknown
            try { frame = JSON.parse(raw) } catch { /* Ordinary malformed frames remain backend-owned. */ }
            if (frame && typeof frame === "object" && "t" in frame && frame.t === "sub"
              && "topic" in frame && typeof frame.topic === "string" && frame.topic.startsWith("doc:code:")) {
              if ("id" in frame && Number.isSafeInteger(frame.id) && (frame.id as number) >= 0) {
                socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" }))
              }
              return
            }
          }
          bridge.connect?.()
          if (bridge.upstream?.readyState === WebSocket.OPEN) {
            if (bridge.upstream.bufferedAmount > MAX_WS_BACKPRESSURE_BYTES) { socket.close(1009, "live upstream backpressure"); return }
            bridge.upstream.send(raw)
          } else if (bridge.pending.length < MAX_CLOUD_WS_PENDING && bridge.pendingBytes + bytes <= MAX_WS_BACKPRESSURE_BYTES) {
            bridge.pending.push(raw)
            bridge.pendingBytes += bytes
          } else socket.close(1009, "live upstream backpressure")
          return
        }
        const bridge = socket.data.cloud
        const frameBytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength
        // Each branch refuses its own over-cap frame with its own reason: plue's 64 KiB for the terminal, 1 MiB for the lsp relay.
        const cap = MAX_CLOUD_WS_FRAME_BYTES[bridge.kind]
        if (frameBytes > cap) {
          socket.close(1009, `A ${bridge.kind} frame is larger than the upstream accepts (${cap / 1024} KiB).`)
          return
        }
        const upstream = bridge.upstream
        if (upstream !== undefined && upstream.readyState === WebSocket.OPEN) {
          // A flooding renderer must not grow the upstream client's buffer without bound (the other direction is capped by backpressureLimit).
          if (upstream.bufferedAmount > MAX_CLOUD_WS_UPSTREAM_BUFFER) {
            socket.close(1009, `The ${bridge.kind} input outran the upstream.`)
            return
          }
          upstream.send(raw)
        } else if (bridge.pending.length < MAX_CLOUD_WS_PENDING) {
          bridge.pending.push(raw)
        } else {
          socket.close(1011, `cloud ${bridge.kind} upstream never opened`)
        }
      },
      close: (socket) => {
        if ("live" in socket.data) {
          socket.data.live.pending.length = 0
          socket.data.live.upstream?.close()
          return
        }
        const bridge = socket.data.cloud
        cloudBridges.delete(socket)
        if (bridge.upstream !== undefined) {
          try {
            bridge.upstream.close()
          } catch {
            // A dead upstream needs no close; the session is the cloud's to reap.
          }
          bridge.upstream = undefined
        }
      }
    }
  })

  const port = server.port ?? 0
  origin = `http://127.0.0.1:${port}`
  expectedHost = `127.0.0.1:${port}`
  log(`SMITHERS_LOCAL_ORIGIN=${origin}`)

  const local: LocalServer = {
    origin,
    port,
    sessionToken,
    websocketProtocol,
    server,
    stop: async () => {
      const writerCleanup = [...writers].flatMap(([runId, writer]) => [() => agent?.cancel(runId), () => writer.end()])
      writers.clear()
      // A configured-model turn holds a provider request open; interrupting its fiber aborts it.
      for (const interrupt of [...sealedTurns.values()]) interrupt()
      // Stop accepting traffic before waiting on independent resources. A
      // failed finalizer must not strand the listener or another child owner.
      const results = await Promise.allSettled([
        ...writerCleanup,
        () => closeCloudBridges(1001, "the local app is shutting down"),
        () => server.stop(true),
        () => cloudAuth?.stop()
      ].map(async (cleanup) => cleanup()))
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError(errors, "Local server shutdown failed.")
    }
  }
  let stopPromise: Promise<void> | undefined
  return { ...local, stop: () => stopPromise ??= local.stop() }
}
