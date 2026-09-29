/**
 * JSON-RPC over the MCP Streamable HTTP transport.
 *
 * Every client message is one `POST` to the server's endpoint. A notification
 * is answered with `202 Accepted`; a request is answered either with one
 * `application/json` reply or with a `text/event-stream` whose events carry
 * server notifications, server requests, and finally the reply. The server's
 * `Mcp-Session-Id` from `initialize` is sent on every later message, together
 * with the negotiated `MCP-Protocol-Version`.
 *
 * Requests go through the `HttpClient` in context, which is the host's egress
 * client: its proxy, pinning, and capability checks apply unchanged, and a
 * destination the egress policy denies fails with `connection_closed`.
 *
 * Out of scope: the optional standalone `GET` event stream, resuming a broken
 * event stream with `Last-Event-ID`, and OAuth discovery. An expired session
 * fails rather than re-initializing, so no request is ever replayed.
 *
 * @since 1.0.0-rc.1
 */

import { isRecord } from "@smthrs/canonical/Record"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import { Deferred, Effect, Option, type Redacted, type Scope, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type { McpError } from "../McpError.ts"
import * as DiagnosticReporter from "./DiagnosticReporter.ts"
import * as JsonLimits from "./JsonLimits.ts"
import * as Limits from "./Limits.ts"
import * as Rpc from "./Rpc.ts"
import * as Transport from "./Transport.ts"

/**
 * Supplies the bearer credential for a Streamable HTTP server.
 *
 * `token` runs once per HTTP message, so a provider can rotate or refresh the
 * credential between messages. Its failure fails that message unchanged.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface AuthProvider {
  readonly token: Effect.Effect<Redacted.Redacted<string>, McpError>
}

/**
 * Options accepted by {@link connect}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface ConnectOptions {
  /** The name this server is known by, for error messages only. */
  readonly server: string
  /** The server's MCP endpoint: an absolute `http:` or `https:` URL without credentials. */
  readonly url: string
  /** Bearer credential source. Omit for a server that needs none. */
  readonly authProvider?: AuthProvider | undefined
  /** Default deadline for a request/reply exchange. See {@link Transport.defaultRequestTimeoutMs}. */
  readonly requestTimeoutMs?: number | undefined
  /** Maximum UTF-8 bytes accepted in one inbound JSON-RPC message. See {@link Transport.defaultMaxFrameBytes}. */
  readonly maxFrameBytes?: number | undefined
  /** Maximum UTF-8 bytes emitted in one JSON-RPC message. See {@link Transport.defaultMaxOutboundFrameBytes}. */
  readonly maxOutboundFrameBytes?: number | undefined
}

/** Deadline for the best-effort `DELETE` that ends a session on scope close. */
const sessionCloseMs = 1_000

/** A session id is visible ASCII only (0x21-0x7E). */
const validSessionId = /^[\x21-\x7e]+$/

const endpointOf = (url: string): URL | undefined => {
  if (!URL.canParse(url)) return undefined
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
  if (parsed.username !== "" || parsed.password !== "") return undefined
  return parsed
}

const utf8 = new TextEncoder()

const mediaType = (header: string | undefined): string => (header ?? "").split(";")[0]!.trim().toLowerCase()

/**
 * Opens a Streamable HTTP session and returns a live {@link Transport.Transport}.
 * No message is sent until the first request; the endpoint and limits are
 * checked first. Closing the calling scope ends the session with a
 * best-effort `DELETE` and rejects later traffic.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const connect = (
  options: ConnectOptions
): Effect.Effect<Transport.Transport, McpError, HttpClient.HttpClient | Scope.Scope> =>
  Effect.gen(function*() {
    const server = options.server
    const diagnostic = yield* DiagnosticReporter.make(server)
    const requestTimeoutMs = options.requestTimeoutMs ?? Transport.defaultRequestTimeoutMs
    const maxFrameBytes = options.maxFrameBytes ?? Transport.defaultMaxFrameBytes
    const maxOutboundFrameBytes = options.maxOutboundFrameBytes ?? Transport.defaultMaxOutboundFrameBytes
    yield* Limits.checkPositiveIntegers(server, [
      ["requestTimeoutMs", requestTimeoutMs],
      ["maxFrameBytes", maxFrameBytes],
      ["maxOutboundFrameBytes", maxOutboundFrameBytes]
    ])
    const endpoint = endpointOf(options.url)
    if (endpoint === undefined) {
      return yield* Effect.fail(Limits.protocolError(
        server,
        `MCP server "${server}" url must be an absolute http or https URL without credentials`
      ))
    }
    // Each message runs in its own scope, which aborts the HTTP request and
    // releases its body however the exchange ends.
    const client = HttpClient.withScope(yield* HttpClient.HttpClient)
    const scope = yield* Effect.scope
    const closing = yield* Deferred.make<void>()

    let open = true
    let sessionId: string | undefined
    let protocolVersion: string | undefined
    let nextId = 0

    const unreachable = (error: HttpClientError.HttpClientError): McpError => {
      diagnostic("transport", error.message)
      return Option.isSome(KernelHttpClient.fromHttpClientError(error))
        ? Transport.closed(server, "is not reachable: egress to its URL is not granted")
        : Transport.closed(server, "is not reachable; transport details withheld")
    }

    const frameOf = (method: string, message: Rpc.OutboundMessage): Effect.Effect<Uint8Array, McpError> => {
      // Rpc.encode appends the stdio line terminator; an HTTP body has none.
      const frame = Rpc.encode(message).subarray(0, -1)
      return frame.byteLength <= maxOutboundFrameBytes
        ? Effect.succeed(frame)
        : Effect.fail(Limits.protocolError(
          server,
          `MCP server "${server}" tried to send a ${method} frame larger than ${maxOutboundFrameBytes} bytes`
        ))
    }

    const withSession = (request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest => {
      let next = request
      if (sessionId !== undefined) next = HttpClientRequest.setHeader(next, "mcp-session-id", sessionId)
      if (protocolVersion !== undefined) {
        next = HttpClientRequest.setHeader(next, "mcp-protocol-version", protocolVersion)
      }
      return next
    }

    /** Reads a whole body, failing once it passes `maxFrameBytes`. */
    const readBody = (stream: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>) =>
      stream.pipe(
        Stream.mapError(unreachable),
        Stream.runFoldEffect(
          () => ({ chunks: [] as Array<Uint8Array>, bytes: 0 }),
          (body, chunk) => {
            body.bytes += chunk.byteLength
            if (body.bytes > maxFrameBytes) {
              return Effect.fail(Limits.protocolError(server, `MCP frame exceeded ${maxFrameBytes} bytes`))
            }
            body.chunks.push(chunk)
            return Effect.succeed(body)
          }
        ),
        Effect.map((body) => {
          const joined = new Uint8Array(body.bytes)
          let offset = 0
          for (const chunk of body.chunks) {
            joined.set(chunk, offset)
            offset += chunk.byteLength
          }
          return new TextDecoder().decode(joined)
        })
      )

    const authorize = (request: HttpClientRequest.HttpClientRequest) =>
      options.authProvider === undefined
        ? Effect.succeed(request)
        : Effect.map(options.authProvider.token, (token) => HttpClientRequest.bearerToken(request, token))

    /**
     * Sends one message and returns the raw response, or fails with a
     * transport, status, or session failure.
     */
    const post = (method: string, message: Rpc.OutboundMessage, dispatched?: { value: boolean }) =>
      Effect.gen(function*() {
        if (!open) return yield* Effect.fail(Transport.closed(server, "connection scope closed"))
        const body = yield* frameOf(method, message)
        const request = yield* authorize(withSession(
          HttpClientRequest.post(endpoint).pipe(
            HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
            HttpClientRequest.bodyUint8Array(body, "application/json")
          )
        ))
        const sentSession = sessionId !== undefined
        if (dispatched !== undefined) dispatched.value = true
        const response = yield* Effect.mapError(client.execute(request), unreachable)
        if (response.status === 404 && sentSession) {
          return yield* Effect.fail(Transport.closed(server, "ended the session; reconnect to continue"))
        }
        if (response.status < 200 || response.status > 299) {
          diagnostic("remote-error", { status: response.status })
          return yield* Effect.fail(Limits.protocolError(
            server,
            `MCP server "${server}" answered ${method} with HTTP ${response.status}`
          ))
        }
        return response
      })

    /** Sends a notification or a reply to a server request; the body is ignored. */
    const deliver = (method: string, message: Rpc.OutboundMessage) =>
      Effect.scoped(Effect.flatMap(post(method, message), (response) => Effect.asVoid(readBody(response.stream))))

    /** Fails `effect` with `connection_closed`, interrupting it, when the scope closes first. */
    const untilClosed = <A>(effect: Effect.Effect<A, McpError>) =>
      Effect.raceFirst(
        effect,
        Effect.andThen(Deferred.await(closing), Effect.fail(Transport.closed(server, "connection scope closed")))
      )

    /**
     * Handles one inbound JSON-RPC message during request `id`: server
     * requests are answered, notifications dropped, and the reply returned.
     */
    const receive = (method: string, id: number, text: string): Effect.Effect<Option.Option<unknown>, McpError> =>
      Effect.gen(function*() {
        const message = Rpc.parse(text)
        if (message === undefined) {
          return yield* Effect.fail(
            Limits.protocolError(server, `MCP server "${server}" sent a message that is not JSON-RPC`)
          )
        }
        const jsonIssue = JsonLimits.checkParsed(message)
        if (jsonIssue !== undefined) {
          return yield* Effect.fail(
            Limits.protocolError(server, `MCP server "${server}" sent invalid JSON: ${jsonIssue}`)
          )
        }
        const reply = Rpc.classify(message)
        switch (reply._tag) {
          case "Notification":
            return Option.none()
          case "Request": {
            yield* deliver(
              "server-response",
              reply.method === "ping"
                ? { jsonrpc: "2.0", id: reply.id, result: {} }
                : { jsonrpc: "2.0", id: reply.id, error: { code: -32_601, message: "Method not found" } }
            )
            return Option.none()
          }
          case "Malformed":
            return yield* Effect.fail(Limits.protocolError(
              server,
              `MCP server "${server}" sent a malformed JSON-RPC reply: ${reply.reason}`
            ))
          case "UncorrelatedError":
            diagnostic("remote-error", { code: reply.code, message: reply.message, data: reply.data })
            return Option.none()
        }
        if (reply.id !== id) {
          return yield* Effect.fail(Limits.protocolError(
            server,
            `MCP server "${server}" answered ${method} with a reply to another request`
          ))
        }
        if (reply._tag === "Error") {
          diagnostic("remote-error", { code: reply.code, message: reply.message, data: reply.data })
          return yield* Effect.fail(Transport.replyError(server, method, reply))
        }
        return Option.some(reply.result)
      })

    /** Collects `data:` lines into events; a blank line ends one. */
    const events = (stream: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>) =>
      Transport.lines(server, maxFrameBytes, Stream.mapError(stream, unreachable), { crTerminates: true }).pipe(
        Stream.mapAccumEffect(
          () => ({ data: undefined as string | undefined, bytes: 0 }),
          (event, line) => {
            if (line === "") {
              const data = event.data
              event.data = undefined
              event.bytes = 0
              return Effect.succeed([event, data === undefined ? [] : [data]] as const)
            }
            if (!line.startsWith("data:")) return Effect.succeed([event, []] as const)
            const value = line.slice(line.startsWith("data: ") ? 6 : 5)
            event.bytes += utf8.encode(value).byteLength + (event.data === undefined ? 0 : 1)
            event.data = event.data === undefined ? value : `${event.data}\n${value}`
            return event.bytes > maxFrameBytes
              ? Effect.fail(Limits.protocolError(server, `MCP frame exceeded ${maxFrameBytes} bytes`))
              : Effect.succeed([event, []] as const)
          }
        )
      )

    const exchange = (method: string, params: unknown, id: number, dispatched: { value: boolean }) =>
      Effect.scoped(Effect.gen(function*() {
        const response = yield* post(method, { jsonrpc: "2.0", id, method, params }, dispatched)
        if (method === "initialize") {
          const header = response.headers["mcp-session-id"]
          if (header !== undefined && !validSessionId.test(header)) {
            return yield* Effect.fail(Limits.protocolError(server, `MCP server "${server}" sent an invalid session id`))
          }
          sessionId = header
        }
        const type = mediaType(response.headers["content-type"])
        let result: Option.Option<unknown>
        if (type === "application/json") {
          result = yield* Effect.flatMap(readBody(response.stream), (text) => receive(method, id, text))
        } else if (type === "text/event-stream") {
          result = Option.flatten(
            yield* events(response.stream).pipe(
              Stream.mapEffect((data) => receive(method, id, data)),
              Stream.filter(Option.isSome),
              Stream.runHead
            )
          )
        } else {
          return yield* Effect.fail(Limits.protocolError(
            server,
            `MCP server "${server}" answered ${method} with an unsupported content type`
          ))
        }
        if (Option.isNone(result)) {
          return yield* Effect.fail(Transport.closed(server, `closed its response before answering ${method}`))
        }
        if (method === "initialize" && isRecord(result.value) && typeof result.value.protocolVersion === "string") {
          protocolVersion = result.value.protocolVersion
        }
        return result.value
      }))

    const notify = (method: string, params?: unknown, timeoutMs = requestTimeoutMs): Effect.Effect<void, McpError> =>
      Limits.isPositiveInteger(timeoutMs)
        ? untilClosed(deliver(method, { jsonrpc: "2.0", method, params })).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => Effect.fail(Transport.timeout(server, method, timeoutMs))
          })
        )
        : Effect.fail(Limits.protocolError(server, "MCP notification timeout must be a positive integer"))

    const request = (
      method: string,
      params?: unknown,
      timeoutMs = requestTimeoutMs
    ): Effect.Effect<unknown, McpError> =>
      Effect.suspend(() => {
        if (!Limits.isPositiveInteger(timeoutMs)) {
          return Effect.fail(Limits.protocolError(server, "MCP request timeout must be a positive integer"))
        }
        const id = ++nextId
        const dispatched = { value: false }
        return exchange(method, params, id, dispatched).pipe(
          // Closing the HTTP response is not a cancellation in MCP; tell the
          // server explicitly, without delaying the deadline being reported.
          Effect.onInterrupt(() =>
            dispatched.value && open && method !== "initialize"
              ? Effect.asVoid(Effect.forkIn(
                Effect.ignore(notify("notifications/cancelled", {
                  requestId: id,
                  reason: Transport.cancellationReason
                })),
                scope
              ))
              : Effect.void
          ),
          untilClosed,
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => Effect.fail(Transport.timeout(server, method, timeoutMs))
          })
        )
      })

    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        open = false
        const ended = Deferred.succeed(closing, undefined)
        if (sessionId === undefined) return ended
        return Effect.andThen(
          ended,
          Effect.scoped(Effect.flatMap(authorize(withSession(HttpClientRequest.delete(endpoint))), client.execute))
            .pipe(
              Effect.timeout(sessionCloseMs),
              Effect.ignore
            )
        )
      })
    )

    return { request, notify }
  })
