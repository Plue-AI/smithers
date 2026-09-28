/**
 * A run records the code that started it, and resume refuses other code.
 *
 * Before #1807 nothing on a run said which flow definition launched it, so a
 * resume after the flow was edited re-entered the new definition and re-ran
 * whatever step its changed keys no longer matched. The run row now carries
 * the flow's `executionDigest` and the engine version, and `Control.resume`
 * refuses a run whose flow no longer has that digest unless the operator
 * passes `allowCodeDrift`.
 */
import { Effect, Exit } from "effect"
import { expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { CodeDrift } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { DurableFlow } from "../src/SqlControlRuntime.ts"
import { durable } from "./DurableStack.ts"
import { park } from "./Park.ts"
import { live, memoryRuntime } from "./TestStack.ts"

const flow = (executionDigest: string): DurableFlow => ({
  flowId: "drift",
  description: "A flow edited between launch and resume",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} },
  executionDigest
})

/** Starts a v1 run, parks it, re-registers `next`, and resumes. */
const resumeAfter = (next: string | undefined, allowCodeDrift?: boolean) => {
  let catalog = [flow("digest-v1")]
  return Effect.gen(function*() {
    const control = yield* Control
    const runtime = yield* ControlRuntime
    const card = yield* control.plan({ flowId: "drift", input: {} })
    yield* control.approve({ ...card.approval, idempotencyKey: "approve:drift" })
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: "run:drift"
    })
    if (!("runId" in receipt) || receipt.runId === undefined) return yield* Effect.die(JSON.stringify(receipt))
    const runId = receipt.runId
    const started = yield* runtime.getRun(runId)
    yield* park(runtime, runId)
    catalog = next === undefined ? [] : [flow(next)]
    const resumed = yield* Effect.exit(
      control.resume({
        runId,
        idempotencyKey: `resume:drift:${allowCodeDrift === true}`,
        ...(allowCodeDrift === undefined ? {} : { allowCodeDrift })
      })
    )
    return { started, resumed, after: yield* runtime.getRun(runId) }
  }).pipe(
    Effect.provide(durable({
      engineVersion: "9.9.9-test",
      loadFlows: () => Effect.sync(() => catalog),
      executor: ControlExecutor.makeNoop({ launch: () => Effect.succeed("accepted" as const) })
    })),
    Effect.scoped,
    Effect.runPromise
  )
}

it("records the flow's execution digest and the engine version on the run", async () => {
  const { started } = await resumeAfter("digest-v1")
  expect(started.executionDigest).toBe("digest-v1")
  expect(started.engineVersion).toBe("9.9.9-test")
})

it("resume refuses a run started by a different plan fingerprint", async () => {
  const { resumed, after } = await resumeAfter("digest-v2")
  expect(Exit.isFailure(resumed)).toBe(true)
  const error = Exit.isFailure(resumed) ? resumed.cause.reasons[0] : undefined
  expect(error?._tag === "Fail" ? error.error : undefined).toEqual(
    new CodeDrift({ runId: after.runId, flowId: "drift", recorded: "digest-v1", current: "digest-v2" })
  )
  // Refused before the claim: the run is still parked and unowned.
  expect(after.status).toBe("parked")
  expect(after.ownerId).toBeUndefined()
})

it("refuses a run whose flow is gone", async () => {
  const { resumed, after } = await resumeAfter(undefined)
  const error = Exit.isFailure(resumed) ? resumed.cause.reasons[0] : undefined
  const drift = error?._tag === "Fail" ? error.error : undefined
  expect(drift).toEqual(new CodeDrift({ runId: after.runId, flowId: "drift", recorded: "digest-v1" }))
  expect(drift?.message).toBe(
    `Run ${after.runId} started on drift digest-v1, which is now gone. Resume with --allow-code-drift to run the changed code.`
  )
  expect(after.status).toBe("parked")
})

it("resumes an unchanged flow", async () => {
  const { resumed, after } = await resumeAfter("digest-v1")
  expect(Exit.isSuccess(resumed)).toBe(true)
  expect(after.status).toBe("accepted")
})

it("resumes drifted code when the operator allows it", async () => {
  const { resumed, after } = await resumeAfter("digest-v2", true)
  expect(Exit.isSuccess(resumed)).toBe(true)
  expect(after.status).toBe("accepted")
})

it("records the same identity in the memory runtime and resumes its unchanged flow", async () => {
  const observed = await Effect.gen(function*() {
    const control = yield* Control
    const runtime = yield* ControlRuntime
    const card = yield* control.plan({ flowId: "drift", input: {} })
    yield* control.approve({ ...card.approval, idempotencyKey: "approve:memory" })
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: "run:memory"
    })
    if (!("runId" in receipt) || receipt.runId === undefined) return yield* Effect.die(JSON.stringify(receipt))
    const runId = receipt.runId
    const started = yield* runtime.getRun(runId)
    yield* park(runtime, runId)
    yield* control.resume({ runId, idempotencyKey: "resume:memory" })
    return { started, after: yield* runtime.getRun(runId) }
  }).pipe(
    Effect.provide(live({
      runtime: memoryRuntime({ flows: [flow("digest-v1")], engineVersion: "9.9.9-test" }),
      executor: ControlExecutor.makeNoop({ launch: () => Effect.succeed("accepted" as const) })
    })),
    Effect.runPromise
  )
  expect(observed.started).toMatchObject({ executionDigest: "digest-v1", engineVersion: "9.9.9-test" })
  expect(observed.after.status).toBe("accepted")
})
