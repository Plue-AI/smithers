/**
 * Host-backed Language Server Protocol client over the permission-checked
 * process spawner.
 *
 * LSP is framed JSON-RPC over ordinary stdio pipes, so the client spawns
 * through `@smthrs/kernel`'s `ChildProcessSpawner`; a terminal is never
 * involved.
 *
 * @since 1.0.0
 */

import * as ChildProcessEnvironment from "@smthrs/kernel/ChildProcessEnvironment"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Deferred, Effect, Fiber, Layer, Option, Queue, type Scope, Semaphore, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import { pathToFileURL } from "node:url"
import * as LanguageServer from "./LanguageServer.ts"
import * as StdError from "./StdError.ts"

/**
 * Maximum frames buffered for a language server's standard input.
 *
 * Bounded offers apply backpressure, and each offer uses the request timeout
 * so a server that stops reading produces a typed timeout instead of an
 * unbounded queue or a new hang.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_QUEUED_FRAMES = 256

/**
 * Maximum concurrent JSON-RPC requests awaiting a response.
 *
 * Every entry already has a timeout, and process exit or stdout closure fails
 * all entries. This cap is the last-resort bound for a host that fans out
 * requests without limit.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_PENDING_REQUESTS = 512

const DEFAULT_SETTLE_MS = 5_000

/**
 * One host language-server process.
 *
 * Response headers may contain at most 8 KiB, and response bodies may contain
 * at most 8 MiB.
 *
 * @category models
 * @since 1.0.0
 */
export interface Config {
  /**
   * The file extensions this server answers for, such as `[".ts", ".tsx"]`.
   * A server without `extensions` answers every file no other server claims.
   */
  readonly extensions?: ReadonlyArray<string> | undefined
  readonly command: string
  readonly args?: ReadonlyArray<string> | undefined
  readonly cwd: string
  readonly environment?: Readonly<Record<string, string>> | undefined
  /**
   * Sent as `initializationOptions` on `initialize`. A host pins where the
   * server loads its own code from here, for example
   * `{ tsserver: { path: "<host copy>/tsserver.js" } }` for
   * typescript-language-server, which otherwise runs the workspace's own
   * `node_modules/typescript`.
   */
  readonly initializationOptions?: unknown
  readonly timeoutMs?: number | undefined
  /**
   * How long `diagnostics` waits for a server without pull diagnostics to
   * publish for the latest synced text. Defaults to 5 seconds.
   */
  readonly settleMs?: number | undefined
}

interface JsonRpcMessage {
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: unknown
}

/** JSON-RPC's code for a method the server does not implement. */
const METHOD_NOT_FOUND = -32601

const LANGUAGE_IDS: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".rb": "ruby",
  ".sh": "shellscript",
  ".md": "markdown",
  ".yml": "yaml",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp"
}

const extensionOf = (path: string): string => NodePath.extname(path).toLowerCase()

const languageId = (path: string): string => {
  const extension = extensionOf(path)
  return LANGUAGE_IDS[extension] ?? (extension.slice(1) || "plaintext")
}

interface FrameDecoder {
  readonly push: (chunk: Uint8Array) => ReadonlyArray<FrameEvent>
}

type FrameEvent =
  | { readonly _tag: "Message"; readonly value: unknown }
  | { readonly _tag: "Failure"; readonly error: StdError.StdError; readonly id?: number | undefined }

const failure = (code: StdError.Code, message: string): StdError.StdError => new StdError.StdError({ code, message })

const maximumHeaderBytes = 8 * 1024
const maximumFrameBytes = 8 * 1024 * 1024
const headerEnd = new Uint8Array([13, 10, 13, 10])
const contentLengthPrefix = new TextEncoder().encode("Content-Length:")

const concatenate = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const combined = new Uint8Array(left.length + right.length)
  combined.set(left)
  combined.set(right, left.length)
  return combined
}

interface ChunkBuffer {
  readonly length: number
  readonly push: (chunk: Uint8Array) => void
  readonly indexOf: (needle: Uint8Array) => number
  readonly take: (length: number) => Uint8Array
  readonly discard: (length: number) => void
}

const makeChunkBuffer = (): ChunkBuffer => {
  let chunks: Array<Uint8Array> = []
  let head = 0
  let headOffset = 0
  let length = 0

  const compact = (): void => {
    if (head === chunks.length) {
      chunks = []
      head = 0
      headOffset = 0
    } else if (head >= 64 && head * 2 >= chunks.length) {
      chunks = chunks.slice(head)
      head = 0
    }
  }

  const consume = (count: number, output?: Uint8Array): void => {
    let remaining = count
    let outputOffset = 0
    while (remaining > 0) {
      const chunk = chunks[head]
      if (chunk === undefined) throw new RangeError("Chunk buffer underflow")
      const available = chunk.byteLength - headOffset
      const consumed = Math.min(available, remaining)
      if (output !== undefined) {
        output.set(chunk.subarray(headOffset, headOffset + consumed), outputOffset)
        outputOffset += consumed
      }
      headOffset += consumed
      length -= consumed
      remaining -= consumed
      if (headOffset === chunk.byteLength) {
        head++
        headOffset = 0
      }
    }
    compact()
  }

  return {
    get length() {
      return length
    },
    push: (chunk) => {
      if (chunk.byteLength === 0) return
      chunks.push(chunk)
      length += chunk.byteLength
    },
    indexOf: (needle) => {
      let absolute = 0
      let matched = 0
      for (let chunkIndex = head; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex]
        if (chunk === undefined) continue
        const start = chunkIndex === head ? headOffset : 0
        for (let index = start; index < chunk.byteLength; index++) {
          const byte = chunk[index]
          if (byte === needle[matched]) matched++
          else matched = byte === needle[0] ? 1 : 0
          if (matched === needle.byteLength) return absolute - needle.byteLength + 1
          absolute++
        }
      }
      return -1
    },
    take: (count) => {
      if (count < 0 || count > length) throw new RangeError("Chunk buffer underflow")
      const output = new Uint8Array(count)
      consume(count, output)
      return output
    },
    discard: (count) => {
      if (count < 0 || count > length) throw new RangeError("Chunk buffer underflow")
      consume(count)
    }
  }
}

const malformedId = (body: string): number | undefined => {
  const match = /"id"\s*:\s*(\d+)/.exec(body)
  if (match === null) return undefined
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : undefined
}

const makeFrameDecoder = (): FrameDecoder => {
  const pending = makeChunkBuffer()
  let bodyLength: number | undefined
  let resynchronizing = false
  return {
    push: (chunk) => {
      pending.push(chunk)
      const events: Array<FrameEvent> = []
      while (pending.length > 0 || bodyLength === 0) {
        if (resynchronizing) {
          const nextHeader = pending.indexOf(contentLengthPrefix)
          if (nextHeader < 0) {
            pending.discard(Math.max(0, pending.length - contentLengthPrefix.byteLength + 1))
            break
          }
          pending.discard(nextHeader)
          resynchronizing = false
        }
        if (bodyLength !== undefined) {
          if (pending.length < bodyLength) break
          const body = new TextDecoder().decode(pending.take(bodyLength))
          bodyLength = undefined
          try {
            events.push({ _tag: "Message", value: JSON.parse(body) as unknown })
          } catch {
            events.push({
              _tag: "Failure",
              error: failure("request_failed", "Language server returned malformed JSON"),
              id: malformedId(body)
            })
          }
          continue
        }
        const delimiter = pending.indexOf(headerEnd)
        if (delimiter < 0) {
          if (pending.length > maximumHeaderBytes) {
            events.push({
              _tag: "Failure",
              error: failure(
                "request_failed",
                `Language server frame header exceeded ${maximumHeaderBytes} bytes`
              )
            })
            pending.discard(1)
            resynchronizing = true
            continue
          }
          break
        }
        if (delimiter > maximumHeaderBytes) {
          events.push({
            _tag: "Failure",
            error: failure("request_failed", `Language server frame header exceeded ${maximumHeaderBytes} bytes`)
          })
          pending.discard(delimiter + headerEnd.byteLength)
          resynchronizing = true
          continue
        }
        const header = new TextDecoder().decode(pending.take(delimiter))
        pending.discard(headerEnd.byteLength)
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(header)
        if (match === null) {
          events.push({
            _tag: "Failure",
            error: failure("request_failed", "Language server frame omitted Content-Length")
          })
          resynchronizing = true
          continue
        }
        const length = Number(match[1])
        if (!Number.isSafeInteger(length) || length < 0 || length > maximumFrameBytes) {
          events.push({
            _tag: "Failure",
            error: failure("request_failed", `Language server frame exceeded ${maximumFrameBytes} bytes`)
          })
          resynchronizing = true
          continue
        }
        bodyLength = length
      }
      return events
    }
  }
}

const asMessage = (value: unknown): JsonRpcMessage | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined

const frame = (message: unknown): Uint8Array => {
  const body = new TextEncoder().encode(JSON.stringify(message))
  const header = new TextEncoder().encode(`Content-Length: ${body.byteLength}\r\n\r\n`)
  return concatenate(header, body)
}

const firstCallHierarchyItem = (value: unknown): unknown | undefined => Array.isArray(value) ? value[0] : undefined

const isFile = (path: string): boolean => {
  try {
    return NodeFs.statSync(path, { throwIfNoEntry: false })?.isFile() === true
  } catch {
    return false
  }
}

/** Whether anything, a file or a directory, exists at `path`. */
const exists = (path: string): boolean => {
  try {
    return NodeFs.statSync(path, { throwIfNoEntry: false }) !== undefined
  } catch {
    return false
  }
}

const realPath = (path: string): string => {
  try {
    return NodeFs.realpathSync(path)
  } catch {
    return NodePath.resolve(path)
  }
}

const isWithin = (root: string, path: string): boolean => {
  const relative = NodePath.relative(root, path)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative))
}

/**
 * Resolves the program a spawn would execute: a command containing a path
 * separator against `cwd`, a bare name through the child's `PATH`, where an
 * empty or relative entry is relative to `cwd`.
 */
const resolveCommand = (command: string, cwd: string, path: string | undefined): string | undefined => {
  if (command.includes("/") || command.includes(NodePath.sep)) {
    const candidate = NodePath.resolve(cwd, command)
    return isFile(candidate) ? candidate : undefined
  }
  for (const entry of (path ?? "").split(NodePath.delimiter)) {
    const candidate = NodePath.resolve(cwd, entry, command)
    if (!isFile(candidate)) continue
    try {
      NodeFs.accessSync(candidate, NodeFs.constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Refuses a server whose program or any file-naming argument lies in the
 * workspace. The server runs on the host as the host user, so a program the
 * workspace supplies (its `node_modules/.bin`, a `./` script, a symlink it
 * planted) would let workspace files choose what the host executes.
 */
/**
 * Programs whose job is to run another program named in their arguments or
 * found in the working directory: shells, `env`, and package runners. Their
 * arguments are code or package names, not files, so the workspace check below
 * cannot see what they would execute (`sh -c node_modules/.bin/x`, `npx x`).
 */
const LAUNCHERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "env",
  "npx",
  "pnpx",
  "npm",
  "pnpm",
  "yarn",
  "bunx",
  "deno",
  "cmd",
  "powershell",
  "pwsh"
])

/** Interpreter flags that take code or a module to load instead of a file path. */
const CODE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader"])

const launcher = (config: Config): string | undefined => {
  const name = NodePath.basename(config.command).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, "")
  if (LAUNCHERS.has(name)) return name
  if (name !== "node" && name !== "bun" && name !== "nodejs") return undefined
  const args = config.args ?? []
  if (name === "bun" && ["x", "run", "exec"].includes(args[0] ?? "")) return `bun ${args[0]}`
  const flag = args.find((argument) => CODE_FLAGS.has(argument.split("=")[0]!) || argument === "--experimental-loader")
  return flag === undefined ? undefined : `${name} ${flag.split("=")[0]}`
}

const workspaceProgram = (
  config: Config,
  path: string | undefined
): StdError.StdError | undefined => {
  const launching = launcher(config)
  if (launching !== undefined) {
    return failure(
      "permission_denied",
      `Language server command runs ${launching}, which executes a program its arguments or the workspace choose; name the server's own host binary instead`
    )
  }
  const lexicalRoot = NodePath.resolve(config.cwd)
  const realRoot = realPath(lexicalRoot)
  const inWorkspace = (file: string): boolean =>
    isWithin(lexicalRoot, file) || isWithin(realRoot, file) || isWithin(realRoot, realPath(file)) ||
    isWithin(lexicalRoot, realPath(file))
  const program = resolveCommand(config.command, lexicalRoot, path)
  if (program !== undefined && inWorkspace(program)) {
    return failure(
      "permission_denied",
      `Language server program ${program} is inside the workspace ${lexicalRoot}; run a host copy instead`
    )
  }
  for (const argument of config.args ?? []) {
    for (const value of [argument, argument.slice(argument.indexOf("=") + 1)]) {
      if (value === "") continue
      const candidate = NodePath.resolve(lexicalRoot, value)
      // A directory counts: `node <dir>` runs `<dir>/index.js` or its package main.
      if (exists(candidate) && inWorkspace(candidate)) {
        return failure(
          "permission_denied",
          `Language server argument names ${candidate}, a path inside the workspace ${lexicalRoot}`
        )
      }
    }
  }
  return undefined
}

interface PublishedDiagnostics {
  readonly version: number | undefined
  readonly sequence: number
  readonly diagnostics: ReadonlyArray<unknown>
}

interface OpenDocument {
  readonly version: number
  /** The publish sequence number when this version was sent. */
  readonly sentAt: number
}

const makeClient = (
  config: Config
): Effect.Effect<
  LanguageServer.LanguageServer,
  StdError.StdError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const timeoutMs = config.timeoutMs ?? 30_000
    const settleMs = config.settleMs ?? DEFAULT_SETTLE_MS
    const env = ChildProcessEnvironment.make(process.env, config.environment)
    const refused = yield* Effect.sync(() => workspaceProgram(config, env.PATH))
    if (refused !== undefined) return yield* Effect.fail(refused)
    // The process's stdin is fed from this queue for the client's lifetime, so
    // each request is one offered frame and the pipe never closes between them.
    const input = yield* Queue.bounded<Uint8Array>(MAX_QUEUED_FRAMES)
    const handle = yield* spawner.spawn(
      ChildProcess.make(config.command, config.args ?? [], {
        cwd: config.cwd,
        env,
        extendEnv: false,
        stdin: { stream: Stream.fromQueue(input), endOnDone: false }
      })
    ).pipe(
      Effect.mapError((error) =>
        failure("provider_unavailable", `Language server process could not be started: ${error.message}`)
      )
    )
    const pending = new Map<number, Deferred.Deferred<unknown, StdError.StdError>>()
    const decoder = makeFrameDecoder()
    let nextId = 1
    let terminalError: StdError.StdError | undefined

    // Keep draining stderr while requests run. Copy retained bytes so a small
    // tail never holds a larger backing buffer alive.
    const maximumStderrBytes = 64 * 1024
    let stderrTail: Uint8Array = new Uint8Array(0)
    const stderrFiber = yield* handle.stderr.pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          stderrTail = chunk.byteLength >= maximumStderrBytes
            ? chunk.slice(-maximumStderrBytes)
            : concatenate(
              stderrTail.slice(Math.max(0, stderrTail.byteLength + chunk.byteLength - maximumStderrBytes)),
              chunk
            )
        })
      ),
      Effect.catch((cause) => Effect.logWarning("Language server stderr stream failed", cause)),
      Effect.forkScoped({ startImmediately: true })
    )
    const stderr = (): string => {
      let start = 0
      while (start < stderrTail.byteLength && start < 3 && (stderrTail[start]! & 0b1100_0000) === 0b1000_0000) start++
      return new TextDecoder().decode(stderrTail.subarray(start))
    }

    const failPending = (error: StdError.StdError): Effect.Effect<void> =>
      Effect.flatMap(
        Effect.sync(() => {
          const deferreds = [...pending.values()]
          pending.clear()
          return deferreds
        }),
        (deferreds) => Effect.forEach(deferreds, (deferred) => Deferred.fail(deferred, error), { discard: true })
      )

    const failRequest = (id: number, error: StdError.StdError): Effect.Effect<void> => {
      const deferred = pending.get(id)
      if (deferred === undefined) return Effect.void
      pending.delete(id)
      return Deferred.fail(deferred, error).pipe(Effect.asVoid)
    }

    const closeWith = (error: StdError.StdError): Effect.Effect<void> =>
      Effect.gen(function*() {
        // stdout EOF and process exit can arrive before the last stderr chunk.
        // A bounded grace also handles servers that close stdout but stay alive.
        yield* Fiber.await(stderrFiber).pipe(Effect.timeoutOption(100))
        terminalError ??= error
        yield* failPending(terminalError)
      })

    const uriOf = (path: string): string => pathToFileURL(NodePath.resolve(config.cwd, path)).href
    const documents = new Map<string, OpenDocument>()
    // Versions keep climbing across a close and reopen, so a late publish for
    // the closed text never passes for the reopened one.
    const versions = new Map<string, number>()
    const published = new Map<string, PublishedDiagnostics>()
    const listeners = new Map<string, Set<Deferred.Deferred<void>>>()
    let publishSequence = 0
    let pullUnsupported = false

    const publish = (params: unknown): Effect.Effect<void> => {
      const notification = asMessage(params) as {
        readonly uri?: unknown
        readonly version?: unknown
        readonly diagnostics?: unknown
      } | undefined
      if (typeof notification?.uri !== "string" || !Array.isArray(notification.diagnostics)) return Effect.void
      const uri = notification.uri
      const version = typeof notification.version === "number" ? notification.version : undefined
      const previous = published.get(uri)?.version
      // A late publish for an older version never replaces a newer one.
      if (version !== undefined && previous !== undefined && version < previous) return Effect.void
      published.set(uri, {
        version,
        sequence: ++publishSequence,
        diagnostics: notification.diagnostics
      })
      const waiting = listeners.get(uri)
      if (waiting === undefined) return Effect.void
      listeners.delete(uri)
      return Effect.forEach(waiting, (listener) => Deferred.succeed(listener, undefined), { discard: true })
    }

    const receive = (value: unknown): Effect.Effect<void> => {
      const message = asMessage(value)
      if (message?.method === "textDocument/publishDiagnostics") return publish(message.params)
      if (message === undefined || typeof message.id !== "number") return Effect.void
      const deferred = pending.get(message.id)
      if (deferred === undefined) return Effect.void
      pending.delete(message.id)
      if (message.error === undefined) return Deferred.succeed(deferred, message.result)
      const error = asMessage(message.error) as {
        readonly code?: unknown
        readonly message?: unknown
        readonly data?: unknown
      } | undefined
      return Deferred.fail(
        deferred,
        new StdError.StdError({
          code: "request_failed",
          message: typeof error?.message === "string" ? error.message : "Language server returned a JSON-RPC error",
          ...(typeof error?.code === "number" && typeof error.message === "string"
            ? {
              rpcError: {
                code: error.code,
                message: error.message,
                ...(error.data === undefined ? {} : { data: error.data })
              }
            }
            : {})
        })
      )
    }

    const receiveFrame = (event: FrameEvent): Effect.Effect<void> =>
      event._tag === "Message"
        ? receive(event.value)
        // A rejected frame has no trustworthy response id. Failing every
        // waiter prevents another request from hanging behind corrupt framing.
        : event.id === undefined
        ? failPending(event.error)
        : failRequest(event.id, event.error)

    yield* handle.stdout.pipe(
      Stream.runForEach((chunk) => Effect.forEach(decoder.push(chunk), receiveFrame, { discard: true })),
      Effect.matchEffect({
        onFailure: () => closeWith(failure("request_failed", "Language server output stream failed")),
        onSuccess: () => closeWith(failure("request_failed", "Language server output stream closed"))
      }),
      Effect.forkScoped({ startImmediately: true })
    )

    yield* handle.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        closeWith(failure("request_failed", `Language server process exited with code ${exitCode}`))
      ),
      Effect.catch(() => closeWith(failure("request_failed", "Language server process exited"))),
      Effect.forkScoped({ startImmediately: true })
    )

    const send = (message: unknown): Effect.Effect<void, StdError.StdError> =>
      Effect.suspend(() =>
        terminalError === undefined
          ? Queue.offer(input, frame(message)).pipe(
            Effect.asVoid,
            Effect.timeout(timeoutMs),
            Effect.mapError((cause) =>
              cause instanceof StdError.StdError
                ? cause
                : failure(
                  "timeout",
                  `Language server stdin is not being drained; frame offer exceeded ${timeoutMs}ms`
                )
            )
          )
          : Effect.fail(terminalError)
      )

    const request = (
      method: string,
      params: unknown
    ): Effect.Effect<unknown, StdError.StdError> =>
      Effect.gen(function*() {
        const deferred = yield* Deferred.make<unknown, StdError.StdError>()
        const registered = yield* Effect.sync((): number | StdError.StdError => {
          if (terminalError !== undefined) return terminalError
          if (pending.size >= MAX_PENDING_REQUESTS) {
            return failure(
              "request_failed",
              `Language server reached the ${MAX_PENDING_REQUESTS} pending-request cap`
            )
          }
          const id = nextId++
          pending.set(id, deferred)
          return id
        })
        if (registered instanceof StdError.StdError) return yield* Effect.fail(registered)
        const id = registered
        return yield* Effect.gen(function*() {
          yield* send({ jsonrpc: "2.0", id, method, params })
          return yield* Deferred.await(deferred).pipe(
            Effect.timeout(timeoutMs),
            Effect.mapError((cause) =>
              cause instanceof StdError.StdError
                ? cause
                : failure("timeout", `Language server request timed out: ${method}`)
            )
          )
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              pending.delete(id)
            })
          )
        )
      }).pipe(Effect.mapError((error) =>
        new StdError.StdError({
          ...error,
          method,
          message: error.rpcError === undefined ? error.message : `${method}: ${error.message}`,
          ...(stderrTail.byteLength === 0 ? {} : { stderr: stderr() })
        })
      ))

    const notify = (method: string, params: unknown): Effect.Effect<void, StdError.StdError> =>
      send({ jsonrpc: "2.0", method, params })

    yield* request("initialize", {
      processId: null,
      rootUri: pathToFileURL(config.cwd).href,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false },
          publishDiagnostics: { versionSupport: true },
          diagnostic: { dynamicRegistration: false }
        }
      },
      ...(config.initializationOptions === undefined ? {} : { initializationOptions: config.initializationOptions })
    })
    yield* notify("initialized", {})

    const positionParams = (position: LanguageServer.Position) => ({
      textDocument: { uri: uriOf(position.path) },
      position: { line: position.line, character: position.character }
    })

    // One sync at a time, so versions reach the server in the order they are numbered.
    const syncLock = yield* Semaphore.make(1)
    const sync = (path: string, text: string): Effect.Effect<void, StdError.StdError> =>
      syncLock.withPermit(Effect.suspend(() => {
        const uri = uriOf(path)
        const open = documents.get(uri)
        const version = (versions.get(uri) ?? 0) + 1
        const sentAt = publishSequence
        const message = open === undefined
          ? notify("textDocument/didOpen", {
            textDocument: { uri, languageId: languageId(path), version, text }
          })
          : notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] })
        return message.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              versions.set(uri, version)
              documents.set(uri, { version, sentAt })
            })
          )
        )
      }))

    const close = (path: string): Effect.Effect<void, StdError.StdError> =>
      syncLock.withPermit(Effect.suspend(() => {
        const uri = uriOf(path)
        if (!documents.has(uri)) return Effect.void
        documents.delete(uri)
        published.delete(uri)
        return notify("textDocument/didClose", { textDocument: { uri } })
      }))

    /** What the server published for the document's latest synced text, if it has. */
    const current = (uri: string): PublishedDiagnostics | undefined => {
      const entry = published.get(uri)
      const open = documents.get(uri)
      if (entry === undefined || open === undefined) return undefined
      const fresh = entry.version === undefined ? entry.sequence > open.sentAt : entry.version >= open.version
      return fresh ? entry : undefined
    }

    const awaitPublished = (uri: string): Effect.Effect<PublishedDiagnostics> =>
      Effect.suspend(() => {
        const entry = current(uri)
        if (entry !== undefined) return Effect.succeed(entry)
        return Effect.flatMap(Deferred.make<void>(), (listener) => {
          const waiting = listeners.get(uri) ?? new Set()
          waiting.add(listener)
          listeners.set(uri, waiting)
          return Deferred.await(listener).pipe(
            Effect.ensuring(Effect.sync(() => {
              listeners.get(uri)?.delete(listener)
            })),
            Effect.flatMap(() => awaitPublished(uri))
          )
        })
      })

    const pushedDiagnostics = (path: string): Effect.Effect<unknown, StdError.StdError> =>
      Effect.gen(function*() {
        const uri = uriOf(path)
        if (!documents.has(uri)) {
          // A push-only server publishes only for open documents.
          const text = yield* Effect.try({
            try: () => NodeFs.readFileSync(NodePath.resolve(config.cwd, path), "utf8"),
            catch: () => new StdError.StdError({ code: "not_found", message: `File not found: ${path}`, path })
          })
          yield* sync(path, text)
        }
        const entry = yield* awaitPublished(uri).pipe(Effect.timeoutOption(settleMs))
        if (Option.isNone(entry)) {
          return yield* Effect.fail(
            new StdError.StdError({
              code: "timeout",
              message: `Language server published no diagnostics for ${path} within ${settleMs}ms`,
              method: "textDocument/publishDiagnostics",
              path
            })
          )
        }
        return { kind: "full", items: entry.value.diagnostics }
      })

    const diagnostics = (path: string): Effect.Effect<unknown, StdError.StdError> =>
      pullUnsupported
        ? pushedDiagnostics(path)
        : request("textDocument/diagnostic", { textDocument: { uri: uriOf(path) } }).pipe(
          Effect.catchIf(
            (error) => error.rpcError?.code === METHOD_NOT_FOUND,
            () => {
              pullUnsupported = true
              return pushedDiagnostics(path)
            }
          )
        )

    const prepareCallHierarchy = (position: LanguageServer.Position) =>
      request("textDocument/prepareCallHierarchy", positionParams(position))
    const callHierarchy = (
      method: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
      position: LanguageServer.Position
    ): Effect.Effect<unknown, StdError.StdError> =>
      prepareCallHierarchy(position).pipe(
        Effect.flatMap((prepared) => {
          const item = firstCallHierarchyItem(prepared)
          return item === undefined ? Effect.succeed([]) : request(method, { item })
        })
      )

    return LanguageServer.make({
      hover: (position) => request("textDocument/hover", positionParams(position)),
      definition: (position) => request("textDocument/definition", positionParams(position)),
      references: (position) =>
        request("textDocument/references", {
          ...positionParams(position),
          context: { includeDeclaration: true }
        }),
      implementation: (position) => request("textDocument/implementation", positionParams(position)),
      documentSymbols: (path) => request("textDocument/documentSymbol", { textDocument: { uri: uriOf(path) } }),
      workspaceSymbols: (query) => request("workspace/symbol", { query }),
      prepareCallHierarchy,
      callHierarchyIncoming: (position) => callHierarchy("callHierarchy/incomingCalls", position),
      callHierarchyOutgoing: (position) => callHierarchy("callHierarchy/outgoingCalls", position),
      diagnostics,
      sync,
      close
    })
  })

const normalizeExtension = (extension: string): string =>
  (extension.startsWith(".") ? extension : `.${extension}`).toLowerCase()

/**
 * Constructs scoped host language-server clients, one process per config, and
 * routes each file to the server whose `extensions` include its extension, or
 * else to the server that declares none. `workspaceSymbols` asks every server
 * and concatenates their answers.
 *
 * Every client opens a file on its first `sync` and sends the full text on
 * each later one. `diagnostics` pulls `textDocument/diagnostic`; a server that
 * answers `MethodNotFound` is read from its `textDocument/publishDiagnostics`
 * notifications instead, waiting up to `settleMs` for the latest synced text.
 *
 * Fails with `permission_denied`, before spawning, when the resolved program or
 * a file or directory named by an argument lies under `config.cwd`, or when the command is a
 * launcher (a shell, `env`, a package runner such as `npx` or `pnpm`, or `node`
 * and `bun` given inline code or a preload) whose arguments choose what runs.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  config: Config | ReadonlyArray<Config>
): Effect.Effect<
  LanguageServer.LanguageServer,
  StdError.StdError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function*() {
    const configs: ReadonlyArray<Config> = Array.isArray(config) ? config : [config as Config]
    if (configs.length === 0) {
      return yield* Effect.fail(failure("invalid_input", "At least one language server must be configured"))
    }
    const clients = yield* Effect.forEach(configs, makeClient)
    const claims = configs.map((entry) => entry.extensions?.map(normalizeExtension))
    const fallback = claims.findIndex((claimed) => claimed === undefined)
    const route = (path: string): Effect.Effect<LanguageServer.LanguageServer, StdError.StdError> => {
      const extension = extensionOf(path)
      const claimed = claims.findIndex((entry) => entry?.includes(extension) === true)
      const index = claimed >= 0 ? claimed : fallback
      return index >= 0
        ? Effect.succeed(clients[index]!)
        : Effect.fail(
          new StdError.StdError({
            code: "unsupported",
            message: `No language server is configured for ${extension || "extensionless"} files`,
            path
          })
        )
    }
    const byPosition = (
      method:
        | "hover"
        | "definition"
        | "references"
        | "implementation"
        | "prepareCallHierarchy"
        | "callHierarchyIncoming"
        | "callHierarchyOutgoing"
    ) =>
    (position: LanguageServer.Position) => Effect.flatMap(route(position.path), (client) => client[method](position))
    return LanguageServer.make({
      hover: byPosition("hover"),
      definition: byPosition("definition"),
      references: byPosition("references"),
      implementation: byPosition("implementation"),
      prepareCallHierarchy: byPosition("prepareCallHierarchy"),
      callHierarchyIncoming: byPosition("callHierarchyIncoming"),
      callHierarchyOutgoing: byPosition("callHierarchyOutgoing"),
      documentSymbols: (path) => Effect.flatMap(route(path), (client) => client.documentSymbols(path)),
      diagnostics: (path) => Effect.flatMap(route(path), (client) => client.diagnostics(path)),
      sync: (path, text) => Effect.flatMap(route(path), (client) => client.sync(path, text)),
      close: (path) => Effect.flatMap(route(path), (client) => client.close(path)),
      workspaceSymbols: (query) =>
        clients.length === 1 ?
          clients[0]!.workspaceSymbols(query) :
          Effect.forEach(clients, (client) => client.workspaceSymbols(query), { concurrency: "unbounded" }).pipe(
            Effect.map((answers) =>
              answers.flatMap((answer) => Array.isArray(answer) ? answer : answer == null ? [] : [answer])
            )
          )
    })
  })

/**
 * Provides a scoped host language-server implementation.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  config: Config | ReadonlyArray<Config>
): Layer.Layer<LanguageServer.LanguageServer, StdError.StdError, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(LanguageServer.LanguageServer, make(config))
