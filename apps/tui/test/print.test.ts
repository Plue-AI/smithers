import { expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as Host from "../src/host.ts"
import * as Print from "../src/print.ts"
import * as Runtime from "../src/runtime.ts"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A host whose runs settle only when the test says so; it records every run's input. */
const fake = (overrides: Partial<Host.Host> = {}) => {
  const controls = new Map<string, (outcome: Host.Outcome) => void>()
  const inputs = new Map<string, Host.TurnInput>()
  const cancelled: Array<string> = []
  const host: Host.Host = {
    cwd: mkdtempSync(join(tmpdir(), "tui-print-")),
    judged: false,
    dispose: async () => {},
    run: (input) => {
      inputs.set(input.source!, input)
      return {
        done: new Promise((resolve) => controls.set(input.source!, resolve)),
        cancel: () => {
          cancelled.push(input.source!)
          controls.get(input.source!)?.({ _tag: "cancelled" })
        }
      }
    },
    ...overrides
  }
  return { host, controls, inputs, cancelled }
}

const flow = async (ports: Runtime.Ports, name: string) => {
  const bindings = await Effect.runPromise(Runtime.source(ports).bindings())
  return bindings.find((binding) => binding.descriptor.name === name)!
}

it("runs the prompt as a worker that delegates, waits for its children and prints their aggregate", async () => {
  const { host, controls, inputs } = fake()
  const printed = Print.run({ host, prompt: "Review the range", workerSeat: "worker:test", delegable: [] })
  await tick()
  const root = inputs.get(Print.rootId)!
  expect(root).toMatchObject({ prompt: "Review the range", role: "worker", seat: "worker:test" })
  const delegate = await flow(root.runtime!, "agent.delegate")
  const wait = await flow(root.runtime!, "agent.wait")
  for (const id of ["billing", "auth"]) {
    expect(await Effect.runPromise(delegate.run({ input: { id, title: id, prompt: `Review ${id}` } } as never)))
      .toMatchObject({ outcome: "success", value: { id: `${Print.rootId}/${id}` } })
  }
  await tick()
  expect(inputs.get(`${Print.rootId}/billing`)).toMatchObject({ prompt: "Review billing", role: "worker" })
  const waited = Effect.runPromise(wait.run({ input: { ids: ["billing", "auth"] } } as never))
  controls.get(`${Print.rootId}/billing`)!({ _tag: "done", answer: "2 defects" })
  controls.get(`${Print.rootId}/auth`)!({ _tag: "done", answer: "clean" })
  expect(await waited).toMatchObject({
    outcome: "success",
    value: [{ status: "done", answer: "2 defects" }, { status: "done", answer: "clean" }]
  })
  controls.get(Print.rootId)!({ _tag: "done", answer: "billing: 2 defects; auth: clean" })
  expect(await printed).toEqual({ _tag: "done", answer: "billing: 2 defects; auth: clean" })
})

it("refuses a delegate model this machine cannot reach before any child starts", async () => {
  const { host, inputs, controls } = fake()
  const printed = Print.run({ host, prompt: "Review", workerSeat: "worker:test", delegable: ["sol"] })
  await tick()
  const delegate = await flow(inputs.get(Print.rootId)!.runtime!, "agent.delegate")
  expect(
    await Effect.runPromise(
      delegate.run({ input: { id: "fast", title: "Fast", prompt: "x", model: "cerebras" } } as never)
    )
  ).toMatchObject({
    outcome: "failure",
    message: "Flow agent.delegate failed: Model cerebras is not available here; use sol or omit model"
  })
  await tick()
  expect([...inputs.keys()]).toEqual([Print.rootId])
  controls.get(Print.rootId)!({ _tag: "done", answer: "done" })
  await printed
})

it("refuses an ask that reaches the person at once, since nobody is at the terminal", async () => {
  const { host, inputs, controls } = fake()
  const printed = Print.run({ host, prompt: "Review", workerSeat: "worker:test", delegable: [] })
  await tick()
  const ports = inputs.get(Print.rootId)!.runtime!
  expect(ports.ask!({ question: "Which range?", options: ["a", "b"] })).rejects.toThrow(Print.unattended)
  // A child's ask goes to its parent first; only past the root does it reach the person.
  const delegate = await flow(ports, "agent.delegate")
  await Effect.runPromise(delegate.run({ input: { id: "child", title: "Child", prompt: "x" } } as never))
  await tick()
  const child = inputs.get(`${Print.rootId}/child`)!.runtime!
  const asked = child.ask!({ question: "Approve the deploy?", to: "person" })
  expect(asked).rejects.toThrow(Print.unattended)
  await asked.catch(() => {})
  controls.get(`${Print.rootId}/child`)!({ _tag: "done", answer: "done" })
  controls.get(Print.rootId)!({ _tag: "done", answer: "done" })
  expect(await printed).toEqual({ _tag: "done", answer: "done" })
})

it("stops unfinished children once the root settles, and reports a root failure", async () => {
  const { host, inputs, controls, cancelled } = fake()
  const printed = Print.run({ host, prompt: "Review", workerSeat: "worker:test", delegable: [] })
  await tick()
  const delegate = await flow(inputs.get(Print.rootId)!.runtime!, "agent.delegate")
  await Effect.runPromise(delegate.run({ input: { id: "slow", title: "Slow", prompt: "x" } } as never))
  await tick()
  controls.get(Print.rootId)!({ _tag: "failed", message: "boom", detail: "boom" })
  const outcome = await printed
  expect(outcome).toMatchObject({ _tag: "failed", headline: expect.any(String) })
  expect(cancelled).toEqual([`${Print.rootId}/slow`])
})

it("keeps a named model: no routing, and every worker nobody chose a seat for runs on it", async () => {
  const { host, inputs, controls } = fake({ routes: true })
  const printed = Print.run({
    host,
    prompt: "Review",
    workerSeat: "worker:test",
    model: "openai:gpt-6.1-sol",
    delegable: []
  })
  await tick()
  const root = inputs.get(Print.rootId)!
  expect(root.seat).toBe("openai:gpt-6.1-sol")
  const delegate = await flow(root.runtime!, "agent.delegate")
  await Effect.runPromise(delegate.run({ input: { id: "child", title: "Child", prompt: "x" } } as never))
  await tick()
  expect(inputs.get(`${Print.rootId}/child`)?.seat).toBe("openai:gpt-6.1-sol")
  controls.get(`${Print.rootId}/child`)!({ _tag: "done", answer: "ok" })
  controls.get(Print.rootId)!({ _tag: "done", answer: "ok" })
  await printed
})

it("routes the root like any unchosen worker when no model is named", async () => {
  const { host, inputs, controls } = fake({ routes: true })
  const printed = Print.run({ host, prompt: "Review", workerSeat: "worker:test", delegable: [] })
  await tick()
  expect(inputs.get(Print.rootId)?.seat).toBe("auto")
  controls.get(Print.rootId)!({ _tag: "done", answer: "ok" })
  await printed
})

it("reports each denied flow once on the notice line, from any worker", async () => {
  const { host, inputs, controls } = fake()
  const lines: Array<string> = []
  const printed = Print.run({
    host,
    prompt: "Review",
    workerSeat: "worker:test",
    delegable: [],
    onNotice: (line) => lines.push(line)
  })
  await tick()
  const denial = {
    _tag: "cell-call-settled",
    flowName: "bash",
    result: { outcome: "failure", code: "capability_refused", message: "Denied: bash" }
  }
  inputs.get(Print.rootId)!.onEvent(denial as never)
  inputs.get(Print.rootId)!.onEvent(denial as never)
  controls.get(Print.rootId)!({ _tag: "done", answer: "ok" })
  await printed
  expect(lines).toEqual(["denied bash; SMITHERS_TUI_APPROVE=all allows"])
})
