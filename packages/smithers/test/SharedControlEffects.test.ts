/** The shared implementations run without either CLI parser or a Console renderer. */
import { Control } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Launch from "../src/commands/Launch.ts"
import * as RunControl from "../src/commands/RunControl.ts"
import * as Project from "../src/Project.ts"
import * as Ui from "../src/Ui.ts"

const flow = {
  flowId: "demo/ship",
  description: "Ship",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} }
} as const
const host = Layer.mergeAll(
  TestControl.layer({ flows: [flow], now: () => 0 }),
  Project.layer(process.cwd(), Project.legacyRoot(undefined, process.cwd())),
  Ui.layer({})
)
const run = <A, E>(effect: Effect.Effect<A, E, Control.Control | Ui.Ui>) =>
  Effect.runPromise(effect.pipe(Effect.provide(host)))

const options: Launch.StartOptions = {
  flow: flow.flowId,
  data: Option.none(),
  wait: false,
  detached: false,
  quiet: true,
  remote: Option.none(),
  mcpConfig: Option.none(),
  root: Option.none(),
  budgetTokens: Option.none(),
  budgetMs: Option.none(),
  budgetUsd: Option.none(),
  onExceeded: Option.none(),
  deadline: Option.none()
}

describe("shared control Effects", () => {
  it("plans, approves, executes and reads output as documents", async () => {
    const result = await run(Effect.gen(function*() {
      const card = yield* RunControl.plan(flow.flowId, ["branch=next", "flag"], Option.some("{\"branch\":\"main\"}"))
      const approved = yield* Launch.approve(JSON.stringify(card.approval))
      const launched = yield* Launch.execute(JSON.stringify(card.approval))
      expect(launched).toMatchObject({ _tag: "Accepted" })
      const runId = (launched as { runId: string }).runId
      return { card, approved, output: yield* RunControl.output(runId) }
    }))
    expect(result.card).toMatchObject({
      flowId: flow.flowId,
      inputSummary: JSON.stringify({ branch: "main", flag: true })
    })
    expect(result.approved).toMatchObject({ _tag: "Accepted" })
    expect(result.output).toEqual([])
  })

  it("starts through the same plan and approval services", async () => {
    const document = await run(Launch.start(options))
    expect(document).toMatchObject({ _tag: "Accepted", runId: expect.any(String) })
  })

  it.each([
    { budgetTokens: Option.some(0) },
    { budgetMs: Option.some(1.5) },
    { budgetUsd: Option.some(Number.POSITIVE_INFINITY) },
    { deadline: Option.some("never") },
    { detached: true, wait: true },
    { detached: true, remote: Option.some("https://remote.invalid") }
  ])("rejects invalid start options before approving: %j", async (patch) => {
    await expect(run(Launch.start({ ...options, ...patch }))).rejects.toThrow()
  })

  it("refuses reserved plans before launching", async () => {
    await expect(run(RunControl.plan("system/release", [], Option.none()))).rejects.toThrow()
  })

  it.each(["{", "{\"target\":{}}"])("rejects malformed approval payload %s", async (serialized) => {
    await expect(run(Launch.execute(serialized))).rejects.toThrow(/approval/)
    await expect(run(Launch.approve(serialized))).rejects.toThrow(/approval/)
    await expect(run(Launch.deny(serialized))).rejects.toThrow(/approval/)
  })

  it("delivers distinct signals and exact steering text, then cancels idempotently", async () => {
    const result = await run(Effect.gen(function*() {
      const launched = yield* Launch.start(options)
      const runId = (launched as { runId: string }).runId
      const first = yield* RunControl.deliverSignal(runId, "{\"name\":\"first\",\"payload\":null}")
      const second = yield* RunControl.deliverSignal(runId, "{\"name\":\"second\",\"payload\":null}")
      const steer = yield* RunControl.steer(runId, "Keep the exact words")
      const cancelled = yield* RunControl.cancel(runId)
      const replay = yield* RunControl.cancel(runId)
      return { first, second, steer, cancelled, replay }
    }))
    if (result.first._tag !== "Accepted" || result.second._tag !== "Accepted") {
      throw new Error("Expected both signal deliveries to be accepted")
    }
    expect(result.first.receiptId).not.toEqual(result.second.receiptId)
    expect(result.steer).toMatchObject({ _tag: "Accepted" })
    expect(result.cancelled).toMatchObject({ _tag: "Terminal", status: "cancelled" })
    expect(result.replay).toEqual(result.cancelled)
  })

  it("rejects unknown runs and missing node output with actionable errors", async () => {
    await expect(run(RunControl.output("missing"))).rejects.toThrow()
    await run(Effect.gen(function*() {
      const launched = yield* Launch.start(options)
      const runId = (launched as { runId: string }).runId
      const exit = yield* Effect.exit(RunControl.output(runId, "missing-node"))
      expect(exit._tag).toBe("Failure")
    }))
  })
})
