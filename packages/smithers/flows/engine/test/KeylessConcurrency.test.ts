import type * as Crypto from "effect/Crypto"
/**
 * Issue #111: keyless same-declaration actions dispatched concurrently
 * take their ordinals from fiber arrival order, so a crash-resume that
 * replays the fibers in the opposite order silently hands one invocation the
 * other's recorded outcome — with no input material persisted, the swap is
 * undetectable after the fact. Temporal fails such replays with a
 * nondeterminism error; the engine refuses the hazard on the first run
 * instead: a second in-flight keyless dispatch of one allocation scope dies
 * with `ConcurrentKeylessDispatch`. A declared `idempotencyKey` or an
 * interpreter-provided structural site is the sanctioned way to make
 * concurrent invocations distinguishable.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, StepIdentity } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scheduler, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { effect } from "./Harness.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

const flow = Flow.make("KeylessConcurrency/flow", {
  payload: { id: Schema.String },
  success: Schema.Void,
  body: () => Node.succeed(undefined)
})

const keylessFetch = Action.make({
  name: "KeylessConcurrency/fetch",
  tier: "irreversible",
  success: Schema.Void,
  execute: Effect.void
})

const keyedFetch = (idempotencyKey: string) =>
  Action.make({
    name: "KeylessConcurrency/fetch",
    tier: "irreversible",
    idempotencyKey,
    success: Schema.Void,
    execute: Effect.void
  })

/**
 * An engine whose dispatch parks on `gate`, so two dispatches genuinely
 * overlap instead of the first completing synchronously before the second
 * starts.
 */
const gatedEngine = (gate: Deferred.Deferred<void>) =>
  scriptedEngine({
    actionExecute: () => Effect.as(Deferred.await(gate), new Flow.Complete({ exit: Exit.void }))
  })

const drive = (
  executionId: string,
  program: (
    engine: FlowRuntime.FlowRuntime["Service"],
    gate: Deferred.Deferred<void>
  ) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime | Crypto.Crypto>
): Effect.Effect<Exit.Exit<unknown, unknown>, never, Crypto.Crypto> =>
  Effect.gen(function*() {
    const gate = yield* Deferred.make<void>()
    const engine = gatedEngine(gate)
    return yield* program(engine, gate).pipe(
      Effect.provideService(
        FlowRuntime.FlowInstance,
        FlowEngine.makeInstance(flow, executionId)
      ),
      Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine)),
      Effect.exit
    )
  })

const dies = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some((reason) =>
    Cause.isDieReason(reason) &&
    reason.defect instanceof Action.ConcurrentKeylessDispatch &&
    reason.defect.actionName === "KeylessConcurrency/fetch"
  )

describe("concurrent keyless same-declaration dispatches are refused (issue #111)", () => {
  effect("keeps a handler-driven keyless dispatch on the byte-identical name-only scope and key", () => {
    return Effect.gen(function*() {
      const keys: Array<string> = []
      const engine = scriptedEngine({
        actionExecute: (input) =>
          Effect.sync(() => {
            keys.push(input.key)
            return new Flow.Complete({ exit: Exit.void })
          })
      })
      const scope = yield* StepIdentity.allocationScope({
        kind: "action",
        name: keylessFetch.name
      })
      const expected = yield* StepIdentity.invocationKey({
        runId: "keyless-handler-single",
        parentScope: scope,
        ordinal: 1,
        tier: "irreversible"
      })
      yield* engine.actionExecute(keylessFetch, 1).pipe(
        Effect.provideService(
          FlowRuntime.FlowInstance,
          FlowEngine.makeInstance(flow, "keyless-handler-single")
        )
      )

      expect(scope).toBe("action/24:KeylessConcurrency/fetch")
      expect(keys).toEqual([expected])
    })
  })

  effect("two overlapping keyless dispatches of one declaration die loudly", () => {
    return Effect.gen(function*() {
      const exit = yield* drive("keyless-overlap", (engine, gate) =>
        Effect.all([
          engine.actionExecute(keylessFetch, 1),
          // The second dispatch arrives while the first is still parked in
          // the gated body — the exact window in which a replay could
          // reverse arrival order and swap the recorded outcomes.
          engine.actionExecute(keylessFetch, 1).pipe(
            Effect.ensuring(Deferred.done(gate, Exit.void))
          )
        ], { concurrency: "unbounded" }))
      expect(dies(exit)).toBe(true)
    })
  })

  effect("declared idempotency keys make the same pair safe to overlap", () => {
    return Effect.gen(function*() {
      const exit = yield* drive("keyed-overlap", (engine, gate) =>
        Effect.gen(function*() {
          // Fork both dispatches so they genuinely overlap in the gated
          // body, then release the gate from outside.
          const fiber = yield* Effect.forkChild(Effect.all([
            engine.actionExecute(keyedFetch("url-a"), 1),
            engine.actionExecute(keyedFetch("url-b"), 1)
          ], { concurrency: "unbounded" }))
          yield* Effect.yieldNow
          yield* Deferred.done(gate, Exit.void)
          yield* Fiber.join(fiber)
        }))
      expect(Exit.isSuccess(exit)).toBe(true)
    })
  })

  effect("two overlapping same-key dispatches at an ordinal-keyed tier are refused (issue #130)", () => {
    // A declared idempotencyKey is only the way out when the keys are
    // DISTINCT: two concurrent dispatches of one irreversible declaration
    // with the SAME key share one allocation scope, so their ordinals — and
    // step keys — would again be assigned by fiber arrival order (and the
    // #116 private cursor views would hand both dispatches the same pinned
    // ordinal from a shared enclosing block). Same hazard, same refusal.
    return Effect.gen(function*() {
      const exit = yield* drive("keyed-same-key-overlap", (engine, gate) =>
        Effect.all([
          engine.actionExecute(keyedFetch("url-a"), 1),
          engine.actionExecute(keyedFetch("url-a"), 1).pipe(
            Effect.ensuring(Deferred.done(gate, Exit.void))
          )
        ], { concurrency: "unbounded" }))
      expect(dies(exit)).toBe(true)
    })
  })

  effect("sequential same-key dispatches at an ordinal-keyed tier stay allowed", () => {
    return Effect.gen(function*() {
      const exit = yield* drive("keyed-same-key-sequential", (engine, gate) =>
        Effect.gen(function*() {
          yield* Deferred.done(gate, Exit.void)
          yield* engine.actionExecute(keyedFetch("url-a"), 1)
          yield* engine.actionExecute(keyedFetch("url-a"), 1)
        }))
      expect(Exit.isSuccess(exit)).toBe(true)
    })
  })

  effect("sequential keyless dispatches of one declaration stay allowed", () => {
    return Effect.gen(function*() {
      const exit = yield* drive("keyless-sequential", (engine, gate) =>
        Effect.gen(function*() {
          yield* Deferred.done(gate, Exit.void)
          yield* engine.actionExecute(keylessFetch, 1)
          yield* engine.actionExecute(keylessFetch, 1)
        }))
      expect(Exit.isSuccess(exit)).toBe(true)
    })
  })
})

describe("interruption cannot poison the in-flight guard (issue #139)", () => {
  effect("a dispatch interrupted at any op boundary never leaks its scope", () => {
    // The guard's acquire (`inFlight.add`) and its ensuring release used to
    // be separated by a yield boundary: an interruption landing after the
    // add but before the finalizer registered left the scope in the Set
    // forever, so every later — fully sequential — dispatch of the same
    // ordinal scope falsely died `ConcurrentKeylessDispatch`. The window is
    // one runtime op wide, so the probe shrinks the scheduler's op budget
    // (`MaxOpsBeforeYield`) and sweeps the interrupt across the early
    // boundaries; before the acquire went uninterruptible, (budget 3,
    // step 4) and (budget 7, step 0) both landed inside the window and
    // leaked the scope. With the fix, no combination leaks.
    return Effect.gen(function*() {
      for (let budget = 3; budget <= 8; budget++) {
        for (let steps = 0; steps < 12; steps++) {
          const exit = yield* drive(`inflight-interrupt-${budget}-${steps}`, (engine, gate) =>
            Effect.gen(function*() {
              const probe = yield* Effect.forkChild(
                engine.actionExecute(keylessFetch, 1).pipe(
                  Effect.provideService(Scheduler.MaxOpsBeforeYield, budget)
                )
              )
              for (let i = 0; i < steps; i++) yield* Effect.yieldNow
              // Signal the interrupt, then open the gate: a probe already
              // parked in the body would otherwise deadlock the join
              // against the gate it is waiting on.
              const interrupter = yield* Effect.forkChild(Fiber.interrupt(probe))
              yield* Deferred.done(gate, Exit.void)
              yield* Fiber.await(probe)
              yield* Fiber.join(interrupter).pipe(Effect.exit)
              // The guard released, the same scope must dispatch cleanly.
              yield* engine.actionExecute(keylessFetch, 1)
            }))
          expect({ budget, steps, success: Exit.isSuccess(exit) })
            .toEqual({ budget, steps, success: true })
        }
      }
    })
  })
})

class Unprovided extends Context.Service<Unprovided, { readonly value: string }>()(
  "test/flows-engine/KeylessConcurrency/Unprovided"
) {}

/** Never called; tsc checks it (#2704). */
const unprovidedServiceProbe = () => {
  // @ts-expect-error drive provides only the flow instance and runtime, not Unprovided
  drive("probe", () => Effect.map(Unprovided, (service) => service.value))
  drive("probe", (engine) => engine.actionExecute(keylessFetch, 1))
}

describe("regression: provide-then-cast test helpers erase layer requirements (#2704)", () => {
  it("rejects a body that needs a service its layer does not provide", () => {
    // The assertion is the `@ts-expect-error` directive above.
    expect(unprovidedServiceProbe).toBeTypeOf("function")
  })
})
