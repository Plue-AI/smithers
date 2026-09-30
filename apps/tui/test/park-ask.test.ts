/** A worker's `ctx.park` asks the person: its boundary waits for their answer, and with no one to ask it fails. */
import { expect, it } from "bun:test"
import { Effect, Exit } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Asks from "../src/asks.ts"
import type * as Host from "../src/host.ts"
import * as Steering from "../src/steering.ts"
import { Workspace } from "../src/workspace.ts"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const texts = (drain: { readonly inserts: ReadonlyArray<{ readonly content: ReadonlyArray<unknown> }> }) =>
  drain.inserts.flatMap((message) => message.content.map((part) => (part as { text: string }).text))
const park = { reason: "waiting-input", message: "New name for add()?" } as const

it("holds a park's boundary until the person answers, then delivers the answer once", async () => {
  const asked: Array<string> = []
  let reply: (answer: string) => void = () => {}
  const queue = Steering.make({
    ask: (question) => {
      asked.push(question)
      return new Promise((resolve) => (reply = resolve))
    }
  })
  let settled = false
  const drained = Effect.runPromise(queue.source.drain({ boundary: "1:park:0", wouldIdle: true, park }))
    .then((value) => {
      settled = true
      return value
    })
  await tick()
  expect(asked).toEqual(["New name for add()?"])
  expect(settled).toBe(false)
  reply("sum")
  expect(texts(await drained)).toEqual(["sum"])
  // The same boundary answers the same way again without asking twice; other boundaries never ask.
  expect(texts(await Effect.runPromise(queue.source.drain({ boundary: "1:park:0", wouldIdle: true, park }))))
    .toEqual(["sum"])
  expect(texts(await Effect.runPromise(queue.source.drain({ boundary: "2", wouldIdle: false })))).toEqual([])
  expect(asked).toEqual(["New name for add()?"])
})

it("fails a park loudly when no one can answer it, never answering it itself", async () => {
  const unasked = await Effect.runPromiseExit(
    Steering.make().source.drain({ boundary: "1:park:0", wouldIdle: true, park })
  )
  expect(Exit.isFailure(unasked)).toBe(true)
  expect(JSON.stringify(unasked)).toContain("No one answered: New name for add()?")
  const withdrawn = await Effect.runPromiseExit(
    Steering.make({ ask: () => Promise.reject(new Error("Ask withdrawn")) }).source.drain({
      boundary: "1:park:0",
      wouldIdle: true,
      park
    })
  )
  expect(Exit.isFailure(withdrawn)).toBe(true)
  expect(JSON.stringify(withdrawn)).toContain("suspended")
})

it("lets the driver's message answer a park while the person drives the worker", async () => {
  const asked: Array<string> = []
  const queue = Steering.make({
    ask: (question) => {
      asked.push(question)
      return new Promise(() => {})
    }
  })
  queue.hijack()
  const drained = Effect.runPromise(queue.source.drain({ boundary: "1:park:0", wouldIdle: true, park }))
  await tick()
  queue.drive("plus")
  expect(texts(await drained)).toEqual(["plus"])
  expect(asked).toEqual([])
})

it("puts a worker's park to the person as an ask under their name, frees its seat, and shows the answer", async () => {
  const inputs = new Map<string, Host.TurnInput>()
  const host: Host.Host = {
    cwd: mkdtempSync(join(tmpdir(), "tui-park-ask-")),
    judged: false,
    dispose: async () => {},
    run: (input) => {
      inputs.set(input.source!, input)
      return { done: new Promise(() => {}), cancel: () => {} }
    }
  }
  const workspace = new Workspace({ host, workerSeat: "worker:test", history: () => [], persist: () => {} })
  workspace.request({ id: "rename", title: "Rename add() in math.js", prompt: "Rename add()." })
  await tick()
  expect(workspace.snapshot().tabs[0]!.status).toBe("running")
  const boundary = Effect.runPromise(
    inputs.get("rename")!.steering!.drain({ boundary: "1:park:0", wouldIdle: true, park })
  )
  await tick()
  const [ask] = workspace.asks.list()
  expect(ask).toMatchObject({ from: "rename", holder: Asks.person, question: "New name for add()?" })
  expect(workspace.snapshot().tabs[0]!.status).toBe("waiting")
  expect(workspace.asks.answer(ask!.id, "sum")).toBe(true)
  expect(texts(await boundary)).toEqual(["sum"])
  expect(workspace.snapshot().tabs[0]!.status).toBe("running")
  expect(workspace.transcript("rename").items.filter((item) => item.kind === "user").map((item) => item.text))
    .toContain("sum")
  workspace.dispose()
})
