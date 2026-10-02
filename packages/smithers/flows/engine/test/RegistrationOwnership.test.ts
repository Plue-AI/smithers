import { describe, expect } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scheduler, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { effect } from "./Harness.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

const makeFlow = (name: string) =>
  Flow.make(`RegistrationOwnership/${name}`, {
    payload: {},
    success: Schema.String,
    body: () => Node.succeed("declaration")
  })

const registrationScope = Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))

// Encoded erases authored flow properties and codec services. These fixtures
// pass actual authored flows with service-free schemas, so narrow only this
// storage seam; registration and execution use the public memory runtime.
const registerInMemory = (
  memory: FlowRuntime.FlowRuntime["Service"],
  flow: Parameters<FlowEngine.Encoded["register"]>[0],
  execute: Parameters<FlowEngine.Encoded["register"]>[1]
): Effect.Effect<void, never, Scope.Scope> => (memory.register as FlowEngine.Encoded["register"])(flow, execute)

const expectUnregistered = (flow: ReturnType<typeof makeFlow>, executionId: string) =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(flow.execute({}, { executionId }))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const refusal = Cause.squash(exit.cause)
      expect(refusal).toBeInstanceOf(FlowEngine.FlowNotRegistered)
      expect(refusal).toMatchObject({ flowName: flow._tag, code: "flow_not_registered" })
    }
  })

describe("flow registration ownership", () => {
  for (const forked of [false, true]) {
    effect(
      `same-flow recursive admission refuses and permits retry (forked: ${forked})`,
      () =>
        Effect.scoped(Effect.gen(function*() {
          const memory = yield* FlowRuntime.FlowRuntime
          const flow = makeFlow(`recursive-${forked}`)
          let attempts = 0
          const runtime: FlowRuntime.FlowRuntime["Service"] = scriptedEngine({
            register: (registered, execute) =>
              Effect.gen(function*() {
                if (++attempts === 1) {
                  const nested = runtime.register(flow, () => Effect.succeed("recursive"), { ifAbsent: true })
                  yield* forked ? Effect.flatMap(Effect.forkChild(nested), Fiber.join) : nested
                }
                yield* registerInMemory(memory, registered, execute)
              })
          })
          const caller = yield* registrationScope
          const pending = yield* runtime.register(flow, () => Effect.succeed("outer")).pipe(
            Scope.provide(caller),
            Effect.timeout("1 second"),
            Effect.exit,
            Effect.forkChild
          )
          yield* TestClock.adjust("1 second")
          const refused = yield* Fiber.join(pending)
          expect(Exit.isFailure(refused)).toBe(true)
          if (Exit.isFailure(refused)) {
            expect(Cause.hasDies(refused.cause)).toBe(true)
            expect(Cause.squash(refused.cause)).toEqual(
              new Error(`Flow ${flow._tag} cannot recursively register itself while admission is in progress`)
            )
          }
          yield* expectUnregistered(flow, "recursive-refused")
          yield* runtime.register(flow, () => Effect.succeed("retry"), { ifAbsent: true })
          expect(yield* flow.execute({}, { executionId: "retry" })).toBe("retry")
          yield* Scope.close(caller, Exit.void)
          expect(yield* flow.execute({}, { executionId: "caller-released" })).toBe("retry")
          expect(attempts).toBe(2)
        })).pipe(Effect.provide(FlowEngine.layerMemory))
    )
  }

  effect(
    "nested registration of the same flow in a separate runtime remains independent",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const memory = yield* FlowRuntime.FlowRuntime
        const secondContext = yield* Layer.build(Layer.fresh(FlowEngine.layerMemory))
        const secondMemory = Context.get(secondContext, FlowRuntime.FlowRuntime)
        const flow = makeFlow("separate-runtimes")
        const second = scriptedEngine({ register: (flow, execute) => registerInMemory(secondMemory, flow, execute) })
        const first = scriptedEngine({
          register: (registered, execute) =>
            Effect.gen(function*() {
              yield* second.register(flow, () => Effect.succeed("second"), { ifAbsent: true })
              yield* registerInMemory(memory, registered, execute)
            })
        })
        const pending = yield* first.register(flow, () => Effect.succeed("first")).pipe(
          Effect.timeout("1 second"),
          Effect.exit,
          Effect.forkChild
        )
        yield* TestClock.adjust("1 second")
        expect(Exit.isSuccess(yield* Fiber.join(pending))).toBe(true)
        expect(yield* flow.execute({}, { executionId: "first" })).toBe("first")
        expect(
          yield* flow.execute({}, { executionId: "second" }).pipe(
            Effect.provideService(FlowRuntime.FlowRuntime, secondMemory)
          )
        ).toBe("second")
      })).pipe(Effect.provide(FlowEngine.layerMemory))
  )

  for (const forked of [false, true]) {
    effect(
      `encoded admission can await registration of a different flow (forked: ${forked})`,
      () =>
        Effect.scoped(Effect.gen(function*() {
          const memory = yield* FlowRuntime.FlowRuntime
          const outer = makeFlow(`nested-outer-${forked}`)
          const inner = makeFlow(`nested-inner-${forked}`)
          const runtime: FlowRuntime.FlowRuntime["Service"] = scriptedEngine({
            register: (flow, execute) =>
              Effect.gen(function*() {
                if (flow._tag === outer._tag) {
                  const register = runtime.register(inner, () => Effect.succeed("inner"), { ifAbsent: true })
                  yield* forked ? Effect.flatMap(Effect.forkChild(register), Fiber.join) : register
                }
                yield* registerInMemory(memory, flow, execute)
              })
          })
          const admitted = yield* runtime.register(outer, () => Effect.succeed("outer")).pipe(
            Effect.timeout("1 second"),
            Effect.exit,
            Effect.forkChild
          )
          // Advance virtual time after the scheduler reaches a stable state:
          // synchronous nested admission must settle before this deadline, while
          // a gate deadlock fails without depending on the machine's wall clock.
          yield* TestClock.adjust("1 second")
          expect(Exit.isSuccess(yield* Fiber.join(admitted))).toBe(true)
          expect(yield* outer.execute({}, { executionId: "outer" })).toBe("outer")
          expect(yield* inner.execute({}, { executionId: "inner" })).toBe("inner")
        })).pipe(Effect.provide(FlowEngine.layerMemory))
    )
  }

  // Only admission is controlled by the encoded fixture. Registration and
  // execution still use the real memory engine; its public layer has no hook
  // for delaying the storage admission to reproduce cancellation and readiness.
  for (const installed of [false, true]) {
    effect(
      `interrupted encoded admission rolls back with its scope open (installed: ${installed})`,
      () =>
        Effect.scoped(Effect.gen(function*() {
          const memory = yield* FlowRuntime.FlowRuntime
          const flow = makeFlow(`interrupted-admission-${installed}`)
          const entered = yield* Deferred.make<void>()
          let admissions = 0
          const runtime = scriptedEngine({
            register: (flow, execute) =>
              Effect.gen(function*() {
                if (++admissions === 1) {
                  if (installed) yield* registerInMemory(memory, flow, execute)
                  yield* Deferred.succeed(entered, undefined)
                  yield* Effect.never
                }
                yield* registerInMemory(memory, flow, execute)
              })
          })
          const pendingScope = yield* registrationScope
          const pending = yield* runtime.register(flow, () => Effect.succeed("cancelled"), { ifAbsent: true }).pipe(
            Scope.provide(pendingScope),
            Effect.forkChild
          )
          yield* Deferred.await(entered)
          yield* Fiber.interrupt(pending)
          const cancelled = yield* Fiber.await(pending)
          expect(Exit.isFailure(cancelled) && Cause.hasInterruptsOnly(cancelled.cause)).toBe(true)
          yield* expectUnregistered(flow, "interrupted-admission")
          yield* runtime.register(flow, () => Effect.succeed("replacement"), { ifAbsent: true })
          expect(yield* flow.execute({}, { executionId: "replacement" })).toBe("replacement")
          yield* Scope.close(pendingScope, Exit.void)
          expect(yield* flow.execute({}, { executionId: "cancelled-scope-released" })).toBe("replacement")
          expect(admissions).toBe(2)
        })).pipe(Effect.provide(FlowEngine.layerMemory))
    )
  }

  effect(
    "concurrent ifAbsent waits for encoded admission before returning a usable winner",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const memory = yield* FlowRuntime.FlowRuntime
        const flow = makeFlow("pending-admission")
        const entered = yield* Deferred.make<void>()
        const admit = yield* Deferred.make<void>()
        const loserDone = yield* Deferred.make<void>()
        let admissions = 0
        const runtime = scriptedEngine({
          register: (flow, execute) =>
            Effect.gen(function*() {
              admissions++
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(admit)
              yield* registerInMemory(memory, flow, execute)
            })
        })
        const winnerScope = yield* registrationScope
        const loserScope = yield* registrationScope
        const winner = yield* runtime.register(flow, () => Effect.succeed("winner"), { ifAbsent: true }).pipe(
          Scope.provide(winnerScope),
          Effect.forkChild
        )
        yield* Deferred.await(entered)
        const loser = yield* runtime.register(flow, () => Effect.succeed("loser"), { ifAbsent: true }).pipe(
          Scope.provide(loserScope),
          Effect.andThen(Deferred.succeed(loserDone, undefined)),
          Effect.forkChild
        )
        for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow
        expect(yield* Deferred.isDone(loserDone)).toBe(false)
        yield* Deferred.succeed(admit, undefined)
        yield* Fiber.join(winner)
        yield* Fiber.join(loser)
        expect(admissions).toBe(1)
        expect(yield* flow.execute({}, { executionId: "winner" })).toBe("winner")
        yield* Scope.close(loserScope, Exit.void)
        expect(yield* flow.execute({}, { executionId: "loser-released" })).toBe("winner")
        yield* Scope.close(winnerScope, Exit.void)
        yield* expectUnregistered(flow, "winner-released")
      })).pipe(Effect.provide(FlowEngine.layerMemory))
  )

  effect(
    "ifAbsent registers a missing flow, releases it, and permits registration again",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        const flow = makeFlow("absent")
        const first = yield* registrationScope
        yield* runtime.register(flow, () => Effect.succeed("first"), { ifAbsent: true }).pipe(
          Effect.provideService(Scope.Scope, first)
        )
        expect(yield* flow.execute({}, { executionId: "first" })).toBe("first")
        yield* Scope.close(first, Exit.void)
        yield* expectUnregistered(flow, "released")

        yield* runtime.register(flow, () => Effect.succeed("second"), { ifAbsent: true })
        expect(yield* flow.execute({}, { executionId: "second" })).toBe("second")
      })).pipe(Effect.provide(FlowEngine.layerMemory))
  )

  effect(
    "an explicit host registration survives later and concurrent ifAbsent scopes",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        const flow = makeFlow("host")
        const calls: Array<string> = []
        yield* runtime.register(flow, () =>
          Effect.sync(() => {
            calls.push("host")
            return "host"
          }))
        const late = yield* registrationScope
        const discovered = () =>
          Effect.sync(() => {
            calls.push("discovered")
            return "discovered"
          })
        yield* runtime.register(flow, discovered, { ifAbsent: true }).pipe(Effect.provideService(Scope.Scope, late))
        expect(yield* flow.execute({}, { executionId: "late" })).toBe("host")
        yield* Scope.close(late, Exit.void)
        expect(yield* flow.execute({}, { executionId: "late-released" })).toBe("host")

        const scopes = yield* Effect.all(Array.from({ length: 8 }, () => registrationScope))
        yield* Effect.all(
          scopes.map((scope) =>
            runtime.register(flow, discovered, { ifAbsent: true }).pipe(Effect.provideService(Scope.Scope, scope))
          ),
          { concurrency: "unbounded" }
        ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 3))
        expect(yield* flow.execute({}, { executionId: "concurrent" })).toBe("host")
        for (const scope of scopes) {
          yield* Scope.close(scope, Exit.void)
        }
        expect(yield* flow.execute({}, { executionId: "concurrent-released" })).toBe("host")
        expect(calls).toEqual(["host", "host", "host", "host"])
      })).pipe(Effect.provide(FlowEngine.layerMemory))
  )

  effect(
    "explicit registrations override within their scope and restore the previous handler",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        const flow = makeFlow("override")
        yield* runtime.register(flow, () => Effect.succeed("host"))
        const options = [undefined, {}, { ifAbsent: false }] as const
        for (let index = 0; index < options.length; index++) {
          const scope = yield* registrationScope
          yield* runtime.register(flow, () => Effect.succeed(`override-${index}`), options[index]).pipe(
            Effect.provideService(Scope.Scope, scope)
          )
          expect(yield* flow.execute({}, { executionId: `override-${index}` })).toBe(`override-${index}`)
          yield* Scope.close(scope, Exit.void)
          expect(yield* flow.execute({}, { executionId: `restored-${index}` })).toBe("host")
        }
      })).pipe(Effect.provide(FlowEngine.layerMemory))
  )

  effect(
    "closing an older explicit scope preserves the current registration",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        const flow = makeFlow("out-of-order")
        const older = yield* registrationScope
        const newer = yield* registrationScope
        yield* runtime.register(flow, () => Effect.succeed("older")).pipe(Effect.provideService(Scope.Scope, older))
        yield* runtime.register(flow, () => Effect.succeed("newer")).pipe(Effect.provideService(Scope.Scope, newer))
        yield* Scope.close(older, Exit.void)
        expect(yield* flow.execute({}, { executionId: "newer-remains" })).toBe("newer")
        yield* Scope.close(newer, Exit.void)
        yield* expectUnregistered(flow, "both-released")
      })).pipe(Effect.provide(FlowEngine.layerMemory))
  )

  effect(
    "concurrent ifAbsent registration has one owner and losing scopes cannot unregister it",
    () =>
      Effect.gen(function*() {
        for (let budget = 3; budget <= 12; budget++) {
          yield* Effect.scoped(Effect.gen(function*() {
            const runtime = yield* FlowRuntime.FlowRuntime
            const flow = makeFlow(`race-${budget}`)
            const scopes = yield* Effect.all(Array.from({ length: 8 }, () => registrationScope))
            const calls: Array<number> = []
            yield* Effect.all(
              scopes.map((scope, index) =>
                runtime.register(flow, () =>
                  Effect.sync(() => {
                    calls.push(index)
                    return String(index)
                  }), { ifAbsent: true }).pipe(Effect.provideService(Scope.Scope, scope))
              ),
              { concurrency: "unbounded" }
            ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget))

            const winner = Number(yield* flow.execute({}, { executionId: `winner-${budget}` }))
            expect(Number.isInteger(winner) && winner >= 0 && winner < scopes.length).toBe(true)
            for (let index = 0; index < scopes.length; index++) {
              if (index === winner) continue
              yield* Scope.close(scopes[index]!, Exit.void)
              expect(yield* flow.execute({}, { executionId: `loser-${budget}-${index}` })).toBe(String(winner))
            }
            expect(calls).toEqual(Array.from({ length: scopes.length }, () => winner))
            yield* Scope.close(scopes[winner]!, Exit.void)
            yield* expectUnregistered(flow, `winner-released-${budget}`)
            yield* runtime.register(flow, () => Effect.succeed("replacement"), { ifAbsent: true })
            expect(yield* flow.execute({}, { executionId: `replacement-${budget}` })).toBe("replacement")

            // Release the winner before its peers too: extra hidden owners would
            // become executable here even though no caller requested an override.
            const early = makeFlow(`winner-first-${budget}`)
            const contenders = yield* Effect.all(Array.from({ length: 8 }, () => registrationScope))
            yield* Effect.all(
              contenders.map((scope, index) =>
                runtime.register(early, () => Effect.succeed(String(index)), { ifAbsent: true }).pipe(
                  Effect.provideService(Scope.Scope, scope)
                )
              ),
              { concurrency: "unbounded" }
            ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget))
            const earlyWinner = Number(yield* early.execute({}, { executionId: `early-winner-${budget}` }))
            yield* Scope.close(contenders[earlyWinner]!, Exit.void)
            yield* expectUnregistered(early, `early-released-${budget}`)
            yield* runtime.register(early, () => Effect.succeed("replacement"), { ifAbsent: true })
            for (const scope of contenders) yield* Scope.close(scope, Exit.void)
            expect(yield* early.execute({}, { executionId: `early-replacement-${budget}` })).toBe("replacement")
          })).pipe(Effect.provide(FlowEngine.layerMemory))
        }
      })
  )
})
