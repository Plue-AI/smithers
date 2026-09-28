import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Sink, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as LanguageServer from "../src/LanguageServer.ts"
import * as Lsp from "../src/Lsp.ts"
import * as NodeLanguageServer from "../src/NodeLanguageServer.ts"
import { hostScript } from "./hostScript.ts"
import { fileInfo } from "./TestLayers.ts"

const decodeFrame = (frame: Uint8Array): Readonly<Record<string, unknown>> => {
  const text = new TextDecoder().decode(frame)
  return JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4)) as Readonly<Record<string, unknown>>
}

const encodeFrame = (value: unknown): Uint8Array => {
  const body = new TextEncoder().encode(JSON.stringify(value))
  const header = new TextEncoder().encode(`Content-Length: ${body.byteLength}\r\n\r\n`)
  const frame = new Uint8Array(header.length + body.length)
  frame.set(header)
  frame.set(body, header.length)
  return frame
}

const malformedFrame = (body: string): Uint8Array => {
  const bytes = new TextEncoder().encode(body)
  const header = new TextEncoder().encode(`Content-Length: ${bytes.byteLength}\r\n\r\n`)
  const frame = new Uint8Array(header.length + bytes.length)
  frame.set(header)
  frame.set(bytes, header.length)
  return frame
}

const failure = <A>(exit: Exit.Exit<A, unknown>): { readonly code: unknown; readonly message: unknown } | undefined => {
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons.find(Cause.isFailReason)
  if (reason === undefined || typeof reason.error !== "object" || reason.error === null) return undefined
  const record = reason.error as { readonly code?: unknown; readonly message?: unknown }
  return { code: record.code, message: record.message }
}

const respond = (
  output: Queue.Queue<Uint8Array, Cause.Done>,
  value: unknown
): Effect.Effect<void, Cause.Done> => Queue.offer(output, encodeFrame(value)).pipe(Effect.asVoid)

const scriptedSpawner = (
  responder: (
    request: Readonly<Record<string, unknown>>,
    output: Queue.Queue<Uint8Array, Cause.Done>
  ) => Effect.Effect<void, Cause.Done>,
  exitCode: Effect.Effect<ExitCode> = Effect.never
) =>
  ChildProcessSpawner.makeNoop({
    spawn: (command) =>
      Effect.gen(function*() {
        const standard = command as ChildProcess.StandardCommand
        const stdinConfig = standard.options.stdin as ChildProcess.StdinConfig
        const stdin = stdinConfig.stream as Stream.Stream<Uint8Array>
        const output = yield* Queue.unbounded<Uint8Array, Cause.Done>()
        yield* stdin.pipe(
          Stream.runForEach((bytes) => responder(decodeFrame(bytes), output)),
          Effect.forkScoped({ startImmediately: true })
        )
        return makeHandle({
          pid: ProcessId(1),
          exitCode,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.fromQueue(output),
          stderr: Stream.empty,
          all: Stream.fromQueue(output),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
  })

/**
 * The transport cases below run a scripted process and assert the failure the
 * transport itself raises, so the request deadline is set far above any of them
 * rather than at a few milliseconds: a short deadline races the failure it is
 * meant to leave alone, and on a loaded machine the deadline wins and the case
 * reports `timeout` for a frame that was refused correctly. A regression still
 * fails the case, just slower.
 */
describe("NodeLanguageServer", () => {
  it("spawns through the protected spawner and performs framed JSON-RPC requests", async () => {
    const requests: Array<Readonly<Record<string, unknown>>> = []
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const spawner = ChildProcessSpawner.makeNoop({
            spawn: (command) =>
              Effect.gen(function*() {
                const standard = command as ChildProcess.StandardCommand
                expect(standard.command).toBe("typescript-language-server")
                expect(standard.args).toEqual(["--stdio"])
                expect(standard.options.cwd).toBe("/workspace")
                const stdinConfig = standard.options.stdin as ChildProcess.StdinConfig
                expect(Stream.isStream(stdinConfig.stream)).toBe(true)
                expect(stdinConfig.endOnDone).toBe(false)
                const stdin = stdinConfig.stream as Stream.Stream<Uint8Array>
                const output = yield* Queue.unbounded<Uint8Array>()
                yield* stdin.pipe(
                  Stream.runForEach((bytes) => {
                    const request = decodeFrame(bytes)
                    requests.push(request)
                    if (typeof request.id !== "number") return Effect.void
                    const response = request.method === "textDocument/hover"
                      ? { jsonrpc: "2.0", id: request.id, result: { contents: "hover result" } }
                      : { jsonrpc: "2.0", id: request.id, result: { capabilities: {} } }
                    return Queue.offer(output, encodeFrame(response)).pipe(Effect.asVoid)
                  }),
                  Effect.forkScoped({ startImmediately: true })
                )
                return makeHandle({
                  pid: ProcessId(1),
                  exitCode: Effect.never,
                  isRunning: Effect.succeed(true),
                  kill: () => Effect.void,
                  stdin: Sink.drain,
                  stdout: Stream.fromQueue(output),
                  stderr: Stream.empty,
                  all: Stream.fromQueue(output),
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                  unref: Effect.succeed(Effect.void)
                })
              })
          })
          const server = yield* NodeLanguageServer.make({
            command: "typescript-language-server",
            args: ["--stdio"],
            cwd: "/workspace"
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
          return yield* Lsp.run({
            operation: "hover",
            path: "/workspace/a.ts",
            line: 2,
            character: 3
          }).pipe(
            Effect.provideService(LanguageServer.LanguageServer, server),
            Effect.provide(FileSystem.layerNoop({ stat: () => Effect.succeed(fileInfo()) }))
          )
        })
      )
    )
    expect(result.result).toEqual({ contents: "hover result" })
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "textDocument/hover"
    ])
    expect(requests[2]?.params).toMatchObject({
      position: { line: 1, character: 2 }
    })
  })

  it("decodes a multibyte response fragmented across individual bytes", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const spawner = scriptedSpawner((request, output) => {
        const response = request.method === "textDocument/hover"
          ? { jsonrpc: "2.0", id: request.id, result: { contents: "héllo 😀" } }
          : { jsonrpc: "2.0", id: request.id, result: { capabilities: {} } }
        const bytes = encodeFrame(response)
        return Effect.forEach(
          Array.from(bytes, (_, index) => bytes.slice(index, index + 1)),
          (chunk) => Queue.offer(output, chunk),
          { discard: true }
        )
      })
      const server = yield* NodeLanguageServer.make({
        command: "language-server",
        cwd: "/workspace"
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      return yield* server.hover({ path: "/workspace/a.ts", line: 0, character: 0 })
    })))
    expect(result).toEqual({ contents: "héllo 😀" })
  })

  it("rejects a header that exceeds 8 KiB without a delimiter", async () => {
    const unterminated = new Uint8Array(8 * 1024 + 1).fill(120)
    unterminated.set(new TextEncoder().encode("Content-Length: 2\r\n"))
    const spawner = scriptedSpawner((_request, output) => Queue.offer(output, unterminated).pipe(Effect.asVoid))
    const exit = await Effect.runPromise(Effect.exit(Effect.scoped(
      NodeLanguageServer.make({ command: "language-server", cwd: "/workspace", timeoutMs: 10_000 }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
      )
    )))
    expect(failure(exit)).toEqual({
      code: "request_failed",
      message: "Language server frame header exceeded 8192 bytes"
    })
  })

  it("rejects an oversized frame and resynchronizes at the next header", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const spawner = scriptedSpawner((request, output) => {
        if (request.method === "initialize") {
          return respond(output, { jsonrpc: "2.0", id: request.id, result: { capabilities: {} } })
        }
        if (request.method === "textDocument/hover") {
          return Queue.offer(
            output,
            new TextEncoder().encode(`Content-Length: ${8 * 1024 * 1024 + 1}\r\n\r\n`)
          ).pipe(Effect.asVoid)
        }
        return respond(output, { jsonrpc: "2.0", id: request.id, result: [{ uri: "file:///workspace/a.ts" }] })
      })
      const server = yield* NodeLanguageServer.make({
        command: "language-server",
        cwd: "/workspace",
        timeoutMs: 10_000
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      const oversized = yield* Effect.exit(server.hover({ path: "/workspace/a.ts", line: 0, character: 0 }))
      const definition = yield* server.definition({ path: "/workspace/a.ts", line: 0, character: 0 })
      return { definition, oversized }
    })))
    expect(failure(result.oversized)?.code).toBe("request_failed")
    expect(result.definition).toEqual([{ uri: "file:///workspace/a.ts" }])
  })

  it("fails malformed JSON without waiting for the request timeout", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const spawner = scriptedSpawner((request, output) =>
        request.method === "initialize"
          ? respond(output, { jsonrpc: "2.0", id: request.id, result: { capabilities: {} } })
          : Queue.offer(output, malformedFrame(`{"jsonrpc":"2.0","id":${String(request.id)},`)).pipe(Effect.asVoid)
      )
      const server = yield* NodeLanguageServer.make({
        command: "language-server",
        cwd: "/workspace",
        timeoutMs: 10_000
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      return yield* Effect.exit(server.hover({ path: "/workspace/a.ts", line: 0, character: 0 }))
    })))
    expect(failure(result)?.code).toBe("request_failed")
  })

  it("fails an outstanding request when stdout closes", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const spawner = scriptedSpawner((request, output) =>
        request.method === "initialize"
          ? respond(output, { jsonrpc: "2.0", id: request.id, result: { capabilities: {} } })
          : Queue.end(output)
      )
      const server = yield* NodeLanguageServer.make({
        command: "language-server",
        cwd: "/workspace",
        timeoutMs: 10_000
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      return yield* Effect.exit(server.hover({ path: "/workspace/a.ts", line: 0, character: 0 }))
    })))
    expect(failure(result)?.code).toBe("request_failed")
  })

  it("fails every outstanding request when the process exits", async () => {
    const exits = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const terminated = yield* Deferred.make<ExitCode>()
      let requests = 0
      const spawner = scriptedSpawner(
        (request, output) => {
          if (request.method === "initialize") {
            return respond(output, { jsonrpc: "2.0", id: request.id, result: { capabilities: {} } })
          }
          requests++
          return requests === 2 ? Deferred.succeed(terminated, ExitCode(17)).pipe(Effect.asVoid) : Effect.void
        },
        Deferred.await(terminated)
      )
      const server = yield* NodeLanguageServer.make({
        command: "language-server",
        cwd: "/workspace",
        timeoutMs: 10_000
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      const position = { path: "/workspace/a.ts", line: 0, character: 0 }
      return yield* Effect.all([
        Effect.exit(server.hover(position)),
        Effect.exit(server.definition(position))
      ], { concurrency: "unbounded" })
    })))
    expect(exits.map((exit) => failure(exit)?.code)).toEqual(["request_failed", "request_failed"])
  })

  it("times out a frame offer when the server stops draining stdin", async () => {
    const exits = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const stopped = yield* Deferred.make<void>()
      const spawner = scriptedSpawner((request, output) => {
        if (request.method === "initialize") {
          return respond(output, { jsonrpc: "2.0", id: request.id, result: { capabilities: {} } })
        }
        return Deferred.succeed(stopped, undefined).pipe(
          Effect.andThen(Effect.never)
        )
      })
      const server = yield* NodeLanguageServer.make({
        command: "language-server",
        cwd: "/workspace",
        timeoutMs: 50
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      yield* Deferred.await(stopped)
      const position = { path: "/workspace/a.ts", line: 0, character: 0 }
      return yield* Effect.all(
        Array.from({ length: 257 }, () => Effect.exit(server.hover(position))),
        { concurrency: "unbounded" }
      )
    })))

    expect(NodeLanguageServer.MAX_QUEUED_FRAMES).toBe(256)
    expect(exits.map(failure).every((error) => error?.code === "timeout")).toBe(true)
    expect(exits.map(failure)).toContainEqual({
      code: "timeout",
      message: expect.stringContaining("stdin is not being drained")
    })
  })

  it("refuses a request beyond the pending cap without disturbing in-flight requests", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const saturated = yield* Deferred.make<void>()
      const requestIds: Array<number> = []
      let responseQueue: Queue.Queue<Uint8Array, Cause.Done> | undefined
      const spawner = scriptedSpawner((request, output) => {
        if (request.method === "initialize") {
          return respond(output, { jsonrpc: "2.0", id: request.id, result: { capabilities: {} } })
        }
        if (request.method === "initialized" || typeof request.id !== "number") return Effect.void
        responseQueue = output
        requestIds.push(request.id)
        return requestIds.length === 512
          ? Deferred.succeed(saturated, undefined).pipe(Effect.asVoid)
          : Effect.void
      })
      const server = yield* NodeLanguageServer.make({
        command: "language-server",
        cwd: "/workspace",
        timeoutMs: 10_000
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      const position = { path: "/workspace/a.ts", line: 0, character: 0 }
      const inFlight = yield* Effect.all(
        Array.from({ length: 512 }, () => server.hover(position)),
        { concurrency: "unbounded" }
      ).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(saturated).pipe(Effect.timeout(5_000))
      const extra = yield* Effect.exit(server.definition(position).pipe(Effect.timeout(500)))
      if (responseQueue === undefined) return yield* Effect.die("Scripted server did not receive the requests")
      // Bound to a const: the closure below outlives the narrowing of a `let`
      // the scripted spawner also writes to.
      const answers = responseQueue
      yield* Effect.forEach(
        [...requestIds],
        (id) => respond(answers, { jsonrpc: "2.0", id, result: { id } }),
        { discard: true }
      )
      const completed = yield* Fiber.join(inFlight).pipe(Effect.timeout(5_000))
      return { completed, extra }
    })))

    expect(NodeLanguageServer.MAX_PENDING_REQUESTS).toBe(512)
    expect(failure(result.extra)).toEqual({
      code: "request_failed",
      message: expect.stringContaining("512")
    })
    expect(result.completed).toHaveLength(512)
  })
})

const sentinelServer = String.raw`
let input = Buffer.alloc(0)
process.stdin.on("data", chunk => {
  input = Buffer.concat([input, chunk])
  for (;;) {
    const end = input.indexOf("\r\n\r\n")
    if (end < 0) return
    const length = Number(/Content-Length: (\d+)/i.exec(input.subarray(0, end).toString())[1])
    if (input.length < end + 4 + length) return
    const request = JSON.parse(input.subarray(end + 4, end + 4 + length).toString())
    input = input.subarray(end + 4 + length)
    if (request.id === undefined) continue
    const result = request.method === "initialize" ? { capabilities: {} } : {
      sentinel: process.env.SMITHERS_LSP_DUMMY_SECRET ?? null
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: request.id, result })
    process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body)
  }
})
`

describe("NodeLanguageServer diagnostics and environment", () => {
  for (const declared of [false, true]) {
    it(`filters a real child's ambient sentinel with declared=${declared}`, async () => {
      const previous = process.env["SMITHERS_LSP_DUMMY_SECRET"]
      process.env["SMITHERS_LSP_DUMMY_SECRET"] = "ambient-dummy"
      try {
        const result = await Effect.runPromise(
          Effect.scoped(Effect.gen(function*() {
            const server = yield* NodeLanguageServer.make({
              command: process.execPath,
              args: [hostScript(sentinelServer)],
              cwd: process.cwd(),
              environment: declared ? { SMITHERS_LSP_DUMMY_SECRET: "declared-dummy" } : undefined
            })
            return yield* server.hover({ path: "/workspace/a.ts", line: 0, character: 0 })
          })).pipe(Effect.provide(NodeServices.layer))
        )
        expect(result).toEqual({ sentinel: declared ? "declared-dummy" : null })
      } finally {
        if (previous === undefined) delete process.env["SMITHERS_LSP_DUMMY_SECRET"]
        else process.env["SMITHERS_LSP_DUMMY_SECRET"] = previous
      }
    })
  }

  it("preserves the request method and JSON-RPC error code, message and data", async () => {
    const rpcError = { code: -32602, message: "Invalid hover position", data: { parameter: "position" } }
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const spawner = scriptedSpawner((request, output) =>
        respond(
          output,
          request.method === "initialize"
            ? { jsonrpc: "2.0", id: request.id, result: { capabilities: {} } }
            : { jsonrpc: "2.0", id: request.id, error: rpcError }
        )
      )
      const server = yield* NodeLanguageServer.make({ command: "language-server", cwd: "/workspace" })
        .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      return yield* Effect.flip(server.hover({ path: "/workspace/a.ts", line: 0, character: 0 }))
    })))
    expect(result).toMatchObject({ code: "request_failed", method: "textDocument/hover", rpcError })
    expect(result.message).toContain("Invalid hover position")
  })

  it("retains a bounded stderr tail when a real server exits during initialization", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(NodeLanguageServer.make({
        command: process.execPath,
        args: [
          hostScript("process.stderr.write('é'.repeat(100000) + 'configuration missing', () => process.exit(17))")
        ],
        cwd: process.cwd()
      })).pipe(Effect.provide(NodeServices.layer), Effect.flip)
    )
    expect(result).toMatchObject({
      code: "request_failed",
      method: "initialize",
      stderr: expect.stringContaining("configuration missing")
    })
    const stderr = result.stderr ?? ""
    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(64 * 1024)
    expect(stderr).not.toContain("�")
  })

  it("attaches stderr to an outstanding request when the initialized server exits", async () => {
    const script = sentinelServer.replace(
      "const result =",
      `
      if (request.method === "textDocument/hover") {
        process.stderr.write("hover configuration failed", () => process.exit(23))
        return
      }
      const result =`
    )
    const result = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const server = yield* NodeLanguageServer.make({
          command: process.execPath,
          args: [hostScript(script)],
          cwd: process.cwd()
        })
        return yield* Effect.flip(server.hover({ path: "/workspace/a.ts", line: 0, character: 0 }))
      })).pipe(Effect.provide(NodeServices.layer))
    )
    expect(result).toMatchObject({
      code: "request_failed",
      method: "textDocument/hover",
      stderr: "hover configuration failed"
    })
  })
})
