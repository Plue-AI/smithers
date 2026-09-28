/**
 * Newline-delimited JSON-RPC transport over a spawned MCP server's stdio.
 *
 * This module owns exactly the connection lifecycle and request/reply
 * correlation an MCP session needs: spawn once, write frames in, read frames
 * out, match replies to the request that asked for them. It knows nothing
 * about `initialize`, `tools/list`, or `tools/call`. It answers the protocol's
 * liveness `ping` with an empty result, and unsupported server requests with
 * method-not-found. {@link McpClient} owns feature negotiation and tool calls.
 *
 * Server-initiated notifications are received and dropped. A future caller
 * that needs `notifications/*` (for example a progress stream) is the reason
 * to add a subscription surface here rather than threading one more parameter
 * through every constructor now.
 *
 * @since 1.0.0-rc.0
 */

import * as Redaction from "@smthrs/journal/Redaction"
import * as ChildProcessEnvironment from "@smthrs/kernel/ChildProcessEnvironment"
import { Deferred, Effect, Exit, Fiber, HashMap, Option, Queue, Ref, Stream } from "effect"
import type { Scope } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { McpError } from "../McpError.ts"
import * as DiagnosticReporter from "./DiagnosticReporter.ts"
import * as JsonLimits from "./JsonLimits.ts"
import * as Limits from "./Limits.ts"
import * as Rpc from "./Rpc.ts"

/**
 * The retained stderr diagnostic: redacted complete lines capped to the
 * configured byte tail, and the raw line still arriving.
 */
interface StderrTail {
  readonly redacted: string
  readonly pending: string
}

const emptyStderrTail: StderrTail = { redacted: "", pending: "" }

/**
 * The longest unterminated stderr line held for redaction. A longer line is
 * withheld whole, because redacting it in pieces could split a credential.
 */
const maxPendingStderrBytes = 65_536

const withheldStderrLine = "[stderr line withheld]\n"

const utf8 = new TextEncoder()

/** The last `limit` bytes of `text`, cut on a UTF-8 character boundary. */
const tailBytes = (text: string, limit: number): string => {
  const bytes = utf8.encode(text)
  if (bytes.byteLength <= limit) return text
  let start = bytes.byteLength - limit
  // Skip continuation bytes so the tail starts on a whole character.
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1
  return new TextDecoder().decode(bytes.subarray(start))
}

/** True while `text` holds a private key block whose end has not arrived. */
const openKeyBlock = (text: string): boolean => text.lastIndexOf("-----BEGIN") > text.lastIndexOf("-----END")

/**
 * Adds decoded stderr text. Complete lines are redacted before they join the
 * capped tail. A private key block spans lines, so lines stay pending until
 * its end arrives.
 */
const appendStderr = (current: StderrTail, text: string, limit: number): StderrTail => {
  let pending = current.pending + text
  let redacted = current.redacted
  const lineEnd = pending.lastIndexOf("\n")
  if (lineEnd >= 0 && !openKeyBlock(pending.slice(0, lineEnd + 1))) {
    redacted += String(Redaction.redact(pending.slice(0, lineEnd + 1)))
    pending = pending.slice(lineEnd + 1)
  }
  if (utf8.encode(pending).byteLength > Math.max(limit, maxPendingStderrBytes)) {
    redacted += withheldStderrLine
    pending = ""
  }
  return { redacted: tailBytes(redacted, limit), pending }
}

/**
 * The diagnostic an observer receives: the redacted tail and the redacted
 * pending line, whitespace flattened, capped to the last `limit` bytes. The
 * cap runs after redaction, so it can only cut a placeholder, never a
 * credential.
 */
const renderStderr = (current: StderrTail, limit: number): string =>
  tailBytes(
    (current.redacted + String(Redaction.redact(current.pending))).replace(/\s+/g, " ").trim(),
    limit
  )

/**
 * One live connection to a spawned MCP server.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Transport {
  /** Sends a request and resolves with its `result`, or fails with the server's `error`. */
  readonly request: (method: string, params?: unknown, timeoutMs?: number) => Effect.Effect<unknown, McpError>
  /** Sends a notification, bounding queue admission by the optional positive-integer deadline. */
  readonly notify: (method: string, params?: unknown, timeoutMs?: number) => Effect.Effect<void, McpError>
}

/**
 * Options accepted by {@link connect}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ConnectOptions {
  /** The name this server is known by, for error messages only. */
  readonly server: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string | undefined
  /** Values merged into the bootstrap allowlist rather than the full host environment. */
  readonly env?: Record<string, string | undefined> | undefined
  /** Default deadline for a request/reply exchange. See {@link defaultRequestTimeoutMs}. */
  readonly requestTimeoutMs?: number | undefined
  /** Maximum number of frames waiting to be written. See {@link defaultQueueCapacity}. */
  readonly queueCapacity?: number | undefined
  /** Maximum UTF-8 bytes accepted in one inbound JSON-RPC frame. See {@link defaultMaxFrameBytes}. */
  readonly maxFrameBytes?: number | undefined
  /** Maximum UTF-8 bytes emitted in one JSON-RPC frame. See {@link defaultMaxOutboundFrameBytes}. */
  readonly maxOutboundFrameBytes?: number | undefined
  /** Maximum diagnostic stderr bytes retained in memory. See {@link defaultMaxStderrBytes}. */
  readonly maxStderrBytes?: number | undefined
}

/**
 * Default request deadline.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultRequestTimeoutMs = 120_000

/**
 * Default number of outbound frames allowed to wait in memory.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultQueueCapacity = 64

/**
 * Default maximum inbound JSON-RPC frame size (one MiB).
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxFrameBytes = 1024 * 1024

/**
 * Default maximum outbound JSON-RPC frame size (one MiB).
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxOutboundFrameBytes = 1024 * 1024

/**
 * Default maximum child-stderr tail retained for connection diagnostics.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxStderrBytes = 2048

const closed = (server: string, reason: string): McpError =>
  new McpError({ code: "connection_closed", message: `MCP server "${server}" ${reason}`, server })

const timeout = (server: string, method: string, timeoutMs: number): McpError =>
  new McpError({
    code: "timeout",
    message: `MCP server "${server}" did not answer ${method} within ${timeoutMs}ms`,
    server
  })

const diagnosticErrorCodes: ReadonlySet<string> = new Set(["spawn_failed", "timeout", "connection_closed"])
const cancellationReason = "request no longer awaited"
// Exit and stdout EOF can precede the parent's final stderr read. Await the
// actual drainer, with a finite fallback for a child/descendant holding its
// stderr pipe open. Caller interruption never has to wait out this budget.
const terminalStderrDrainMs = 250

type Pending = {
  readonly deferred: Deferred.Deferred<unknown, McpError>
  readonly method: string
}

type OutboundFrame = {
  readonly frame: Uint8Array
  readonly request?: {
    readonly id: number
    cancelled: boolean
    dispatched: boolean
  }
}

type ConnectionState = {
  readonly _tag: "Open"
  readonly pending: HashMap.HashMap<number, Pending>
} | {
  readonly _tag: "Closed"
  readonly error: Deferred.Deferred<McpError>
}

const replyError = (
  server: string,
  method: string,
  reply: Extract<Rpc.Reply, { readonly _tag: "Error" }>
): McpError => {
  // Servers do not standardize unknown-tool prose, so this heuristic stays
  // limited to the two MCP error codes and an explicit tool plus absence phrase.
  const remoteUnknownTool = (reply.code === -32_601 || reply.code === -32_602) &&
    /\btool\b/i.test(reply.message) &&
    /\b(?:unknown|unrecognized|no such|not found)\b/i.test(reply.message)
  return new McpError({
    code: method === "tools/call"
      ? remoteUnknownTool ? "tool_not_found" : "tool_failed"
      : "protocol_error",
    message: `MCP server "${server}" failed ${method} (${reply.code}); remote details withheld`,
    server
  })
}

/** Splits stdout in linear time, retaining one bounded partial frame plus an optional CR. */
const frames = (
  server: string,
  maxFrameBytes: number,
  stream: Stream.Stream<Uint8Array, unknown>
): Stream.Stream<string, unknown | McpError> => {
  type PartialFrame = { pieces: Array<Uint8Array>; bytes: number }
  const decoder = new TextDecoder()
  const decode = (partial: PartialFrame): string => {
    const joined = new Uint8Array(partial.bytes)
    let offset = 0
    for (const piece of partial.pieces) {
      joined.set(piece, offset)
      offset += piece.byteLength
    }
    const end = joined[partial.bytes - 1] === 0x0d ? partial.bytes - 1 : partial.bytes
    return decoder.decode(joined.subarray(0, end))
  }
  return stream.pipe(
    Stream.mapAccumEffect(
      (): PartialFrame => ({ pieces: [], bytes: 0 }),
      (partial, chunk) => {
        const complete: Array<string> = []
        const append = (piece: Uint8Array): boolean => {
          if (piece.byteLength === 0) return true
          const bytes = partial.bytes + piece.byteLength
          // A final CR may be the first half of CRLF. Allow that one byte
          // beyond the cap, but count it if more frame content follows.
          const contentBytes = bytes - (piece[piece.byteLength - 1] === 0x0d ? 1 : 0)
          if (contentBytes > maxFrameBytes) return false
          partial.pieces.push(piece)
          partial.bytes = bytes
          return true
        }
        let start = 0
        for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
          if (!append(chunk.subarray(start, end))) {
            return Effect.fail(Limits.protocolError(server, `MCP frame exceeded ${maxFrameBytes} bytes`))
          }
          complete.push(decode(partial))
          partial = { pieces: [], bytes: 0 }
          start = end + 1
        }
        if (!append(chunk.subarray(start))) {
          return Effect.fail(Limits.protocolError(server, `MCP frame exceeded ${maxFrameBytes} bytes`))
        }
        return Effect.succeed([partial, complete] as const)
      },
      { onHalt: (partial) => partial.bytes === 0 ? [] : [decode(partial)] }
    ),
    Stream.filter((line) => line.trim() !== "")
  )
}

/**
 * Spawns an MCP server over stdio and returns a live {@link Transport}.
 *
 * The connection is scoped: the writer and reader loops are daemon fibers
 * forked into the calling scope, and closing that scope tears the process
 * down with it. Every request pending when the connection closes fails with
 * `connection_closed` instead of hanging forever.
 *
 * Stdout that does not claim JSON-RPC is ignored because servers commonly log
 * there. Once an object carries its own `jsonrpc` property, a malformed version
 * or reply closes the connection with `protocol_error`.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const connect = (
  options: ConnectOptions
): Effect.Effect<Transport, McpError, ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function*() {
    const diagnostic = yield* DiagnosticReporter.make(options.server)
    const requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs
    const queueCapacity = options.queueCapacity ?? defaultQueueCapacity
    const maxFrameBytes = options.maxFrameBytes ?? defaultMaxFrameBytes
    const maxOutboundFrameBytes = options.maxOutboundFrameBytes ?? defaultMaxOutboundFrameBytes
    const maxStderrBytes = options.maxStderrBytes ?? defaultMaxStderrBytes
    yield* Limits.checkPositiveIntegers(options.server, [
      ["requestTimeoutMs", requestTimeoutMs],
      ["queueCapacity", queueCapacity],
      ["maxFrameBytes", maxFrameBytes],
      ["maxOutboundFrameBytes", maxOutboundFrameBytes],
      ["maxStderrBytes", maxStderrBytes]
    ])

    const handle = yield* ChildProcess.make(options.command, options.args, {
      cwd: options.cwd,
      env: ChildProcessEnvironment.make(process.env, options.env),
      extendEnv: false,
      stdin: "pipe",
      stdout: "pipe",
      // Stderr is diagnostic only: a scoped drainer below retains at most the
      // configured byte tail, and stderr failure never fails the connection.
      stderr: "pipe"
    }).pipe(
      Effect.mapError((error) => {
        diagnostic("spawn", error.message)
        return new McpError({
          code: "spawn_failed",
          message: `Failed to start MCP server "${options.server}"; process details withheld`,
          server: options.server
        })
      })
    )

    // Stderr is redacted a whole line at a time as it arrives, and only the
    // redacted text is capped. Capping raw bytes first could cut a
    // credential's recognizable prefix and leave its remainder unredacted.
    const stderrState = yield* Ref.make<StderrTail>(emptyStderrTail)
    const stderrDecoder = new TextDecoder()
    const stderrDrainer = yield* handle.stderr.pipe(
      Stream.runForEach((chunk) =>
        Ref.update(
          stderrState,
          (current) => appendStderr(current, stderrDecoder.decode(chunk, { stream: true }), maxStderrBytes)
        )
      ),
      Effect.ignore,
      Effect.forkScoped
    )

    const withStderr = (error: McpError): Effect.Effect<McpError> => {
      if (!diagnosticErrorCodes.has(error.code)) return Effect.succeed(error)
      return Effect.map(Ref.get(stderrState), (current) => {
        const rendered = renderStderr(current, maxStderrBytes)
        if (rendered !== "") diagnostic("stderr", rendered)
        return rendered === ""
          ? error
          : new McpError({
            code: error.code,
            message: `${error.message} (stderr diagnostic withheld)`,
            server: error.server
          })
      })
    }

    const nextId = yield* Ref.make(0)
    const outbound = yield* Queue.bounded<OutboundFrame>(queueCapacity)
    const terminalError = yield* Deferred.make<McpError>()
    const state = yield* Ref.make<ConnectionState>({ _tag: "Open", pending: HashMap.empty() })

    // Define these before starting the reader: a server can send a request
    // immediately on connection, before our first outbound request exists.
    const enqueue = (frame: OutboundFrame): Effect.Effect<void, McpError> =>
      Effect.flatMap(Queue.offer(outbound, frame), (offered) =>
        offered
          ? Effect.void
          : Effect.flatMap(Deferred.await(terminalError), Effect.fail))

    const frameOf = (method: string, message: Rpc.OutboundMessage): Effect.Effect<Uint8Array, McpError> =>
      Effect.try({
        try: () => Rpc.encode(message),
        catch: () =>
          Limits.protocolError(options.server, `MCP server "${options.server}" could not encode a ${method} frame`)
      }).pipe(
        Effect.flatMap((frame) =>
          frame.byteLength <= maxOutboundFrameBytes
            ? Effect.succeed(frame)
            : Effect.fail(
              Limits.protocolError(
                options.server,
                `MCP server "${options.server}" tried to send a ${method} frame larger than ${maxOutboundFrameBytes} bytes`
              )
            )
        )
      )

    /** Closes once, fails every waiter, and rejects all future traffic. */
    const closeWith = (baseError: McpError, drainStderr = true) =>
      Effect.uninterruptible(Effect.gen(function*() {
        const waiters = yield* Ref.modify(state, (current) =>
          current._tag === "Closed"
            ? [undefined, current] as const
            : [Array.from(HashMap.values(current.pending)), { _tag: "Closed", error: terminalError }] as const)
        if (waiters === undefined) return
        // Stop admission immediately. Pending requests and blocked/new offers
        // share the terminal result, so none can tear down the stderr reader
        // merely because a different process signal won the close race.
        yield* Queue.shutdown(outbound)
        yield* (drainStderr && diagnosticErrorCodes.has(baseError.code)
          ? Fiber.await(stderrDrainer).pipe(
            Effect.asVoid,
            Effect.timeoutOrElse({ duration: terminalStderrDrainMs, orElse: () => Effect.void }),
            Effect.interruptible
          )
          : Effect.void).pipe(Effect.ensuring(Effect.gen(function*() {
            // Even interruption while draining settles every waiter. Awaiting
            // the drainer's fiber does not interrupt that fiber on timeout.
            const error = yield* withStderr(baseError)
            yield* Deferred.succeed(terminalError, error)
            yield* Effect.forEach(waiters, (pending) => Deferred.fail(pending.deferred, error), {
              discard: true
            })
          })))
      }))

    // Writer: drains outbound frames into the process's stdin for the life of
    // the connection scope. A write failure is the same "connection is gone"
    // fact the reader loop reports, so it collapses pending requests too.
    // Pull one record at a time: batching would mark later records dispatched
    // while an earlier stdin write is still blocked. Check and mark without a
    // yield so request cleanup cannot interleave with the dispatch decision.
    yield* Stream.fromEffectRepeat(Queue.take(outbound)).pipe(
      Stream.filter((record) => {
        if (record.request === undefined) return true
        if (record.request.cancelled) return false
        record.request.dispatched = true
        return true
      }),
      Stream.map((record) => record.frame),
      Stream.run(handle.stdin),
      Effect.onExit((exit) => closeWith(closed(options.server, "stdin closed"), !Exit.hasInterrupts(exit))),
      Effect.forkScoped
    )

    // Reader: one line of stdout is one JSON-RPC message. A validated reply
    // resolves its pending request by id; malformed tagged messages close the
    // whole connection, while stdout noise, notifications, and unknown ids drop.
    yield* frames(options.server, maxFrameBytes, handle.stdout).pipe(
      Stream.runForEach((line) =>
        Effect.gen(function*() {
          const message = Rpc.parse(line)
          if (message === undefined) return
          const jsonIssue = JsonLimits.checkParsed(message)
          if (jsonIssue !== undefined) {
            return yield* Effect.fail(
              Limits.protocolError(options.server, `MCP server "${options.server}" sent invalid JSON: ${jsonIssue}`)
            )
          }
          const reply = Rpc.classify(message)
          if (reply._tag === "Notification") return
          if (reply._tag === "Request") {
            const response: Rpc.OutboundMessage = reply.method === "ping"
              ? { jsonrpc: "2.0", id: reply.id, result: {} }
              : { jsonrpc: "2.0", id: reply.id, error: { code: -32_601, message: "Method not found" } }
            // Opposite-direction ids are independent, even when they equal an
            // active tool request's id. Responses share the bounded writer and
            // size guard, never creating another pending request of our own.
            return yield* frameOf("server-response", response).pipe(
              Effect.flatMap((frame) => enqueue({ frame })),
              Effect.timeoutOrElse({
                duration: requestTimeoutMs,
                orElse: () => Effect.fail(timeout(options.server, "server-response admission", requestTimeoutMs))
              })
            )
          }
          if (reply._tag === "Malformed") {
            return yield* Effect.fail(
              Limits.protocolError(
                options.server,
                `MCP server "${options.server}" sent a malformed JSON-RPC reply: ${reply.reason}`
              )
            )
          }
          if (reply._tag === "UncorrelatedError") {
            diagnostic("remote-error", { code: reply.code, message: reply.message, data: reply.data })
            return
          }
          const pending = yield* Ref.modify(state, (current) => {
            if (current._tag === "Closed") return [Option.none<Pending>(), current] as const
            return [
              HashMap.get(current.pending, reply.id),
              { ...current, pending: HashMap.remove(current.pending, reply.id) }
            ] as const
          })
          if (Option.isNone(pending)) return
          if (reply._tag === "Error") {
            diagnostic("remote-error", { code: reply.code, message: reply.message, data: reply.data })
            yield* Deferred.fail(
              pending.value.deferred,
              replyError(options.server, pending.value.method, reply)
            )
          } else {
            yield* Deferred.succeed(pending.value.deferred, reply.result)
          }
        })
      ),
      Effect.matchEffect({
        onFailure: (error) =>
          closeWith(
            error instanceof McpError ? error : closed(options.server, "stdout failed")
          ),
        // A clean EOF is still a closed MCP connection. Node reports an
        // ordinary child exit by ending stdout successfully.
        onSuccess: () => closeWith(closed(options.server, "stdout closed"))
      }),
      Effect.forkScoped
    )

    // Some process implementations expose exit before stdout observes EOF.
    // Treat either signal as the same terminal transition.
    yield* handle.exitCode.pipe(
      Effect.flatMap((exitCode) => closeWith(closed(options.server, `exited with code ${exitCode}`))),
      Effect.catch(() => closeWith(closed(options.server, "process exited"))),
      Effect.forkScoped
    )

    // Finalizers run in reverse order. Record scope closure before interrupting
    // the I/O fibers, whose cleanup must not replace it with "stdin closed".
    // Scope closure also tears down the child, so no cancellation is needed.
    yield* Effect.addFinalizer(() => closeWith(closed(options.server, "connection scope closed"), false))

    const takePending = (id: number): Effect.Effect<boolean> =>
      Ref.modify(state, (current) => {
        if (current._tag === "Closed") return [false, current]
        const present = HashMap.has(current.pending, id)
        return [present, { ...current, pending: HashMap.remove(current.pending, id) }]
      })

    const request = (
      method: string,
      params?: unknown,
      timeoutMs = requestTimeoutMs
    ): Effect.Effect<unknown, McpError> =>
      Effect.gen(function*() {
        if (!Limits.isPositiveInteger(timeoutMs)) {
          return yield* Effect.fail(
            Limits.protocolError(options.server, "MCP request timeout must be a positive integer")
          )
        }
        const id = yield* Ref.updateAndGet(nextId, (n) => n + 1)
        const deferred = yield* Deferred.make<unknown, McpError>()
        const frame = yield* frameOf(method, { jsonrpc: "2.0", id, method, params })
        const requestState = { id, cancelled: false, dispatched: false }
        return yield* Effect.gen(function*() {
          const registration = yield* Ref.modify(state, (current) =>
            current._tag === "Closed"
              ? [current.error, current] as const
              : [undefined, {
                ...current,
                pending: HashMap.set(current.pending, id, { deferred, method })
              }] as const)
          if (registration !== undefined) return yield* Effect.flatMap(Deferred.await(registration), Effect.fail)
          yield* enqueue({ frame, request: requestState })
          return yield* Deferred.await(deferred)
        }).pipe(
          Effect.ensuring(Effect.gen(function*() {
            requestState.cancelled = true
            const pending = yield* takePending(id)
            if (!requestState.dispatched || !pending || method === "initialize") return
            yield* frameOf("notifications/cancelled", {
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: requestState.id, reason: cancellationReason }
            }).pipe(
              // Best-effort cancellation cannot delay the deadline it reports.
              Effect.flatMap((frame) => Effect.sync(() => Queue.offerUnsafe(outbound, { frame }))),
              Effect.ignore
            )
          })),
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => Effect.flatMap(withStderr(timeout(options.server, method, timeoutMs)), Effect.fail)
          })
        )
      })

    const notify = (
      method: string,
      params?: unknown,
      timeoutMs = requestTimeoutMs
    ): Effect.Effect<void, McpError> => {
      if (!Limits.isPositiveInteger(timeoutMs)) {
        return Effect.fail(Limits.protocolError(options.server, "MCP notification timeout must be a positive integer"))
      }
      return Effect.gen(function*() {
        const current = yield* Ref.get(state)
        if (current._tag === "Closed") return yield* Effect.flatMap(Deferred.await(current.error), Effect.fail)
        const frame = yield* frameOf(method, { jsonrpc: "2.0", method, params })
        yield* enqueue({ frame })
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.flatMap(withStderr(timeout(options.server, method, timeoutMs)), Effect.fail)
        })
      )
    }

    return { request, notify }
  })
