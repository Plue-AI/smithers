/** The real Port over the native control host, under Bun, against a fixture project. */
import { afterAll, expect, it } from "bun:test"
import { Schema } from "effect"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as FlowControl from "../src/flow-control.ts"
import { FlowError } from "../src/flows.ts"
import { FlowRuns } from "../src/flows.ts"
import * as Host from "../src/host.ts"

const root = join(import.meta.dir, "fixtures", "flows-project")
const stateRoot = mkdtempSync(join(tmpdir(), "tui-flows-"))
const host = Host.make({ cwd: root, environment: {}, approvals: "ask" })
const port = FlowControl.make({ cwd: root, environment: {}, stateRoot, approvals: host.approvals! })
// Each discover builds a fresh registry over the real fixture project, several seconds under load.
afterAll(async () => {
  await port.dispose()
  await host.dispose()
  rmSync(stateRoot, { recursive: true, force: true })
})

it("discovers flows without importing them", async () => {
  const listed = await port.discover()
  expect(listed.map(({ name, description }) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name)))
    .toEqual([
      { name: "composed", description: "Composed" },
      { name: "consequential", description: "Consequential" },
      { name: "echo", description: "Echo" },
      { name: "review", description: "Review" },
      { name: "scout", description: "Scout" },
      { name: "wide", description: "Wide" }
    ])
}, 30_000)

it("lists a markdown flow as an agent with its seat and TUI manifest", async () => {
  const review = (await port.discover()).find((flow) => flow.name === "review")
  expect(review).toMatchObject({
    kind: "markdown",
    seat: "sol",
    effort: "high",
    capabilities: ["fs:read:**"],
    tui: { keys: [{ key: "alt+r", label: "Review" }] }
  })
  expect((await port.discover()).find((flow) => flow.name === "echo")?.kind).toBe("module")
}, 30_000)

it("reads an agent's body and refuses a module's", async () => {
  const body = await port.body("review")
  expect(body.text.trim()).toBe("Review the change.")
  expect(body.baseDirectory).toBe(join(root, "flows", "review"))
  expect(body.digest).toMatch(/^[0-9a-f]{64}$/)
  const refused = await port.body("echo").catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(FlowError)
  expect((refused as FlowError).code).toBe("refused")
  const missing = await port.body("missing").catch((error: unknown) => error)
  expect((missing as FlowError).code).toBe("unknown_flow")
}, 30_000)

it("keeps an agent's declared capabilities when it also declares flows", async () => {
  // The registry widens a delegating markdown flow to `*`; the agent's envelope must not widen with it.
  expect((await port.discover()).find((flow) => flow.name === "scout")?.capabilities).toEqual(["*"])
  expect((await port.body("scout")).capabilities).toEqual(["fs:read:**"])
  expect((await port.body("review")).capabilities).toEqual(["fs:read:**"])
}, 30_000)

it("reads a module flow's payload schema", async () => {
  const input = await port.input("echo")
  expect(input).toBeDefined()
  expect(Schema.is(input!)({ text: "hi" })).toBe(true)
  expect(Schema.is(input!)({})).toBe(false)
})

it("takes a markdown flow's input as it is: the control plane runs its prompt, not a catalog delegate", async () => {
  // The catalog refuses `review` (no `agent` delegate here); starting it must not repeat that refusal.
  expect(await port.input("review")).toBeUndefined()
}, 30_000)

it("rejects an unknown flow with a typed error", async () => {
  const error = await port.input("missing").catch((error: unknown) => error)
  expect(error).toBeInstanceOf(FlowError)
  expect((error as FlowError).code).toBe("unknown_flow")
})

it("keeps the actionable import failure and its original cause", async () => {
  const project = mkdtempSync(join(tmpdir(), "tui-broken-flow-"))
  const folder = join(project, "flows/broken")
  mkdirSync(folder, { recursive: true })
  symlinkSync(join(import.meta.dir, "../node_modules"), join(project, "node_modules"), "dir")
  writeFileSync(
    join(folder, "flow.ts"),
    `
    import { Flow } from "@smthrs/flow"
    import { Node } from "@smthrs/plan"
    import { Schema } from "effect"
    throw new Error("missing project configuration\\nadditional diagnostic detail")
    export default Flow.make("broken", { description: "Broken", payload: {}, success: Schema.String, body: () => Node.succeed("unused") })
  `
  )
  const broken = FlowControl.make({ cwd: project, environment: {}, approvals: host.approvals! })
  try {
    const failure = await broken.input("broken").catch((error: unknown) => error) as FlowError
    expect(failure).toBeInstanceOf(FlowError)
    expect(failure.code).toBe("refused")
    expect(failure.message).toContain("missing project configuration")
    expect(failure.message).not.toContain("additional diagnostic detail")
    expect((failure.cause as Error).cause).toBeInstanceOf(Error)
    expect(((failure.cause as Error).cause as Error).message).toContain("additional diagnostic detail")
  } finally {
    await broken.dispose()
    rmSync(project, { recursive: true, force: true })
  }
})

it("plans, starts and settles a run from the watch", async () => {
  const card = await port.plan("echo", { text: "hi" })
  const runId = await port.start(card)
  expect(runId).toBeString()
  const events: Array<string> = []
  const settled = await port.watch(runId, (event) => events.push(event.kind)).done
  expect(settled).toEqual({ kind: "done", answer: "hi" })
  expect(events).toContain("control.run.completed")
  expect((await port.events(runId)).length).toBeGreaterThan(0)
  // A retry that finds the run already completed reads its answer from the journal.
  expect(await port.resume(runId)).toEqual({ kind: "done", answer: "hi" })
}, 120_000)

it("lists runs started outside the TUI without opening the flow host", async () => {
  const runId = await port.start(await port.plan("echo", { text: "listed" }))
  await port.watch(runId, () => {}).done
  // A second port over the same store, as `smthrs flow start` leaves it: never opened here.
  const observer = FlowControl.make({ cwd: root, environment: {}, stateRoot, approvals: host.approvals! })
  try {
    const listed = await observer.runs!()
    expect(listed.find((run) => run.runId === runId)).toMatchObject({ runId, flow: "echo", status: "completed" })
    expect(listed.length).toBeLessThanOrEqual(20)
  } finally {
    await observer.dispose()
  }
}, 120_000)

it("lists no runs and creates no store where nothing ran", async () => {
  const empty = mkdtempSync(join(tmpdir(), "tui-no-store-"))
  const observer = FlowControl.make({ cwd: root, environment: {}, stateRoot: empty, approvals: host.approvals! })
  try {
    expect(await observer.runs!()).toEqual([])
    expect(readdirSync(empty)).toEqual([])
  } finally {
    await observer.dispose()
    rmSync(empty, { recursive: true, force: true })
  }
})

it("routes a * envelope through the shared approval rows", async () => {
  const card = await port.plan("wide", {})
  const started = port.start(card).catch((error: unknown) => error)
  for (let n = 0; n < 200 && (await host.approvals!.pending()).length === 0; n++) await Bun.sleep(5)
  const [request] = await host.approvals!.pending()
  expect(request!.action).toBe("fs:write")
  expect(await host.approvals!.reply(request!, "deny")).toBeUndefined()
  expect(await started).toBeInstanceOf(FlowError)
}, 60_000)

it("stops a project flow waiting for authorization without launching it", async () => {
  const runs = new FlowRuns({ port, persist: () => {} })
  const receipt = runs.request({ flow: "consequential", input: {}, by: "user" })
  try {
    for (let n = 0; n < 2000 && (await host.approvals!.pending()).length === 0; n++) await Bun.sleep(5)
    expect(await host.approvals!.pending()).toHaveLength(1)
    runs.cancel(receipt.id)
    await Bun.sleep(20)
    expect(await host.approvals!.pending()).toHaveLength(0)
    expect(runs.get(receipt.id)?.runId).toBeUndefined()
    expect(runs.get(receipt.id)!.status).toBe("cancelled")
  } finally {
    for (const request of await host.approvals!.pending()) await host.approvals!.reply(request, "deny")
    runs.dispose()
  }
}, 60_000)

for (const mode of ["ask", "deny", "all"] as const) {
  for (const by of ["user", "agent"] as const) {
    it(`${by} project flows honor ${mode} through the worker approval store`, async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), "tui-flow-approval-"))
      const host = Host.make({ cwd: root, environment: {}, approvals: mode })
      const port = FlowControl.make({
        cwd: root,
        stateRoot,
        environment: { SMITHERS_TUI_APPROVE: mode },
        approvals: host.approvals!
      })
      const runs = new FlowRuns({ port, persist: () => {} })
      const request = runs.request({ id: "consequential", flow: "consequential", input: {}, by })
      const wait = async (until: () => Promise<boolean>) => {
        // Opening the host plans every fixture flow; under load that alone passes 20 s.
        const deadline = Date.now() + 50_000
        while (!await until()) {
          if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(runs.snapshot())}`)
          await Bun.sleep(5)
        }
      }
      try {
        await wait(async () =>
          (await host.approvals!.pending()).length > 0 || ["done", "failed"].includes(runs.get(request.id)!.status)
        )
        if (mode === "ask") {
          expect((await host.approvals!.pending()).length).toBe(1)
          const actions: string[] = []
          for (let n = 0; n < 3; n++) {
            await wait(async () => (await host.approvals!.pending()).length > 0)
            const [pending] = await host.approvals!.pending()
            expect(pending!.source).toBe("flow:consequential")
            expect(runs.get(request.id)?.runId).toBeUndefined()
            actions.push(pending!.action)
            expect(await host.approvals!.reply(pending!, pending!.always ? "run" : "once")).toBeUndefined()
          }
          expect(actions.sort()).toEqual(["fs:write", "net:post", "proc:spawn"])
        }
        await wait(async () => ["done", "failed"].includes(runs.get(request.id)!.status))
        expect(runs.get(request.id)?.status).toBe(mode === "deny" ? "failed" : "done")
        if (mode === "deny") {
          expect(runs.get(request.id)?.runId).toBeUndefined()
          expect(runs.get(request.id)?.message).toContain("Denied:")
        }
        expect(await host.approvals!.pending()).toEqual([])
      } finally {
        runs.dispose()
        await port.dispose()
        await host.dispose()
        rmSync(stateRoot, { recursive: true, force: true })
      }
    }, 60_000)
  }
}

it("settles a run whose input the payload schema rejects as failed", async () => {
  // Planning accepts it (the body cannot be walked); the run itself fails, and the watch says so.
  const runId = await port.start(await port.plan("echo", { text: 3 }))
  const settled = await port.watch(runId, () => {}).done
  // The cause's first line only, never its stack.
  expect(settled).toEqual({ kind: "failed", message: "Schema validation failed" })
}, 60_000)

it("stops a running run through the control plane", async () => {
  const runId = await port.start(await port.plan("echo", { text: "stop" }))
  // `start` returns before the engine drives the run, so the stop lands first.
  await port.cancel(runId)
  expect(await port.watch(runId, () => {}).done).toEqual({ kind: "cancelled" })
  expect((await port.events(runId)).map((event) => event.kind)).toContain("control.run.cancel-requested")
  const error = await port.cancel("missing").catch((error: unknown) => error)
  expect(error).toBeInstanceOf(FlowError)
  expect((error as FlowError).code).toBe("control")
}, 60_000)
