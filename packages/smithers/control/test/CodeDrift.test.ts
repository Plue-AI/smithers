/**
 * A run records the code that started it, and every path that re-drives it
 * refuses other code.
 *
 * Before #1807 nothing on a run said which flow definition launched it, so a
 * resume after the flow was edited re-entered the new definition and re-ran
 * whatever step its changed keys no longer matched. The run row now carries
 * the flow's `executionDigest` and the engine version. `Control.resume`, a
 * node approval decision, and a steer wake refuse a run whose flow or engine
 * changed, unless the operator resumes it with `allowCodeDrift`, which then
 * records the code it resumed on. An exact run lookup reports the drift.
 */
import { Effect, Exit } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { expect, it } from "vitest"
import { Control, type Service as ControlService } from "../src/Control.ts"
import { CodeDrift } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { ApprovalTarget, RunId } from "../src/ControlSchema.ts"
import type { DurableFlow } from "../src/SqlControlRuntime.ts"
import { durable, type DurableStack } from "./DurableStack.ts"
import { park } from "./Park.ts"
import { live, memoryRuntime } from "./TestStack.ts"

const flow = (executionDigest: string): DurableFlow => ({
  flowId: "drift",
  description: "A flow edited between launch and resume",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} },
  executionDigest
})

/**
 * Starts a v1 run, parks it, runs `before` against it, re-registers `next`
 * (or removes the flow), and runs `act`.
 */
const scenario = <A, E>(options: {
  readonly next: string | undefined
  readonly before?: (runId: RunId) => Effect.Effect<void, unknown, DurableStack>
  readonly act: (runId: RunId) => Effect.Effect<A, E, DurableStack>
}) => {
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
    if (options.before !== undefined) yield* options.before(runId)
    catalog = options.next === undefined ? [] : [flow(options.next)]
    const acted = yield* Effect.exit(options.act(runId))
    return { runId, started, acted, after: yield* runtime.getRun(runId) }
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

/** Starts a v1 run, parks it, re-registers `next`, and resumes. */
const resumeAfter = (
  next: string | undefined,
  allowCodeDrift?: boolean,
  before?: (runId: RunId) => Effect.Effect<void, unknown, DurableStack>
) =>
  scenario({
    next,
    ...(before === undefined ? {} : { before }),
    act: (runId) =>
      withControl((control) =>
        control.resume({
          runId,
          idempotencyKey: `resume:drift:${allowCodeDrift === true}`,
          ...(allowCodeDrift === undefined ? {} : { allowCodeDrift })
        })
      )
  }).then(({ acted, ...rest }) => ({ ...rest, resumed: acted }))

const withControl = <A, E>(f: (control: ControlService) => Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    return yield* f(yield* Control)
  })

const withSql = <A, E>(f: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    return yield* f(yield* SqlClient.SqlClient)
  })

/** The typed failure an exit carries, if any. */
const failure = <E>(exit: Exit.Exit<unknown, E>): E | undefined => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return reason?._tag === "Fail" ? reason.error : undefined
}

/** Rewrites a stored control summary field, as an older build would have left it. */
const storeField = (runId: RunId, field: string, value: string) =>
  withSql((sql) =>
    sql`UPDATE flows_runs SET state_json = json_set(state_json, ${`$.${field}`}, ${value}) WHERE run_id = ${runId}`
  )

it("records the flow's execution digest and the engine version on the run", async () => {
  const { started } = await resumeAfter("digest-v1")
  expect(started.executionDigest).toBe("digest-v1")
  expect(started.engineVersion).toBe("9.9.9-test")
})

it("resume refuses a run started by a different plan fingerprint", async () => {
  const { resumed, after } = await resumeAfter("digest-v2")
  expect(Exit.isFailure(resumed)).toBe(true)
  expect(failure(resumed)).toEqual(
    new CodeDrift({ runId: after.runId, flowId: "drift", recorded: "digest-v1", current: "digest-v2" })
  )
  // Refused before the claim: the run is still parked and unowned.
  expect(after.status).toBe("parked")
  expect(after.ownerId).toBeUndefined()
})

it("refuses a run whose flow is gone", async () => {
  const { resumed, after } = await resumeAfter(undefined)
  const drift = failure(resumed)
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

it("resumes drifted code when the operator allows it, and records the code it resumed on", async () => {
  const { resumed, after } = await resumeAfter("digest-v2", true)
  expect(Exit.isSuccess(resumed)).toBe(true)
  expect(after.status).toBe("accepted")
  expect(after.executionDigest).toBe("digest-v2")
})

it("resume refuses a run started on a different engine version", async () => {
  const { resumed, after } = await resumeAfter(
    "digest-v1",
    undefined,
    (runId) => storeField(runId, "engineVersion", "1.0.0-old")
  )
  const drift = failure(resumed)
  expect(drift).toEqual(
    new CodeDrift({ runId: after.runId, flowId: "drift", recordedEngine: "1.0.0-old", currentEngine: "9.9.9-test" })
  )
  expect(drift?.message).toBe(
    `Run ${after.runId} started on engine 1.0.0-old, which is now 9.9.9-test. Resume with --allow-code-drift to run the changed code.`
  )
  expect(after.status).toBe("parked")
})

it("an allowed engine drift records the engine it resumed on", async () => {
  const { resumed, after } = await resumeAfter(
    "digest-v1",
    true,
    (runId) => storeField(runId, "engineVersion", "1.0.0-old")
  )
  expect(Exit.isSuccess(resumed)).toBe(true)
  expect(after.engineVersion).toBe("9.9.9-test")
})

it("approving a node wait after the flow changed fails CodeDrift and leaves the run waiting", async () => {
  const target = (runId: RunId): Extract<ApprovalTarget, { readonly _tag: "Node" }> => ({
    _tag: "Node",
    runId,
    requestId: "ask:drift",
    digest: "ask-digest",
    envelope: { capabilities: [], flows: [], budget: {} }
  })
  const observed = await scenario({
    next: "digest-v2",
    // The park the executor writes when an ask raises `PermissionRequired`.
    before: (runId) =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        yield* runtime.resume(runId)
        yield* runtime.registerApproval(target(runId))
        yield* runtime.writeStatus(runId, yield* runtime.claimFence(runId), "waiting-approval")
      }),
    act: (runId) =>
      withControl((control) => control.approve({ target: target(runId), scope: "run", idempotencyKey: "approve:ask" }))
  })
  expect(failure(observed.acted)).toEqual(
    new CodeDrift({ runId: observed.runId, flowId: "drift", recorded: "digest-v1", current: "digest-v2" })
  )
  // Nothing was resolved or delegated: the ask is still open for a decision.
  expect(observed.after.status).toBe("waiting-approval")
  expect(observed.after.pendingResume).toBeUndefined()
})

it("a steer does not wake a parked run whose flow changed", async () => {
  const observed = await scenario({
    next: "digest-v2",
    before: (runId) => withSql((sql) => sql`UPDATE flows_runs SET waiting_reason = 'event' WHERE run_id = ${runId}`),
    act: (runId) =>
      withControl((control) =>
        control.steer({
          runId,
          message: {
            messageId: "steer:drift",
            runId,
            principal: { id: "operator", kind: "test", stampedAt: 0 },
            createdAt: 0,
            body: "wake up"
          },
          idempotencyKey: "steer:drift"
        })
      )
  })
  // The steer is admitted and queued; the run keeps its park and its owner is unset.
  expect(Exit.isSuccess(observed.acted)).toBe(true)
  expect(observed.after.status).toBe("parked")
  expect(observed.after.ownerId).toBeUndefined()
})

it("a run row with no identity of its own inherits its same-flow ancestor's", async () => {
  // A trampoline round or engine-written fork stores engine state, not a
  // control summary, so it records no digest. Checking it against nothing
  // let it resume on any code.
  const observed = await scenario({
    next: "digest-v2",
    before: (runId) =>
      withSql((sql) =>
        sql`INSERT INTO flows_runs (run_id, status, created_at_ms, parent_run_id, state_json)
              VALUES ('round-1', 'suspended', 1, ${runId}, ${
          JSON.stringify({ version: 1, flowName: "drift", payload: {} })
        })`
      ),
    act: () => withControl((control) => control.resume({ runId: "round-1", idempotencyKey: "resume:round-1" }))
  })
  expect(failure(observed.acted)).toEqual(
    new CodeDrift({ runId: "round-1", flowId: "drift", recorded: "digest-v1", current: "digest-v2" })
  )
})

it("an exact run lookup reports the drift a resume would refuse", async () => {
  const lookup = (next: string) =>
    scenario({
      next,
      act: (runId) => withControl((control) => control.list({ _tag: "runs", filters: { runId } }))
    })
  const drifted = await lookup("digest-v2")
  const unchanged = await lookup("digest-v1")
  const run = (exit: typeof drifted.acted) =>
    Exit.isSuccess(exit) && exit.value._tag === "runs" ? exit.value.items[0] : undefined
  expect(run(drifted.acted)?.codeDrift).toEqual({ recorded: "digest-v1", current: "digest-v2" })
  expect(run(unchanged.acted)).toBeDefined()
  expect(run(unchanged.acted)?.codeDrift).toBeUndefined()
  // Computed for the reader, never stored on the row.
  expect(drifted.after.codeDrift).toBeUndefined()
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
