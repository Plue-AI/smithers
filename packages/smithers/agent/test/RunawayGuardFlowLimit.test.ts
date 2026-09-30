/**
 * A module flow a host runs as a step, bounded by the tool-call guard (#2279).
 *
 * `coding/PreparePlan` runs through `Interpreter`, not as a cell call, so the
 * sandbox's call limit and the harness's `tool-call` trip never reach it.
 * `RunawayGuard.layerFlowLimit` wraps its registration: each drive is admitted
 * through `Budget.Parking` and runs under the limit, and a drive past it parks
 * the run on `Stuck` `tool-call` facts. These cases run on the memory engine,
 * with a host wrapper that provides `Budget.Parking` around every handler the
 * way `ModuleAuthority` does.
 */
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { HarnessError } from "@smthrs/harness/HarnessError"
import { Node } from "@smthrs/plan"
import { Cause, Deferred, Effect, Exit, Schema, Scope } from "effect"
import { describe, expect, it } from "vitest"
import * as Budget from "../src/Budget.ts"
import * as RunawayGuard from "../src/RunawayGuard.ts"

const guarded = Flow.make("agent/test/guarded-step", {
  payload: {},
  success: Schema.String,
  error: Schema.Unknown,
  body: () => Node.succeed("unused")
})

const other = Flow.make("agent/test/unguarded-step", {
  payload: {},
  success: Schema.String,
  error: Schema.Unknown,
  body: () => Node.succeed("unused")
})

const parked: Budget.Parked = {
  waiting: { reason: "budget", token: "budget/run-1/timeout/step/1" },
  failure: new HarnessError({ code: "engine_failed", message: "Budget approval required" })
}

type Admission = Effect.Effect<
  { readonly _tag: "proceed"; readonly continued: number } | { readonly _tag: "park"; readonly parked: Budget.Parked },
  HarnessError
>

/** A `Budget.Parking` that records what it was asked. */
const parking = (options: { readonly guardsTimeouts?: boolean; readonly admit?: Admission } = {}) => {
  const admitted: Array<string> = []
  const tripped: Array<RunawayGuard.Timeout> = []
  const service: Budget.Parking["Service"] = {
    guardsTimeouts: options.guardsTimeouts ?? true,
    park: () => Effect.die("no budget park is expected"),
    trip: (timeout) =>
      Effect.sync(() => {
        tripped.push(timeout)
        return parked
      }),
    admit: (subject) =>
      Effect.suspend(() => {
        admitted.push(subject)
        return options.admit ?? Effect.succeed({ _tag: "proceed" as const, continued: 0 })
      })
  }
  return { admitted, tripped, service }
}

type Outcome =
  | { readonly _tag: "completed"; readonly value: unknown }
  | { readonly _tag: "failed"; readonly error: unknown }
  | { readonly _tag: "suspended"; readonly waiting: FlowRuntime.WaitingAnnotation | undefined }

/**
 * Registers `body` for `flow` under the guard at `limitMillis`, executes it,
 * and settles on the guarded drive's own exit, as the host wrapper saw it.
 */
const drive = (
  flow: typeof guarded | typeof other,
  body: Effect.Effect<string>,
  service: Budget.Parking["Service"] | undefined,
  limitMillis = 20
): Promise<Outcome> =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const settled = yield* Deferred.make<Outcome>()
    // The host: provides the parking service around every handler and reads
    // the drive's exit and declared wait, as `ModuleAuthority` does.
    const host = FlowRuntime.FlowRuntime.of({
      ...engine,
      register: (registered, execute) =>
        engine.register(registered, (payload, executionId) =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            const handled = execute(payload, executionId)
            return yield* (service === undefined ? handled : Effect.provideService(handled, Budget.Parking, service))
              .pipe(Effect.onExit((exit) =>
                Deferred.succeed(
                  settled,
                  Exit.isSuccess(exit)
                    ? { _tag: "completed", value: exit.value }
                    : Cause.hasInterruptsOnly(exit.cause) && instance.suspended
                    ? { _tag: "suspended", waiting: instance.waiting }
                    : { _tag: "failed", error: Cause.squash(exit.cause) }
                )
              ))
          }))
    })
    const scope = yield* Effect.scope
    yield* Effect.gen(function*() {
      const runtime = yield* FlowRuntime.FlowRuntime
      yield* runtime.register(flow, () => body).pipe(Scope.provide(scope))
      yield* runtime.execute(flow, { executionId: "exec-1", payload: {}, discard: true })
    }).pipe(
      Effect.provide(RunawayGuard.layerFlowLimit(guarded._tag, limitMillis)),
      Effect.provideService(FlowRuntime.FlowRuntime, host)
    )
    return yield* Deferred.await(settled)
  }).pipe(Effect.provide(FlowEngine.layerMemory), Effect.scoped, Effect.runPromise)

const slow = Effect.as(Effect.sleep("2 seconds"), "late")
const quick = Effect.succeed("planned")

describe("RunawayGuard.layerFlowLimit", () => {
  it("parks a drive that runs past its limit on tool-call facts naming the flow and execution", async () => {
    const guard = parking()
    const outcome = await drive(guarded, slow, guard.service)

    expect(outcome).toEqual({ _tag: "suspended", waiting: parked.waiting })
    expect(guard.admitted).toEqual(["agent/test/guarded-step:exec-1"])
    expect(guard.tripped).toHaveLength(1)
    expect(guard.tripped[0]).toMatchObject({
      _tag: "flows/agent/Timeout",
      source: "tool-call",
      subject: "agent/test/guarded-step:exec-1",
      limitMillis: 20,
      message: "agent/test/guarded-step ran past its 20 ms limit."
    })
    // The frozen facts are a Stuck tool-call incident Continue runs once more.
    expect(RunawayGuard.incident(guard.tripped[0]!)).toEqual({
      classification: "Stuck",
      source: "tool-call",
      message: "agent/test/guarded-step ran past its 20 ms limit.",
      subject: "agent/test/guarded-step:exec-1",
      max: 20,
      allowance: 20
    })
  })

  it("lets a drive inside its limit settle without tripping", async () => {
    const guard = parking()
    const outcome = await drive(guarded, quick, guard.service)

    expect(outcome).toEqual({ _tag: "completed", value: "planned" })
    expect(guard.admitted).toEqual(["agent/test/guarded-step:exec-1"])
    expect(guard.tripped).toEqual([])
  })

  it("re-parks on an open question without running the drive", async () => {
    let ran = false
    const guard = parking({ admit: Effect.succeed({ _tag: "park" as const, parked }) })
    const outcome = await drive(guarded, Effect.sync(() => (ran = true, "ran")), guard.service)

    expect(outcome).toEqual({ _tag: "suspended", waiting: parked.waiting })
    expect(ran).toBe(false)
    expect(guard.tripped).toEqual([])
  })

  it("runs a continued drive again under a fresh limit", async () => {
    const guard = parking({ admit: Effect.succeed({ _tag: "proceed" as const, continued: 1 }) })
    const again = await drive(guarded, quick, guard.service)
    const stuckAgain = await drive(
      guarded,
      slow,
      parking({
        admit: Effect.succeed({ _tag: "proceed" as const, continued: 1 })
      }).service
    )

    expect(again).toEqual({ _tag: "completed", value: "planned" })
    // Timing out again asks again, as the guard's own trip decides.
    expect(stuckAgain).toEqual({ _tag: "suspended", waiting: parked.waiting })
  })

  it("fails a stopped drive before it runs again", async () => {
    let ran = false
    const stop = RunawayGuard.stopped({ classification: "Stuck", source: "tool-call", message: "planning stuck" })
    const outcome = await drive(
      guarded,
      Effect.sync(() => (ran = true, "ran")),
      parking({ admit: Effect.fail(stop) }).service
    )

    expect(ran).toBe(false)
    expect(outcome).toEqual({ _tag: "failed", error: stop })
  })

  it("fails the drive when the park cannot be recorded", async () => {
    const unrecorded = new HarnessError({ code: "engine_failed", message: "could not commit" })
    const guard = parking()
    const failing = { ...guard.service, trip: () => Effect.fail(unrecorded) }
    const outcome = await drive(guarded, slow, failing)

    expect(outcome).toEqual({ _tag: "failed", error: unrecorded })
  })

  it("leaves the flow unbounded where the budget does not park, or nothing parks", async () => {
    const unguarded = parking({ guardsTimeouts: false })
    const late = Effect.as(Effect.sleep("60 millis"), "late")

    expect(await drive(guarded, late, unguarded.service)).toEqual({ _tag: "completed", value: "late" })
    expect(unguarded.admitted).toEqual([])
    expect(await drive(guarded, late, undefined)).toEqual({ _tag: "completed", value: "late" })
  })

  it("passes every other registration through unchanged", async () => {
    const guard = parking()
    const late = Effect.as(Effect.sleep("60 millis"), "late")

    expect(await drive(other, late, guard.service)).toEqual({ _tag: "completed", value: "late" })
    expect(guard.admitted).toEqual([])
  })
})
