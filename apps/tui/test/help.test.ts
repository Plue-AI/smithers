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

const unresolved = {
  _tag: "@smthrs/agent/Seat/SeatUnresolved",
  seat: "claude-code:opus",
  message: "Run `claude auth login`, then retry."
}
const failWith = (controls: Map<string, (outcome: Host.Outcome) => void>, id: string, error: unknown) =>
  controls.get(id)!({ _tag: "failed", message: "failed", detail: "", error })

it("hands a parent already waiting the failed worker's sign-in question, and a retry relaunches it", async () => {
  const { workspace, controls, call, status } = await setup()
  const waiting = call("plan", "agent.wait", { ids: ["impl"] })
  await tick()
  failWith(controls, "plan/impl", unresolved)
  const waited = await waiting
  expect(waited).toMatchObject({
    outcome: "success",
    value: [{
      id: "plan/impl",
      status: "failed",
      message: "failed",
      ask: { question: "Model sign-in required. Run `claude auth login`, then retry.", options: ["retry", "stop"] }
    }]
  })
  const ask = (waited as unknown as { value: ReadonlyArray<{ ask: { id: string } }> }).value[0]!.ask
  await call("plan", "agent.answer", { id: ask.id, answer: "Retry" })
  await tick()
  expect(status("plan/impl")).toBe("running")
  expect(workspace.asks.list()).toEqual([])
})

it("leaves the worker failed when the answer is stop", async () => {
  const { workspace, controls, status } = await setup()
  failWith(controls, "plan/impl", unresolved)
  await tick()
  expect(workspace.asks.answer(workspace.asks.list()[0]!.id, "stop")).toBe(true)
  await tick()
  expect(status("plan/impl")).toBe("failed")
  expect(workspace.asks.list()).toEqual([])
})

it("asks about a person's refusal and a plan that did not converge, and about nothing a person cannot help", async () => {
  const cases = [
    [
      { _tag: "@smthrs/flow/HumanTaskFailed", code: "rejected", task: "t", attempts: 1, rejections: [], message: "m" },
      1
    ],
    [{
      _tag: "/harness/HarnessError",
      code: "model_failed",
      message: "m",
      cause: { _tag: "FramesExhausted", frames: 6 }
    }, 1],
    [{ _tag: "flows/model/ModelError", code: "quota_exceeded", message: "limit" }, 0],
    [{ _tag: "coding/Error", code: "declined", message: "already fixed" }, 0],
    [{ _tag: "flows/agent/BudgetExceeded", scope: "tokens", message: "cap" }, 0]
  ] as const
  for (const [error, asks] of cases) {
    const { workspace, controls } = await setup()
    failWith(controls, "plan/impl", error)
    await tick()
    expect(workspace.asks.list(), JSON.stringify(error)).toHaveLength(asks)
  }
})

it("asks nothing for a top-level worker: its failure card already asks the person", async () => {
  const { workspace, controls, status } = await setup()
  failWith(controls, "plan", unresolved)
  await tick()
  expect(status("plan")).toBe("failed")
  expect(workspace.asks.list().filter((ask) => ask.from === "plan")).toEqual([])
})

it("withdraws the ask when the worker is retried another way, or its parent stops or finishes", async () => {
  const retried = await setup()
  failWith(retried.controls, "plan/impl", unresolved)
  await tick()
  expect(retried.workspace.asks.list()).toHaveLength(1)
  retried.workspace.retry("plan/impl")
  await tick()
  expect(retried.workspace.asks.list()).toEqual([])
  const stopped = await setup()
  failWith(stopped.controls, "plan/impl", unresolved)
  await tick()
  expect(stopped.workspace.asks.list()).toHaveLength(1)
  stopped.controls.get("plan")!({ _tag: "cancelled" })
  await tick()
  expect(stopped.workspace.asks.list()).toEqual([])
  const finished = await setup()
  failWith(finished.controls, "plan/impl", unresolved)
  await tick()
  expect(finished.workspace.asks.list()).toHaveLength(1)
  finished.controls.get("plan")!({ _tag: "done", answer: "done" })
  await tick()
  expect(finished.workspace.asks.list()).toEqual([])
})

it("asks for help at most twice in a worker's life, then lets a third failure stand", async () => {
  const { workspace, controls, status } = await setup()
  for (const round of [1, 2, 3]) {
    failWith(controls, "plan/impl", unresolved)
    await tick()
    expect(status("plan/impl")).toBe("failed")
    const open = workspace.asks.list()
    expect(open, `round ${round}`).toHaveLength(round < 3 ? 1 : 0)
    if (round < 3) {
      workspace.asks.answer(open[0]!.id, "retry")
      await tick()
      expect(status("plan/impl")).toBe("running")
    }
  }
})

it("refuses an answer that is not one of the ask's options, and keeps the ask open", async () => {
  const { workspace, controls, call, status } = await setup()
  const waiting = call("plan", "agent.wait", { ids: ["impl"] })
  await tick()
  failWith(controls, "plan/impl", unresolved)
  await waiting
  const [ask] = workspace.asks.list()
  expect(await call("plan", "agent.answer", { id: ask!.id, answer: "Retry." })).toMatchObject({ outcome: "failure" })
  expect(workspace.asks.list()).toHaveLength(1)
  expect(await call("plan", "agent.answer", { id: ask!.id, answer: " RETRY " })).toMatchObject({ outcome: "success" })
  await tick()
  expect(status("plan/impl")).toBe("running")
})

it("matches an option whatever its case, and passes the option through as written", async () => {
  const { workspace, runtime, call } = await setup()
  const answer = runtime.get("plan/impl")!.ask!({ question: "Cookie or bearer?", options: ["Cookie", "Bearer"] })
  await tick()
  const [ask] = workspace.asks.list()
  expect(await call("plan", "agent.answer", { id: ask!.id, answer: "cookie" })).toMatchObject({ outcome: "success" })
  expect(await answer).toEqual({ answer: "Cookie", approved: true })
})
