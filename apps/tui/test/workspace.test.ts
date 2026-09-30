/** Custom agents in worker tabs: the body is read at launch, never at request. */
import * as Seat from "@smthrs/agent/Seat"
import { ModelError } from "@smthrs/model/ModelError"
import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Agents from "../src/agents.ts"
import type * as Extension from "../src/extension.ts"
import type * as Flows from "../src/flows.ts"
import type * as Host from "../src/host.ts"
import * as Models from "../src/models.ts"
import * as Session from "../src/session.ts"
import { seats, Workspace } from "../src/workspace.ts"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const descriptor = (overrides: Partial<Extension.Descriptor> = {}): Extension.Descriptor => ({
  name: "review",
  description: "Reviews the change.",
  modelInvocable: true,
  kind: "markdown",
  seat: "opus",
  flows: [],
  capabilities: ["fs:read:**"],
  path: "/repo/flows/review/flow.mdx",
  ...overrides
})
const listed: ReadonlyArray<Extension.Descriptor> = [
  descriptor(),
  descriptor({ name: "echo", kind: "module" }),
  descriptor({ name: "manual", modelInvocable: false, seat: undefined })
]
const body = (text = "Review the change."): Flows.Body => ({
  descriptor: descriptor(),
  text,
  baseDirectory: "/repo/flows/review",
  digest: "a".repeat(64)
})

const setup = (
  options: {
    readonly known?: boolean
    readonly routes?: boolean
    readonly delegable?: ReadonlyArray<Models.DelegateModel>
    readonly seatOf?: (declared: string) => string | undefined
    readonly restored?: Workspace["snapshot"] extends () => infer S ? S : never
    readonly cwd?: string
  } = {}
) => {
  const inputs: Array<Host.TurnInput> = []
  const finishes: Array<(outcome: Host.Outcome) => void> = []
  const loads: Array<{ name: string; resolve: (body: Flows.Body) => void; reject: (error: unknown) => void }> = []
  const records: Array<Session.Record> = []
  /** A pending Jev pick per `auto` launch; the fake host reports it as `Host.run` does. */
  const routers: Array<
    {
      resolve: (routed: { seat: string; variant: string | null; backups?: ReadonlyArray<string> }) => void
      reject: (error: Seat.SeatUnrouted) => void
    }
  > = []
  /** A pending description per ask, with the seat it was asked of. */
  const descriptions: Array<{ seat: string; resolve: (text: string) => void }> = []
  const host: Host.Host = {
    cwd: options.cwd ?? mkdtempSync(join(tmpdir(), "tui-agents-")),
    judged: options.routes === true,
    ...(options.routes === undefined ? {} : { routes: options.routes }),
    dispose: async () => {},
    describe: ({ seat }) => new Promise((resolve) => descriptions.push({ seat, resolve })),
    run: (input) => {
      inputs.push(input)
      const done = new Promise<Host.Outcome>((resolve) => finishes.push(resolve))
      const finish = finishes.at(-1)!
      if (input.seat === Seat.auto) {
        void new Promise<{ seat: string; variant: string | null; backups?: ReadonlyArray<string> }>((resolve, reject) =>
          routers.push({ resolve, reject })
        ).then(
          (routed) => input.onSeat?.({ backups: [], ...routed }),
          (error: Seat.SeatUnrouted) => finish({ _tag: "failed", message: error.message, detail: "", error })
        )
      }
      return { done, cancel: () => finishes.at(-1)?.({ _tag: "cancelled" }) }
    }
  }
  let current = listed
  const agents: Agents.Port = {
    listed: () => (options.known === false ? undefined : current),
    load: (name) =>
      new Promise((resolve, reject) =>
        loads.push({
          name,
          resolve: (value) => {
            try {
              resolve({ descriptor: Agents.find(current, name, "user"), body: value })
            } catch (error) {
              reject(error)
            }
          },
          reject
        })
      )
  }
  const workspace = new Workspace({
    host,
    workerSeat: "worker:test",
    history: () => [],
    persist: (record) => records.push(record),
    ...(options.restored === undefined ? {} : { restored: options.restored }),
    agents,
    seatOf: options.seatOf ?? ((declared) => Models.seatOf(declared, [])),
    ...(options.delegable === undefined ? {} : { delegable: options.delegable })
  })
  return {
    workspace,
    host,
    inputs,
    finishes,
    loads,
    records,
    routers,
    descriptions,
    relist: (next: ReadonlyArray<Extension.Descriptor>) => {
      current = next
    }
  }
}
const request = { id: "rev", title: "Review src", prompt: "Look at src.", agent: "review" }

describe("delegate models", () => {
  it("requests detected Claude seats and keeps an omitted model for routing", async () => {
    const f = setup({ delegable: ["opus", "claude-code:opus", "sonnet"] })
    for (const model of ["opus", "claude-code:opus", "sonnet"] as const) {
      expect(f.workspace.request({ id: model, title: model, prompt: "Review.", model }).status).toBe("requested")
    }
    expect(f.workspace.request({ id: "routed", title: "Routed", prompt: "Review." }).status).toBe("requested")
    await tick()
    expect(f.inputs.map((input) => input.seat)).toEqual(["opus", "claude-code:opus", "sonnet", "worker:test"])
    f.workspace.dispose()
  })

  it("refuses a model this machine cannot reach before any tab exists", () => {
    const f = setup({ delegable: ["sol"] })
    expect(() => f.workspace.request({ id: "q", title: "Q", prompt: "Answer.", model: "cerebras" }))
      .toThrow("Model cerebras is not available here; use sol or omit model")
    expect(f.workspace.snapshot().tabs).toEqual([])
    expect(f.workspace.request({ id: "q", title: "Q", prompt: "Answer.", model: "sol" }).status).toBe("requested")
    expect(() => setup({ delegable: [] }).workspace.request({ id: "q", title: "Q", prompt: "A.", model: "luna" }))
      .toThrow("Model luna is not available here; omit model")
    expect(() => f.workspace.request({ id: "opus", title: "Opus", prompt: "Review.", model: "opus" }))
      .toThrow("Model opus is not available here; use sol or omit model")
  })
})

describe("custom agents", () => {
  it("returns requested before the body is read and keeps chat usable while it never resolves", async () => {
    const f = setup()
    expect(f.workspace.request(request)).toEqual({ id: "rev", status: "requested" })
    expect(f.records[0]).toMatchObject({ type: "tab", tab: { status: "requested", agent: { name: "review" } } })
    await tick()
    expect(f.loads.map((load) => load.name)).toEqual(["review"])
    expect(f.inputs).toHaveLength(0)
    expect(f.workspace.read("rev").status).toBe("requested")
    // Chat can request and publish other work while the body read hangs.
    expect(f.workspace.request({ id: "other", title: "Other", prompt: "Other work." }).status).toBe("requested")
    f.workspace.publish({ id: "plan", title: "Plan", summary: "One step.", rows: [] })
    await tick()
    expect(f.inputs.map((input) => input.source)).toEqual(["other"])
    expect(f.workspace.busy).toBe(true)
  })

  it("runs the agent's profile on its declared seat and records the digest", async () => {
    const f = setup()
    f.workspace.request(request)
    await tick()
    f.loads[0]!.resolve(body())
    await tick()
    const [input] = f.inputs
    // A Claude alias stays an alias, so the seat resolver picks its route.
    expect(input?.seat).toBe("opus")
    expect(input?.role).toBe("worker")
    expect(input?.agent?.name).toBe("review")
    expect(input?.agent?.system).toStartWith("Review the change.")
    expect(input?.agent?.envelope).toEqual(["fs:read:**"])
    expect(f.workspace.snapshot().tabs[0]).toMatchObject({
      status: "running",
      seat: "opus",
      agent: { name: "review", digest: "a".repeat(64) }
    })
    f.finishes[0]!({ _tag: "done", answer: "approve" })
    await tick()
    expect(f.workspace.read("rev")).toMatchObject({ status: "done", answer: "approve" })
  })

  it("passes a custom agent's fallback order unless the caller overrides its model", async () => {
    const f = setup()
    f.relist([descriptor({ fallbackSeats: ["sol", "luna"] })])
    f.workspace.request(request)
    f.workspace.request({ ...request, id: "override", model: "sol" })
    await tick()
    f.loads[0]!.resolve(body())
    f.loads[1]!.resolve(body())
    await tick()
    expect(f.inputs[0]?.fallbackSeats).toEqual([Models.delegateModels.sol, Models.delegateModels.luna])
    expect(f.inputs[1]?.fallbackSeats).toBeUndefined()
    f.workspace.dispose()
  })

  it("prefers the requested model, then the agent's, then the worker seat", async () => {
    const f = setup()
    f.workspace.request({ ...request, model: "sol" })
    f.workspace.request({ ...request, id: "plain", agent: "manual", by: "user" })
    await tick()
    f.loads[0]!.resolve(body())
    f.loads[1]!.resolve(body())
    await tick()
    expect(f.inputs.map((input) => input.seat)).toEqual([Models.delegateModels.sol, "worker:test"])
  })

  it("settles an unreadable body as a typed failure and retries with the edited file", async () => {
    const f = setup()
    f.workspace.request({ ...request, model: "sol" })
    await tick()
    f.loads[0]!.reject(new Error("body for flow \"review\" is unavailable\n  at stack"))
    await tick()
    expect(f.workspace.read("rev")).toMatchObject({
      status: "failed",
      message: "body for flow \"review\" is unavailable"
    })
    expect(f.workspace.snapshot().tabs[0]?.code).toBe("unreadable")
    expect(f.inputs).toHaveLength(0)
    expect(f.workspace.snapshot().tabs[0]?.failure).toMatchObject({
      headline: "Agent review could not be read; press r."
    })
    const file = f.workspace.snapshot().tabs[0]!.file
    expect(JSON.stringify(f.workspace.snapshot().tabs[0])).not.toContain("at stack")
    expect(JSON.stringify(Session.load(file))).not.toContain("at stack")
    expect(Session.load(file).filter((record) => record.type === "outcome")).toHaveLength(1)
    expect(Session.load(file).find((record) => record.type === "outcome")).toMatchObject({
      outcome: { _tag: "failed", message: "body for flow \"review\" is unavailable" }
    })
    const restored = setup({ cwd: f.host.cwd, restored: f.workspace.snapshot() })
    expect(restored.workspace.snapshot().tabs[0]).toMatchObject({ status: "failed", code: "unreadable" })
    expect(restored.workspace.transcript("rev").activity?.status).toBe("failed")
    restored.workspace.dispose()
    f.workspace.retry("rev")
    expect(f.workspace.read("rev").status).toBe("requested")
    await tick()
    f.loads[1]!.resolve(body("Review it again."))
    await tick()
    // Retry keeps the agent and the requested model, and re-reads the file.
    expect(f.inputs[0]?.agent?.system).toStartWith("Review it again.")
    expect(f.inputs[0]?.seat).toBe(Models.delegateModels.sol)
  })

  it("fails the tab with unknown_seat when the declared model is unknown", async () => {
    const f = setup()
    f.relist([descriptor({ seat: "gpt-9" })])
    f.workspace.request(request)
    await tick()
    f.loads[0]!.resolve(body())
    await tick()
    expect(f.workspace.snapshot().tabs[0]).toMatchObject({
      status: "failed",
      code: "unknown_seat",
      message: "Unknown model gpt-9"
    })
    expect(f.inputs).toHaveLength(0)
  })

  it("refuses unknown agents, module flows and person-only agents synchronously", () => {
    const f = setup()
    const code = (run: () => unknown) => {
      try {
        run()
      } catch (error) {
        return (error as Agents.AgentError).code
      }
    }
    expect(code(() => f.workspace.request({ ...request, agent: "missing" }))).toBe("unknown_agent")
    expect(code(() => f.workspace.request({ ...request, agent: "claude-code:opus" }))).toBe("seat_as_agent")
    expect(code(() => f.workspace.request({ ...request, agent: "cerebras" }))).toBe("seat_as_agent")
    expect(() => f.workspace.request({ ...request, agent: "claude-code:opus" }))
      .toThrow("claude-code:opus is a model seat; pass it as model")
    expect(code(() => f.workspace.request({ ...request, agent: "echo" }))).toBe("not_an_agent")
    expect(code(() => f.workspace.request({ ...request, agent: "manual" }))).toBe("not_invocable")
    expect(f.workspace.request({ ...request, agent: "manual", by: "user" }).status).toBe("requested")
    expect(f.records.filter((record) => record.type === "tab")).toHaveLength(1)
  })

  it("keeps unknown_agent under a replay resolver that accepts every name", () => {
    const f = setup({ seatOf: () => "replay:test" })
    expect(() => f.workspace.request({ ...request, agent: "nobody" }))
      .toThrow("No agent named nobody")
  })

  it("hints when a seat is mistaken for an agent before discovery finishes", async () => {
    const f = setup({ known: false })
    f.workspace.request({ ...request, agent: "claude-code:opus" })
    await tick()
    f.loads[0]!.resolve(body())
    await tick()
    expect(f.workspace.snapshot().tabs[0]).toMatchObject({
      status: "failed",
      code: "seat_as_agent",
      message: "claude-code:opus is a model seat; pass it as model"
    })
    f.workspace.dispose()
  })

  it.each([true, false])("refuses the routed seat auto as an agent, listing known: %p", (known) => {
    const f = setup({ known })
    let refused: unknown
    try {
      f.workspace.request({ ...request, agent: "auto" })
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(Agents.AgentError)
    expect(refused).toMatchObject({ code: "seat_as_agent", message: "auto is the routed seat; omit agent" })
    expect(f.records.filter((record) => record.type === "tab")).toHaveLength(0)
    expect(f.loads).toHaveLength(0)
    f.workspace.dispose()
  })

  it("deduplicates the same request and refuses the id for a different agent", () => {
    const f = setup()
    f.workspace.request(request)
    expect(f.workspace.request(request)).toEqual({ id: "rev", status: "requested" })
    expect(() => f.workspace.request({ ...request, agent: "manual", by: "user" })).toThrow("another request")
    expect(() => f.workspace.request({ ...request, agent: undefined })).toThrow("another request")
    expect(() => f.workspace.request({ ...request, model: "sol" })).toThrow("another request")
    expect(f.records.filter((record) => record.type === "tab")).toHaveLength(1)
  })

  it.each(["failed", "cancelled"] as const)(
    "relaunches a %s child on its parent's reused request id",
    async (status) => {
      const f = setup()
      f.workspace.request({ id: "parent", title: "Parent", prompt: "Coordinate." })
      await tick()
      const parent = f.workspace.snapshot().tabs.find((tab) => tab.id === "parent")!
      const original = { id: "fix", title: "Fix", prompt: "Try the first approach." }
      expect(f.workspace.requestChild(parent, original)).toEqual({ id: "parent/fix", status: "requested" })
      await tick()
      const firstFile = f.workspace.snapshot().tabs.find((tab) => tab.id === "parent/fix")!.file
      if (status === "failed") f.finishes[1]!({ _tag: "failed", message: "Needs another approach", detail: "" })
      else f.workspace.cancel("parent/fix")
      await tick()
      expect(f.workspace.read("parent/fix").status).toBe(status)

      const revised = { ...original, prompt: "Use the other approach.", title: "Fix again" }
      expect(f.workspace.requestChild(parent, revised)).toEqual({ id: "parent/fix", status: "requested" })
      expect(f.workspace.snapshot().tabs.filter((tab) => tab.id === "parent/fix")).toHaveLength(1)
      const replacement = f.workspace.snapshot().tabs.find((tab) => tab.id === "parent/fix")!
      expect(replacement).toMatchObject({ parent: "parent", depth: 1, prompt: revised.prompt, title: revised.title })
      expect(replacement.file).not.toBe(firstFile)
      await tick()
      expect(f.inputs.at(-1)).toMatchObject({ prompt: revised.prompt, source: "parent/fix" })
      expect(f.workspace.requestChild(parent, revised).status).toBe("running")
      expect(f.inputs).toHaveLength(3)
      f.workspace.dispose()
    }
  )

  it("keeps completed child requests deduplicated and rejects a changed prompt", async () => {
    const f = setup()
    f.workspace.request({ id: "parent", title: "Parent", prompt: "Coordinate." })
    await tick()
    const parent = f.workspace.snapshot().tabs.find((tab) => tab.id === "parent")!
    const child = { id: "fix", title: "Fix", prompt: "Check the result." }
    f.workspace.requestChild(parent, child)
    await tick()
    f.finishes[1]!({ _tag: "done", answer: "Verified." })
    await tick()
    expect(f.workspace.requestChild(parent, child)).toEqual({ id: "parent/fix", status: "done" })
    expect(() => f.workspace.requestChild(parent, { ...child, prompt: "Change the result." }))
      .toThrow("Request id already belongs to another request")
    expect(f.inputs).toHaveLength(2)
    f.workspace.dispose()
  })

  it("does not let a top-level request take over a failed child's id", async () => {
    const f = setup()
    f.workspace.request({ id: "parent", title: "Parent", prompt: "Coordinate." })
    await tick()
    const parent = f.workspace.snapshot().tabs.find((tab) => tab.id === "parent")!
    f.workspace.requestChild(parent, { id: "fix", title: "Fix", prompt: "Try it." })
    await tick()
    f.finishes[1]!({ _tag: "failed", message: "Needs another approach", detail: "" })
    await tick()
    expect(() => f.workspace.request({ id: "parent/fix", title: "Other", prompt: "Take over." }))
      .toThrow("Request id already belongs to another request")
    expect(f.workspace.snapshot().tabs.find((tab) => tab.id === "parent/fix")?.parent).toBe("parent")
    expect(f.inputs).toHaveLength(2)
    f.workspace.dispose()
  })

  it("relaunches an identical failed request but restores it if the replacement is invalid", async () => {
    const f = setup({ delegable: ["sol"] })
    const original = { id: "fix", title: "Fix", prompt: "Try it.", model: "sol" as const }
    f.workspace.request(original)
    await tick()
    f.finishes[0]!({ _tag: "failed", message: "Provider down", detail: "" })
    await tick()
    const failed = f.workspace.snapshot().tabs[0]!
    expect(() => f.workspace.request({ ...original, model: "opus" })).toThrow("Model opus is not available here")
    expect(f.workspace.snapshot().tabs[0]).toEqual(failed)
    expect(f.workspace.request(original)).toEqual({ id: "fix", status: "requested" })
    await tick()
    expect(f.inputs).toHaveLength(2)
    expect(f.inputs[1]!.prompt).toBe(original.prompt)
    f.workspace.dispose()
  })

  it("does not launch a cancelled request after an immediate same-id replacement", async () => {
    const f = setup()
    f.workspace.request({ id: "fix", title: "First", prompt: "Old prompt." })
    f.workspace.cancel("fix")
    expect(f.workspace.request({ id: "fix", title: "Second", prompt: "New prompt." }).status).toBe("requested")
    await tick()
    expect(f.inputs.map((input) => input.prompt)).toEqual(["New prompt."])
    expect(f.workspace.snapshot().tabs[0]).toMatchObject({ prompt: "New prompt.", status: "running" })
    f.workspace.dispose()
  })

  it("continues a finished native worker with its prior answer and the person's new prompt", async () => {
    const f = setup()
    f.workspace.request({ id: "fix", title: "Fix", prompt: "Find the cause." })
    await tick()
    f.finishes[0]!({ _tag: "done", answer: "The cache key is stale." })
    await tick()
    const file = f.workspace.snapshot().tabs[0]!.file
    expect(f.workspace.continue("fix", "Correct the cache key.")).toEqual({ id: "fix", status: "requested" })
    await tick()
    expect(f.workspace.snapshot().tabs[0]).toMatchObject({ file, status: "running", prompt: "Correct the cache key." })
    expect(f.inputs[1]).toMatchObject({ source: "fix", prompt: "Correct the cache key." })
    expect(JSON.stringify(f.inputs[1]!.history)).toContain("The cache key is stale.")
    f.workspace.dispose()
  })

  it("keeps both completed turns in a native worker's transcript after reload", async () => {
    const first = setup()
    first.workspace.request({ id: "fix", title: "Fix", prompt: "Find the cause." })
    await tick()
    first.finishes[0]!({ _tag: "done", answer: "The cache key is stale." })
    await tick()
    first.workspace.continue("fix", "Correct the cache key.")
    await tick()
    first.finishes[1]!({ _tag: "done", answer: "The cache key is corrected." })
    await tick()
    const restored = setup({ cwd: first.host.cwd, restored: first.workspace.snapshot() })
    expect(restored.workspace.read("fix")).toMatchObject({ status: "done", answer: "The cache key is corrected." })
    const transcript = restored.workspace.transcript("fix")
    expect(transcript.items.filter((item) => item.kind === "user").map((item) => item.text)).toEqual([
      "Find the cause.",
      "Correct the cache key."
    ])
    const outcomes = Session.load(restored.workspace.snapshot().tabs[0]!.file).filter((record) =>
      record.type === "outcome"
    )
    expect(outcomes.map((record) => record.outcome)).toEqual([
      { _tag: "done", answer: "The cache key is stale." },
      { _tag: "done", answer: "The cache key is corrected." }
    ])
    expect(restored.inputs).toHaveLength(0)
    first.workspace.dispose()
    restored.workspace.dispose()
  })

  it("settles a completion no judge could check as done · unchecked, never failed, across a reload", async () => {
    const first = setup()
    first.workspace.request({ id: "fix", title: "Fix", prompt: "Fix the failing test." })
    await tick()
    first.finishes[0]!({ _tag: "done", answer: "Fixed src/cart.js.", unchecked: true })
    await tick()
    expect(first.workspace.snapshot().tabs[0]).toMatchObject({
      status: "done",
      answer: "Fixed src/cart.js.",
      unchecked: true
    })
    expect(first.workspace.snapshot().tabs[0]).not.toHaveProperty("failure")
    const items = first.workspace.transcript("fix").items
    expect(items.at(-1)).toMatchObject({ kind: "answer", text: "Fixed src/cart.js." })
    expect(items.some((item) => item.kind === "error")).toBe(false)
    expect(first.workspace.transcript("fix").activity?.status).toBe("completed")
    const restored = setup({ cwd: first.host.cwd, restored: first.workspace.snapshot() })
    expect(restored.workspace.snapshot().tabs[0]).toMatchObject({ status: "done", unchecked: true })
    expect(restored.workspace.transcript("fix").items.at(-1)).toMatchObject({
      kind: "answer",
      text: "Fixed src/cart.js."
    })
    // A follow-up is a new run: nothing about it is unchecked yet.
    restored.workspace.continue("fix", "Also cover the empty cart.")
    await tick()
    expect(restored.workspace.snapshot().tabs[0]).not.toHaveProperty("unchecked")
    first.workspace.dispose()
    restored.workspace.dispose()
  })

  it("keeps a judge's setup instructions off a failed worker's card", async () => {
    const f = setup()
    f.workspace.request({ id: "fix", title: "Fix", prompt: "Fix it." })
    await tick()
    const error = {
      _tag: "@smthrs/agent/Seat/SeatUnresolved",
      seat: "anthropic:opus",
      message: "Set ANTHROPIC_API_KEY."
    }
    f.finishes[0]!({ _tag: "failed", message: "Set ANTHROPIC_API_KEY.", detail: "", error })
    await tick()
    expect(f.workspace.snapshot().tabs[0]).toMatchObject({
      status: "failed",
      failure: { headline: "Model sign-in required", line: "" },
      message: "Set ANTHROPIC_API_KEY."
    })
    f.workspace.dispose()
  })

  it("refuses to continue a missing, busy or blank worker without changing its run", async () => {
    const f = setup()
    expect(() => f.workspace.continue("missing", "More.")).toThrow("Unknown tab")
    f.workspace.request({ id: "fix", title: "Fix", prompt: "Find the cause." })
    await tick()
    const running = f.workspace.snapshot().tabs[0]!
    expect(() => f.workspace.continue("fix", "More.")).toThrow("Only a finished worker can continue")
    expect(f.workspace.snapshot().tabs[0]).toEqual(running)
    f.finishes[0]!({ _tag: "done", answer: "Found it." })
    await tick()
    const done = f.workspace.snapshot().tabs[0]!
    expect(() => f.workspace.continue("fix", "  \n  ")).toThrow("Enter a message to continue")
    expect(f.workspace.snapshot().tabs[0]).toEqual(done)
    expect(f.inputs).toHaveLength(1)
    f.workspace.dispose()
  })

  it("restores a queued continuation and sends its follow-up when a seat opens", async () => {
    const first = setup()
    for (let index = 0; index < seats; index++) {
      first.workspace.request({ id: `busy-${index}`, title: "Busy", prompt: `Work ${index}.` })
    }
    await tick()
    expect(first.inputs).toHaveLength(seats)
    first.workspace.request({ id: "waiting", title: "Waiting", prompt: "First answer." })
    expect(first.workspace.read("waiting").status).toBe("queued")
    first.finishes[0]!({ _tag: "done", answer: "Initial answer." })
    await tick()
    expect(first.workspace.read("waiting").status).toBe("running")
    expect(first.workspace.continue("busy-0", "Follow-up after restart.")).toEqual({
      id: "busy-0",
      status: "queued"
    })
    const saved = first.workspace.snapshot()
    first.workspace.dispose()

    const restored = setup({ cwd: first.host.cwd, restored: saved })
    await tick()
    expect(restored.workspace.read("busy-0").status).toBe("queued")
    expect(restored.inputs.some((input) => input.prompt === "Follow-up after restart.")).toBe(false)
    const running = restored.workspace.snapshot().tabs.find((tab) => tab.status === "running")!
    const run = restored.inputs.findIndex((input) => input.source === running.id)
    restored.finishes[run]!({ _tag: "done", answer: "Seat released." })
    await tick()
    expect(restored.inputs.at(-1)).toMatchObject({ source: "busy-0", prompt: "Follow-up after restart." })
    restored.workspace.dispose()
  })

  it("restarts an unfinished continuation despite an earlier completion in the same file", async () => {
    const first = setup()
    first.workspace.request({ id: "fix", title: "Fix", prompt: "Find the cause." })
    await tick()
    first.finishes[0]!({ _tag: "done", answer: "Found the cause." })
    await tick()
    first.workspace.continue("fix", "Apply the repair.")
    await tick()
    const saved = first.workspace.snapshot()
    expect(saved.tabs[0]).toMatchObject({ status: "running", prompt: "Apply the repair." })
    first.workspace.dispose()

    const restored = setup({ cwd: first.host.cwd, restored: saved })
    await tick()
    expect(restored.workspace.read("fix").status).toBe("running")
    expect(restored.inputs).toHaveLength(1)
    expect(restored.inputs[0]).toMatchObject({ source: "fix", prompt: "Apply the repair." })
    expect(JSON.stringify(restored.inputs[0]!.history)).toContain("Found the cause.")
    restored.finishes[0]!({ _tag: "done", answer: "Repair applied." })
    await tick()
    expect(restored.workspace.read("fix")).toMatchObject({ status: "done", answer: "Repair applied." })
    restored.workspace.dispose()
  })

  it("ignores a title callback from the earlier turn of the same worker file", async () => {
    const f = setup()
    f.workspace.request({ id: "fix", title: "Fix", prompt: "Find the cause." })
    await tick()
    f.finishes[0]!({ _tag: "done", answer: "Found it." })
    await tick()
    f.workspace.continue("fix", "Apply the repair.")
    await tick()
    expect(f.descriptions).toHaveLength(2)
    f.descriptions[1]!.resolve("Apply the repair")
    await tick()
    f.descriptions[0]!.resolve("Find the cause")
    await tick()
    expect(f.workspace.snapshot().tabs[0]?.description).toBe("Apply the repair")
    f.workspace.dispose()
  })

  it("does not launch a cancelled continuation after another follows it in the same file", async () => {
    const f = setup()
    f.workspace.request({ id: "fix", title: "Fix", prompt: "Find the cause." })
    await tick()
    f.finishes[0]!({ _tag: "done", answer: "Found it." })
    await tick()
    const file = f.workspace.snapshot().tabs[0]!.file
    expect(f.workspace.continue("fix", "First follow-up.")).toEqual({ id: "fix", status: "requested" })
    f.workspace.cancel("fix")
    expect(f.workspace.continue("fix", "Second follow-up.")).toEqual({ id: "fix", status: "requested" })
    await tick()
    expect(f.inputs.map((input) => input.prompt)).toEqual(["Find the cause.", "Second follow-up."])
    expect(f.workspace.snapshot().tabs[0]).toMatchObject({ file, status: "running", prompt: "Second follow-up." })
    const userMessages = Session.load(file).filter((record) => record.type === "user").map((record) => record.text)
    expect(userMessages).toEqual(["Find the cause.", "Second follow-up."])
    expect(f.workspace.transcript("fix").items.filter((item) => item.kind === "user").map((item) => item.text))
      .toEqual(userMessages)
    f.workspace.dispose()
  })

  it("continues a worker stopped before its first session file was created", async () => {
    const f = setup()
    f.workspace.request({ id: "fix", title: "Fix", prompt: "Initial prompt." })
    const file = f.workspace.snapshot().tabs[0]!.file
    f.workspace.cancel("fix")
    expect(existsSync(file)).toBe(false)
    expect(f.workspace.continue("fix", "Run after the stop.")).toEqual({ id: "fix", status: "requested" })
    await tick()
    expect(f.inputs.map((input) => input.prompt)).toEqual(["Run after the stop."])
    expect(Session.load(file).filter((record) => record.type === "user").map((record) => record.text))
      .toEqual(["Run after the stop."])
    f.workspace.dispose()
  })

  it("rebuilds an interrupted native continuation's history from its completed steps and steering", async () => {
    const first = setup()
    first.workspace.request({ id: "fix", title: "Fix", prompt: "Find the cause." })
    await tick()
    first.finishes[0]!({ _tag: "done", answer: "Cause found." })
    await tick()
    first.workspace.continue("fix", "Apply the fix.")
    await tick()
    const second = first.inputs[1]!
    second.onEvent({ _tag: "cell-produced", cell: { text: "write corrected value" } } as never)
    second.onEvent({ _tag: "cell-printed", text: "changed config.json" } as never)
    expect(first.workspace.steer("fix", "Also update the regression test.")).toBe(true)
    const saved = first.workspace.snapshot()
    first.workspace.dispose()

    const restored = setup({ cwd: first.host.cwd, restored: saved })
    await tick()
    expect(restored.inputs).toHaveLength(1)
    const history = JSON.stringify(restored.inputs[0]!.history)
    expect(history).toContain("Cause found.")
    expect(history).toContain("write corrected value")
    expect(history).toContain("changed config.json")
    expect(history).toContain("Also update the regression test.")
    restored.workspace.dispose()
  })

  it("restores a reset-relaunched continuation as running despite its old failed receipt", async () => {
    const first = setup()
    first.workspace.request({ id: "fix", title: "Fix", prompt: "Find the cause." })
    await tick()
    first.finishes[0]!({ _tag: "done", answer: "Cause found." })
    await tick()
    first.workspace.continue("fix", "Apply the fix.")
    await tick()
    first.finishes[1]!({
      _tag: "failed",
      message: "usage limit",
      detail: "stack",
      error: new ModelError({ code: "rate_limited", message: "usage limit", resetAtEpochMillis: Date.now() + 40 })
    })
    await tick()
    expect(first.workspace.read("fix").status).toBe("failed")
    first.workspace.waitForReset("fix")
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(first.workspace.read("fix").status).toBe("running")
    expect(first.inputs).toHaveLength(3)
    const saved = first.workspace.snapshot()
    first.workspace.dispose()

    const restored = setup({ cwd: first.host.cwd, restored: saved })
    await tick()
    expect(restored.workspace.read("fix").status).toBe("running")
    expect(restored.inputs).toHaveLength(1)
    expect(restored.inputs[0]!.prompt).toBe("Apply the fix.")
    restored.workspace.dispose()
  })

  it("keeps the first successful answer through a failed follow-up, manual retry and next follow-up", async () => {
    const f = setup()
    f.workspace.request({ id: "fix", title: "Fix", prompt: "Find the cause." })
    await tick()
    f.finishes[0]!({ _tag: "done", answer: "The stale cache key is the cause." })
    await tick()
    f.workspace.continue("fix", "Correct the key.")
    await tick()
    f.finishes[1]!({ _tag: "failed", message: "Provider unavailable", detail: "" })
    await tick()
    expect(f.workspace.read("fix").status).toBe("failed")
    f.workspace.retry("fix")
    await tick()
    const retryHistory = JSON.stringify(f.inputs[2]!.history)
    expect(retryHistory).toContain("The stale cache key is the cause.")
    f.finishes[2]!({ _tag: "done", answer: "The key is corrected." })
    await tick()
    f.workspace.continue("fix", "Check the result.")
    await tick()
    const nextHistory = JSON.stringify(f.inputs[3]!.history)
    expect(nextHistory.split("The stale cache key is the cause.")).toHaveLength(2)
    expect(nextHistory.split("The key is corrected.")).toHaveLength(2)
    f.workspace.dispose()
  })

  it("keeps each completed answer once across several native continuations", async () => {
    const f = setup()
    const prompts = ["Find the cause.", "Apply the fix.", "Add coverage.", "Review the change."]
    const answers = [
      `Cause: stale cache key. ${"a".repeat(5_000)}`,
      `Fixed the key. ${"b".repeat(5_000)}`,
      `Added a regression test. ${"c".repeat(5_000)}`
    ]
    f.workspace.request({ id: "fix", title: "Fix", prompt: prompts[0]! })
    for (let index = 0; index < answers.length; index++) {
      await tick()
      f.finishes[index]!({ _tag: "done", answer: answers[index]! })
      await tick()
      f.workspace.continue("fix", prompts[index + 1]!)
    }
    await tick()
    expect(f.inputs[3]!.prompt).toBe("Review the change.")
    const history = JSON.stringify(f.inputs[3]!.history)
    for (const answer of answers) {
      expect(history.split(answer)).toHaveLength(2)
    }
    f.workspace.dispose()
  })

  it("never launches a tab stopped while its body was being read", async () => {
    const f = setup()
    f.workspace.request(request)
    await tick()
    f.workspace.cancel("rev")
    f.loads[0]!.resolve(body())
    await tick()
    expect(f.inputs).toHaveLength(0)
    expect(f.workspace.read("rev").status).toBe("cancelled")
  })

  it("keeps a plain delegation's model on retry", async () => {
    const f = setup()
    f.workspace.request({ id: "fix", title: "Fix", prompt: "Fix it.", model: "sol" })
    await tick()
    f.finishes[0]!({ _tag: "failed", message: "Provider down", detail: "" })
    await tick()
    f.workspace.retry("fix")
    await tick()
    expect(f.inputs.map((input) => input.seat)).toEqual([Models.delegateModels.sol, Models.delegateModels.sol])
  })
})

it("checks an agent at launch when the listing was not known at request", async () => {
  const f = setup({ known: false })
  f.workspace.request({ ...request, agent: "manual" })
  await tick()
  f.loads[0]!.resolve(body())
  await tick()
  expect(f.workspace.snapshot().tabs[0]).toMatchObject({ status: "failed", code: "not_invocable" })
  expect(f.inputs).toHaveLength(0)
})

describe("routed workers", () => {
  const plain = { id: "fix", title: "Fix", prompt: "Fix it." }
  const seats = (f: ReturnType<typeof setup>) => f.inputs.map((input) => input.seat)

  it("persists auto and returns the receipt before routing settles, and chat stays usable", async () => {
    const f = setup({ routes: true })
    expect(f.workspace.request(plain)).toEqual({ id: "fix", status: "requested" })
    expect(f.records[0]).toMatchObject({ type: "tab", tab: { status: "requested", seat: Seat.auto } })
    await tick()
    expect(seats(f)).toEqual([Seat.auto])
    expect(f.routers).toHaveLength(1)
    // The router never answers here; chat still requests, publishes and deduplicates.
    expect(f.workspace.request({ ...plain, id: "other" }).status).toBe("requested")
    expect(f.workspace.request(plain)).toEqual({ id: "fix", status: "running" })
    f.workspace.publish({ id: "plan", title: "Plan", summary: "One step.", rows: [] })
    expect(f.workspace.read("fix").status).toBe("running")
  })

  it("keeps the routed seat, and a retry reuses it without routing again", async () => {
    const f = setup({ routes: true })
    f.workspace.request(plain)
    await tick()
    f.routers[0]!.resolve({ seat: "sol", variant: null })
    await tick()
    expect(f.workspace.snapshot().tabs[0]?.seat).toBe("sol")
    expect(f.workspace.request(plain)).toEqual({ id: "fix", status: "running" })
    f.finishes[0]!({ _tag: "failed", message: "Provider down", detail: "" })
    await tick()
    f.workspace.retry("fix")
    await tick()
    expect(seats(f)).toEqual([Seat.auto, "sol"])
    expect(f.routers).toHaveLength(1)
  })

  it("runs a requested model or an agent's declared one without routing", async () => {
    const f = setup({ routes: true })
    f.workspace.request({ ...plain, model: "sol" })
    f.workspace.request(request)
    await tick()
    f.loads[0]!.resolve(body())
    await tick()
    expect(seats(f)).toEqual([Models.delegateModels.sol, "opus"])
    expect(f.workspace.snapshot().tabs.some((tab) => tab.seat === Seat.auto)).toBe(false)
    expect(f.routers).toHaveLength(0)
  })

  it("routes an agent that declares no model", async () => {
    const f = setup({ routes: true })
    f.workspace.request({ ...request, agent: "manual", by: "user" })
    await tick()
    f.loads[0]!.resolve(body())
    await tick()
    expect(seats(f)).toEqual([Seat.auto])
  })

  it("an operator's SMITHERS_TUI_WORKER_SEAT means no routing", async () => {
    const available: Models.Available = {
      models: [{ seat: "openai:gpt-6-sol", label: "GPT-6 Sol", provider: "OpenAI" }, {
        seat: "openai:gpt-6.1-sol",
        label: "GPT-6.1 Sol",
        provider: "OpenAI"
      }],
      defaultSeat: undefined,
      workerSeat: undefined,
      environment: {}
    }
    const f = setup({
      routes: Models.routing(available, { SMITHERS_TUI_WORKER_SEAT: "worker:test" }, true) !== undefined
    })
    f.workspace.request(plain)
    await tick()
    expect(seats(f)).toEqual(["worker:test"])
    expect(f.routers).toHaveLength(0)
  })

  it("fails the tab visibly when routing fails, and a retry routes again", async () => {
    const f = setup({ routes: true })
    f.workspace.request(plain)
    await tick()
    f.routers[0]!.reject(new Seat.SeatUnrouted({ seat: Seat.auto, reason: "timeout", message: "Jev timed out" }))
    await tick()
    expect(f.workspace.read("fix")).toMatchObject({ status: "failed", message: "Jev timed out" })
    expect(f.workspace.snapshot().tabs[0]?.seat).toBe(Seat.auto)
    f.workspace.retry("fix")
    await tick()
    expect(f.routers).toHaveLength(2)
    f.routers[1]!.resolve({ seat: "sol", variant: null })
    await tick()
    expect(f.workspace.snapshot().tabs[0]).toMatchObject({ status: "running", seat: "sol" })
  })
  it("keeps the routed variant, and a retry hands it back with the routed seat", async () => {
    const f = setup({ routes: true })
    f.workspace.request(plain)
    await tick()
    f.routers[0]!.resolve({ seat: "sol", variant: "investigate" })
    await tick()
    expect(f.workspace.snapshot().tabs[0]).toMatchObject({ seat: "sol", variant: "investigate" })
    f.finishes[0]!({ _tag: "failed", message: "Provider down", detail: "" })
    await tick()
    f.workspace.retry("fix")
    await tick()
    expect(f.inputs.map(({ seat, variant }) => ({ seat, variant }))).toEqual([
      { seat: Seat.auto, variant: undefined },
      { seat: "sol", variant: "investigate" }
    ])
    expect(f.routers).toHaveLength(1)
  })

  it("a restored tab the current build refuses fails its tab instead of the process", async () => {
    const first = setup({ routes: true })
    first.workspace.request(plain)
    await tick()
    const saved = first.records.flatMap((record) => record.type === "tab" ? [record.tab] : []).at(-1)!
    // A session an older build saved while it still admitted `agent: "auto"`.
    const legacy = { ...saved, status: "requested" as const, agent: { name: "auto", digest: "" } }
    const second = setup({ routes: true, cwd: first.host.cwd, restored: { tabs: [legacy], panels: [] } })
    await tick()
    await tick()
    expect(second.workspace.snapshot().tabs).toMatchObject([{
      id: legacy.id,
      status: "failed",
      code: "seat_as_agent",
      failure: { headline: "auto is a model; choose it with /model." }
    }])
    expect(second.workspace.transcript(legacy.id).activity?.status).toBe("failed")
    expect(second.inputs).toHaveLength(0)
    second.workspace.dispose()
  })

  it("a routed tab restored after restart resumes with its seat and variant", async () => {
    const first = setup({ routes: true })
    first.workspace.request(plain)
    await tick()
    first.routers[0]!.resolve({ seat: "sol", variant: "change" })
    await tick()
    const saved = first.records.flatMap((record) => record.type === "tab" ? [record.tab] : []).at(-1)!
    expect(saved).toMatchObject({ status: "running", seat: "sol", variant: "change" })
    const second = setup({ routes: true, cwd: first.host.cwd, restored: { tabs: [saved], panels: [] } })
    await tick()
    await tick()
    expect(second.inputs.map(({ seat, variant }) => ({ seat, variant }))).toEqual([{
      seat: "sol",
      variant: "change"
    }])
    expect(second.routers).toHaveLength(0)
  })

  it("a routed UI worker restored after restart keeps its route's backups", async () => {
    const first = setup({ routes: true })
    first.workspace.request(plain)
    await tick()
    // The graph fails a UI task's Opus over to Kimi, then Sol.
    first.routers[0]!.resolve({ seat: "opus", variant: "change", backups: ["kimi", "sol"] })
    await tick()
    const saved = first.records.flatMap((record) => record.type === "tab" ? [record.tab] : []).at(-1)!
    expect(saved).toMatchObject({ seat: "opus", backups: ["kimi", "sol"] })
    const second = setup({ routes: true, cwd: first.host.cwd, restored: { tabs: [saved], panels: [] } })
    await tick()
    await tick()
    expect(second.inputs.map(({ route, seat }) => ({ seat, route }))).toEqual([{
      seat: "opus",
      route: { backups: ["kimi", "sol"] }
    }])
    expect(second.routers).toHaveLength(0)
  })

  it("a retry on a seat the user picks drops the routed variant", async () => {
    const f = setup({ routes: true })
    f.workspace.request(plain)
    await tick()
    f.routers[0]!.resolve({ seat: "sol", variant: "investigate" })
    await tick()
    f.finishes[0]!({ _tag: "failed", message: "Provider down", detail: "" })
    await tick()
    f.workspace.retry("fix", Models.delegateModels.sol)
    await tick()
    expect(f.inputs[1]).toMatchObject({ seat: Models.delegateModels.sol })
    expect(f.inputs[1]?.variant).toBeUndefined()
    expect(f.inputs[1]?.route).toBeUndefined()
    expect(f.workspace.snapshot().tabs[0]?.variant).toBeUndefined()
    expect(f.workspace.snapshot().tabs[0]?.backups).toBeUndefined()
  })

  it("a routed worker is described by its routed seat", async () => {
    const f = setup({ routes: true })
    f.workspace.request(plain)
    await tick()
    // Nothing is asked of `auto`; the title stands in until the seat is known.
    expect(f.descriptions).toHaveLength(0)
    expect(f.workspace.snapshot().tabs[0]?.description).toBe(plain.title)
    f.routers[0]!.resolve({ seat: "sol", variant: "change" })
    await tick()
    expect(f.descriptions.map(({ seat }) => seat)).toEqual(["sol"])
    f.descriptions[0]!.resolve("Fixes the bug")
    await tick()
    expect(f.workspace.snapshot().tabs[0]?.description).toBe("Fixes the bug")
  })

  it("a stale description from an earlier attempt never overwrites the retry's", async () => {
    const f = setup({ routes: true })
    f.workspace.request(plain)
    await tick()
    f.routers[0]!.resolve({ seat: "sol", variant: null })
    await tick()
    f.finishes[0]!({ _tag: "failed", message: "Provider down", detail: "" })
    await tick()
    f.workspace.retry("fix")
    await tick()
    expect(f.descriptions.map(({ seat }) => seat)).toEqual(["sol", "sol"])
    f.descriptions[1]!.resolve("Newer attempt")
    await tick()
    f.descriptions[0]!.resolve("Earlier attempt")
    await tick()
    expect(f.workspace.snapshot().tabs[0]?.description).toBe("Newer attempt")
  })
})
