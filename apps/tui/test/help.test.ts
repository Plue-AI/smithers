/** `ctx.help` through the worker's own runtime flows: `agent.wait`, `agent.answer`, and the asker's seat. */
import { expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Asks from "../src/asks.ts"
import type * as Host from "../src/host.ts"
import * as Runtime from "../src/runtime.ts"
import { Workspace } from "../src/workspace.ts"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const setup = async () => {
  const controls = new Map<string, (answer: Host.Outcome) => void>()
  const runtime = new Map<string, Runtime.Ports>()
  const inputs = new Map<string, Host.TurnInput>()
  const host: Host.Host = {
    cwd: mkdtempSync(join(tmpdir(), "tui-help-")),
    judged: false,
    compaction: async () => undefined,
    dispose: async () => {},
    run: (input) => {
      runtime.set(input.source!, input.runtime!)
      inputs.set(input.source!, input)
      return { done: new Promise((resolve) => controls.set(input.source!, resolve)), cancel: () => {} }
    }
  }
  const workspace = new Workspace({ host, workerSeat: "worker:test", history: () => [], persist: () => {} })
  workspace.request({ id: "plan", title: "Plan", prompt: "Plan it" })
  await tick()
  const flow = async (tab: string, name: string) =>
    (await Effect.runPromise(Runtime.source(runtime.get(tab)!).bindings())).find((each) =>
      each.descriptor.name === name
    )!
  const call = async (tab: string, name: string, input: unknown) =>
    Effect.runPromise((await flow(tab, name)).run({ input } as never))
  await call("plan", "agent.delegate", { id: "impl", title: "impl", prompt: "Implement" })
  await tick()
  const status = (id: string) => workspace.snapshot().tabs.find((tab) => tab.id === id)?.status
  return { workspace, runtime, inputs, controls, call, status }
}

it("returns a parent's wait early with its child's ask, even one it was told while running, once", async () => {
  const { workspace, runtime, call, status } = await setup()
  const answer = runtime.get("plan/impl")!.ask!({ question: "Cookie or bearer?", options: ["cookie", "bearer"] })
  await tick()
  // The parent is running: it is told before its next frame, as a note in its tab, not as the person's words.
  const [ask] = workspace.asks.list()
  expect(ask).toMatchObject({ from: "plan/impl", holder: "plan" })
  expect(workspace.transcript("plan").items.at(-1)).toMatchObject({ kind: "note" })
  expect(status("plan/impl")).toBe("waiting")
  // It then waits on the asking child before reading the message: the wait still returns with the ask.
  const waited = await call("plan", "agent.wait", { ids: ["impl"] })
  expect(waited).toMatchObject({
    outcome: "success",
    value: [{ id: "plan/impl", ask: { id: ask!.id, question: "Cookie or bearer?", options: ["cookie", "bearer"] } }]
  })
  expect(await call("plan", "agent.answer", { id: ask!.id, answer: "cookie" })).toMatchObject({
    outcome: "success",
    value: { id: ask!.id, status: "answered" }
  })
  expect(await answer).toEqual({ answer: "cookie", approved: true })
  await tick()
  expect(status("plan/impl")).toBe("running")
})

it("moves an ask up when its parent waits again without answering, so the wait never deadlocks", async () => {
  const { workspace, runtime, controls, call } = await setup()
  const answer = runtime.get("plan/impl")!.ask!({ question: "q?" })
  await tick()
  await call("plan", "agent.wait", { ids: ["impl"] })
  const again = call("plan", "agent.wait", { ids: ["impl"] })
  await tick()
  expect(workspace.asks.list()[0]).toMatchObject({ holder: Asks.person, trail: ["plan", Asks.person] })
  expect(workspace.asks.answer(workspace.asks.list()[0]!.id, "yes")).toBe(true)
  expect(await answer).toEqual({ answer: "yes", approved: true })
  controls.get("plan/impl")!({ _tag: "done", answer: "done" })
  expect(await again).toMatchObject({ outcome: "success", value: [{ id: "plan/impl", status: "done" }] })
})

it("refuses an answer from an agent that does not hold the ask", async () => {
  const { runtime, call, workspace } = await setup()
  void runtime.get("plan/impl")!.ask!({ question: "q?", to: "person" })
  await tick()
  const refused = await call("plan", "agent.answer", { id: workspace.asks.list()[0]!.id, answer: "x" })
  expect(refused).toMatchObject({ outcome: "failure" })
})

it("binds ask for workers, unbounded like agent.wait", () => {
  expect(Runtime.waiting).toEqual(["agent.wait", "ask"])
})
