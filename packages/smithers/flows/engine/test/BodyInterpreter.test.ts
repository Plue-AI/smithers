/**
 * A bodied flow driven end to end by the real in-memory engine: the action
 * path a call node takes, the tier it takes it at, the branch decided on a real
 * value, what a duplicate execute of an in-flight execution id does, and what a
 * body re-driven after a park does with the effects it already ran.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter, StepIdentity } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { pollUntil } from "./Harness.ts"

const Read = Action.make("body/read", {
  payload: { path: Schema.String },
  success: Schema.Struct({ value: Schema.Number, files: Schema.Array(Schema.String) })
})

const Double = Action.make("body/double", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

const Pipeline = Flow.make("body/pipeline", {
  payload: { path: Schema.String },
  success: Schema.Number,
  body: ({ path }) =>
    Read.call({ path }).pipe(
      Node.bindPlanned((result) => Double.call({ value: result.value })),
      Node.map((doubled) => doubled + 1)
    )
})

const Decide = Flow.make("body/decide", {
  payload: { path: Schema.String, target: Schema.Number },
  success: Schema.String,
  body: ({ path, target }) =>
    Read.call({ path }).pipe(
      Node.branch({
        if: (result) => result.value >= target,
        then: (result) => Double.call({ value: result.value }).pipe(Node.map((doubled) => `over:${doubled}`)),
        // A planned value is passed on, never computed on: the arm settles
        // with the reference itself, resolved against the real read.
        else: (result) => Node.succeed(result.files[0]!)
      })
    )
})

/** The action invocations one case saw, in dispatch order. */
const wire = (value: number) => {
  const calls: Array<string> = []
  const layer = Layer.mergeAll(
    Read.toLayer(({ path }) =>
      Effect.sync(() => {
        calls.push(`read:${path}`)
        return { value, files: [`${path}.a`] }
      })
    ),
    Double.toLayer((payload) =>
      Effect.sync(() => {
        calls.push(`double:${payload.value}`)
        return payload.value * 2
      })
    ),
    Interpreter.layer(Pipeline),
    Interpreter.layer(Decide)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory)
  )
  return { calls, layer }
}

describe("bodied flow on the memory engine", () => {
  it.effect("runs each action call through the engine's action path and settles the root", () =>
    Effect.gen(function*() {
      const { calls, layer } = wire(21)

      const value = yield* withCrypto(
        Pipeline.execute({ path: "counter.txt" }, { executionId: "body-pipeline" }).pipe(Effect.provide(layer))
      )

      expect(value).toBe(43)
      expect(calls).toEqual(["read:counter.txt", "double:21"])
    }))

  it.effect("takes the arm the predicate chose on the real value, and runs only that arm", () =>
    Effect.gen(function*() {
      const over = wire(100)
      const under = wire(3)

      expect(
        yield* withCrypto(
          Decide.execute({ path: "counter.txt", target: 50 }, { executionId: "body-over" }).pipe(
            Effect.provide(over.layer)
          )
        )
      ).toBe("over:200")
      expect(over.calls).toEqual(["read:counter.txt", "double:100"])

      expect(
        yield* withCrypto(
          Decide.execute({ path: "counter.txt", target: 50 }, { executionId: "body-under" }).pipe(
            Effect.provide(under.layer)
          )
        )
      ).toBe("counter.txt.a")
      expect(under.calls).toEqual(["read:counter.txt"])
    }))

  it.effect("dedupes a duplicate execute of an in-flight execution id onto the one running body", () =>
    Effect.gen(function*() {
      // Both calls name one execution id while the body is parked inside its
      // second action, so the engine joins the second onto the fiber already
      // running rather than driving the body twice. Nothing is replayed here:
      // there is one drive, and both callers read its answer.
      const calls: Array<string> = []
      const results = yield* withCrypto(Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const layer = Layer.mergeAll(
          Read.toLayer(({ path }) =>
            Effect.sync(() => {
              calls.push(`read:${path}`)
              return { value: 21, files: [`${path}.a`] }
            })
          ),
          Double.toLayer(({ value }) =>
            Effect.gen(function*() {
              calls.push(`double:${value}`)
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return value * 2
            })
          ),
          Interpreter.layer(Pipeline)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(FlowEngine.layerMemory)
        )
        const program = Pipeline.execute({ path: "counter.txt" }, { executionId: "body-duplicate" })
        return yield* (Effect.gen(function*() {
          const first = yield* program.pipe(Effect.forkChild)
          yield* Deferred.await(entered)
          const duplicate = yield* program.pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* Deferred.succeed(release, undefined)
          return [yield* Fiber.join(first), yield* Fiber.join(duplicate)]
        }).pipe(Effect.provide(layer)))
      }))

      expect(results).toEqual([43, 43])
      expect(calls).toEqual(["read:counter.txt", "double:21"])
    }))

  it.effect("re-drives a body after a park without rerunning the action that already settled", () =>
    Effect.gen(function*() {
      // The genuine re-drive the case above does NOT cover: the first drive
      // settles `Read`, parks, and ends; `resume` builds and walks the body a
      // second time. The settled action replays from its recorded outcome
      // because a re-driven instance re-derives the same invocation key, so the
      // round finishes on the second pass having read once.
      const calls: Array<string> = []
      let approved = false
      const Gated = Flow.make("body/gated", {
        payload: { path: Schema.String },
        success: Schema.Number,
        body: ({ path }) =>
          Read.call({ path }).pipe(
            Node.bindPlanned((result): Node.Node<Flow.Park | Flow.Done<number>> =>
              approved ? Flow.done(result.value) : Flow.park({ reason: "approval", token: "body-gate" })
            )
          )
      })
      const layer = Layer.mergeAll(
        Read.toLayer(({ path }) =>
          Effect.sync(() => {
            calls.push(`read:${path}`)
            return { value: 21, files: [`${path}.a`] }
          })
        ),
        Interpreter.layer(Gated)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory)
      )

      const observed = yield* withCrypto(
        Effect.gen(function*() {
          yield* Gated.execute({ path: "counter.txt" }, { executionId: "body-park", discard: true })
          const parked = yield* pollUntil(Gated.poll("body-park"), (result) => result._tag === "Suspended", {
            turns: 50
          })
          approved = true
          yield* Gated.resume("body-park")
          return {
            parked,
            woken: yield* pollUntil(Gated.poll("body-park"), (result) => result._tag === "Complete", { turns: 50 })
          }
        }).pipe(Effect.provide(layer))
      )

      expect(Option.isSome(observed.parked) && observed.parked.value._tag).toBe("Suspended")
      expect(
        Option.isSome(observed.woken) && observed.woken.value._tag === "Complete" &&
          Exit.isSuccess(observed.woken.value.exit) && observed.woken.value.exit.value
      ).toBe(21)
      // One read across both drives: the re-drive replayed the settled action.
      expect(calls).toEqual(["read:counter.txt"])
    }))

  it.effect("dispatches a call node at the tier its declaration carries", () =>
    Effect.gen(function*() {
      // A compensable action is the tier the engine cannot run without a
      // snapshot boundary, so its refusal is proof the node's declared tier
      // reached the engine rather than a default.
      const Compensable = Action.make("body/compensable", {
        payload: { path: Schema.String },
        success: Schema.Void,
        tier: "compensable"
      })
      const Risky = Flow.make("body/risky", {
        payload: { path: Schema.String },
        success: Schema.Void,
        body: ({ path }) => Compensable.call({ path })
      })
      const layer = Layer.mergeAll(
        Compensable.toLayer(() => Effect.void),
        Interpreter.layer(Risky)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory)
      )

      const exit = yield* withCrypto(
        Risky.execute({ path: "counter.txt" }, { executionId: "body-tier" }).pipe(Effect.exit, Effect.provide(layer))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("requires SnapshotBoundary")
      const defect = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined
      expect(defect).toBeInstanceOf(FlowEngine.SnapshotBoundaryRequired)
      expect(defect).toMatchObject({ code: "snapshot_boundary_required" })
    }))
})

describe("graph failure semantics on the memory engine", () => {
  it.effect("stops a dependency chain at a dying action: no downstream dispatch, the defect is the cause", () =>
    Effect.gen(function*() {
      // `Pipeline` is Read -> Double -> map. When Read dies, the chain must
      // stop at the failed node: Double is downstream of the dead value and can
      // never be dispatched, and the flow's cause is exactly Read's defect.
      const calls: Array<string> = []
      const layer = Layer.mergeAll(
        Read.toLayer(({ path }) =>
          Effect.suspend((): Effect.Effect<{ value: number; files: Array<string> }> => {
            calls.push(`read:${path}`)
            return Effect.die("read-kaboom")
          })
        ),
        Double.toLayer(({ value }) =>
          Effect.sync(() => {
            calls.push(`double:${value}`)
            return value * 2
          })
        ),
        Interpreter.layer(Pipeline)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory)
      )

      const exit = yield* withCrypto(
        Pipeline.execute({ path: "counter.txt" }, { executionId: "body-chain-defect" }).pipe(
          Effect.exit,
          Effect.provide(layer)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("read-kaboom")
      // Evaluation reached Read and nothing after it.
      expect(calls).toEqual(["read:counter.txt"])
    }))

  it.effect("interrupts the active sibling of a failed `All` member and propagates exactly the member's cause", () =>
    Effect.gen(function*() {
      // One member fails while its sibling is genuinely mid-flight: the sibling
      // must be torn down (its cleanup observed before the flow reports), the
      // node after the `All` must never dispatch, and the flow's typed cause is
      // the failing member's error alone — the sibling's interruption is
      // engine plumbing, not part of the answer.
      const Fails = Action.make("body/all-fails", {
        payload: {},
        success: Schema.String,
        error: Schema.String
      })
      const Slow = Action.make("body/all-slow", { payload: {}, success: Schema.String })
      const After = Action.make("body/all-after", {
        payload: { left: Schema.String, right: Schema.String },
        success: Schema.String
      })
      const Pair = Flow.make("body/pair", {
        payload: {},
        success: Schema.String,
        error: Schema.String,
        body: () =>
          Node.all({ left: Fails.call({}), right: Slow.call({}) }).pipe(
            Node.bindPlanned(({ left, right }) => After.call({ left, right }))
          )
      })

      const events: Array<string> = []
      const observed = yield* withCrypto(Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const layer = Layer.mergeAll(
          Fails.toLayer(() =>
            Effect.gen(function*() {
              // Fail only once the sibling is provably active, so the failure
              // races a genuinely running fiber rather than an undispatched one.
              yield* Deferred.await(entered)
              events.push("fails:settle")
              return yield* Effect.fail("left-broke")
            })
          ),
          Slow.toLayer(() =>
            Effect.gen(function*() {
              events.push("slow:start")
              yield* Deferred.succeed(entered, undefined)
              // `Effect.never` can only exit by interruption, so the `ensuring`
              // firing is proof the sibling's fiber was torn down.
              return yield* Effect.never.pipe(
                Effect.ensuring(Effect.sync(() => void events.push("slow:cleanup")))
              )
            })
          ),
          After.toLayer(() =>
            Effect.sync(() => {
              events.push("after")
              return "after"
            })
          ),
          Interpreter.layer(Pair)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(FlowEngine.layerMemory)
        )
        return yield* Pair.execute({}, { executionId: "body-all-failure" }).pipe(
          Effect.exit,
          Effect.provide(layer)
        )
      }))

      expect(Exit.isFailure(observed)).toBe(true)
      // Exactly the member's typed error; the sibling's interruption does not
      // pollute the propagated cause.
      expect(Exit.isFailure(observed) && Cause.squash(observed.cause)).toBe("left-broke")
      // The sibling was active when the member failed, and its cleanup ran
      // before the flow reported.
      expect(events).toEqual(["slow:start", "fails:settle", "slow:cleanup"])
    }))
})

/**
 * Concurrent `All` members carry their graph node ids into action identity.
 * Distinct structural sites therefore own distinct ordinal scopes even when
 * they call one keyless declaration, while indistinguishable handler-driven
 * dispatches remain guarded by `ConcurrentKeylessDispatch`.
 */
describe("concurrent `All` members against the engine's keyless guard", () => {
  const Left = Action.make("body/left", { payload: {}, success: Schema.String })
  const Right = Action.make("body/right", { payload: {}, success: Schema.String })
  const Shared = Action.make("body/shared", { payload: { name: Schema.String }, success: Schema.String })

  const Colliding = Flow.make("body/colliding", {
    payload: {},
    success: Schema.Struct({ left: Schema.String, right: Schema.String }),
    body: () => Node.all({ left: Shared.call({ name: "left" }), right: Shared.call({ name: "right" }) })
  })

  const Distinct = Flow.make("body/distinct", {
    payload: {},
    success: Schema.Struct({ left: Schema.String, right: Schema.String }),
    body: () => Node.all({ left: Left.call({}), right: Right.call({}) })
  })

  /**
   * Two bodies that each park until the other has entered, so the members
   * genuinely overlap in the engine's action path. A sequential walk would
   * deadlock here rather than pass.
   */
  const rendezvous = (registration: Layer.Layer<never, never, FlowRuntime.FlowRuntime | Action.Implementations>) => {
    const entered: Array<string> = []
    const dispatches: Array<{ readonly attempt: number; readonly key: string; readonly name: string }> = []
    let release = () => {}
    const opened = new Promise<void>((resolve) => {
      release = resolve
    })
    const park = (name: string) =>
      Effect.gen(function*() {
        entered.push(name)
        if (entered.length === 1) {
          yield* Effect.promise(() => opened)
        } else {
          release()
        }
        return name
      })
    const observe = (name: string) =>
      Effect.gen(function*() {
        const attempt = yield* Action.CurrentAttempt
        const key = yield* Action.CurrentInvocationKey
        if (key === undefined) return yield* Effect.die("engine omitted the dispatch invocation key")
        dispatches.push({ attempt, key, name })
        return yield* park(name)
      })
    const layer = Layer.mergeAll(
      Shared.toLayer(({ name }) => observe(name)),
      Left.toLayer(() => observe("left")),
      Right.toLayer(() => observe("right")),
      registration
    ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory))
    return { dispatches, entered, layer }
  }

  it.effect("overlaps one keyless declaration at distinct structural sites, each at ordinal one", () =>
    Effect.gen(function*() {
      const executionId = "body-colliding"
      const { dispatches, entered, layer } = rendezvous(Interpreter.layer(Colliding))
      const observed = yield* withCrypto(
        Effect.gen(function*() {
          const value = yield* Colliding.execute({}, { executionId })
          const left = yield* StepIdentity.invocationKey({
            runId: executionId,
            parentScope: "action/11:body/shared/g:18:root.flow.all.left",
            ordinal: 1,
            tier: "unsealed"
          })
          const right = yield* StepIdentity.invocationKey({
            runId: executionId,
            parentScope: "action/11:body/shared/g:19:root.flow.all.right",
            ordinal: 1,
            tier: "unsealed"
          })
          return { expected: { left, right }, value }
        }).pipe(Effect.provide(layer))
      )
      expect(observed.value).toEqual({ left: "left", right: "right" })
      expect(entered).toEqual(["left", "right"])
      expect(dispatches.map(({ attempt }) => attempt)).toEqual([1, 1])
      expect(Object.fromEntries(dispatches.map(({ key, name }) => [name, key]))).toEqual(observed.expected)
    }))

  it.effect("replays the same structural keys and pins each site's ordinal across retry attempts", () =>
    Effect.gen(function*() {
      const executionId = "body-colliding-retry"
      const { dispatches, layer } = rendezvous(Interpreter.layer(Colliding))
      const instance = FlowEngine.makeInstance(Colliding, executionId)
      let drives = 0
      const value = yield* withCrypto(
        Effect.gen(function*() {
          drives++
          const interpretation = yield* Interpreter.interpret(Colliding, {})
          if (drives === 1) return yield* Effect.fail("replay once")
          return interpretation.value
        }).pipe(
          Action.retry({ times: 1 }),
          Effect.orDie,
          Effect.provideService(FlowRuntime.FlowInstance, instance),
          Effect.provide(layer)
        )
      )
      const keysAt = (attempt: number) =>
        Object.fromEntries(
          dispatches.filter((dispatch) => dispatch.attempt === attempt).map(({ key, name }) => [name, key])
        )

      expect(value).toEqual({ left: "left", right: "right" })
      expect(drives).toBe(2)
      expect(dispatches).toHaveLength(4)
      expect(keysAt(2)).toEqual(keysAt(1))
      expect(new Set(Object.values(keysAt(1))).size).toBe(2)
    }))

  it.effect("overlaps two concurrent members of distinct declarations", () =>
    Effect.gen(function*() {
      const { entered, layer } = rendezvous(Interpreter.layer(Distinct))
      const value = yield* withCrypto(
        Distinct.execute({}, { executionId: "body-distinct" }).pipe(Effect.provide(layer))
      )
      expect(value).toEqual({ left: "left", right: "right" })
      // Both entered before either returned: the members really did overlap.
      expect(entered).toEqual(["left", "right"])
    }))
})
