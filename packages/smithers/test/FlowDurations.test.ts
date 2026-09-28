/**
 * The duration projection, over runs a real engine really executed.
 *
 * `@smthrs/gateway` proves the fold and the read path against fixtures. This
 * is the other half: the node records come from the engine's own journal,
 * cross into the control journal through the `EngineJournalSupervisor` bridge
 * a deployed host wires, and are read back through the same
 * `Projection.Snapshot` a card calls. If the engine stops recording a node, or
 * records one without the tag it dispatched, the rows below empty out.
 */
import { Control } from "@smthrs/control/Control"
import type { ApprovalPayload, ControlEvent, PlanCard } from "@smthrs/control/ControlSchema"
import type * as GatewayProjection from "@smthrs/gateway/GatewayProjection"
import { Projections } from "@smthrs/gateway/Projections"
import { Effect, type Scope } from "effect"
import { describe, expect, it } from "vitest"
import { bridgeSettledKind, Engine, flowId, relayPrincipal, runOn, stack } from "./BridgedEngineRun.ts"

const approvalOf = (card: PlanCard): ApprovalPayload => ({
  target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
  scope: card.approval.scope,
  idempotencyKey: `approve:${card.planId}`
})

/** Plans, approves and launches the fixture, returning its run id. */
const launch = (label: string) =>
  Effect.gen(function*() {
    const control = yield* Control
    const card = yield* control.plan({ flowId, input: { label } })
    yield* control.approve({ ...approvalOf(card), principal: relayPrincipal })
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${card.planId}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")
    return receipt.runId
  })

/** The run's control events once the bridge has drained the engine's journal. */
const drained = (
  runId: string,
  attempts = 2_000
): Effect.Effect<ReadonlyArray<ControlEvent>, never, Projections> =>
  Effect.gen(function*() {
    const projections = yield* Projections
    const events = (yield* Effect.orDie(projections.snapshot({ _tag: "run-events", runId }))).rows
    if (events.some((event) => event.kind === bridgeSettledKind)) return events
    if (attempts <= 0) return yield* Effect.die(`the bridge never drained ${runId}`)
    yield* Effect.sleep("5 millis")
    return yield* drained(runId, attempts - 1)
  })

/** Runs the fixture to its terminal status and waits for the bridge to catch up. */
const finished = (label: string) =>
  Effect.gen(function*() {
    const control = yield* Control
    const engine = yield* Engine
    const runId = yield* launch(label)
    yield* engine.parkedBelow(runId)
    yield* control.signal({
      runId,
      signal: { name: "graph-gate", payload: "merged" },
      idempotencyKey: `gate:${runId}`
    })
    expect(yield* engine.settled(runId)).toBe("completed")
    yield* drained(runId)
    return runId
  })

const scenario = <E>(
  title: string,
  body: () => Effect.Effect<void, E, Control | Projections | Engine | Scope.Scope>
) => it(title, { timeout: 120_000 }, () => runOn(stack, body()))

describe("flow-durations over a bridged real engine", () => {
  scenario("ranks every tag two finished runs of the flow executed", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const selector = { _tag: "flow-durations" as const, flowId }

      // Nothing has finished yet, so the flow predicts nothing.
      expect((yield* projections.snapshot(selector)).rows).toEqual([])

      yield* finished("durations-first")
      yield* finished("durations-second")

      const rows = (yield* projections.snapshot(selector)).rows as ReadonlyArray<GatewayProjection.FlowDurationRow>

      // The tags are the ones the fixture's graph dispatches: action tags and
      // flow tags, never a step key digest and never a plan node id. Each one
      // is executed once per run, so two runs answer two samples, including
      // for the three flow tags the engine records twice: once on the caller's
      // `FlowCall` node and once on the callee execution's own `root`.
      // Pinning them makes a node the engine stops recording, or starts
      // counting twice again, fail here.
      expect(new Map(rows.map((row) => [row.actionTag, row.samples]))).toEqual(
        new Map([
          ["agent/run", 2],
          ["gateway/GraphFixture", 2],
          ["gateway/graph/Ask", 2],
          ["gateway/graph/Cacheable", 2],
          ["gateway/graph/Flaky", 2],
          ["gateway/graph/Gate", 2],
          ["gateway/graph/Steady", 2],
          ["system/human-task", 2]
        ])
      )

      // `gateway/graph/Doomed` raises on every attempt, and a collapse is not
      // a duration: the tag has no row at all rather than a row measuring how
      // long the failure took.
      expect(rows.some((row) => row.actionTag === "gateway/graph/Doomed")).toBe(false)

      for (const row of rows) {
        expect(row.flowId).toBe(flowId)
        expect(row.p50Ms).toBeGreaterThanOrEqual(0)
        expect(row.p90Ms).toBeGreaterThanOrEqual(row.p50Ms)
      }

      // A flow tag measures wall time, and the fixture's gate parks on a human
      // until this suite signals it. `Gate` contains `Ask` contains
      // `system/human-task`, and the park is inside all three, so their
      // durations nest. These rows are how long the flow took, not how long it
      // computed.
      const millis = (actionTag: string) => rows.find((row) => row.actionTag === actionTag)!
      expect(millis("gateway/graph/Gate").p50Ms).toBeGreaterThanOrEqual(millis("gateway/graph/Ask").p50Ms)
      expect(millis("gateway/graph/Ask").p50Ms).toBeGreaterThanOrEqual(millis("system/human-task").p50Ms)
      // Rows read in tag order, so two reads of the same history agree.
      expect(rows.map((row) => row.actionTag)).toEqual([...rows.map((row) => row.actionTag)].sort())
    }))
})
