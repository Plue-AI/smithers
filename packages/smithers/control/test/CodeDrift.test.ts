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
import { CodeDrift, PersistenceError, RunNotFound } from "../src/ControlError.ts"
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

/** The durable stack options a scenario may replace. */
type StackOptions = NonNullable<Parameters<typeof durable>[0]>

/**
 * Starts a v1 run, parks it (unless `park` is false), runs `before` against
 * it, re-registers `next` (or removes the flow), and runs `act`. `stack`
 * replaces durable options; it reads the catalog `next` installs through
 * `catalog`.
 */
const scenario = <A, E>(options: {
  readonly next: string | undefined
  readonly park?: boolean
  readonly stack?: (catalog: () => ReadonlyArray<DurableFlow>) => StackOptions
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
    if (options.park !== false) yield* park(runtime, runId)
    if (options.before !== undefined) yield* options.before(runId)
    catalog = options.next === undefined ? [] : [flow(options.next)]
    const acted = yield* Effect.exit(options.act(runId))
    return { runId, started, acted, after: yield* runtime.getRun(runId) }
  }).pipe(
    Effect.provide(durable({
      engineVersion: "9.9.9-test",
      loadFlows: () => Effect.sync(() => catalog),
      executor: ControlExecutor.makeNoop({ launch: () => Effect.succeed("accepted" as const) }),
      ...options.stack?.(() => catalog)
    })),
    Effect.scoped,
    Effect.runPromise
  )
}

/** Starts a v1 run, parks it, re-registers `next`, and resumes. */
const resumeAfter = (
  next: string | undefined,
  allowCodeDrift?: boolean,
  before?: (runId: RunId) => Effect.Effect<void, unknown, DurableStack>,
  stack?: (catalog: () => ReadonlyArray<DurableFlow>) => StackOptions
) =>
  scenario({
    next,
    ...(before === undefined ? {} : { before }),
    ...(stack === undefined ? {} : { stack }),
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

/** Rewrites a stored control summary, as an older build would have left it. */
const storeState = (runId: RunId, rewrite: (state: Record<string, unknown>) => Record<string, unknown>) =>
  withSql((sql) =>
    Effect.gen(function*() {
      // Rewritten in JS: `json_set` is SQLite-only and the suite also runs on PostgreSQL.
      const [row] = yield* sql<
        { readonly state_json: string }
      >`SELECT state_json FROM flows_runs WHERE run_id = ${runId}`
      const state = JSON.stringify(rewrite(JSON.parse(row!.state_json)))
      yield* sql`UPDATE flows_runs SET state_json = ${state} WHERE run_id = ${runId}`
    })
  )

/** Rewrites one stored control summary field. */
const storeField = (runId: RunId, field: string, value: string) =>
  storeState(runId, (state) => ({ ...state, [field]: value }))

/** Stores a run row the way the engine writes a round or fork: engine state, no control summary. */
const storeEngineRow = (runId: string, parentRunId: string | null, flowName = "drift") =>
  withSql((sql) =>
    sql`INSERT INTO flows_runs (run_id, status, created_at_ms, parent_run_id, state_json)
          VALUES (${runId}, 'suspended', 1, ${parentRunId}, ${JSON.stringify({ version: 1, flowName, payload: {} })})`
  )

/** Stores a control summary row copied from `runId`'s, with `rewrite` applied and no parent column. */
const storeSummaryRow = (
  runId: RunId,
  copyId: string,
  rewrite: (state: Record<string, unknown>) => Record<string, unknown>
) =>
  withSql((sql) =>
    Effect.gen(function*() {
      const [row] = yield* sql<
        { readonly state_json: string }
      >`SELECT state_json FROM flows_runs WHERE run_id = ${runId}`
      const state = JSON.stringify(rewrite({ ...JSON.parse(row!.state_json), runId: copyId }))
      yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, parent_run_id, state_json)
                   VALUES (${copyId}, 'suspended', 1, NULL, ${state})`
    })
  )

/** The state with its recorded code identity removed. */
const withoutIdentity = ({ executionDigest: _digest, engineVersion: _engine, ...rest }: Record<string, unknown>) => rest

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
    `Run ${after.runId} started on drift digest-v1, which is now gone. Restore the flow to resume it.`
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

it("an allowed drift to a flow that is gone is refused before the claim", async () => {
  // There is no code to adopt, so accepting would record none and hand the
  // executor a run it can only fail (#2740).
  const { resumed, after } = await resumeAfter(undefined, true)
  expect(failure(resumed)).toEqual(new CodeDrift({ runId: after.runId, flowId: "drift", recorded: "digest-v1" }))
  expect(after.status).toBe("parked")
  expect(after.ownerId).toBeUndefined()
  expect(after.executionDigest).toBe("digest-v1")
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
    before: (runId) => storeEngineRow("round-1", runId),
    act: () => withControl((control) => control.resume({ runId: "round-1", idempotencyKey: "resume:round-1" }))
  })
  expect(failure(observed.acted)).toEqual(
    new CodeDrift({ runId: "round-1", flowId: "drift", recorded: "digest-v1", current: "digest-v2" })
  )
})

it("an exact run lookup reports a changed, a removed, and an unchanged flow", async () => {
  const lookup = (next: string | undefined) =>
    scenario({
      next,
      act: (runId) => withControl((control) => control.list({ _tag: "runs", filters: { runId } }))
    })
  const drifted = await lookup("digest-v2")
  const unchanged = await lookup("digest-v1")
  const removed = await lookup(undefined)
  const run = (exit: typeof drifted.acted) =>
    Exit.isSuccess(exit) && exit.value._tag === "runs" ? exit.value.items[0] : undefined
  expect(run(drifted.acted)?.codeDrift).toEqual({ recorded: "digest-v1", current: "digest-v2" })
  expect(run(unchanged.acted)).toBeDefined()
  expect(run(unchanged.acted)?.codeDrift).toBeUndefined()
  // A removed flow has no current identity to name.
  expect(run(removed.acted)?.codeDrift).toEqual({ recorded: "digest-v1" })
  // Computed for the reader, never stored on the row.
  expect(drifted.after.codeDrift).toBeUndefined()
})

it("names each change a peer reported, and an engine it did not name as unknown", () => {
  // A CodeDrift decoded from another process may carry only the fields it
  // wrote; the message still has to say which code changed.
  expect(new CodeDrift({ runId: "run-1", flowId: "drift", recordedEngine: "1.0.0-old" }).message).toBe(
    "Run run-1 started on engine 1.0.0-old, which is now unknown. Resume with --allow-code-drift to run the changed code."
  )
  expect(
    new CodeDrift({
      runId: "run-1",
      flowId: "drift",
      recorded: "digest-v1",
      current: "digest-v2",
      recordedEngine: "1.0.0-old",
      currentEngine: "9.9.9-test"
    }).message
  ).toBe(
    "Run run-1 started on drift digest-v1, which is now digest-v2 and engine 1.0.0-old, which is now 9.9.9-test. Resume with --allow-code-drift to run the changed code."
  )
})

it("an exact run lookup reports an engine drift, and omits a drift it cannot compute", async () => {
  let catalogFails = false
  const lookup = (runId: RunId) => withControl((control) => control.list({ _tag: "runs", filters: { runId } }))
  const observed = await scenario({
    next: "digest-v1",
    stack: (catalog) => ({
      loadFlows: () =>
        catalogFails
          ? Effect.fail(new PersistenceError({ operation: "load flows", message: "the flow directory is unreadable" }))
          : Effect.sync(catalog)
    }),
    before: (runId) => storeField(runId, "engineVersion", "1.0.0-old"),
    act: (runId) =>
      Effect.gen(function*() {
        const engine = yield* lookup(runId)
        catalogFails = true
        const unreadable = yield* lookup(runId)
        return { engine, unreadable }
      })
  })
  if (!Exit.isSuccess(observed.acted)) throw new Error("lookup failed")
  const run = (listed: typeof observed.acted.value.engine) => listed._tag === "runs" ? listed.items[0] : undefined
  // Only the engine changed, so no flow digest is named.
  expect(run(observed.acted.value.engine)?.codeDrift).toEqual({
    recordedEngine: "1.0.0-old",
    currentEngine: "9.9.9-test"
  })
  // The catalog cannot be read: the run is still listed, without a drift.
  expect(run(observed.acted.value.unreadable)).toMatchObject({ runId: observed.runId, status: "parked" })
  expect(run(observed.acted.value.unreadable)?.codeDrift).toBeUndefined()
})

it("checks drift against the flows on disk now, not the cached catalog", async () => {
  // `loadFlows` keeps answering the snapshot the host loaded; `currentFlows`
  // reads what an edit left on disk (#1807).
  const { resumed, after } = await resumeAfter("digest-v2", undefined, undefined, (current) => ({
    loadFlows: () => Effect.succeed([flow("digest-v1")]),
    currentFlows: () => Effect.sync(current)
  }))
  expect(failure(resumed)).toEqual(
    new CodeDrift({ runId: after.runId, flowId: "drift", recorded: "digest-v1", current: "digest-v2" })
  )
  expect(after.status).toBe("parked")
})

it("an allowed drift records the code the host adopted, and refuses a flow it cannot adopt", async () => {
  // `adoptFlow` answers the code the executor now holds, which may differ from
  // the catalog entry; recording anything else accepted a run the executor
  // then failed (#2740).
  const adopting = (adopted: DurableFlow | undefined) => (current: () => ReadonlyArray<DurableFlow>) => ({
    currentFlows: () => Effect.sync(current),
    adoptFlow: (flowId: string) => Effect.succeed(flowId === "drift" ? adopted : undefined)
  })
  const loaded = await resumeAfter("digest-v2", true, undefined, adopting(flow("digest-v3-loaded")))
  expect(Exit.isSuccess(loaded.resumed)).toBe(true)
  expect(loaded.after).toMatchObject({ status: "accepted", executionDigest: "digest-v3-loaded" })

  const unloadable = await resumeAfter("digest-v2", true, undefined, adopting(undefined))
  expect(failure(unloadable.resumed)).toEqual(
    new CodeDrift({ runId: unloadable.after.runId, flowId: "drift", recorded: "digest-v1" })
  )
  expect(unloadable.after).toMatchObject({ status: "parked", executionDigest: "digest-v1" })
  expect(unloadable.after.ownerId).toBeUndefined()
})

it("an allowed drift keeps the recorded engine when the host names none", async () => {
  const { resumed, after } = await resumeAfter(
    "digest-v2",
    true,
    (runId) => storeField(runId, "engineVersion", "1.0.0-old"),
    () => ({ engineVersion: undefined })
  )
  expect(Exit.isSuccess(resumed)).toBe(true)
  expect(after).toMatchObject({ status: "accepted", executionDigest: "digest-v2", engineVersion: "1.0.0-old" })
})

it("an allowed drift that takes over a run from a dead owner records the adopted code", async () => {
  const observed = await scenario({
    next: "digest-v2",
    park: false,
    stack: () => ({
      owner: { hostId: "drift-host", pid: 1, nonce: "live" },
      isAlive: (owner) => Effect.succeed(owner.pid === 1)
    }),
    // The run is still running, under a process on this host that has exited
    // and whose heartbeat lease has lapsed.
    before: (runId) =>
      withSql((sql) =>
        Effect.andThen(
          sql`UPDATE flows_runs SET owner_pid = 2, owner_nonce = 'dead', heartbeat_at_ms = 0 WHERE run_id = ${runId}`,
          sql`UPDATE flows_consensus_leases SET owner_pid = 2, owner_nonce = 'dead', heartbeat_at_ms = 0 WHERE run_id = ${runId}`
        )
      ),
    act: (runId) =>
      withControl((control) => control.resume({ runId, idempotencyKey: "resume:takeover", allowCodeDrift: true }))
  })
  expect(observed.started.status).toBe("running")
  expect(failure(observed.acted)).toBeUndefined()
  expect(Exit.isSuccess(observed.acted)).toBe(true)
  expect(observed.after).toMatchObject({ status: "accepted", executionDigest: "digest-v2" })
})

it("walks identity-less ancestors of the same flow to the nearest one that recorded code", async () => {
  // round-3 and round-2 are engine rows chained by `parent_run_id`; round-1 is
  // a control summary that names its parent only in the summary.
  const observed = await scenario({
    next: "digest-v2",
    before: (runId) =>
      Effect.gen(function*() {
        yield* storeSummaryRow(runId, "round-1", (state) => ({ ...withoutIdentity(state), parentRunId: runId }))
        yield* storeEngineRow("round-2", "round-1")
        yield* storeEngineRow("round-3", "round-2")
      }),
    act: () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        return {
          recorded: yield* runtime.recordedCode("round-3"),
          drift: yield* runtime.codeDrift("round-3"),
          missing: yield* Effect.flip(runtime.recordedCode("no-such-run"))
        }
      })
  })
  if (!Exit.isSuccess(observed.acted)) throw new Error("read failed")
  expect(observed.acted.value.recorded).toEqual({ executionDigest: "digest-v1", engineVersion: "9.9.9-test" })
  expect(observed.acted.value.drift).toEqual(
    new CodeDrift({ runId: "round-3", flowId: "drift", recorded: "digest-v1", current: "digest-v2" })
  )
  expect(observed.acted.value.missing).toEqual(new RunNotFound({ runId: "no-such-run" }))
})

it("inherits an ancestor that recorded only its engine", async () => {
  const observed = await scenario({
    next: "digest-v1",
    before: (runId) =>
      Effect.gen(function*() {
        yield* storeState(runId, (state) => ({ ...withoutIdentity(state), engineVersion: "1.0.0-old" }))
        yield* storeEngineRow("round-1", runId)
      }),
    act: () => withControl((control) => control.resume({ runId: "round-1", idempotencyKey: "resume:engine-only" }))
  })
  expect(failure(observed.acted)).toEqual(
    new CodeDrift({ runId: "round-1", flowId: "drift", recordedEngine: "1.0.0-old", currentEngine: "9.9.9-test" })
  )
})

it("stops the ancestor walk at a missing parent or another flow, leaving no identity", async () => {
  const observed = await scenario({
    next: "digest-v2",
    before: (runId) =>
      Effect.gen(function*() {
        // `parent_run_id` is a foreign key, but a control summary names its
        // parent in the summary too, and nothing constrains that copy.
        yield* storeSummaryRow(runId, "orphan", (state) => ({ ...withoutIdentity(state), parentRunId: "no-such-run" }))
        yield* storeEngineRow("other-flow", runId, "other")
      }),
    act: () =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        return {
          orphan: { recorded: yield* runtime.recordedCode("orphan"), drift: yield* runtime.codeDrift("orphan") },
          other: { recorded: yield* runtime.recordedCode("other-flow"), drift: yield* runtime.codeDrift("other-flow") }
        }
      })
  })
  if (!Exit.isSuccess(observed.acted)) throw new Error("read failed")
  const none = { recorded: { executionDigest: undefined, engineVersion: undefined }, drift: undefined }
  // Neither row can be tied to the code that started the flow, so nothing is
  // recorded to compare against: this is the pre-#1807 fallback, not a match.
  expect(observed.acted.value.orphan).toEqual(none)
  expect(observed.acted.value.other).toEqual(none)
})

/** Starts a memory run on v1, parks it, and runs `act`. */
const memoryScenario = <A, E>(
  act: (runId: RunId) => Effect.Effect<A, E, Control | ControlRuntime>,
  engineVersion: string | undefined
) =>
  Effect.gen(function*() {
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
    const acted = yield* act(runId)
    return { started, acted, after: yield* runtime.getRun(runId) }
  }).pipe(
    Effect.provide(live({
      runtime: memoryRuntime({ flows: [flow("digest-v1")], engineVersion }),
      executor: ControlExecutor.makeNoop({ launch: () => Effect.succeed("accepted" as const) })
    })),
    Effect.runPromise
  )

it("records the same identity in the memory runtime and resumes its unchanged flow", async () => {
  const observed = await memoryScenario(
    (runId) => withControl((control) => control.resume({ runId, idempotencyKey: "resume:memory" })),
    "9.9.9-test"
  )
  expect(observed.started).toMatchObject({ executionDigest: "digest-v1", engineVersion: "9.9.9-test" })
  expect(observed.after.status).toBe("accepted")
})

it.each(["9.9.9-test", undefined])(
  "the memory runtime reports and re-records a run's code on an allowed drift (engine %s)",
  async (engineVersion) => {
    // The memory catalog is fixed, so its code never drifts; an operator may
    // still pass the flag, and the claim then records the same identity.
    const observed = await memoryScenario((runId) =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const recorded = yield* runtime.recordedCode(runId)
        yield* withControl((control) =>
          control.resume({ runId, idempotencyKey: "resume:memory:allowed", allowCodeDrift: true })
        )
        const missing = yield* Effect.flip(runtime.recordedCode("run-missing"))
        return { recorded, missing }
      }), engineVersion)
    expect(observed.acted.recorded).toEqual({ executionDigest: "digest-v1", engineVersion })
    expect(observed.acted.missing).toEqual(new RunNotFound({ runId: "run-missing" }))
    expect(observed.after).toMatchObject({ status: "accepted", executionDigest: "digest-v1" })
    expect(observed.after.engineVersion).toBe(engineVersion)
  }
)
