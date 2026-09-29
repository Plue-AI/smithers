import { describe, expect } from "@effect/vitest"
import { Action, DurableClock, Flow, FlowRuntime, StepIdentity } from "@smthrs/flow"
import { Effect, Exit, Option, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { effect, pollUntil } from "./Harness.ts"

describe("memory timer resume context", () => {
  for (const registration of ["composition", "action"] as const) {
    effect(
      `${registration} registration starts fresh flow rounds and preserves nested dispatch identities`,
      () =>
        Effect.gen(function*() {
          const runtime = yield* FlowRuntime.FlowRuntime
          const declaration = Action.make("MemoryResumeContext/step", {
            payload: {},
            success: Schema.Number,
            error: Schema.String
          })
          const flow = Flow.make("MemoryResumeContext/flow", {
            payload: {},
            success: Schema.Number,
            error: Schema.String,
            body: (payload) => declaration.call(payload)
          })
          const rounds: Array<{
            attempt: number
            ordinal: Action.OrdinalSlot | undefined
            invocation: string | undefined
            site: Option.Option<string>
            report: boolean
          }> = []
          const parentKeys: Array<string | undefined> = []
          let childExecutions = 0
          let staleHeartbeats = 0
          let staleReports = 0
          const child = Action.make({
            name: "MemoryResumeContext/sealed",
            tier: "sealed",
            idempotencyKey: "recorded-result",
            success: Schema.Number,
            execute: Effect.sync(() => ++childExecutions)
          })
          const parent = Action.make({
            name: "MemoryResumeContext/parent",
            success: Schema.Number,
            error: Schema.String,
            execute: Effect.gen(function*() {
              parentKeys.push(yield* Action.CurrentInvocationKey)
              const result = yield* child
              // The timer is armed inside the second attempt of a retry block.
              // Its wake must not carry this dispatch's attempt or pinned slots
              // into the next top-level walk of the flow.
              yield* Action.retry(
                Effect.gen(function*() {
                  if ((yield* Action.CurrentAttempt) === 1) return yield* Effect.fail("retry")
                  yield* DurableClock.sleep({ name: "resume-context", duration: "10 millis", inMemoryThreshold: 1 })
                }).pipe(
                  Effect.provideService(Action.CurrentInvocationKey, "stale-invocation"),
                  Effect.provideService(Action.CurrentHeartbeat, Effect.sync(() => void staleHeartbeats++)),
                  Effect.provideService(StepIdentity.DispatchSite, "stale.site"),
                  Effect.provideService(StepIdentity.DispatchReport, {
                    dispatched: () => Effect.sync(() => void staleReports++)
                  })
                ),
                { times: 1 }
              )
              return result
            })
          })
          const register = runtime.register(flow, () =>
            Effect.gen(function*() {
              rounds.push({
                attempt: yield* Action.CurrentAttempt,
                ordinal: yield* Action.CurrentOrdinal,
                invocation: yield* Action.CurrentInvocationKey,
                site: yield* Effect.serviceOption(StepIdentity.DispatchSite),
                report: Option.isSome(yield* Effect.serviceOption(StepIdentity.DispatchReport))
              })
              yield* Action.heartbeat
              return yield* parent
            }))
          if (registration === "composition") {
            yield* register
          } else {
            const registrationScope = yield* Effect.scope
            const registrationAction = Action.make({
              name: "MemoryResumeContext/register",
              execute: register.pipe(
                Effect.provideService(Scope.Scope, registrationScope),
                Effect.provideService(Action.CurrentAttempt, 2),
                Effect.provideService(Action.CurrentOrdinal, { values: new Map(), cursors: new Map() }),
                Effect.provideService(Action.CurrentInvocationKey, "captured-invocation"),
                Effect.provideService(Action.CurrentHeartbeat, Effect.sync(() => void staleHeartbeats++)),
                Effect.provideService(StepIdentity.DispatchSite, "captured.site"),
                Effect.provideService(StepIdentity.DispatchReport, {
                  dispatched: () => Effect.sync(() => void staleReports++)
                })
              )
            })
            const registrationFlow = Flow.make("MemoryResumeContext/registration", {
              payload: {},
              success: Schema.Number,
              error: Schema.String,
              body: (payload) => declaration.call(payload)
            })
            yield* runtime.register(registrationFlow, () => Effect.as(registrationAction, 0))
            yield* runtime.execute(registrationFlow, {
              payload: {},
              executionId: "registration-context",
              discard: false
            })
          }
          yield* runtime.execute(flow, { payload: {}, executionId: "resume-context", discard: true })
          const parked = yield* pollUntil(flow.poll("resume-context"), (result) => result._tag === "Suspended", {
            turns: 40
          })
          expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")
          expect(childExecutions).toBe(1)
          yield* TestClock.adjust("10 millis")
          const settled = yield* pollUntil(flow.poll("resume-context"), (result) => result._tag === "Complete", {
            turns: 40
          })
          expect(Option.isSome(settled) && settled.value._tag === "Complete" && settled.value.exit).toEqual(
            Exit.succeed(1)
          )
          expect(parentKeys).toHaveLength(2)
          expect(parentKeys[0]).toEqual(expect.any(String))
          expect(parentKeys[1]).toBe(parentKeys[0])
          expect(childExecutions).toBe(1)
          expect(rounds).toEqual(Array.from({ length: 2 }, () => ({
            attempt: 1,
            ordinal: undefined,
            invocation: undefined,
            site: Option.none(),
            report: false
          })))
          expect(staleHeartbeats).toBe(0)
          expect(staleReports).toBe(0)
        }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
    )
  }
})
