/** Flow runs over a controllable fake Port: persistence, receipts, and settlement only from the watch. */
import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import * as Agents from "../src/agents.ts"
import {
  actions,
  type Card,
  discoveryNotice,
  FlowDiscoveryFailed,
  FlowError,
  FlowRuns,
  interrupted,
  type Listed,
  type Port,
  type Run,
  type Settled
} from "../src/flows.ts"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"
import { Workspace } from "../src/workspace.ts"

/** A module flow as discovery lists it. */
const flow = (name: string, description: string, modelInvocable = true): Listed => ({
  name,
  description,
  modelInvocable,
  kind: "module",
  flows: [],
  capabilities: [],
  path: `/repo/flows/${name}/flow.ts`
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

interface Pending<A> {
  readonly promise: Promise<A>
  readonly resolve: (value: A) => void
  readonly reject: (error: unknown) => void
}
const pending = <A>(): Pending<A> => {
  let resolve!: (value: A) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<A>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Every method records its call; the test resolves each promise or leaves it pending. */
const fake = (options: { listed?: ReadonlyArray<Listed>; schema?: Schema.Top; refuseCancel?: boolean } = {}) => {
  const calls: Array<string> = []
  const inputs: Array<Pending<Schema.Top | undefined>> = []
  const plans: Array<Pending<Card>> = []
  const starts: Array<Pending<string>> = []
  const resumes: Array<Pending<{ runId: string } | Settled>> = []
  const watches: Array<{ done: Pending<Settled>; emit: (event: unknown) => void }> = []
  const auto = { input: true, plan: true, start: true }
  const listed = options.listed ?? [flow("review", "Review a change")]
  const port: Port = {
    discover: async () => {
      calls.push("discover")
      return listed
    },
    input: (flow) => {
      calls.push(`input:${flow}`)
      const next = pending<Schema.Top | undefined>()
      inputs.push(next)
      if (auto.input) next.resolve(options.schema)
      return next.promise
    },
    body: async (flow) => {
      calls.push(`body:${flow}`)
      throw new FlowError("refused", `${flow} is a module flow`)
    },
    plan: (flow, input) => {
      calls.push(`plan:${flow}:${JSON.stringify(input)}`)
      const next = pending<Card>()
      plans.push(next)
      if (auto.plan) next.resolve({ raw: {} })
      return next.promise
    },
    start: () => {
      calls.push("start")
      const next = pending<string>()
      starts.push(next)
      if (auto.start) next.resolve(`run-${starts.length}`)
      return next.promise
    },
    resume: (runId) => {
      calls.push(`resume:${runId}`)
      const next = pending<{ runId: string } | Settled>()
      resumes.push(next)
      return next.promise
    },
    watch: (runId, onEvent) => {
      calls.push(`watch:${runId}`)
      const done = pending<Settled>()
      watches.push({ done, emit: (event) => onEvent(event as Parameters<typeof onEvent>[0]) })
      return { done: done.promise, close: () => calls.push(`close:${runId}`) }
    },
    events: async (runId) => {
      calls.push(`events:${runId}`)
      return []
    },
    cancel: async (runId) => {
      calls.push(`cancel:${runId}`)
      if (options.refuseCancel === true) throw new Error("Cancel refused")
    },
    dispose: async () => {}
  }
  return { port, calls, inputs, plans, starts, resumes, watches, auto }
}

const setup = (options: Parameters<typeof fake>[0] & { restored?: ReadonlyArray<Run> } = {}) => {
  const port = fake(options)
  const records: Array<Session.Record> = []
  const runs = new FlowRuns({ port: port.port, persist: (record) => records.push(record), restored: options.restored })
  return { ...port, records, runs }
}

const call = (event: string, nodeId: number) => ({
  sequence: nodeId,
  kind: event,
  runId: "run-1",
  occurredAt: nodeId,
  payload: { flowName: "bash", input: { command: "ls" }, output: "ok", callId: `c${nodeId}` }
})

describe("flow runs", () => {
  it("keeps the newest discovery when refresh responses overlap", async () => {
    const f = setup()
    const first = pending<ReadonlyArray<Listed>>()
    const second = pending<ReadonlyArray<Listed>>()
    const queue = [first, second]
    Object.assign(f.port, { discover: () => queue.shift()!.promise })
    f.runs.refresh()
    f.runs.refresh()
    const newest = [flow("new", "")]
    second.resolve(newest)
    await tick()
    first.resolve([flow("old", "")])
    await tick()
    expect(f.runs.listed()).toEqual(newest)
    f.runs.dispose()
  })

  it("persists and acknowledges before any port call and deduplicates", () => {
    const f = setup()
    expect(f.runs.request({ id: "r1", flow: "review", input: {}, by: "agent" })).toEqual({
      id: "r1",
      status: "requested"
    })
    expect(f.records).toHaveLength(1)
    expect(f.records[0]).toMatchObject({ type: "flow", run: { id: "r1", flow: "review", status: "requested" } })
    expect(f.calls).toEqual([])
    expect(f.runs.busy).toBe(true)
    expect(f.runs.request({ id: "r1", flow: "review", input: {}, by: "agent" })).toEqual({
      id: "r1",
      status: "requested"
    })
    expect(f.records).toHaveLength(1)
    expect(() => f.runs.request({ id: "r1", flow: "review", input: { title: "x" }, by: "agent" })).toThrow(
      "another request"
    )
  })

  it("an unresolved input() keeps it busy, and cancel ignores the stale answer", async () => {
    const f = setup({ schema: Schema.Struct({}) })
    f.auto.input = false
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    expect(f.calls).toEqual(["discover", "input:review"])
    expect(f.runs.busy).toBe(true)
    f.runs.cancel("r1")
    expect(f.runs.get("r1")?.status).toBe("cancelled")
    expect(f.runs.busy).toBe(false)
    f.inputs[0]!.resolve(Schema.Struct({}))
    await tick()
    expect(f.calls.some((each) => each.startsWith("plan"))).toBe(false)
    expect(f.runs.get("r1")?.status).toBe("cancelled")
  })

  it("missing required input parks for a form, and fill proceeds to launch", async () => {
    const f = setup({ schema: Schema.Struct({ title: Schema.String }) })
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    expect(f.runs.get("r1")).toMatchObject({ status: "input", message: "Needs: Title" })
    expect(f.calls.some((each) => each.startsWith("plan"))).toBe(false)
    expect(f.runs.panel("r1").rows[0]).toMatchObject({ id: "act", label: "Fill in" })
    f.runs.fill("r1", { title: "x" })
    await tick()
    expect(f.calls).toContain(`plan:review:{"title":"x"}`)
    expect(f.calls).toContain("start")
    expect(f.calls).toContain("watch:run-1")
    expect(f.runs.get("r1")).toMatchObject({ status: "running", runId: "run-1", input: { title: "x" } })
    expect(f.records.at(-1)).toMatchObject({ type: "flow", run: { status: "running", runId: "run-1" } })
    expect(f.runs.get("r1")?.endedAt).toBeUndefined()
    expect(f.runs.busy).toBe(true)
  })

  it("restores a run an older build parked for wildcard approval as interrupted", () => {
    const legacy = {
      id: "r1",
      flow: "review",
      by: "agent",
      input: {},
      requested: "{}",
      status: "approval",
      startedAt: 1
    } as unknown as Run
    const f = setup({ restored: [legacy] })
    expect(f.runs.get("r1")).toMatchObject({ status: "failed", message: interrupted })
  })

  it("settles only from the watch", async () => {
    const f = setup()
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    expect(f.runs.get("r1")?.status).toBe("running")
    expect(actions(f.runs.get("r1"))).toEqual({ retry: false, stop: true })
    f.watches[0]!.emit(call("control.agent.cell-call-started", 1))
    f.watches[0]!.emit(call("control.agent.cell-call-settled", 2))
    expect(f.runs.get("r1")?.status).toBe("running")

    const done = setup()
    done.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    done.watches[0]!.emit(call("control.agent.cell-call-started", 1))
    done.watches[0]!.done.resolve({ kind: "done", answer: "Looks good." })
    await tick()
    expect(done.runs.get("r1")).toMatchObject({ status: "done", answer: "Looks good." })
    expect(actions(done.runs.get("r1"))).toEqual({ retry: false, stop: false })
    expect(done.runs.get("r1")?.endedAt).toBeNumber()
    const panel = done.runs.panel("r1")
    expect(panel.summary).toBe("Looks good.")
    expect(panel.rows.map((row) => row.label)).toEqual(["bash", "Result"])

    const failed = setup()
    failed.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    failed.watches[0]!.done.resolve({ kind: "failed", message: "boom" })
    await tick()
    expect(failed.runs.get("r1")).toMatchObject({ status: "failed", message: "boom" })
    expect(actions(failed.runs.get("r1"))).toEqual({ retry: true, stop: false })
    expect(failed.runs.busy).toBe(false)
  })

  it("cancel while running asks the control plane and waits for the watch", async () => {
    const f = setup()
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    f.runs.cancel("r1")
    await tick()
    expect(f.calls).toContain("cancel:run-1")
    expect(f.runs.get("r1")?.status).toBe("running")
    f.watches[0]!.done.resolve({ kind: "cancelled" })
    await tick()
    expect(f.runs.get("r1")?.status).toBe("cancelled")
    expect(f.runs.panel("r1").summary).toBe("Stopped.")
  })

  it("keeps parked and approval states through diagnostic events and resumes only on a run receipt", async () => {
    const f = setup()
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    f.watches[0]!.emit(call("control.run.waiting-approval", 1))
    f.watches[0]!.emit(call("control.agent.discipline-armed", 2))
    expect(f.runs.get("r1")?.status).toBe("waiting")
    f.watches[0]!.emit(call("control.run.parked", 3))
    f.watches[0]!.emit({ ...call("control.agent.suspended", 4), payload: { reason: { message: "Which branch?" } } })
    expect(f.runs.get("r1")?.status).toBe("parked")
    expect(f.runs.busy).toBe(false)
    expect(f.runs.panel("r1").summary).toBe("Which branch?")
    f.watches[0]!.emit(call("control.run.running", 5))
    expect(f.runs.get("r1")?.status).toBe("running")
    expect(f.runs.get("r1")?.message).toBeUndefined()
  })

  it("queues a parked resume with its durable run ID and ignores a replaced watch", async () => {
    const f = setup()
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    f.watches[0]!.emit(call("control.run.parked", 1))
    for (const id of ["r2", "r3", "r4"]) f.runs.request({ id, flow: "review", input: {}, by: "user" })
    await tick()
    expect(f.starts).toHaveLength(4)
    expect(f.runs.retry("r1")).toEqual({ id: "r1", status: "queued" })
    expect(f.runs.get("r1")?.runId).toBe("run-1")
    f.watches[1]!.done.resolve({ kind: "done", answer: "done" })
    await tick()
    expect(f.calls).toContain("resume:run-1")
    expect(f.starts).toHaveLength(4)
    f.resumes[0]!.resolve({ runId: "run-1" })
    await tick()
    f.watches[0]!.done.reject(new Error("old watch closed"))
    f.watches[0]!.emit(call("control.run.parked", 9))
    await tick()
    expect(f.runs.get("r1")?.status).toBe("running")
    const last = f.watches.at(-1)!
    last.emit(call("control.run.parked", 10))
    f.runs.cancel("r1")
    expect(f.calls).toContain("cancel:run-1")
    last.done.resolve({ kind: "cancelled" })
    await tick()
    expect(f.runs.get("r1")?.status).toBe("cancelled")
  })

  it("cancels a queued resume without launching a replacement or losing its watch", async () => {
    const f = setup()
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    f.watches[0]!.emit(call("control.run.parked", 1))
    for (const id of ["r2", "r3", "r4"]) f.runs.request({ id, flow: "review", input: {}, by: "user" })
    await tick()
    f.runs.retry("r1")
    f.runs.cancel("r1")
    expect(f.calls).toContain("cancel:run-1")
    expect(f.calls).not.toContain("resume:run-1")
    f.watches.at(-1)!.done.resolve({ kind: "cancelled" })
    f.watches[1]!.done.resolve({ kind: "done", answer: "done" })
    await tick()
    expect(f.runs.get("r1")?.status).toBe("cancelled")
    expect(f.starts).toHaveLength(4)
    expect(f.resumes).toHaveLength(0)
  })

  it("a run parked for approval keeps its watch: resumes, and a stop settles it", async () => {
    const f = setup()
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    f.watches[0]!.emit(call("control.run.waiting-approval", 1))
    expect(f.runs.get("r1")?.status).toBe("waiting")
    expect(f.runs.busy).toBe(true)
    // Repeated approval events cannot report a resume.
    f.watches[0]!.emit(call("control.run.waiting-approval", 2))
    expect(f.runs.get("r1")?.status).toBe("waiting")
    // Approved elsewhere: the same watch sees the run move on.
    f.watches[0]!.emit(call("control.run.running", 3))
    expect(f.runs.get("r1")?.status).toBe("running")
    f.watches[0]!.emit(call("control.run.waiting-approval", 4))
    expect(f.runs.get("r1")?.status).toBe("waiting")
    f.runs.cancel("r1")
    await tick()
    expect(f.calls).toEqual(["discover", "input:review", "plan:review:{}", "start", "watch:run-1", "cancel:run-1"])
    f.watches[0]!.done.resolve({ kind: "cancelled" })
    await tick()
    expect(f.runs.get("r1")?.status).toBe("cancelled")
    expect(f.runs.busy).toBe(false)
  })

  it("a stop while start is in flight stops the run start launched", async () => {
    const f = setup()
    f.auto.start = false
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    expect(f.calls.at(-1)).toBe("start")
    f.runs.cancel("r1")
    expect(f.runs.get("r1")?.status).toBe("requested")
    expect(f.runs.busy).toBe(true)
    f.starts[0]!.resolve("run-1")
    await tick()
    expect(f.calls).toContain("cancel:run-1")
    expect(f.calls).toContain("watch:run-1")
    expect(f.runs.busy).toBe(true)
    expect(f.runs.get("r1")?.status).toBe("running")
    f.watches[0]!.done.resolve({ kind: "cancelled" })
    await tick()
    expect(f.runs.get("r1")?.status).toBe("cancelled")
  })

  it("a refused late stop stays monitored and can be retried", async () => {
    const f = setup({ refuseCancel: true })
    f.auto.start = false
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    f.runs.cancel("r1")
    f.starts[0]!.resolve("run-1")
    await tick()
    await tick()
    expect(f.runs.get("r1")).toMatchObject({
      status: "running",
      runId: "run-1",
      message: "The stop was not sent; press x again."
    })
    expect(f.runs.busy).toBe(true)
    expect(f.calls).toContain("watch:run-1")
    f.runs.cancel("r1")
    await tick()
    expect(f.calls.filter((call) => call === "cancel:run-1")).toHaveLength(2)
  })

  it("a stop during launch survives disposal and persists a retryable remote run", async () => {
    const f = setup({ refuseCancel: true })
    f.auto.start = false
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    f.runs.cancel("r1")
    f.runs.dispose()
    f.starts[0]!.resolve("run-1")
    await tick()
    expect(f.calls).toContain("cancel:run-1")
    expect(f.records.at(-1)).toMatchObject({
      type: "flow",
      run: { status: "failed", runId: "run-1", message: "The stop was not sent; press x again." }
    })
    const restored = setup({ restored: f.runs.snapshot() })
    restored.runs.retry("r1")
    await tick()
    expect(restored.calls).toContain("cancel:run-1")
    expect(restored.calls).toContain("watch:run-1")
    expect(restored.calls).not.toContain("start")
  })

  it("disposal drains a stopped launch before the control host can close", async () => {
    const f = setup({ refuseCancel: true })
    f.auto.start = false
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    f.runs.cancel("r1")
    let closed = false
    const disposal = Promise.resolve(f.runs.dispose()).then(() => {
      closed = true
    })
    await tick()
    expect(closed).toBe(false)
    f.starts[0]!.resolve("run-1")
    await disposal
    expect(f.calls).toContain("cancel:run-1")
    expect(f.runs.get("r1")).toMatchObject({
      status: "failed",
      runId: "run-1",
      message: "The stop was not sent; press x again."
    })
  })

  it("the coordinator context bounds a run's message", async () => {
    const f = setup()
    f.runs.request({ id: "r1", flow: "review", input: {}, by: "user" })
    await tick()
    f.watches[0]!.done.resolve({ kind: "failed", message: "x".repeat(5000) })
    await tick()
    const [run] = JSON.parse(f.runs.context()) as Array<{ message: string }>
    expect(run!.message.length).toBeLessThanOrEqual(500)
  })

  it("restore marks interrupted and retry resumes the same durable run", async () => {
    const base = { flow: "review", by: "user" as const, input: {}, requested: "{}", startedAt: 1 }
    const f = setup({
      restored: [
        { ...base, id: "r1", status: "running", runId: "run-9" },
        { ...base, id: "r2", status: "failed", message: "boom" }
      ]
    })
    expect(f.runs.get("r1")).toMatchObject({
      status: "failed",
      message: "Interrupted; retry to continue.",
      runId: "run-9"
    })
    expect(f.records).toHaveLength(1)
    f.runs.retry("r1")
    await tick()
    expect(f.calls).toEqual(["resume:run-9"])
    expect(f.runs.get("r1")?.status).toBe("running")
    f.resumes[0]!.resolve({ runId: "run-9" })
    await tick()
    expect(f.calls).toContain("watch:run-9")

    f.runs.retry("r2")
    await tick()
    expect(f.calls).toContain("plan:review:{}")
    expect(f.calls.filter((each) => each.startsWith("resume"))).toHaveLength(1)
  })

  it("an agent request for a non-model-invocable flow is refused", async () => {
    const f = setup({ listed: [flow("deploy", "Deploy", false)] })
    f.runs.request({ id: "r1", flow: "deploy", input: {}, by: "agent" })
    await tick()
    expect(f.runs.get("r1")).toMatchObject({ status: "failed" })
    expect(f.runs.get("r1")?.message).toBe("deploy starts only from /flow.")
    expect(f.calls.some((each) => each.startsWith("plan"))).toBe(false)
    // Once discovery is cached, the binding refuses at once.
    expect(() => f.runs.request({ id: "r2", flow: "deploy", input: {}, by: "agent" })).toThrow(
      "not for a model to start"
    )
  })

  it("keeps the newest discovery failure until a discovery succeeds", async () => {
    const f = setup()
    let fail = true
    Object.assign(f.port, {
      discover: async () => {
        if (fail) throw new Error("Registry unreadable: flows/x/flow.ts")
        return [{ name: "review", description: "", modelInvocable: true }]
      }
    })
    f.runs.refresh()
    await tick()
    expect(f.runs.failure()).toMatchObject({
      _tag: "FlowDiscoveryFailed",
      cause: new Error("Registry unreadable: flows/x/flow.ts")
    })
    fail = false
    f.runs.refresh()
    await tick()
    expect(f.runs.failure()).toBeUndefined()
    expect(f.runs.listed().map((flow) => flow.name)).toEqual(["review"])
  })

  it("an unknown flow fails with its name", async () => {
    const f = setup()
    f.runs.request({ id: "r1", flow: "nope", input: {}, by: "user" })
    await tick()
    expect(f.runs.get("r1")).toMatchObject({ status: "failed", message: "No flow named nope; /flows lists them." })
  })

  it("queues a fourth run instead of refusing it, and starts it when a seat frees", async () => {
    const f = setup()
    for (const id of ["a", "b", "c"]) f.runs.request({ id, flow: "review", input: {}, by: "user" })
    expect(f.runs.request({ id: "d", flow: "review", input: {}, by: "agent" })).toEqual({ id: "d", status: "queued" })
    expect(f.runs.request({ id: "e", flow: "review", input: {}, by: "agent" })).toEqual({ id: "e", status: "queued" })
    expect(f.runs.busy).toBe(true)
    expect(f.runs.panel("d").summary).toBe("Queued.")
    await tick()
    expect(f.calls.filter((each) => each === "start")).toHaveLength(3)
    f.watches[0]!.done.resolve({ kind: "done", answer: "ok" })
    await tick()
    await tick()
    expect(f.runs.get("a")?.status).toBe("done")
    expect(f.runs.get("d")?.status).not.toBe("queued")
    expect(f.runs.get("e")?.status).toBe("queued")
    expect(f.calls.filter((each) => each === "start")).toHaveLength(4)
  })

  it("a run parked for input is not busy but still holds a seat", async () => {
    const f = setup({ schema: Schema.Struct({ title: Schema.String }) })
    f.runs.request({ id: "a", flow: "review", input: {}, by: "user" })
    await tick()
    expect(f.runs.get("a")?.status).toBe("input")
    expect(f.runs.busy).toBe(false)

    for (const id of ["b", "c"]) f.runs.request({ id, flow: "review", input: {}, by: "user" })
    await tick()
    expect(f.runs.snapshot().every((run) => run.status === "input")).toBe(true)
    expect(f.runs.busy).toBe(false)
    expect(f.runs.request({ id: "d", flow: "review", input: {}, by: "user" })).toEqual({ id: "d", status: "queued" })
    expect(f.runs.busy).toBe(true)
    // A parked run from an earlier process is interrupted on restore, like any unfinished run.
    expect(setup({ restored: f.runs.snapshot() }).runs.get("a")).toMatchObject({ status: "failed" })
  })

  it("cancels a queued run without starting it", async () => {
    const f = setup()
    for (const id of ["a", "b", "c", "d"]) f.runs.request({ id, flow: "review", input: {}, by: "user" })
    f.runs.cancel("d")
    expect(f.runs.get("d")?.status).toBe("cancelled")
    await tick()
    expect(f.calls.filter((each) => each === "start")).toHaveLength(3)
  })

  it("returns a retry's receipt and refuses an unknown or unsettled run with a reason", async () => {
    const f = setup()
    expect(() => f.runs.retry("nope")).toThrow("Unknown tab")
    f.runs.request({ id: "x", flow: "nope", input: {}, by: "user" })
    await tick()
    expect(f.runs.retry("x")).toEqual({ id: "x", status: "requested" })
    expect(() => f.runs.retry("x")).toThrow("Only a failed, stopped, or parked run can be retried")
  })

  it("queues a retry at the cap instead of throwing", async () => {
    const f = setup()
    f.runs.request({ id: "x", flow: "nope", input: {}, by: "user" })
    await tick()
    expect(f.runs.get("x")?.status).toBe("failed")
    for (const id of ["a", "b", "c"]) f.runs.request({ id, flow: "review", input: {}, by: "user" })
    expect(() => f.runs.retry("x")).not.toThrow()
    expect(f.runs.get("x")?.status).toBe("queued")
  })

  it("refuses without a port", () => {
    const runs = new FlowRuns({ persist: () => {} })
    expect(() => runs.request({ flow: "review", input: {}, by: "user" })).toThrow("Flows unavailable")
  })

  it("describes a flow's input once its module is imported, and an agent's as its prompt", async () => {
    const agent: Listed = {
      ...flow("review-agent", "Reviews"),
      kind: "markdown",
      path: "/repo/flows/review-agent/flow.mdx"
    }
    const f = setup({
      listed: [flow("review", "Review a change"), agent],
      schema: Schema.Struct({ title: Schema.String, draft: Schema.optional(Schema.Boolean), count: Schema.Number })
    })
    f.runs.refresh()
    await tick()
    // Describing never imports: no input read before a run did.
    expect(f.runs.describe()).toEqual([
      { name: "review", description: "Review a change", agent: false },
      {
        name: "review-agent",
        description: "Reviews",
        agent: true,
        input: [{ name: "args", type: "string", required: false }]
      }
    ])
    expect(f.calls.filter((call) => call.startsWith("input:"))).toEqual([])
    f.runs.request({ flow: "review", input: {}, by: "user" })
    await tick()
    await tick()
    expect(f.runs.describe()[0]).toEqual({
      name: "review",
      description: "Review a change",
      agent: false,
      input: [
        { name: "title", type: "text", required: true },
        { name: "draft", type: "boolean", required: false },
        { name: "count", type: "number", required: true }
      ]
    })
  })

  it("lists only model-invocable flows to the coordinator, at most 12 fields each", async () => {
    const wide = Schema.Struct(
      Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`f${index}`, Schema.String]))
    )
    const f = setup({ listed: [flow("wide", "Wide"), flow("deploy", "Deploy", false)], schema: wide })
    f.runs.refresh()
    await tick()
    f.runs.request({ flow: "wide", input: {}, by: "user" })
    await tick()
    await tick()
    const described = f.runs.describe((each) => each.modelInvocable)
    expect(described.map((each) => each.name)).toEqual(["wide"])
    expect(described[0]?.input).toHaveLength(12)
  })

  it("tells the coordinator about runs started outside the TUI, read-only", async () => {
    const f = setup()
    f.runs.request({ id: "mine", flow: "review", input: {}, by: "user" })
    await tick()
    await tick()
    Object.assign(f.port, {
      runs: async () => [
        { runId: "run-1", flow: "review", status: "running" },
        { runId: "cli-7", flow: "deploy", status: "completed" }
      ]
    })
    f.runs.refresh()
    await tick()
    await tick()
    const context = JSON.parse(f.runs.context()) as Array<{ id: string; flow: string; status: string; by?: string }>
    // The TUI's own run appears once; the CLI's run is marked by: "cli".
    expect(context.filter((run) => run.id === "mine")).toHaveLength(1)
    expect(context.find((run) => run.id === "run-1")).toBeUndefined()
    expect(context.find((run) => run.id === "cli-7")).toEqual({
      id: "cli-7",
      flow: "deploy",
      status: "completed",
      by: "cli"
    })
    expect(f.runs.snapshot().map((run) => run.id)).toEqual(["mine"])
  })
})

it("reports a typed discovery failure and clears it after recovery", async () => {
  const f = fake()
  let broken = true
  const runs = new FlowRuns({
    port: {
      ...f.port,
      discover: async () => {
        if (broken) throw new Error("registry unavailable")
        return [flow("review", "Review")]
      }
    },
    persist: () => {}
  })
  runs.refresh()
  await tick()
  expect(runs.failure()).toMatchObject({ _tag: "FlowDiscoveryFailed", message: "Flow discovery unavailable" })
  broken = false
  await runs.listing()
  expect(runs.failure()).toBeUndefined()
  expect(runs.listed()).toHaveLength(1)
})

describe("discovery reuse", () => {
  it("refuses an unknown agent from a warm listing without another discovery or body read", async () => {
    const f = setup()
    await f.runs.listing()
    expect(f.calls).toEqual(["discover"])
    const agents = Agents.port(f.runs, f.port)
    await expect(agents.load("missing")).rejects.toMatchObject({ code: "unknown_agent" })
    expect(f.calls).toEqual(["discover"])
    await f.runs.dispose()
  })

  it("joins a pending listing and keeps its completion time as the cache age", async () => {
    const f = setup()
    const first = pending<ReadonlyArray<Listed>>()
    Object.assign(f.port, {
      discover: () => {
        f.calls.push("discover")
        return first.promise
      }
    })
    const one = f.runs.listing({ maxAgeMs: 1000 })
    const two = f.runs.listing({ maxAgeMs: 1000 })
    expect(f.calls).toEqual(["discover"])
    first.resolve([flow("review", "Current")])
    expect(await one).toEqual(await two)
    expect(await f.runs.listing({ maxAgeMs: 1000 })).toEqual([flow("review", "Current")])
    expect(f.calls).toEqual(["discover"])
    await f.runs.dispose()
  })

  it("uses a fresh scan by default and expires an opted-in listing", async () => {
    const f = setup()
    await f.runs.listing({ maxAgeMs: 1 })
    expect(f.calls).toEqual(["discover"])
    await new Promise((resolve) => setTimeout(resolve, 5))
    await f.runs.listing({ maxAgeMs: 1 })
    await f.runs.listing()
    expect(f.calls).toEqual(["discover", "discover", "discover"])
    await f.runs.dispose()
  })

  it("refresh detects edited descriptors while preserving the last listing until completion", async () => {
    const f = setup()
    const old = [flow("review", "Before edit")]
    const edited = [flow("review", "After edit")]
    const next = pending<ReadonlyArray<Listed>>()
    let scans = 0
    Object.assign(f.port, {
      discover: () => {
        scans++
        return scans === 1 ? Promise.resolve(old) : next.promise
      }
    })
    expect(await f.runs.listing({ maxAgeMs: 1000 })).toEqual(old)
    f.runs.refresh()
    expect(f.runs.known()).toEqual(old)
    next.resolve(edited)
    await tick()
    expect(f.runs.known()).toEqual(edited)
    expect(await f.runs.listing({ maxAgeMs: 1000 })).toEqual(edited)
    expect(scans).toBe(2)
    await f.runs.dispose()
  })

  it("joins a refresh in progress before considering the previous listing", async () => {
    const f = setup()
    const next = pending<ReadonlyArray<Listed>>()
    let scans = 0
    Object.assign(f.port, {
      discover: () => {
        scans++
        return scans === 1 ? Promise.resolve([flow("review", "Old")]) : next.promise
      }
    })
    await f.runs.listing({ maxAgeMs: 1000 })
    f.runs.refresh()
    const during = f.runs.listing({ maxAgeMs: 1000 })
    expect(scans).toBe(2)
    next.resolve([flow("review", "Edited")])
    expect(await during).toEqual([flow("review", "Edited")])
    expect(f.runs.known()).toEqual([flow("review", "Edited")])
    await f.runs.dispose()
  })

  it("retries after a failed discovery without caching the failure", async () => {
    const f = setup()
    let scans = 0
    Object.assign(f.port, {
      discover: async () => {
        scans++
        if (scans === 1) throw new Error("temporarily unavailable")
        return [flow("review", "Recovered")]
      }
    })
    await expect(f.runs.listing({ maxAgeMs: 1000 })).rejects.toThrow("temporarily unavailable")
    expect(f.runs.failure()).toMatchObject({ _tag: "FlowDiscoveryFailed" })
    expect(await f.runs.listing({ maxAgeMs: 1000 })).toEqual([flow("review", "Recovered")])
    expect(f.runs.failure()).toBeUndefined()
    expect(scans).toBe(2)
    await f.runs.dispose()
  })

  it("keeps the display listing after a failed refresh and retries on the next load", async () => {
    const f = setup()
    let scans = 0
    Object.assign(f.port, {
      discover: async () => {
        scans++
        if (scans === 2) throw new Error("refresh failed")
        return [flow("review", scans === 1 ? "Before edit" : "After recovery")]
      }
    })
    expect(await f.runs.listing({ maxAgeMs: 1000 })).toEqual([flow("review", "Before edit")])
    f.runs.refresh()
    await tick()
    expect(f.runs.known()).toEqual([flow("review", "Before edit")])
    expect(f.runs.failure()).toMatchObject({ _tag: "FlowDiscoveryFailed" })
    expect(await f.runs.listing({ maxAgeMs: 1000 })).toEqual([flow("review", "After recovery")])
    expect(scans).toBe(3)
    expect(f.runs.failure()).toBeUndefined()
    await f.runs.dispose()
  })
})

it("opens the host once in the background and exposes opening until ready", async () => {
  const f = fake()
  const opened = pending<void>()
  let calls = 0
  const runs = new FlowRuns({
    port: {
      ...f.port,
      warm: () => {
        calls++
        return opened.promise
      }
    },
    persist: () => {}
  })
  runs.warm()
  runs.warm()
  expect(calls).toBe(1)
  expect(runs.opening).toBe(true)
  expect(runs.request({ id: "r", flow: "review", input: {}, by: "user" }).status).toBe("requested")
  expect(runs.panel("r").summary).toBe("Opening flows")
  opened.resolve()
  await tick()
  expect(runs.opening).toBe(false)
  await runs.dispose()
})

it("settles a stopped authorization as cancelled without a failure message", async () => {
  const f = fake()
  const runs = new FlowRuns({
    port: {
      ...f.port,
      start: (_card, _source, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(new FlowError("stopped", "Stopped")), { once: true })
        })
    },
    persist: () => {}
  })
  runs.request({ id: "r", flow: "review", input: {}, by: "user" })
  await tick()
  runs.cancel("r")
  await tick()
  expect(runs.get("r")).toMatchObject({ status: "cancelled", message: undefined })
  await runs.dispose()
})

it("reads restored events only when hydrated and retains a retryable failure", async () => {
  const f = fake()
  let broken = true
  let calls = 0
  const runs = new FlowRuns({
    port: {
      ...f.port,
      events: async () => {
        calls++
        if (broken) throw new Error("control offline")
        return []
      }
    },
    persist: () => {},
    restored: [{
      id: "r",
      flow: "review",
      by: "user",
      input: {},
      requested: "{}",
      status: "done",
      startedAt: 1,
      runId: "remote"
    }]
  })
  runs.panel("r")
  expect(calls).toBe(0)
  await runs.hydrate("r")
  expect(calls).toBe(1)
  expect(runs.panel("r").summary).toBe("Flow history unavailable")
  broken = false
  await runs.hydrate("r")
  expect(calls).toBe(2)
  expect(runs.panel("r").summary).toBe("Done.")
  await runs.dispose()
})

it("refuses cross-registry ids before persisting or launching in either order", async () => {
  const f = fake()
  const records: Session.Record[] = []
  const runs: FlowRuns = new FlowRuns({
    port: f.port,
    persist: (r) => records.push(r),
    occupied: (id) => workspace.has(id)
  })
  const workspace: Workspace = new Workspace({
    host: {
      cwd: "/tmp",
      run: () => {
        throw new Error("must not launch")
      }
    } as unknown as Host.Host,
    workerSeat: "test",
    history: () => [],
    persist: (r) => records.push(r),
    occupied: runs.has
  })
  runs.request({ id: "flow-first", flow: "review", input: {}, by: "user" })
  expect(() => workspace.request({ id: "flow-first", title: "Work", prompt: "Work" })).toThrow("already belongs")
  workspace.request({ id: "worker-first", title: "Work", prompt: "Work" })
  expect(() => runs.request({ id: "worker-first", flow: "review", input: {}, by: "user" })).toThrow("already belongs")
  expect(records).toHaveLength(2)
  expect(f.calls).toEqual([])
  workspace.dispose()
  await runs.dispose()
})

describe("discoveryNotice", () => {
  const failed = (message: string) => new FlowDiscoveryFailed(new Error(message))

  it("shows an unchanged failure once across controllers until a listing succeeds", () => {
    const first = discoveryNotice(undefined, failed("helper missing"), false)
    expect(first.show).toBe(true)
    // A new session's controller has neither listed nor failed yet: nothing to show, nothing forgotten.
    const fresh = discoveryNotice(first.shown, undefined, false)
    expect(fresh).toEqual({ shown: first.shown, show: false })
    // Its own copy of the same failure does not bury a newer acknowledgment.
    expect(discoveryNotice(fresh.shown, failed("helper missing"), false)).toEqual({ shown: first.shown, show: false })
    expect(discoveryNotice(fresh.shown, failed("helper missing"), true).show).toBe(false)
  })

  it("shows a changed failure, and the same failure again after a successful listing", () => {
    const first = discoveryNotice(undefined, failed("helper missing"), false)
    const changed = discoveryNotice(first.shown, failed("helper crashed"), false)
    expect(changed.show).toBe(true)
    expect(changed.shown).not.toBe(first.shown)
    const recovered = discoveryNotice(changed.shown, undefined, true)
    expect(recovered).toEqual({ shown: undefined, show: false })
    expect(discoveryNotice(recovered.shown, failed("helper crashed"), true).show).toBe(true)
  })
})
