/** Taking over a worker (`t`): each boundary parks for the person's message or release; the take-over is recorded. */
import { expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as Host from "../src/host.ts"
import * as Steering from "../src/steering.ts"
import { Workspace } from "../src/workspace.ts"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const texts = (drain: { readonly inserts: ReadonlyArray<{ readonly content: ReadonlyArray<unknown> }> }) =>
  drain.inserts.flatMap((message) => message.content.map((part) => (part as { text: string }).text))

it("parks each boundary once taken over, runs a frame per drive, and runs on after release", async () => {
  const queue = Steering.make()
  const drain = (boundary: string) => Effect.runPromise(queue.source.drain({ boundary, wouldIdle: false }))
  expect(texts(await drain("1"))).toEqual([])
  queue.hijack()
  let settled = false
  const second = drain("2").then((value) => {
    settled = true
    return value
  })
  await tick()
  expect(settled).toBe(false)
  expect(queue.holding()).toBe(true)
  queue.drive("use the cookie")
  expect(texts(await second)).toEqual(["use the cookie"])
  // A blank drive runs the next frame with nothing new.
  const third = drain("3")
  await tick()
  queue.drive("  ")
  expect(texts(await third)).toEqual([])
  // The same boundary answers the same way again, without parking.
  expect(texts(await drain("2"))).toEqual(["use the cookie"])
  const fourth = drain("4")
  await tick()
  queue.release()
  expect(texts(await fourth)).toEqual([])
  expect(texts(await drain("5"))).toEqual([])
  expect(queue.holding()).toBe(false)
})

it("lets a drive sent before the run reaches its boundary through that boundary, once", async () => {
  const queue = Steering.make()
  queue.hijack()
  queue.drive("early")
  expect(texts(await Effect.runPromise(queue.source.drain({ boundary: "1", wouldIdle: false })))).toEqual(["early"])
  let settled = false
  void Effect.runPromise(queue.source.drain({ boundary: "2", wouldIdle: false })).then(() => (settled = true))
  await tick()
  expect(settled).toBe(false)
  queue.release()
  await tick()
  expect(settled).toBe(true)
})

it("records who drove a worker, for how long and how many messages, and refuses a second take-over", async () => {
  const sources = new Map<string, Host.TurnInput>()
  const host: Host.Host = {
    cwd: mkdtempSync(join(tmpdir(), "tui-take-")),
    judged: false,
    compaction: async () => undefined,
    dispose: async () => {},
    run: (input) => {
      sources.set(input.source!, input)
      return { done: new Promise(() => {}), cancel: () => {} }
    }
  }
  const workspace = new Workspace({ host, workerSeat: "worker:test", history: () => [], persist: () => {} })
  workspace.request({ id: "w", title: "w", prompt: "w" })
  await tick()
  const tab = () => workspace.snapshot().tabs[0]!
  expect(workspace.drive("w", "early")).toBe(false)
  expect(workspace.hijack("w", "you")).toBe(true)
  expect(workspace.hijack("w", "you")).toBe(false)
  expect(tab().driver).toMatchObject({ by: "you", messages: 0 })
  const boundary = Effect.runPromise(sources.get("w")!.steering!.drain({ boundary: "1", wouldIdle: true }))
  await tick()
  expect(workspace.holding("w")).toBe(true)
  expect(workspace.drive("w", "check the refresh path")).toBe(true)
  expect(texts(await boundary)).toEqual(["check the refresh path"])
  expect(tab().driver).toMatchObject({ messages: 1 })
  expect(workspace.release("w")).toBe(true)
  expect(tab().driver).toBeUndefined()
  expect(tab().drivers).toEqual([{ by: "you", from: expect.any(Number), to: expect.any(Number), messages: 1 }])
  expect(workspace.transcript("w").items.filter((item) => item.kind === "note").map((item) => item.text)).toEqual([
    "⇄ you took over",
    "⇄ you released"
  ])
})

it("refuses a blank Enter while the run works, and a release drops a pending message's pass", async () => {
  const queue = Steering.make()
  queue.hijack()
  expect(queue.drive("")).toBe(false)
  expect(queue.drive("next")).toBe(true)
  queue.release()
  queue.hijack()
  let settled = false
  void Effect.runPromise(queue.source.drain({ boundary: "1", wouldIdle: false })).then(() => (settled = true))
  await tick()
  // The pass went with the release: this boundary waits again.
  expect(settled).toBe(false)
  expect(queue.drive("")).toBe(true)
  await tick()
  expect(settled).toBe(true)
})

it("frees the seat while it waits for the driver, and takes one back before the frame runs", async () => {
  const events: Array<string> = []
  let unpark: (() => void) | undefined
  const queue = Steering.make({
    parked: () => events.push("parked"),
    unparked: () => {
      events.push("unparked")
      return new Promise((resolve) => (unpark = resolve))
    }
  })
  queue.hijack()
  let settled = false
  void Effect.runPromise(queue.source.drain({ boundary: "1", wouldIdle: false })).then(() => (settled = true))
  await tick()
  expect(events).toEqual(["parked"])
  queue.drive("go")
  await tick()
  expect(events).toEqual(["parked", "unparked"])
  expect(settled).toBe(false)
  unpark!()
  await tick()
  expect(settled).toBe(true)
})

it("stops a worker parked for its driver, filing the take-over", async () => {
  const finish = new Map<string, (outcome: Host.Outcome) => void>()
  const inputs = new Map<string, Host.TurnInput>()
  const host: Host.Host = {
    cwd: mkdtempSync(join(tmpdir(), "tui-take-")),
    judged: false,
    compaction: async () => undefined,
    dispose: async () => {},
    run: (input) => {
      inputs.set(input.source!, input)
      return {
        done: new Promise((resolve) => finish.set(input.source!, resolve)),
        cancel: () => finish.get(input.source!)?.({ _tag: "cancelled" })
      }
    }
  }
  const workspace = new Workspace({ host, workerSeat: "worker:test", history: () => [], persist: () => {} })
  workspace.request({ id: "w", title: "w", prompt: "w" })
  await tick()
  workspace.hijack("w", "you")
  void Effect.runPromise(inputs.get("w")!.steering!.drain({ boundary: "1", wouldIdle: false })).catch(() => {})
  await tick()
  const tab = () => workspace.snapshot().tabs[0]!
  expect(workspace.holding("w")).toBe(true)
  // Parked for its driver, it holds no seat.
  expect(tab().status).toBe("waiting")
  workspace.cancel("w")
  await tick()
  expect(tab().status).toBe("cancelled")
  expect(tab().driver).toBeUndefined()
  expect(tab().drivers).toEqual([{ by: "you", from: expect.any(Number), to: expect.any(Number), messages: 0 }])
})

it("parks a restored worker that was taken over again at its first boundary", async () => {
  const inputs = new Map<string, Host.TurnInput>()
  const host: Host.Host = {
    cwd: mkdtempSync(join(tmpdir(), "tui-take-")),
    judged: false,
    compaction: async () => undefined,
    dispose: async () => {},
    run: (input) => {
      inputs.set(input.source!, input)
      return { done: new Promise(() => {}), cancel: () => {} }
    }
  }
  const records: Array<unknown> = []
  const first = new Workspace({
    host,
    workerSeat: "worker:test",
    history: () => [],
    persist: (record) => records.push(record)
  })
  first.request({ id: "w", title: "w", prompt: "w" })
  await tick()
  first.hijack("w", "you")
  const restored = { tabs: [first.snapshot().tabs[0]!], panels: [] }
  first.dispose()
  inputs.clear()
  const second = new Workspace({ host, workerSeat: "worker:test", history: () => [], persist: () => {}, restored })
  await tick()
  await tick()
  expect(second.snapshot().tabs[0]!.driver).toMatchObject({ by: "you" })
  let settled = false
  void Effect.runPromise(inputs.get("w")!.steering!.drain({ boundary: "1", wouldIdle: false })).then(
    () => (settled = true)
  )
  await tick()
  expect(settled).toBe(false)
  expect(second.holding("w")).toBe(true)
})

it("ends a take-over when the driven worker's host fails", async () => {
  let fail: (error: Error) => void = () => {}
  const host: Host.Host = {
    cwd: mkdtempSync(join(tmpdir(), "tui-take-")),
    judged: false,
    compaction: async () => undefined,
    dispose: async () => {},
    run: () => ({ done: new Promise((_, reject) => (fail = reject)), cancel: () => {} })
  }
  const workspace = new Workspace({ host, workerSeat: "worker:test", history: () => [], persist: () => {} })
  workspace.request({ id: "w", title: "w", prompt: "w" })
  await tick()
  workspace.hijack("w", "you")
  fail(new Error("host died"))
  await tick()
  await tick()
  const tab = workspace.snapshot().tabs[0]!
  expect(tab.status).toBe("failed")
  expect(tab.driver).toBeUndefined()
  expect(tab.drivers).toHaveLength(1)
})
