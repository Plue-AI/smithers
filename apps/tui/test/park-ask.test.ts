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

for (const action of ["drive", "release"] as const) {
  it(`does not treat older steering as a park answer after a blank ${action}`, async () => {
    const asked: Array<string> = []
    const queue = Steering.make({
      ask: async (question) => {
        asked.push(question)
        return "sum"
      }
    })
    queue.steer("check formatting")
    queue.hijack()
    const drained = Effect.runPromise(queue.source.drain({ boundary: "1:park:0", wouldIdle: true, park }))
    await tick()
    if (action === "drive") queue.drive("")
    else queue.release()
    expect(texts(await drained)).toEqual(["check formatting", "sum"])
    expect(asked).toEqual([park.message])
  })

  it(`still asks after a ${action} supplies no answer to a taken-over park`, async () => {
    const asked: Array<string> = []
    let reply: (answer: string) => void = () => {}
    const queue = Steering.make({
      ask: (question) => {
        asked.push(question)
        return new Promise((resolve) => (reply = resolve))
      }
    })
    queue.hijack()
    let settled = false
    const drained = Effect.runPromise(queue.source.drain({ boundary: "1:park:0", wouldIdle: true, park }))
      .then((value) => {
        settled = true
        return value
      })
    await tick()
    expect(queue.holding()).toBe(true)
    if (action === "drive") expect(queue.drive("  ")).toBe(true)
    else queue.release()
    await tick()
    expect(asked).toEqual([park.message])
    expect(settled).toBe(false)
    reply("sum")
    expect(texts(await drained)).toEqual(["sum"])
    expect(texts(await Effect.runPromise(queue.source.drain({ boundary: "1:park:0", wouldIdle: true, park }))))
      .toEqual(["sum"])
    expect(asked).toEqual([park.message])
  })

  it(`fails after a ${action} leaves a taken-over park without an answer channel`, async () => {
    const queue = Steering.make()
    queue.hijack()
    const drained = Effect.runPromiseExit(queue.source.drain({ boundary: "1:park:0", wouldIdle: true, park }))
    await tick()
    if (action === "drive") queue.drive("")
    else queue.release()
    const outcome = await drained
    expect(Exit.isFailure(outcome)).toBe(true)
    expect(JSON.stringify(outcome)).toContain(`No one answered: ${park.message}`)
  })
}

it("lets a nonblank drive queued before the park answer it once", async () => {
  const asked: Array<string> = []
  const queue = Steering.make({
    ask: async (question) => {
      asked.push(question)
      return "should not be used"
    }
  })
  queue.hijack()
  queue.drive("plus")
  expect(texts(await Effect.runPromise(queue.source.drain({ boundary: "1:park:0", wouldIdle: true, park }))))
    .toEqual(["plus"])
  expect(asked).toEqual([])
})

it("asks on a later park after earlier queued drives have already been delivered", async () => {
  const asked: Array<string> = []
  const queue = Steering.make({
    ask: async (question) => {
      asked.push(question)
      return "sum"
    }
  })
  queue.hijack()
  queue.drive("first instruction")
  queue.drive("second instruction")
  expect(texts(await Effect.runPromise(queue.source.drain({ boundary: "0", wouldIdle: false }))))
    .toEqual(["first instruction", "second instruction"])
  queue.steer("unrelated steer")
  expect(texts(await Effect.runPromise(queue.source.drain({ boundary: "1:park:0", wouldIdle: true, park }))))
    .toEqual(["unrelated steer", "sum"])
  expect(asked).toEqual([park.message])
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
