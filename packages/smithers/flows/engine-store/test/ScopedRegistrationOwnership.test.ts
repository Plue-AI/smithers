import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import { EngineStore, StepBoundary } from "@smthrs/engine-store"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Cause, Effect, Exit, Layer, Schema, Scope } from "effect"

// These handlers perform no actions or repository operations. Refuse any Jj
// call instead of granting repository authority to a SQL registration test.
const unexpectedRepositoryOperation = () => Effect.die("Registration must not perform repository operations")
const repository = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: unexpectedRepositoryOperation,
    restore: unexpectedRepositoryOperation,
    diff: unexpectedRepositoryOperation,
    workspaceAdd: unexpectedRepositoryOperation,
    workspaceForget: unexpectedRepositoryOperation,
    status: unexpectedRepositoryOperation
  })
)

const runtime = Layer.effect(FlowRuntime.FlowRuntime)(EngineStore.make({
  owner: { hostId: "scoped-registration" },
  journalSource: "scoped-registration",
  isAlive: () => Effect.succeed(false)
})).pipe(
  Layer.provideMerge(Layer.mergeAll(
    TestStores.layerAt(":memory:"),
    StepBoundary.layerTest(),
    repository
  )),
  Layer.provideMerge(NodeCrypto.layer)
)

const makeFlow = (name: string) =>
  Flow.make(`ScopedRegistration/${name}`, {
    payload: {},
    success: Schema.String,
    body: () => Node.succeed("unused")
  })

const registrationScope = Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))

const expectExecuted = (flow: ReturnType<typeof makeFlow>, executionId: string, value: string) =>
  Effect.gen(function*() {
    expect(yield* flow.execute({}, { executionId })).toBe(value)
    const runs = yield* RunStore.RunStore
    expect((yield* runs.get(executionId)).status).toBe("completed")
  })

const expectMissing = (flow: ReturnType<typeof makeFlow>, executionId: string) =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(flow.execute({}, { executionId }))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.squash(exit.cause)).toEqual(new Error(`Flow ${flow._tag} is not registered`))
    }
  })

describe("SQL flow registration ownership", () => {
  it.effect("closing an explicit override restores the host before later lazy discovery", () =>
    Effect.scoped(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const flow = makeFlow("restore")
      yield* engine.register(flow, () => Effect.succeed("host"))
      const override = yield* registrationScope
      yield* engine.register(flow, () => Effect.succeed("override")).pipe(Scope.provide(override))
      yield* expectExecuted(flow, "override", "override")
      yield* Scope.close(override, Exit.void)
      yield* expectExecuted(flow, "restored", "host")

      const lazy = yield* registrationScope
      yield* engine.register(flow, () => Effect.succeed("discovered"), { ifAbsent: true }).pipe(Scope.provide(lazy))
      yield* expectExecuted(flow, "discovered", "host")
      yield* Scope.close(lazy, Exit.void)
      yield* expectExecuted(flow, "discovery-released", "host")
    })).pipe(Effect.provide(runtime)))

  it.effect("closing a lazy discovery scope preserves the independently registered host", () =>
    Effect.scoped(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const flow = makeFlow("lazy")
      const calls: Array<string> = []
      yield* engine.register(flow, () =>
        Effect.sync(() => {
          calls.push("host")
          return "host"
        }))
      const lazy = yield* registrationScope
      yield* engine.register(flow, () =>
        Effect.sync(() => {
          calls.push("discovered")
          return "discovered"
        }), { ifAbsent: true }).pipe(Scope.provide(lazy))
      yield* expectExecuted(flow, "live", "host")
      yield* Scope.close(lazy, Exit.void)
      yield* expectExecuted(flow, "released", "host")
      expect(calls).toEqual(["host", "host"])
    })).pipe(Effect.provide(runtime)))

  it.effect("closing the older scope preserves the newer registration without reviving the older handler", () =>
    Effect.scoped(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const flow = makeFlow("older-first")
      const older = yield* registrationScope
      const newer = yield* registrationScope
      yield* engine.register(flow, () => Effect.succeed("older")).pipe(Scope.provide(older))
      yield* engine.register(flow, () => Effect.succeed("newer"), { ifAbsent: false }).pipe(Scope.provide(newer))
      yield* Scope.close(older, Exit.void)
      yield* expectExecuted(flow, "newer-survives", "newer")
      yield* Scope.close(newer, Exit.void)
      yield* expectMissing(flow, "both-released")
      yield* engine.register(flow, () => Effect.succeed("replacement"), { ifAbsent: true })
      yield* expectExecuted(flow, "replacement", "replacement")
    })).pipe(Effect.provide(runtime)))

  it.effect("closing a hidden middle scope restores the earlier live handler when the newest scope closes", () =>
    Effect.scoped(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const flow = makeFlow("middle-first")
      const host = yield* registrationScope
      const middle = yield* registrationScope
      const newest = yield* registrationScope
      yield* engine.register(flow, () => Effect.succeed("host")).pipe(Scope.provide(host))
      yield* engine.register(flow, () => Effect.succeed("middle")).pipe(Scope.provide(middle))
      yield* engine.register(flow, () => Effect.succeed("newest")).pipe(Scope.provide(newest))
      yield* Scope.close(middle, Exit.void)
      yield* expectExecuted(flow, "newest-survives", "newest")
      yield* Scope.close(newest, Exit.void)
      yield* expectExecuted(flow, "host-restored", "host")
      yield* Scope.close(host, Exit.void)
      yield* expectMissing(flow, "all-released")
    })).pipe(Effect.provide(runtime)))
})
