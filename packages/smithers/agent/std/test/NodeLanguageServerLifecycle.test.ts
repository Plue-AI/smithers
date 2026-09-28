import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Deferred, Effect, Exit, Fiber, PlatformError, Queue, Schema, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as NodeLanguageServer from "../src/NodeLanguageServer.ts"

interface Request {
  readonly id?: number
  readonly method: string
}
const frame = (body: string): Uint8Array =>
  new TextEncoder().encode(`Content-Length: ${new TextEncoder().encode(body).length}\r\n\r\n${body}`)
const answer = (output: Queue.Queue<Uint8Array>, id: number, result: unknown) =>
  Queue.offer(output, frame(JSON.stringify({ jsonrpc: "2.0", id, result }))).pipe(Effect.asVoid)
const position = { path: "/workspace/a.ts", line: 0, character: 0 }
const ioError = (method: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcessSpawner",
    method,
    description: "controlled transport IO failure"
  })

// The seam delivers real framed bytes and injects only process-adapter IO errors.
const peer = (onRequest: (request: Request, output: Queue.Queue<Uint8Array>) => Effect.Effect<void>, options: {
  readonly stdoutFailure?: Deferred.Deferred<void>
  readonly stderr?: Stream.Stream<Uint8Array, PlatformError.PlatformError>
  readonly exitCode?: Effect.Effect<ExitCode, PlatformError.PlatformError>
} = {}) =>
  ChildProcessSpawner.makeNoop({
    spawn: (command) =>
      Effect.gen(function*() {
        const stdin = (command as ChildProcess.StandardCommand).options.stdin as ChildProcess.StdinConfig
        const input = stdin.stream as Stream.Stream<Uint8Array>
        const output = yield* Queue.unbounded<Uint8Array>()
        yield* input.pipe(
          Stream.runForEach((bytes) => {
            const text = new TextDecoder().decode(bytes)
            const request = JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4)) as Request
            return request.method === "initialize" && request.id !== undefined
              ? answer(output, request.id, { capabilities: {} }) :
              onRequest(request, output)
          }),
          Effect.forkScoped({ startImmediately: true })
        )
        const stdout = options.stdoutFailure === undefined ? Stream.fromQueue(output) : Stream.fromQueue(output).pipe(
          Stream.merge(
            Stream.fromEffect(Deferred.await(options.stdoutFailure)).pipe(
              Stream.flatMap(() => Stream.fail(ioError("stdout")))
            )
          )
        )
        return makeHandle({
          pid: ProcessId(1),
          exitCode: options.exitCode ?? Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout,
          stderr: options.stderr ?? Stream.empty,
          all: stdout,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
  })
const make = (spawner: ReturnType<typeof ChildProcessSpawner.makeNoop>, timeoutMs = 10_000) =>
  NodeLanguageServer.make({ command: "controlled-peer", cwd: "/workspace", timeoutMs })
    .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

describe("NodeLanguageServer transport and request ownership", () => {
  it.each([0, 1, 2])(
    "ignores empty stdout chunks around response fragment %i without losing bytes",
    async (emptyAt) => {
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const methods: Array<string> = []
        const spawner = peer((request, output) =>
          Effect.gen(function*() {
            if (request.id === undefined) return
            methods.push(request.method)
            const response = frame(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "é preserved" }))
            const pieces = [response.slice(0, 9), response.slice(9)]
            for (let index = 0; index <= pieces.length; index++) {
              if (index === emptyAt) yield* Queue.offer(output, new Uint8Array(0))
              if (index < pieces.length) yield* Queue.offer(output, pieces[index]!)
            }
          })
        )
        const server = yield* make(spawner)
        return { first: yield* server.hover(position), next: yield* server.definition(position), methods }
      })))
      expect(result).toEqual({
        first: "é preserved",
        next: "é preserved",
        methods: ["textDocument/hover", "textDocument/definition"]
      })
    }
  )

  it.each(["9007199254740992", "9".repeat(309)])(
    "rejects all pending requests for corrupt JSON with an unsafe peer ID %s and then recovers",
    async (unsafeId) => {
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        let received = 0
        const spawner = peer((request, output) =>
          Effect.gen(function*() {
            if (request.id === undefined) return
            received++
            if (received === 2) yield* Queue.offer(output, frame(`{"id":${unsafeId},"result":`))
            else if (received > 2) yield* answer(output, request.id, "recovered after corrupt peer response")
          })
        )
        const server = yield* make(spawner)
        const errors = yield* Effect.all([
          Effect.flip(server.hover(position)),
          Effect.flip(server.definition(position))
        ], { concurrency: 2 })
        return { errors, next: yield* server.workspaceSymbols("recovery"), received }
      })))
      expect(result.errors).toMatchObject([
        { code: "request_failed", method: "textDocument/hover", message: "Language server returned malformed JSON" },
        {
          code: "request_failed",
          method: "textDocument/definition",
          message: "Language server returned malformed JSON"
        }
      ])
      expect(result.next).toBe("recovered after corrupt peer response")
      expect(result.received).toBe(3)
    }
  )

  it("ignores corrupt JSON with a safe unrecognized ID and unrelated peer messages without replacing the answer", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const methods: Array<string> = []
      const spawner = peer((request, output) =>
        Effect.gen(function*() {
          if (request.id === undefined) return
          methods.push(request.method)
          yield* Queue.offer(output, frame("{\"id\":9007199254740991,\"result\":"))
          for (
            const message of [
              null,
              [],
              "unrelated peer data",
              { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { diagnostics: [] } },
              { jsonrpc: "2.0", id: String(request.id), result: "wrong ID type" },
              { jsonrpc: "2.0", id: 9007199254740991, result: "unknown ID" }
            ]
          ) yield* Queue.offer(output, frame(JSON.stringify(message)))
          yield* answer(output, request.id, { contents: "matching numeric ID only" })
        })
      )
      const server = yield* make(spawner)
      return { first: yield* server.hover(position), next: yield* server.definition(position), methods }
    })))
    expect(result).toEqual({
      first: { contents: "matching numeric ID only" },
      next: { contents: "matching numeric ID only" },
      methods: ["textDocument/hover", "textDocument/definition"]
    })
  })

  it.each(["stdout", "exit polling"] as const)(
    "%s failure rejects every pending request and future calls without more writes",
    async (phase) => {
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const failed = yield* Deferred.make<void>()
        const methods: Array<string> = []
        const spawner = peer(
          (request) =>
            Effect.gen(function*() {
              if (request.id === undefined) return
              methods.push(request.method)
              if (methods.length === 2) yield* Deferred.succeed(failed, undefined)
            }),
          phase === "stdout" ? { stdoutFailure: failed } : {
            exitCode: Deferred.await(failed).pipe(Effect.andThen(Effect.fail(ioError("exitCode"))))
          }
        )
        const server = yield* make(spawner)
        const errors = yield* Effect.all([
          Effect.flip(server.hover(position)),
          Effect.flip(server.definition(position))
        ], { concurrency: 2 })
        const future = yield* Effect.flip(server.workspaceSymbols("after-close"))
        return { errors, future, methods }
      })))
      const message = phase === "stdout" ? "Language server output stream failed" : "Language server process exited"
      expect(result.errors).toMatchObject([
        { code: "request_failed", method: "textDocument/hover", message },
        { code: "request_failed", method: "textDocument/definition", message }
      ])
      expect(result.future).toMatchObject({ code: "request_failed", method: "workspace/symbol", message })
      expect(result.methods).toEqual(["textDocument/hover", "textDocument/definition"])
    }
  )

  it("a stderr read failure does not discard valid protocol responses", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const observed = yield* Deferred.make<void>()
      const stderr = Stream.fail(ioError("stderr")).pipe(Stream.ensuring(Deferred.succeed(observed, undefined)))
      const spawner = peer(
        (request, output) => request.id === undefined ? Effect.void : answer(output, request.id, "still usable"),
        { stderr }
      )
      const server = yield* make(spawner)
      yield* Deferred.await(observed)
      return yield* server.hover(position)
    })))
    expect(result).toBe("still usable")
  })

  it("a malformed JSON response with a known ID rejects only that request and preserves its concurrent sibling", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const requests: Array<Request> = []
      const spawner = peer((request, output) =>
        Effect.gen(function*() {
          if (request.id === undefined) return
          requests.push(request)
          if (requests.length !== 2) return
          const bad = requests.find((row) => row.method === "textDocument/hover")!
          const good = requests.find((row) => row.method === "textDocument/definition")!
          yield* Queue.offer(output, frame(`{"id":${bad.id},"result":`))
          yield* answer(output, good.id!, { contents: "sibling answer" })
        })
      )
      const server = yield* make(spawner)
      return yield* Effect.all([Effect.flip(server.hover(position)), server.definition(position)], { concurrency: 2 })
    })))
    expect(result).toMatchObject([
      { code: "request_failed", method: "textDocument/hover", message: "Language server returned malformed JSON" },
      { contents: "sibling answer" }
    ])
  })

  it("decodes fragmented multibyte responses followed by another frame in the same final chunk", async () => {
    const large = "é".repeat(20_000)
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const requests: Array<Request> = []
      const spawner = peer((request, output) =>
        Effect.gen(function*() {
          if (request.id === undefined) return
          requests.push(request)
          if (requests.length !== 2) return
          const first = frame(JSON.stringify({ jsonrpc: "2.0", id: requests[0]!.id, result: large }))
          const second = frame(
            JSON.stringify({ jsonrpc: "2.0", id: requests[1]!.id, result: { text: "following frame" } })
          )
          for (let offset = 0; offset < first.length - 512; offset += 512) {
            yield* Queue.offer(output, first.slice(offset, offset + 512))
          }
          const tail = first.slice(Math.floor((first.length - 1) / 512) * 512)
          const last = new Uint8Array(tail.length + second.length)
          last.set(tail)
          last.set(second, tail.length)
          yield* Queue.offer(output, last)
        })
      )
      const server = yield* make(spawner)
      return yield* Effect.all([server.hover(position), server.definition(position)], { concurrency: 2 })
    })))
    expect(result).toEqual([large, { text: "following frame" }])
  })

  it("ignores a late malformed response for an interrupted request while preserving a live sibling", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const seen = yield* Deferred.make<void>()
      let oldId: number | undefined
      const spawner = peer((request, output) =>
        Effect.gen(function*() {
          if (request.id === undefined) return
          if (request.method === "textDocument/hover") {
            oldId = request.id
            yield* Deferred.succeed(seen, undefined)
          } else {
            yield* Queue.offer(output, frame(`{"id":${oldId},"result":`))
            yield* answer(output, request.id, "live sibling")
          }
        })
      )
      const server = yield* make(spawner)
      const cancelled = yield* server.hover(position).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(seen)
      yield* Fiber.interrupt(cancelled)
      const interrupted = yield* Fiber.await(cancelled)
      return { interrupted, answer: yield* server.definition(position) }
    })))
    expect(Exit.isFailure(result.interrupted) && Cause.hasInterrupts(result.interrupted.cause)).toBe(true)
    expect(result.answer).toBe("live sibling")
  })

  it("preserves a standard RPC error without optional data and accepts subsequent requests", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const spawner = peer((request, output) =>
        request.id === undefined ?
          Effect.void :
          request.method === "textDocument/hover" ?
          Queue.offer(
            output,
            frame(JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32601, message: "Method not found" }
            }))
          ).pipe(Effect.asVoid) :
          answer(output, request.id, "recovered")
      )
      const server = yield* make(spawner)
      return { error: yield* Effect.flip(server.hover(position)), answer: yield* server.definition(position) }
    })))
    expect(result.error).toMatchObject({
      code: "request_failed",
      method: "textDocument/hover",
      message: "textDocument/hover: Method not found",
      rpcError: { code: -32601, message: "Method not found" }
    })
    expect(result.error.rpcError).toEqual({ code: -32601, message: "Method not found" })
    expect(result.answer).toBe("recovered")
  })

  it("request timeout releases the pending slot and a later response cannot replace the next answer", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const seen = yield* Deferred.make<void>()
        let oldId: number | undefined
        const spawner = peer((request, output) =>
          Effect.gen(function*() {
            if (request.id === undefined) return
            if (request.method === "textDocument/hover") {
              oldId = request.id
              yield* Deferred.succeed(seen, undefined)
            } else {
              yield* answer(output, oldId!, "stale answer")
              yield* answer(output, request.id, "fresh answer")
            }
          })
        )
        const server = yield* make(spawner, 1_000)
        const timed = yield* Effect.flip(server.hover(position)).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(seen)
        yield* TestClock.adjust("1 second")
        const error = yield* Fiber.join(timed)
        const recovered = yield* server.definition(position)
        return { error, recovered }
      })).pipe(Effect.provide(TestClock.layer()))
    )
    expect(result.error).toMatchObject({
      code: "timeout",
      method: "textDocument/hover",
      message: "Language server request timed out: textDocument/hover"
    })
    expect(result.recovered).toBe("fresh answer")
  })

  it("a blocked write times out without leaking pending slots and recovers after stdin resumes", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const stopped = yield* Deferred.make<void>()
        const resume = yield* Deferred.make<void>()
        const sent: Array<string> = []
        const spawner = peer((request, output) =>
          Effect.gen(function*() {
            if (request.method === "initialized") {
              yield* Deferred.succeed(stopped, undefined)
              yield* Deferred.await(resume)
              return
            }
            if (request.id === undefined) return
            sent.push(request.method)
            yield* answer(
              output,
              request.id,
              request.method === "textDocument/definition" ? "fresh after resume" : "stale queued"
            )
          })
        )
        const server = yield* make(spawner, 1_000)
        yield* Deferred.await(stopped)
        const pending = yield* Effect.all(Array.from({ length: 257 }, () => Effect.flip(server.hover(position))), {
          concurrency: "unbounded"
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust("1 second")
        const errors = yield* Fiber.join(pending)
        yield* Deferred.succeed(resume, undefined)
        const recovered = yield* server.definition(position)
        return { errors, recovered, sent }
      })).pipe(Effect.provide(TestClock.layer()))
    )
    expect(result.errors.every((error) => error.code === "timeout" && error.method === "textDocument/hover")).toBe(true)
    expect(
      result.errors.filter((error) =>
        error.message === "Language server stdin is not being drained; frame offer exceeded 1000ms"
      )
    ).toHaveLength(1)
    expect(result.errors.filter((error) => error.message === "Language server request timed out: textDocument/hover"))
      .toHaveLength(256)
    expect(result.recovered).toBe("fresh after resume")
    expect(result.sent).toEqual([...Array.from({ length: 256 }, () => "textDocument/hover"), "textDocument/definition"])
  })

  it("interrupting one saturated request releases exactly one slot and ignores its late response", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const saturated = yield* Deferred.make<void>()
      const replaced = yield* Deferred.make<void>()
      const requests: Array<Request> = []
      let answers: Queue.Queue<Uint8Array> | undefined
      const spawner = peer((request, output) =>
        Effect.gen(function*() {
          if (request.id === undefined) return
          answers = output
          requests.push(request)
          if (requests.length === 512) yield* Deferred.succeed(saturated, undefined)
          if (requests.length === 513) yield* Deferred.succeed(replaced, undefined)
        })
      )
      const server = yield* make(spawner)
      const pending = yield* Effect.forEach(
        Array.from({ length: 512 }),
        () => server.hover(position).pipe(Effect.forkChild({ startImmediately: true }))
      )
      yield* Deferred.await(saturated)
      const refusal = yield* Effect.flip(server.definition(position))
      yield* Fiber.interrupt(pending[0]!)
      const interrupted = yield* Fiber.await(pending[0]!)
      const replacement = yield* server.definition(position).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(replaced)
      if (answers === undefined) throw new Error("No peer response queue")
      const output = answers
      yield* Effect.forEach(
        requests,
        (request, index) => answer(output, request.id!, index === 0 ? "cancelled stale" : `answer-${index}`)
      )
      const remaining = yield* Effect.forEach(pending.slice(1), Fiber.join)
      return { refusal, interrupted, remaining, replacement: yield* Fiber.join(replacement), count: requests.length }
    })))
    expect(result.refusal).toMatchObject({
      code: "request_failed",
      method: "textDocument/definition",
      message: "Language server reached the 512 pending-request cap"
    })
    expect(Exit.isFailure(result.interrupted) && Cause.hasInterrupts(result.interrupted.cause)).toBe(true)
    expect(result.remaining).toEqual(Array.from({ length: 511 }, (_, index) => `answer-${index + 1}`))
    expect(result.replacement).toBe("answer-512")
    expect(result.count).toBe(513)
  })
})

const controlledChild = String.raw`
let input = Buffer.alloc(0);
const calls = [];
function send(id, result) {
 const body = Buffer.from(JSON.stringify({jsonrpc:'2.0',id,result}));
 process.stdout.write(Buffer.concat([Buffer.from('Content-Length: '+body.length+'\r\n\r\n'),body]));
}
process.stdin.on('data', chunk => {
 input = Buffer.concat([input,chunk]);
 while (true) {
  const end = input.indexOf('\r\n\r\n');
  if (end < 0) return;
  const length = Number(/Content-Length:\s*(\d+)/.exec(input.subarray(0,end).toString())[1]);
  if (input.length < end+4+length) return;
  const request = JSON.parse(input.subarray(end+4,end+4+length).toString());
  input = input.subarray(end+4+length);
  calls.push(request.method);
  if (request.method === 'initialize') send(request.id,{capabilities:{}});
  if (request.method === 'workspace/symbol') {
   if (request.params.query === 'exit') process.stderr.write('controlled peer exit',()=>process.exit(19));
   else send(request.id,{pid:process.pid,calls:[...calls]});
  }
 }
});
`
const Receipt = Schema.Struct({ pid: Schema.Number, calls: Schema.Array(Schema.String) })
const realServer = () =>
  NodeLanguageServer.make({
    command: process.execPath,
    args: ["-e", controlledChild],
    cwd: process.cwd(),
    timeoutMs: 10_000
  })
const assertExited = async (pid: number): Promise<void> => {
  let alive = true
  try {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
      } catch (cause) {
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH") {
          alive = false
          return
        }
        throw cause
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`Owned language-server process ${pid} survived scope close`)
  } finally {
    if (alive) {
      try {
        process.kill(pid, "SIGKILL")
      } catch { /* Already reaped. */ }
    }
  }
}

describe("NodeLanguageServer real child ownership", () => {
  it("interrupts a received request while keeping the peer usable, then reaps the child on scope close", async () => {
    let ownedPid: number | undefined
    try {
      const result = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const server = yield* realServer()
          const waiting = yield* server.hover(position).pipe(Effect.forkChild({ startImmediately: true }))
          const received = yield* server.workspaceSymbols("receipt").pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Receipt))
          )
          ownedPid = received.pid
          yield* Fiber.interrupt(waiting)
          const interrupted = yield* Fiber.await(waiting)
          const after = yield* server.workspaceSymbols("after-interrupt").pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Receipt))
          )
          return { received, interrupted, after }
        })).pipe(Effect.provide(NodeServices.layer))
      )
      expect(result.received.calls).toEqual(["initialize", "initialized", "textDocument/hover", "workspace/symbol"])
      expect(Exit.isFailure(result.interrupted) && Cause.hasInterrupts(result.interrupted.cause)).toBe(true)
      expect(result.after).toEqual({
        pid: result.received.pid,
        calls: ["initialize", "initialized", "textDocument/hover", "workspace/symbol", "workspace/symbol"]
      })
    } finally {
      if (ownedPid !== undefined) await assertExited(ownedPid)
    }
  })

  it("a real exiting child rejects all received requests and future calls with its final stderr", async () => {
    let ownedPid: number | undefined
    try {
      const result = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const server = yield* realServer()
          const hover = yield* Effect.flip(server.hover(position)).pipe(Effect.forkChild({ startImmediately: true }))
          const definition = yield* Effect.flip(server.definition(position)).pipe(
            Effect.forkChild({ startImmediately: true })
          )
          const received = yield* server.workspaceSymbols("receipt").pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Receipt))
          )
          ownedPid = received.pid
          const exit = yield* Effect.flip(server.workspaceSymbols("exit"))
          const errors = [
            yield* Fiber.join(hover),
            yield* Fiber.join(definition),
            exit,
            yield* Effect.flip(server.workspaceSymbols("after-exit"))
          ]
          return { received, errors }
        })).pipe(Effect.provide(NodeServices.layer))
      )
      expect(result.received.calls).toEqual([
        "initialize",
        "initialized",
        "textDocument/hover",
        "textDocument/definition",
        "workspace/symbol"
      ])
      expect(result.errors.map(({ code, method, stderr }) => ({ code, method, stderr }))).toEqual([
        { code: "request_failed", method: "textDocument/hover", stderr: "controlled peer exit" },
        { code: "request_failed", method: "textDocument/definition", stderr: "controlled peer exit" },
        { code: "request_failed", method: "workspace/symbol", stderr: "controlled peer exit" },
        { code: "request_failed", method: "workspace/symbol", stderr: "controlled peer exit" }
      ])
      expect(new Set(result.errors.map(({ message }) => message)).size).toBe(1)
      expect(result.errors[0]?.message).toMatch(
        /^Language server (?:process exited with code 19|output stream closed)$/
      )
    } finally {
      if (ownedPid !== undefined) await assertExited(ownedPid)
    }
  })
})
