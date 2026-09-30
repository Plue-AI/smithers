import { expect, test } from "bun:test"
import { createNativeShutdown } from "./NativeShutdown"

type QuitEvent = { response?: { allow: boolean } }
type BeforeQuit = (event: QuitEvent) => void

// These are controlled callback units. No process exit, native SDK, filesystem,
// HTTP server, or scheduler tick is needed to observe the cleanup boundary.
const fixture = (reenterOnQuit = false) => {
  const cleanup = Promise.withResolvers<void>()
  const handlers: BeforeQuit[] = [], trace: string[] = [], finalEvents: QuitEvent[] = []
  let stops = 0
  const shutdown = createNativeShutdown({
    stop: () => { stops++; trace.push("stop"); return cleanup.promise },
    onBeforeQuit: handler => { handlers.push(handler) },
    log: message => { trace.push(`log:${message}`) },
    quit: code => {
      trace.push(`quit:${code}`)
      if (reenterOnQuit) {
        const event = { response: { allow: true } }
        handlers[0]!(event)
        finalEvents.push(event)
      }
    }
  })
  return { cleanup, handlers, trace, finalEvents, shutdown, stops: () => stops }
}

test("all direct shutdown callers wait for one cleanup and settled calls do no more work", async () => {
  const f = fixture()
  const initial = { stops: f.stops(), trace: [...f.trace], handlers: f.handlers.length }
  const callers = [f.shutdown(), f.shutdown()]
  const completed: number[] = []
  const observed = callers.map((caller, index) => caller.then(() => { completed.push(index) }))
  try {
    expect(initial).toEqual({ stops: 0, trace: [], handlers: 1 })
    expect(f.handlers).toHaveLength(1)
    // Complete the current microtask queue, including async wrappers, while
    // the actual cleanup gate remains unresolved. No timing delay is needed.
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(completed).toEqual([])
    expect([f.stops(), f.trace]).toEqual([1, ["stop"]])
    // A native event that already allowed quit is vetoed synchronously while
    // the direct caller is still waiting on its actual cleanup promise.
    const event: QuitEvent = { response: { allow: true } }
    f.handlers[0]!(event)
    expect(event.response).toEqual({ allow: false })
    observed.push(f.shutdown().then(() => { completed.push(2) }))
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(completed).toEqual([])
    expect([f.stops(), f.trace]).toEqual([1, ["stop"]])

    f.cleanup.resolve()
    await Promise.all(observed)
    expect([...completed].sort()).toEqual([0, 1, 2])
    expect(f.trace).toEqual(["stop", "quit:0"])
    await expect(f.shutdown()).resolves.toBeUndefined()
    expect([f.stops(), f.trace]).toEqual([1, ["stop", "quit:0"]])
  } finally {
    f.cleanup.resolve()
    await Promise.all(observed)
  }
})

test("completed cleanup permits the synchronous before-quit event raised inside quit", async () => {
  const f = fixture(true), pendingEvent: QuitEvent = {}
  f.handlers[0]!(pendingEvent)
  const completion = f.shutdown()
  try {
    expect(pendingEvent.response).toEqual({ allow: false })
    expect(f.trace).toEqual(["stop"])
    expect(f.finalEvents).toEqual([])
    f.cleanup.resolve()
    await completion
    // This observation happens inside quit(), before the returned shutdown
    // promise settles: the SDK can route process.exit through before-quit.
    expect(f.finalEvents).toEqual([{ response: { allow: true } }])
    expect([f.stops(), f.trace]).toEqual([1, ["stop", "quit:0"]])
    const final: QuitEvent = { response: { allow: true } }
    f.handlers[0]!(final)
    expect(final.response).toEqual({ allow: true })
    await expect(f.shutdown()).resolves.toBeUndefined()
    expect([f.stops(), f.trace]).toEqual([1, ["stop", "quit:0"]])
  } finally {
    f.cleanup.resolve()
    await completion
  }
})

test.each([
  { name: "Error", failure: new Error("database close refused"), expected: "Shutdown failed: database close refused" },
  { name: "AggregateError", failure: new AggregateError([new Error("backend stop refused")], "Native runtime shutdown failed."), expected: "Shutdown failed: Native runtime shutdown failed." },
  { name: "non-Error rejection", failure: "storage close refused", expected: "Shutdown failed: storage close refused" }
])("$name cleanup failure logs once then quits with status1 and releases the caller", async ({ failure, expected }) => {
  const f = fixture(true), event: QuitEvent = { response: { allow: true } }
  f.handlers[0]!(event)
  const callers = [f.shutdown(), f.shutdown()]
  const completed: number[] = []
  const observed = callers.map((caller, index) => caller.then(() => { completed.push(index) }))
  try {
    expect(event.response).toEqual({ allow: false })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(completed).toEqual([])
    expect([f.stops(), f.trace]).toEqual([1, ["stop"]])
    f.cleanup.reject(failure)
    await Promise.all(observed)
    expect([...completed].sort()).toEqual([0, 1])
    expect(f.trace).toEqual(["stop", `log:${expected}`, "quit:1"])
    expect(f.finalEvents).toEqual([{ response: { allow: true } }])
    const final: QuitEvent = {}
    f.handlers[0]!(final)
    expect(final).toEqual({})
    await expect(f.shutdown()).resolves.toBeUndefined()
    expect([f.stops(), f.trace]).toEqual([1, ["stop", `log:${expected}`, "quit:1"]])
  } finally {
    f.cleanup.resolve()
    await Promise.all(observed)
  }
})

test("a synchronous cleanup callback throw is handled once without rejecting shutdown", async () => {
  const trace: string[] = [], handlers: BeforeQuit[] = []
  const shutdown = createNativeShutdown({
    stop: () => { trace.push("stop"); throw new Error("cleanup could not start") },
    onBeforeQuit: handler => { handlers.push(handler) },
    log: message => { trace.push(`log:${message}`) },
    quit: code => { trace.push(`quit:${code}`) }
  })
  const first = shutdown()
  await expect(first).resolves.toBeUndefined()
  expect(trace).toEqual(["stop", "log:Shutdown failed: cleanup could not start", "quit:1"])
  await expect(shutdown()).resolves.toBeUndefined()
  const event: QuitEvent = { response: { allow: true } }
  handlers[0]!(event)
  expect(event.response).toEqual({ allow: true })
  await shutdown()
  expect(trace).toEqual(["stop", "log:Shutdown failed: cleanup could not start", "quit:1"])
})

test("independent native lifecycles settle separately without releasing another pending quit", async () => {
  const first = fixture(), second = fixture()
  let firstCompleted = false, secondCompleted = false
  const firstDone = first.shutdown().then(() => { firstCompleted = true })
  const secondDone = second.shutdown().then(() => { secondCompleted = true })
  try {
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect([firstCompleted, secondCompleted]).toEqual([false, false])
    first.cleanup.resolve()
    await firstDone
    expect([firstCompleted, secondCompleted]).toEqual([true, false])
    const stillPending: QuitEvent = { response: { allow: true } }
    second.handlers[0]!(stillPending)
    expect(stillPending.response).toEqual({ allow: false })
    expect([first.trace, second.trace]).toEqual([["stop", "quit:0"], ["stop"]])
    second.cleanup.resolve()
    await secondDone
    expect([firstCompleted, secondCompleted]).toEqual([true, true])
    expect([first.stops(), second.stops()]).toEqual([1, 1])
    expect([first.trace, second.trace]).toEqual([["stop", "quit:0"], ["stop", "quit:0"]])
  } finally {
    first.cleanup.resolve(); second.cleanup.resolve()
    await Promise.all([firstDone, secondDone])
  }
})
