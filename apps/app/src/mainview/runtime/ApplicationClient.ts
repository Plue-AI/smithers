import { Data } from "effect"
import type { ApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import {
  APPLICATION_TOKEN_SCOPES,
  AUTHENTICATED_USER_PATH,
  ApplicationUserSchema,
  BOOTSTRAP_TOKEN_HEADER_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  LOCAL_AUTH_BOOTSTRAP_PATH,
  LOCAL_AUTH_LOGIN_PATH,
  LOCAL_AUTH_STATUS_PATH,
  LocalBootstrapRequestSchema,
  LocalCredentialSchema,
  LocalIdentityStatusSchema,
  LocalLoginResponseSchema,
  SOCKET_TICKET_PATH,
  SocketTicketResponseSchema
} from "@smthrs/rpc/ApplicationAuth"
import type {
  LocalBootstrapRequest,
  LocalCredential,
  LocalIdentityStatus,
  LocalLoginResponse
} from "@smthrs/rpc/ApplicationAuth"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import { clientRefusal, refusalOf, retryAfterHeader } from "@smthrs/rpc/Refusal"
import type { Refusal } from "@smthrs/rpc/Refusal"

export type ApplicationClientErrorCode =
  | "cancelled"
  | "auth-missing"
  | "unauthenticated"
  | "forbidden"
  | "rate-limited"
  | "api"
  | "transport"
  | "invalid-target"
  | "invalid-response"

export class ApplicationClientError extends Data.TaggedError("ApplicationClientError")<{
  readonly code: ApplicationClientErrorCode
  readonly message: string
  readonly status: number | null
  readonly apiCode: string | null
  readonly retryAfterSeconds: number | null
  readonly refusal: Refusal
  readonly cause?: unknown
}> {
  constructor(
    code: ApplicationClientErrorCode,
    message: string,
    status: number | null = null,
    apiCode: string | null = null,
    retryAfterSeconds: number | null = null,
    options?: ErrorOptions,
    refusal?: Refusal
  ) {
    super({
      code, message, status, apiCode, retryAfterSeconds,
      /* An error with a status was answered by a server; only one without a status is "nothing answered". */
      refusal: refusal ?? (status === null
        ? clientRefusal(options?.cause, message)
        : refusalOf({ body: apiCode === null ? null : { code: apiCode }, status, message, retryAfterSeconds })),
      ...(options !== undefined && "cause" in options ? { cause: options.cause } : {})
    })
  }
}

export interface ApplicationClientOptions {
  readonly fetchImpl?: FetchLike
  /** The serving origin outside a browser (tests/server rendering). */
  readonly pageOrigin?: string
  /** Tokens stay in the host auth adapter; runtime target documents contain no secrets. */
  readonly token?: () => string | undefined | Promise<string | undefined>
  /** Injectable double-submit cookie reader; browsers default to document.cookie. */
  readonly csrfToken?: () => string | undefined
}

export interface ApplicationRequestOptions extends RequestInit {
  readonly expect?: "json" | "empty"
}

export interface LocalIdentityClient {
  readonly status: (signal?: AbortSignal) => Promise<LocalIdentityStatus>
  readonly login: (credentials: LocalCredential, signal?: AbortSignal) => Promise<LocalLoginResponse>
  readonly bootstrap: (request: LocalBootstrapRequest, signal?: AbortSignal) => Promise<LocalLoginResponse>
}

export interface ApplicationIdentity {
  readonly username: string
  readonly admin: boolean
  readonly scopes: "degraded" | null
}

export interface ApplicationIdentityClient {
  /** Null is the definitive signed-out answer; transport and malformed answers reject. */
  readonly current: (signal?: AbortSignal) => Promise<ApplicationIdentity | null>
}

export interface ApplicationClient {
  readonly target: ApplicationTarget
  readonly baseUrl: string
  readonly fetch: FetchLike
  readonly request: <T = unknown>(path: string, init?: ApplicationRequestOptions) => Promise<T>
  /** Authenticated streaming request; the caller owns and cancels the response body. */
  readonly stream: (path: string, init?: RequestInit) => Promise<Response>
  readonly localIdentity: LocalIdentityClient
  readonly identity: ApplicationIdentityClient
  /** Mint a fresh one-use ticket and append it only to a socket on this target's origin. */
  readonly authorizeWebSocket: (url: string, signal?: AbortSignal) => Promise<string>
}

const isAbort = (error: unknown, signal: AbortSignal | null | undefined): boolean =>
  signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError") ||
  (error instanceof Error && error.name === "AbortError")

const apiFailure = async (response: Response, signal?: AbortSignal | null): Promise<ApplicationClientError> => {
  const body = await response.json().catch((error: unknown) => {
    if (isAbort(error, signal)) throw error
    return null
  }) as { code?: unknown; message?: unknown; error?: unknown } | null
  const message = typeof body?.message === "string" && body.message !== ""
    ? body.message
    : typeof body?.error === "string" && body.error !== ""
    ? body.error
    : `Request failed (${response.status}).`
  const refusal = refusalOf({
    body,
    status: response.status,
    message,
    retryAfterSeconds: retryAfterHeader(response.headers)
  })
  const code: ApplicationClientErrorCode = response.status === 401
    ? "unauthenticated"
    : response.status === 403
    ? "forbidden"
    : response.status === 429
    ? "rate-limited"
    : "api"
  return new ApplicationClientError(
    code,
    message,
    response.status,
    refusal.rawCode,
    refusal.retryAfter,
    undefined,
    refusal
  )
}

const targetUrl = (baseUrl: string, input: string | URL | Request): string | URL | Request => {
  if (baseUrl === "") return input
  if (input instanceof Request) return new Request(new URL(input.url, baseUrl), input)
  if (input instanceof URL) return new URL(input.toString(), baseUrl)
  return new URL(input, `${baseUrl}/`).toString()
}

const selectedOrigin = (baseUrl: string, pageOrigin?: string): string | null => baseUrl !== ""
  ? baseUrl
  : pageOrigin !== undefined
  ? new URL(pageOrigin).origin
  : typeof globalThis.location === "undefined"
  ? null
  : globalThis.location.origin

const assertTargetOrigin = (
  baseUrl: string,
  input: string | URL | Request,
  pageOrigin?: string
): void => {
  const selected = selectedOrigin(baseUrl, pageOrigin)
  if (selected === null) return
  const raw = input instanceof Request ? input.url : input.toString()
  let requested: URL
  try {
    requested = new URL(raw, `${selected}/`)
  } catch (error) {
    throw new ApplicationClientError("invalid-target", "Request URL is invalid.", null, null, null, { cause: error })
  }
  if (requested.origin !== selected) {
    throw new ApplicationClientError(
      "invalid-target",
      "Application credentials cannot be sent outside the selected backend origin."
    )
  }
}

const browserCSRFToken = (): string | undefined => {
  if (typeof document === "undefined") return undefined
  const prefix = `${CSRF_COOKIE_NAME}=`
  for (const part of document.cookie.split(";")) {
    const cookie = part.trim()
    if (!cookie.startsWith(prefix)) continue
    try {
      return decodeURIComponent(cookie.slice(prefix.length)) || undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

const methodOf = (input: string | URL | Request, init?: RequestInit): string =>
  (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()

const isMutation = (method: string): boolean => method !== "GET" && method !== "HEAD" && method !== "OPTIONS"

const invalidResponse = (message: string, cause?: unknown): ApplicationClientError =>
  new ApplicationClientError("invalid-response", message, null, null, null, cause === undefined ? undefined : { cause })

/** One auth, URL, cancellation, and error boundary for every application mode. */
export const createApplicationClient = (
  target: ApplicationTarget,
  options: ApplicationClientOptions = {}
): ApplicationClient => {
  const raw = options.fetchImpl ?? fetch.bind(globalThis)
  const authenticatedFetch: FetchLike = async (input, init) => {
    assertTargetOrigin(target.baseUrl, input, options.pageOrigin)
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers !== undefined) new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    const next: RequestInit = { ...init, headers }
    if (target.auth.kind === "session") {
      next.credentials = "include"
      if (isMutation(methodOf(input, init))) {
        const csrf = (options.csrfToken ?? browserCSRFToken)()?.trim()
        if (csrf !== undefined && csrf !== "") headers.set(CSRF_HEADER_NAME, csrf)
      }
    } else {
      const token = (await options.token?.())?.trim()
      if (token === undefined || token === "") {
        throw new ApplicationClientError("auth-missing", `No ${target.auth.kind} token is available for this backend.`)
      }
      headers.set("authorization", `${target.auth.kind === "bearer" ? "Bearer" : "token"} ${token}`)
      next.credentials = "omit"
    }
    return raw(targetUrl(target.baseUrl, input), next)
  }

  const stream = async (path: string, init?: RequestInit): Promise<Response> => {
    try {
      const response = await authenticatedFetch(path, init)
      if (!response.ok) throw await apiFailure(response, init?.signal)
      return response
    } catch (error) {
      if (error instanceof ApplicationClientError) throw error
      if (isAbort(error, init?.signal)) {
        throw new ApplicationClientError("cancelled", "Request cancelled.", null, null, null, { cause: error })
      }
      /* The thrown text stays on the cause, for Details and the reporter; the refusal says nothing answered. */
      throw new ApplicationClientError(
        "transport",
        "Could not reach Smithers.",
        null,
        null,
        null,
        { cause: error }
      )
    }
  }

  const request = async <T = unknown>(path: string, init: ApplicationRequestOptions = {}): Promise<T> => {
    const { expect = "json", ...requestInit } = init
    const response = await stream(path, requestInit)
    if (expect === "empty" || response.status === 204) return undefined as T
    try {
      return await response.json() as T
    } catch (error) {
      if (isAbort(error, requestInit.signal)) {
        throw new ApplicationClientError("cancelled", "Request cancelled.", null, null, null, { cause: error })
      }
      throw new ApplicationClientError(
        "invalid-response",
        "Backend returned invalid JSON.",
        response.status,
        null,
        null,
        { cause: error }
      )
    }
  }

  const requireOwner = (): void => {
    if (target.ownership !== "owner") {
      throw new ApplicationClientError("invalid-target", "Local owner credentials cannot be sent to a Plue backend.")
    }
  }

  const localIdentity: ApplicationClient["localIdentity"] = {
    status: async (signal) => {
      requireOwner()
      const body = await request(LOCAL_AUTH_STATUS_PATH, { signal })
      const parsed = LocalIdentityStatusSchema.safeParse(body)
      if (!parsed.success) throw invalidResponse("Backend returned an invalid local identity status.", parsed.error)
      return parsed.data
    },
    login: async (credentials, signal) => {
      requireOwner()
      const input = LocalCredentialSchema.parse(credentials)
      const body = await request(LOCAL_AUTH_LOGIN_PATH, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      })
      const parsed = LocalLoginResponseSchema.safeParse(body)
      if (!parsed.success) throw invalidResponse("Backend returned an invalid local login response.", parsed.error)
      return parsed.data
    },
    bootstrap: async (bootstrap, signal) => {
      requireOwner()
      const input = LocalBootstrapRequestSchema.parse(bootstrap)
      const body = await request(LOCAL_AUTH_BOOTSTRAP_PATH, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          [BOOTSTRAP_TOKEN_HEADER_NAME]: input.bootstrapToken
        },
        body: JSON.stringify({ username: input.username, password: input.password, ...(input.email === undefined ? {} : { email: input.email }) })
      })
      const parsed = LocalLoginResponseSchema.safeParse(body)
      if (!parsed.success) throw invalidResponse("Backend returned an invalid local bootstrap response.", parsed.error)
      return parsed.data
    }
  }

  const identity: ApplicationClient["identity"] = {
    current: async (signal) => {
      let body: unknown
      try {
        body = await request(AUTHENTICATED_USER_PATH, { signal })
      } catch (error) {
        if (error instanceof ApplicationClientError && error.code === "unauthenticated") return null
        throw error
      }
      const parsed = ApplicationUserSchema.safeParse(body)
      if (!parsed.success) throw invalidResponse("Backend returned an invalid authenticated user.", parsed.error)
      const scopes = parsed.data.token_scopes
      const grantsAll = scopes?.some((scope) => scope === "all" || scope === "admin") === true
      const available = new Set(scopes)
      const degraded = scopes !== undefined && !grantsAll && APPLICATION_TOKEN_SCOPES.some((scope) => !available.has(scope))
      return {
        username: parsed.data.username,
        admin: parsed.data.is_admin === true,
        scopes: degraded ? "degraded" : null
      }
    }
  }

  const authorizeWebSocket: ApplicationClient["authorizeWebSocket"] = async (input, signal) => {
    const selected = selectedOrigin(target.baseUrl, options.pageOrigin)
    if (selected === null) throw new ApplicationClientError("invalid-target", "The selected backend origin is unavailable.")
    let socket: URL
    try {
      socket = new URL(input)
    } catch (error) {
      throw new ApplicationClientError("invalid-target", "WebSocket URL is invalid.", null, null, null, { cause: error })
    }
    if (socket.protocol !== "ws:" && socket.protocol !== "wss:") {
      throw new ApplicationClientError("invalid-target", "WebSocket URL must use WS(S).")
    }
    const socketHTTPOrigin = `${socket.protocol === "wss:" ? "https:" : "http:"}//${socket.host}`
    if (socketHTTPOrigin !== selected) {
      throw new ApplicationClientError(
        "invalid-target",
        "Application credentials cannot be sent outside the selected backend origin."
      )
    }
    const body = await request(SOCKET_TICKET_PATH, { method: "POST", signal, expect: "json" })
    const parsed = SocketTicketResponseSchema.safeParse(body)
    if (!parsed.success) throw invalidResponse("Backend returned an invalid socket ticket.", parsed.error)
    socket.searchParams.set("ticket", parsed.data.ticket)
    return socket.toString()
  }

  return { target, baseUrl: target.baseUrl, fetch: authenticatedFetch, request, stream, localIdentity, identity, authorizeWebSocket }
}
