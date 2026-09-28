import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Clock, Deferred, Effect, Exit, Fiber, Redacted, Schema, Scope, Sink, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import { TestClock } from "effect/testing"
import { ExitCode, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as Diagnostics from "../src/Diagnostics.ts"
import * as StdioTransport from "../src/internal/StdioTransport.ts"
import { McpError } from "../src/McpError.ts"
import { fakeHandle, type HandleOptions } from "./fixtures/FakeProcess.ts"

const secret = "synthetic-private-value-DO-NOT-PUBLISH"
const diagnosticBytes = new TextEncoder().encode(`API_TOKEN=${secret}\n`)

const connect = (overrides: Partial<HandleOptions>, released: () => void = () => {}) =>
  StdioTransport.connect({
    server: "terminal-drain",
    command: "fixture",
    args: [],
    // A cap shorter than the line: capping raw bytes first would cut the
    // credential's recognizable prefix and hand the observer its remainder.
    maxStderrBytes: secret.length + 1,
    queueCapacity: 1,
    requestTimeoutMs: 1_000
  }).pipe(Effect.provideService(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.makeNoop({
      spawn: () =>
        Effect.acquireRelease(
          Effect.succeed(fakeHandle({ pid: ProcessId(1), ...overrides })),
          () => Effect.sync(released)
        )
    })
  ))

const assertPrivate = (error: McpError, events: ReadonlyArray<Diagnostics.Event>) => {
  expect(error).toBeInstanceOf(McpError)
  expect(error.code).toBe("connection_closed")
  const encoded = Schema.encodeSync(McpError)(error)
  for (const display of [String(error), JSON.stringify(error), JSON.stringify(encoded), JSON.stringify(events)]) {
    expect(display).not.toContain(secret)
    expect(display).not.toContain("API_TOKEN=")
  }
}

const assertDiagnostic = (error: McpError, events: ReadonlyArray<Diagnostics.Event>) => {
  assertPrivate(error, events)
  expect(error.message).toContain("(stderr diagnostic withheld)")
  expect(events).toHaveLength(1)
  expect(events[0]!.source).toBe("stderr")
  expect(Redacted.value(events[0]!.detail)).toBe("API_TOKEN=[REDACTED]")
}

describe("terminal stderr drainage", () => {
  it("reports scope closure for pending and subsequent requests while the child is healthy", async () => {
    let released = false
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const connectionScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(connectionScope, Exit.void))
        const written = yield* Deferred.make<void>()
        const transport = yield* connect({
          stdin: Sink.forEach((_chunk: Uint8Array) => Deferred.succeed(written, undefined))
        }, () => {
          released = true
        }).pipe(Scope.provide(connectionScope))
        const pending = yield* Effect.forkChild(Effect.flip(transport.request("tools/call")), {
          startImmediately: true
        })
        yield* Deferred.await(written)
        expect(released).toBe(false)
        yield* Scope.close(connectionScope, Exit.void)
        const error = yield* Fiber.join(pending)
        expect(error).toMatchObject({
          code: "connection_closed",
          message: "MCP server \"terminal-drain\" connection scope closed"
        })
        expect(yield* Effect.flip(transport.request("after-close"))).toBe(error)
        expect(released).toBe(true)
      })).pipe(Effect.provide(TestClock.layer()))
    )
  })

  it("retains stderr consumed before exit without spending the drain budget", async () => {
    const events: Array<Diagnostics.Event> = []
    const error = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const consumed = yield* Deferred.make<void>()
        const transport = yield* connect({
          stderr: Stream.succeed(diagnosticBytes).pipe(Stream.ensuring(Deferred.succeed(consumed, undefined))),
          // Completion of the finite stream is a happens-after signal for
          // runForEach retaining its final chunk, rather than a timed guess.
          exitCode: Deferred.await(consumed).pipe(Effect.as(ExitCode(1)))
        })
        const pending = yield* Effect.forkChild(Effect.flip(transport.request("call")), { startImmediately: true })
        const result = yield* Fiber.join(pending)
        expect(yield* Clock.currentTimeMillis).toBe(0)
        return result
      })).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provide(Diagnostics.layer((event) => events.push(event)))
      )
    )
    assertDiagnostic(error, events)
  })

  it.each(
    [
      [
        "a credential split across chunks",
        ["API_TO", `KEN=${secret.slice(0, 5)}`, `${secret.slice(5)}\n`],
        "API_TOKEN=[REDACTED]"
      ],
      [
        "a private key block spanning lines",
        ["-----BEGIN RSA PRIVATE KEY-----\n", `MII${secret}\n`, "-----END RSA PRIVATE KEY-----\n"],
        "[REDACTED]"
      ]
    ] as const
  )("redacts %s before the cap cuts its prefix", async (_name, chunks, expected) => {
    const events: Array<Diagnostics.Event> = []
    const error = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const consumed = yield* Deferred.make<void>()
        const transport = yield* connect({
          stderr: Stream.fromIterable(chunks.map((chunk) => new TextEncoder().encode(chunk))).pipe(
            Stream.ensuring(Deferred.succeed(consumed, undefined))
          ),
          exitCode: Deferred.await(consumed).pipe(Effect.as(ExitCode(1)))
        })
        return yield* Effect.flip(transport.request("call"))
      })).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provide(Diagnostics.layer((event) => events.push(event)))
      )
    )
    assertPrivate(error, events)
    const detail = events.map((event) => Redacted.value(event.detail)).join("")
    expect(detail).toBe(expected)
    expect(detail).not.toContain("PUBLISH")
  })

  it.each(["exit", "stdout"] as const)(
    "drains delayed stderr after %s before settling old and new traffic",
    async (signal) => {
      const events: Array<Diagnostics.Event> = []
      const errors = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const written = yield* Deferred.make<void>()
          const terminal = yield* Deferred.make<void>()
          const releaseStderr = yield* Deferred.make<void>()
          const transport = yield* connect({
            stdin: Sink.forEach((_chunk: Uint8Array) => Deferred.succeed(written, undefined)),
            stderr: Stream.fromEffect(Deferred.await(releaseStderr).pipe(Effect.as(diagnosticBytes))),
            ...(signal === "exit"
              ? { exitCode: Deferred.await(terminal).pipe(Effect.as(ExitCode(1))) }
              : { stdout: Stream.fromEffect(Deferred.await(terminal)).pipe(Stream.drain) })
          })
          const pending = yield* Effect.forkChild(Effect.flip(transport.request("first")), { startImmediately: true })
          yield* Deferred.await(written)
          yield* Deferred.succeed(terminal, undefined)
          // Let every fiber reach suspension. The terminal signal is already
          // visible; stderr is deliberately still unavailable.
          yield* TestClock.adjust(1)
          expect(pending.pollUnsafe()).toBeUndefined()
          const later = yield* Effect.forkChild(Effect.flip(transport.request("later")), { startImmediately: true })
          const notification = yield* Effect.forkChild(Effect.flip(transport.notify("later")), {
            startImmediately: true
          })
          expect(later.pollUnsafe()).toBeUndefined()
          expect(notification.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(releaseStderr, undefined)
          return yield* Effect.all([Fiber.join(pending), Fiber.join(later), Fiber.join(notification)])
        })).pipe(
          Effect.provide(TestClock.layer()),
          Effect.provide(Diagnostics.layer((event) => events.push(event)))
        )
      )
      expect(errors.every((error) => error === errors[0])).toBe(true)
      assertDiagnostic(errors[0]!, events)
    }
  )

  it.each(["empty", "partial"] as const)(
    "bounds an indefinitely open %s stderr stream across duplicate terminal signals",
    async (tail) => {
      const events: Array<Diagnostics.Event> = []
      let released = false
      let stderrFinalized = false
      const errors = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const written = yield* Deferred.make<void>()
          const exited = yield* Deferred.make<ExitCode>()
          const stdoutClosed = yield* Deferred.make<void>()
          const transport = yield* connect({
            stdin: Sink.forEach((_chunk: Uint8Array) => Deferred.succeed(written, undefined)),
            exitCode: Deferred.await(exited),
            stdout: Stream.fromEffect(Deferred.await(stdoutClosed)).pipe(Stream.drain),
            stderr: (tail === "partial" ? Stream.concat(Stream.succeed(diagnosticBytes), Stream.never) : Stream.never)
              .pipe(
                Stream.ensuring(Effect.sync(() => {
                  stderrFinalized = true
                }))
              )
          }, () => {
            released = true
          })
          const first = yield* Effect.forkChild(Effect.flip(transport.request("first")), { startImmediately: true })
          yield* Deferred.await(written)
          yield* Deferred.succeed(exited, ExitCode(1))
          yield* TestClock.adjust(200)
          expect(first.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(stdoutClosed, undefined)
          const later = yield* Effect.forkChild(Effect.flip(transport.request("later")), { startImmediately: true })
          yield* TestClock.adjust(49)
          expect(first.pollUnsafe()).toBeUndefined()
          expect(later.pollUnsafe()).toBeUndefined()
          yield* TestClock.adjust(1)
          const result = yield* Effect.all([Fiber.join(first), Fiber.join(later)])
          // The timeout cancels only the waiter, not the scoped stderr reader.
          expect(stderrFinalized).toBe(false)
          expect(yield* Clock.currentTimeMillis).toBe(250)
          return result
        })).pipe(
          Effect.provide(TestClock.layer()),
          Effect.provide(Diagnostics.layer((event) => events.push(event)))
        )
      )
      expect(released).toBe(true)
      expect(stderrFinalized).toBe(true)
      expect(errors[1]).toBe(errors[0])
      if (tail === "partial") assertDiagnostic(errors[0]!, events)
      else {
        assertPrivate(errors[0]!, events)
        expect(events).toHaveLength(0)
      }
    }
  )

  it("keeps an offer blocked by backpressure behind the same terminal drain", async () => {
    const events: Array<Diagnostics.Event> = []
    const errors = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const written = yield* Deferred.make<void>()
        const exited = yield* Deferred.make<ExitCode>()
        const releaseStderr = yield* Deferred.make<void>()
        const transport = yield* connect({
          stdin: Sink.forEach((_chunk: Uint8Array) =>
            Deferred.succeed(written, undefined).pipe(Effect.andThen(Effect.never))
          ),
          exitCode: Deferred.await(exited),
          stderr: Stream.fromEffect(Deferred.await(releaseStderr).pipe(Effect.as(diagnosticBytes)))
        })
        yield* transport.notify("occupy-writer")
        yield* Deferred.await(written)
        yield* transport.notify("occupy-queue")
        const blocked = yield* Effect.forkChild(Effect.flip(transport.request("blocked")), { startImmediately: true })
        yield* Deferred.succeed(exited, ExitCode(1))
        yield* TestClock.adjust(1)
        expect(blocked.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(releaseStderr, undefined)
        const blockedError = yield* Fiber.join(blocked)
        const laterError = yield* Effect.flip(transport.request("later"))
        return { blockedError, laterError }
      })).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provide(Diagnostics.layer((event) => events.push(event)))
      )
    )
    expect(errors.blockedError).toBe(errors.laterError)
    assertDiagnostic(errors.blockedError, events)
  })

  it("settles all terminal waiters when scope closure interrupts an active drain", async () => {
    const events: Array<Diagnostics.Event> = []
    let released = false
    let stderrFinalized = false
    const errors = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const connectionScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(connectionScope, Exit.void))
        const written = yield* Deferred.make<void>()
        const exited = yield* Deferred.make<ExitCode>()
        const transport = yield* connect({
          stdin: Sink.forEach((_chunk: Uint8Array) => Deferred.succeed(written, undefined)),
          exitCode: Deferred.await(exited),
          stderr: Stream.never.pipe(Stream.ensuring(Effect.sync(() => {
            stderrFinalized = true
          })))
        }, () => {
          released = true
        }).pipe(Scope.provide(connectionScope))
        // These callers live outside the connection scope. Closing it must
        // settle them with a typed failure, not merely interrupt the callers.
        const pending = yield* Effect.forkChild(Effect.flip(transport.request("first")), { startImmediately: true })
        yield* Deferred.await(written)
        yield* Deferred.succeed(exited, ExitCode(1))
        yield* TestClock.adjust(10)
        const later = yield* Effect.forkChild(Effect.flip(transport.request("later")), { startImmediately: true })
        const notification = yield* Effect.forkChild(Effect.flip(transport.notify("later")), { startImmediately: true })
        expect(pending.pollUnsafe()).toBeUndefined()
        expect(later.pollUnsafe()).toBeUndefined()
        expect(notification.pollUnsafe()).toBeUndefined()
        yield* Scope.close(connectionScope, Exit.void)
        expect(yield* Clock.currentTimeMillis).toBe(10)
        const afterwards = yield* Effect.flip(transport.request("after-close"))
        return [yield* Fiber.join(pending), yield* Fiber.join(later), yield* Fiber.join(notification), afterwards]
      })).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provide(Diagnostics.layer((event) => events.push(event)))
      )
    )
    expect(released).toBe(true)
    expect(stderrFinalized).toBe(true)
    expect(errors.every((error) => error === errors[0])).toBe(true)
    assertPrivate(errors[0]!, events)
  })

  it("preserves a shorter request deadline and skips drainage during its scope cleanup", async () => {
    let released = false
    const outcome = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const written = yield* Deferred.make<void>()
        const exited = yield* Deferred.make<ExitCode>()
        const result = yield* Effect.forkChild(
          Effect.scoped(Effect.gen(function*() {
            const transport = yield* connect({
              stdin: Sink.forEach((_chunk: Uint8Array) => Deferred.succeed(written, undefined)),
              exitCode: Deferred.await(exited),
              stderr: Stream.never
            }, () => {
              released = true
            })
            return yield* Effect.flip(transport.request("deadline", undefined, 10))
          })),
          { startImmediately: true }
        )
        yield* Deferred.await(written)
        yield* Deferred.succeed(exited, ExitCode(1))
        yield* TestClock.adjust(9)
        expect(result.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust(1)
        const error = yield* Fiber.join(result)
        return { error, time: yield* Clock.currentTimeMillis }
      })).pipe(Effect.provide(TestClock.layer()))
    )
    expect(outcome.error).toMatchObject({ code: "timeout", message: expect.stringContaining("within 10ms") })
    expect(outcome.time).toBe(10)
    expect(released).toBe(true)
  })

  it("treats a failed stderr reader as finished without replacing the terminal error", async () => {
    const events: Array<Diagnostics.Event> = []
    const error = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const failed = yield* Deferred.make<void>()
        const transport = yield* connect({
          stderr: Stream.concat(
            Stream.succeed(diagnosticBytes),
            Stream.fail(PlatformError.systemError({
              _tag: "Unknown",
              module: "ChildProcess",
              method: "stderr",
              description: secret
            }))
          ).pipe(Stream.ensuring(Deferred.succeed(failed, undefined))),
          exitCode: Deferred.await(failed).pipe(Effect.as(ExitCode(1)))
        })
        const result = yield* Effect.flip(transport.request("call"))
        expect(yield* Clock.currentTimeMillis).toBe(0)
        return result
      })).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provide(Diagnostics.layer((event) => events.push(event)))
      )
    )
    assertDiagnostic(error, events)
  })
})

type WrittenFrame = {
  readonly id?: number
  readonly method?: string
  readonly params?: { readonly requestId?: number }
}

const decodeFrame = (chunk: Uint8Array): WrittenFrame => JSON.parse(new TextDecoder().decode(chunk))
const resultFrame = (id: number, result: string): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)

describe("request lifecycle", () => {
  it("reports an uncorrelated error privately and still resolves the pending tool call", async () => {
    const events: Array<Diagnostics.Event> = []
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const written = yield* Deferred.make<number>()
        const reply = yield* Deferred.make<Uint8Array>()
        const transport = yield* connect({
          stdin: Sink.forEach((chunk: Uint8Array) => Deferred.succeed(written, decodeFrame(chunk).id!)),
          stdout: Stream.concat(Stream.fromEffect(Deferred.await(reply)), Stream.never)
        })
        const pending = yield* Effect.forkChild(transport.request("tools/call"), { startImmediately: true })
        const id = yield* Deferred.await(written)
        yield* Deferred.succeed(
          reply,
          new TextEncoder().encode([
            JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32_700, message: secret, data: "context" } }),
            JSON.stringify({ jsonrpc: "2.0", id, result: "tool-result" }),
            ""
          ].join("\n"))
        )
        expect(yield* Fiber.join(pending)).toBe("tool-result")
        yield* transport.notify("still-open")
        expect(events).toHaveLength(1)
        expect(events[0]!.source).toBe("remote-error")
        expect(JSON.parse(Redacted.value(events[0]!.detail))).toEqual({
          code: -32_700,
          message: secret,
          data: "context"
        })
        expect(JSON.stringify(events)).not.toContain(secret)
      })).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provide(Diagnostics.layer((event) => events.push(event)))
      )
    )
  })

  it.each(["timeout", "interrupt"] as const)("skips a queued request after %s", async (abandon) => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const written: Array<WrittenFrame> = []
        const occupied = yield* Deferred.make<void>()
        const releaseWriter = yield* Deferred.make<void>()
        const drained = yield* Deferred.make<void>()
        const transport = yield* connect({
          stdin: Sink.forEach((chunk: Uint8Array) =>
            Effect.gen(function*() {
              const frame = decodeFrame(chunk)
              written.push(frame)
              if (frame.method === "occupy-writer") {
                yield* Deferred.succeed(occupied, undefined)
                yield* Deferred.await(releaseWriter)
              }
              if (frame.method === "after-abandon") yield* Deferred.succeed(drained, undefined)
            })
          )
        })
        yield* transport.notify("occupy-writer")
        yield* Deferred.await(occupied)
        const pending = yield* Effect.forkChild(
          Effect.result(transport.request("tools/call", { name: "mutation", arguments: {} }, 10)),
          { startImmediately: true }
        )
        // Settle queue admission while the stdin sink remains blocked.
        yield* TestClock.adjust(1)
        expect(written.map((frame) => frame.method)).toEqual(["occupy-writer"])
        if (abandon === "timeout") {
          yield* TestClock.adjust(9)
          expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "Failure", failure: { code: "timeout" } })
        } else {
          yield* Fiber.interrupt(pending)
        }
        yield* Deferred.succeed(releaseWriter, undefined)
        yield* transport.notify("after-abandon")
        yield* Deferred.await(drained)
        // The queue has drained past the expired record. Neither the mutation
        // nor a cancellation for an undispatched request may reach stdin.
        expect(written.map((frame) => frame.method)).toEqual(["occupy-writer", "after-abandon"])
      })).pipe(Effect.provide(TestClock.layer()))
    )
  })

  it("correlates three simultaneous requests with replies in reverse order", async () => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const methods = ["one", "two", "three"]
        const written = yield* Effect.forEach(methods, () => Deferred.make<number>())
        const replies = yield* Effect.forEach(methods, () => Deferred.make<Uint8Array>())
        const transport = yield* connect({
          stdin: Sink.forEach((chunk: Uint8Array) => {
            const frame = decodeFrame(chunk)
            const index = methods.indexOf(frame.method!)
            return index < 0 ? Effect.void : Deferred.succeed(written[index]!, frame.id!)
          }),
          stdout: Stream.fromIterable(replies).pipe(
            Stream.flatMap((reply) => Stream.fromEffect(Deferred.await(reply))),
            Stream.concat(Stream.never)
          )
        })
        const callers = yield* Effect.forEach(
          methods,
          (method) => Effect.forkChild(transport.request(method), { startImmediately: true })
        )
        const ids = yield* Effect.forEach(written, Deferred.await)
        expect(new Set(ids).size).toBe(3)
        for (let index = 0; index < replies.length; index++) {
          const reverse = replies.length - index - 1
          yield* Deferred.succeed(replies[index]!, resultFrame(ids[reverse]!, `result-${methods[reverse]}`))
        }
        expect(yield* Effect.forEach(callers, Fiber.join)).toEqual(["result-one", "result-two", "result-three"])
      })).pipe(Effect.provide(TestClock.layer()))
    )
  })

  it("isolates one timeout and its late reply from concurrent and subsequent requests", async () => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const methods = ["abandoned", "healthy", "subsequent"]
        const written = yield* Effect.forEach(methods, () => Deferred.make<number>())
        const replies = yield* Effect.forEach(methods, () => Deferred.make<Uint8Array>())
        const cancelled = yield* Deferred.make<void>()
        const cancellations: Array<number | undefined> = []
        const transport = yield* connect({
          stdin: Sink.forEach((chunk: Uint8Array) =>
            Effect.gen(function*() {
              const frame = decodeFrame(chunk)
              if (frame.method === "notifications/cancelled") {
                cancellations.push(frame.params?.requestId)
                yield* Deferred.succeed(cancelled, undefined)
              }
              const index = methods.indexOf(frame.method!)
              if (index >= 0) yield* Deferred.succeed(written[index]!, frame.id!)
            })
          ),
          stdout: Stream.fromIterable(replies).pipe(
            Stream.flatMap((reply) => Stream.fromEffect(Deferred.await(reply))),
            Stream.concat(Stream.never)
          )
        })
        const abandoned = yield* Effect.forkChild(Effect.flip(transport.request("abandoned", undefined, 10)), {
          startImmediately: true
        })
        const healthy = yield* Effect.forkChild(transport.request("healthy"), { startImmediately: true })
        const abandonedId = yield* Deferred.await(written[0]!)
        const healthyId = yield* Deferred.await(written[1]!)
        yield* TestClock.adjust(10)
        expect(yield* Fiber.join(abandoned)).toMatchObject({ code: "timeout" })
        yield* Deferred.await(cancelled)
        expect(healthy.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(replies[0]!, resultFrame(abandonedId, "late-abandoned-result"))
        yield* Deferred.succeed(replies[1]!, resultFrame(healthyId, "healthy-result"))
        expect(yield* Fiber.join(healthy)).toBe("healthy-result")
        const subsequent = yield* Effect.forkChild(transport.request("subsequent"), { startImmediately: true })
        const subsequentId = yield* Deferred.await(written[2]!)
        expect(new Set([abandonedId, healthyId, subsequentId]).size).toBe(3)
        yield* Deferred.succeed(replies[2]!, resultFrame(subsequentId, "subsequent-result"))
        expect(yield* Fiber.join(subsequent)).toBe("subsequent-result")
        expect(cancellations).toEqual([abandonedId])
      })).pipe(Effect.provide(TestClock.layer()))
    )
  })
})
