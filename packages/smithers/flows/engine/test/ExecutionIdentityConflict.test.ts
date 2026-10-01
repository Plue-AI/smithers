import { describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Deferred, Effect, Exit, Option, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { effect, pollUntil } from "./Harness.ts"

const makeFlow = (name: string) =>
  Flow.make(name, {
    payload: { value: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
    body: () => Node.succeed(0)
  })

const assertConflict = (exit: Exit.Exit<unknown, unknown>, field: string, status: string) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) return
  expect(Cause.hasDies(exit.cause)).toBe(false)
  const failure = exit.cause.reasons.find(Cause.isFailReason)?.error
  expect(failure).toBeInstanceOf(FlowEngine.ExecutionIdentityConflict)
  expect(failure).toMatchObject({
    _tag: "@smthrs/engine/ExecutionIdentityConflict",
    code: "execution_identity_conflict",
    executionId: "existing",
    field,
    status
  })
}

describe("public execute identity conflict (#3371)", () => {
  it("retains the engine export identity and legacy constructor default", () => {
    const conflict = new FlowEngine.ExecutionIdentityConflict({
      executionId: "legacy",
      field: "payload",
      expected: "first",
      actual: "second",
      message: "conflict"
    })
    expect(conflict).toBeInstanceOf(FlowRuntime.ExecutionIdentityConflict)
    expect(conflict.status).toBe("unknown")
  })
  for (const status of ["failed", "cancelled"] as const) {
    effect(`reports a ${status} outer driver exit`, () =>
      Effect.scoped(Effect.gen(function*() {
        const flow = makeFlow(`IdentityConflict/outer/${status}`).annotate(Flow.CaptureDefects, false)
        const engine = yield* FlowRuntime.FlowRuntime
        const entered = yield* Deferred.make<void>()
        yield* engine.register(flow, () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(status === "failed" ? Effect.die("uncaptured") : Effect.never)
          ))
        yield* flow.execute({ value: 1 }, { executionId: "existing", discard: true })
        yield* Deferred.await(entered)
        if (status === "cancelled") yield* engine.interruptUnsafe(flow, "existing")
        else yield* flow.execute({ value: 1 }, { executionId: "existing" }).pipe(Effect.exit)
        const exit = yield* flow.execute({ value: 2 }, { executionId: "existing" }).pipe(Effect.exit)
        assertConflict(exit, "payload", status)
      })).pipe(Effect.provide(FlowEngine.layerMemory)))
  }

  effect(
    "reports the completed origin while its handoff successor remains suspended",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const first = makeFlow("IdentityConflict/handoff/origin")
        const next = makeFlow("IdentityConflict/handoff/next")
        const gate = DurableDeferred.make("IdentityConflict/handoff/gate", { success: Schema.Number })
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.register(first, ({ value }) =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            instance.handoff = new Flow.Handoff({ flow: next._tag, payload: { value } })
            return value
          }))
        yield* engine.register(next, () => DurableDeferred.await(gate))
        yield* first.execute({ value: 1 }, { executionId: "existing", discard: true })
        const nextId = yield* FlowEngine.Round.executionId({ ...FlowEngine.Round.initial("existing"), ordinal: 1 })
        const parked = yield* pollUntil(
          next.poll(nextId).pipe(
            Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeed(Option.none()))
          ),
          (result) => result._tag === "Suspended",
          { turns: 100 }
        )
        expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")
        assertConflict(
          yield* first.execute({ value: 2 }, { executionId: "existing" }).pipe(Effect.exit),
          "payload",
          "completed"
        )
      })).pipe(Effect.provide(FlowEngine.layerMemory))
  )

  for (const status of ["running", "suspended", "completed", "failed", "cancelled"] as const) {
    for (const field of ["flow", "payload", "capabilities"] as const) {
      effect(
        `${field} conflict carries ${status} without starting another worker`,
        () =>
          Effect.scoped(Effect.gen(function*() {
            const flow = makeFlow(`IdentityConflict/${status}/${field}`)
            const other = makeFlow(`${flow._tag}/other`)
            const entered = yield* Deferred.make<void>()
            const parked = DurableDeferred.make(`${flow._tag}/gate`, { success: Schema.Number })
            const engine = yield* FlowRuntime.FlowRuntime
            let workers = 0
            yield* engine.register(flow, () =>
              Effect.gen(function*() {
                workers++
                yield* Deferred.succeed(entered, undefined)
                if (status === "running" || status === "cancelled") return yield* Effect.never
                if (status === "suspended") return yield* DurableDeferred.await(parked)
                if (status === "failed") return yield* Effect.fail("failed")
                return 1
              }))
            yield* engine.register(other, () => Effect.sync(() => ++workers))
            yield* flow.execute({ value: 1 }, { executionId: "existing", discard: true })
            yield* Deferred.await(entered)
            if (status === "cancelled") yield* flow.interrupt("existing")
            if (status !== "running") {
              const result = yield* pollUntil(
                flow.poll("existing"),
                (value) => value._tag === (status === "suspended" ? "Suspended" : "Complete"),
                { turns: 100 }
              )
              expect(Option.isSome(result)).toBe(true)
            }
            const request = (field === "flow" ? other : flow).execute(
              { value: field === "payload" ? 2 : 1 },
              { executionId: "existing" }
            )
            const exit = yield* Effect.exit(
              field === "capabilities"
                ? request.pipe(
                  CapabilitySet.attenuate([new CapabilityPattern({ action: "fs:read", resource: "src/**" })])
                )
                : request
            )
            assertConflict(exit, field, status)
            expect(workers).toBe(1)
          })).pipe(Effect.provide(FlowEngine.layerMemory))
      )
    }
  }
})
