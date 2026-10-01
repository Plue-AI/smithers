/**
 * A flow's `deadline` bounds one execution on the in-memory engine: a parked
 * execution is woken and settled at the deadline, a running one is stopped by
 * the in-fiber race, and one that settles in time is untouched. The restart
 * case, which needs a store, lives in `@smthrs/engine-store`.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Clock, Context, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import type * as Duration from "effect/Duration"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body().pipe(Effect.provide(TestClock.layer()))))

const Wait = Action.make("RunDeadline/wait", { payload: { id: Schema.String }, success: Schema.String })
const gate = DurableDeferred.make("RunDeadline/gate", { success: Schema.String })

const deadlined = (tag: string) =>
  Flow.make(tag, {
    payload: { id: Schema.String },
    success: Schema.String,
    idempotencyKey: ({ id }) => id,
    deadline: "1 hour",
    body: (payload) => Wait.call(payload)
  })

const Parked = deadlined("RunDeadline/parked")
const Running = deadlined("RunDeadline/running")
const InTime = deadlined("RunDeadline/in-time")

const layer = (flow: ReturnType<typeof deadlined>, wait: Effect.Effect<string, never, any>) =>
  Layer.mergeAll(Wait.toLayer(() => wait), Interpreter.layer(flow)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory)
  )

/** Advances the clock in small steps until `poll` reports a settled result. */
const settle = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, FlowRuntime.FlowExecutionNotFound, R>,
  step: Duration.Input
) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let i = 0; i < 200 && (Option.isNone(result) || result.value._tag !== "Complete"); i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust(step)
      result = yield* poll
    }
    return result
  })

const defect = (result: Option.Option<Flow.Result<unknown, unknown>>) => {
  if (Option.isNone(result) || result.value._tag !== "Complete" || !Exit.isFailure(result.value.exit)) return undefined
  return Cause.squash(result.value.exit.cause)
}

describe("Flow deadline", () => {
  effect("a parked execution settles with DeadlineExceeded when its deadline elapses", () =>
    Effect.gen(function*() {
      const flow = Parked
      const executionId = yield* flow.execute({ id: "parked" }, { discard: true })
      yield* TestClock.adjust("59 minutes")
      const before = yield* flow.poll(executionId)
      expect(Option.isSome(before) && before.value._tag).toBe("Suspended")
      const after = yield* settle(flow.poll(executionId), "1 minute")
      const expired = defect(after)
      expect(expired).toBeInstanceOf(Flow.DeadlineExceeded)
      expect(expired).toMatchObject({
        code: "deadline_exceeded",
        flowName: "RunDeadline/parked",
        executionId,
        deadlineMs: 3_600_000,
        startedAtMs: 0,
        message: `RunDeadline/parked execution ${executionId} ran past its 3600000 ms deadline, ` +
          "counted from its start at 1970-01-01T00:00:00.000Z"
      })
    }).pipe(Effect.provide(layer(Parked, DurableDeferred.await(gate)))))

  effect("a running execution is stopped by the in-fiber race at its deadline", () =>
    Effect.gen(function*() {
      const flow = Running
      const executionId = yield* flow.execute({ id: "running" }, { discard: true })
      const result = yield* settle(flow.poll(executionId), "10 minutes")
      expect(defect(result)).toBeInstanceOf(Flow.DeadlineExceeded)
    }).pipe(Effect.provide(layer(Running, Effect.as(Effect.sleep("2 hours"), "late")))))

  effect("an execution that settles before its deadline is untouched", () =>
    Effect.gen(function*() {
      const flow = InTime
      const executionId = yield* flow.execute({ id: "in-time" }, { discard: true })
      const result = yield* settle(flow.poll(executionId), "10 minutes")
      expect(Option.isSome(result) && result.value._tag === "Complete" && result.value.exit).toEqual(
        Exit.succeed("done")
      )
      // The armed deadline clock firing later changes nothing.
      yield* TestClock.adjust("2 hours")
      expect(yield* flow.poll(executionId)).toEqual(result)
    }).pipe(Effect.provide(layer(InTime, Effect.as(Effect.sleep("30 minutes"), "done")))))

  it("refuses a deadline that is not a positive finite duration", () => {
    for (const deadline of ["0 millis", "Infinity", -5] as const) {
      expect(() =>
        Flow.make("RunDeadline/invalid", {
          payload: {},
          success: Schema.String,
          deadline: deadline as never,
          body: () => Wait.call({ id: "x" })
        })
      ).toThrow(`Flow.make: "RunDeadline/invalid" deadline must be a positive finite duration`)
    }
  })

  it("keeps the deadline across annotate", () => {
    const flow = deadlined("RunDeadline/annotated")
    expect(flow.annotateMerge(flow.annotations).deadline).toEqual(flow.deadline)
    const Note = Context.Service<string>("RunDeadline/Note")
    expect(flow.annotate(Note, "kept").deadline).toEqual(flow.deadline)
  })
})

const Step = Action.make("RunDeadline/step", { payload: { value: Schema.Number }, success: Schema.Number })

/** A lineage that counts to `target` one round at a time, each round taking a step. */
type Counter = Flow.Flow<
  string,
  Schema.Struct<{ value: typeof Schema.Number; target: typeof Schema.Number }>,
  typeof Schema.Number,
  typeof Schema.Never,
  Action.Requirement<"RunDeadline/step">
>
const lineages = new Map<string, Counter>()
const counter = (tag: string, next: string, deadline?: Duration.Input): Counter => {
  const flow: Counter = Flow.make(tag, {
    payload: { value: Schema.Number, target: Schema.Number },
    success: Schema.Number,
    ...(deadline === undefined ? {} : { deadline }),
    body: ({ target, value }: { readonly value: number; readonly target: number }) =>
      Step.call({ value }).pipe(
        Node.branch({
          if: (reached) => reached >= target,
          then: (reached) => Flow.done(reached),
          else: (reached) => lineages.get(next)!.to({ value: reached, target })
        })
      )
  })
  lineages.set(tag, flow)
  return flow
}
// The originator declares the hour; the round it hands to declares a longer one
// and the round after that none, and all of them run under the originator's.
const Originator = counter("RunDeadline/lineage", "RunDeadline/lineage-next", "1 hour")
const Successor = counter("RunDeadline/lineage-next", "RunDeadline/lineage-last", "1 day")
const Last = counter("RunDeadline/lineage-last", "RunDeadline/lineage-last")

const lineageLayer = (stepFor: Duration.Input) =>
  Layer.mergeAll(Interpreter.layer(Originator), Interpreter.layer(Successor), Interpreter.layer(Last)).pipe(
    Layer.provideMerge(Step.toLayer(({ value }) => Effect.as(Effect.sleep(stepFor), value + 1))),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory)
  )

/** Follows the lineage to its answer, advancing the clock in `step`s. */
const follow = (payload: { readonly value: number; readonly target: number }, step: Duration.Input) =>
  Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(Effect.exit(Originator.execute(payload)))
    for (let i = 0; i < 200 && fiber.pollUnsafe() === undefined; i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust(step)
    }
    return yield* Fiber.join(fiber)
  })

describe("Flow deadline across trampoline rounds", () => {
  effect(
    "every round of a lineage expires at the originator's first start plus its deadline",
    () =>
      Effect.gen(function*() {
        // Four 25-minute rounds: no single round reaches an hour, the lineage does.
        const exit = yield* follow({ value: 0, target: 4 }, "5 minutes")
        expect(Exit.isFailure(exit)).toBe(true)
        const expired = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        expect(expired).toBeInstanceOf(Flow.DeadlineExceeded)
        expect(expired).toMatchObject({ deadlineMs: 3_600_000, startedAtMs: 0 })
        // The third round expired, under the originator's hour and not its own day.
        expect((expired as Flow.DeadlineExceeded).flowName).toBe("RunDeadline/lineage-last")
        expect(yield* Clock.currentTimeMillis).toBeLessThanOrEqual(65 * 60_000)
      }).pipe(Effect.provide(lineageLayer("25 minutes")))
  )

  effect("a lineage that settles within the originator's deadline answers its value", () =>
    Effect.gen(function*() {
      expect(yield* follow({ value: 0, target: 4 }, "5 minutes")).toEqual(Exit.succeed(4))
    }).pipe(Effect.provide(lineageLayer("10 minutes"))))
})

const TreeLeaf = Flow.make("RunDeadline/tree-leaf", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("leaf")
})
const TreeChild = Flow.make("RunDeadline/tree-child", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("child")
})
const Unrelated = Flow.make("RunDeadline/unrelated", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("unrelated")
})
const TreeParent = Flow.make("RunDeadline/tree-parent", {
  payload: {},
  success: Schema.String,
  deadline: "1 hour",
  body: () => Node.succeed("parent")
})

const treeResults = <A, E, R>(
  ids: ReadonlyArray<readonly [{ readonly poll: (id: string) => Effect.Effect<A, E, R> }, string]>
) => Effect.forEach(ids, ([flow, id]) => flow.poll(id))

const isSuspended = (result: Option.Option<Flow.Result<unknown, unknown>>) =>
  Option.isSome(result) && result.value._tag === "Suspended"
const isCancelled = (result: Option.Option<Flow.Result<unknown, unknown>>) =>
  Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit) &&
  Cause.hasInterruptsOnly(result.value.exit.cause)

// A bounded yield loop observes engine settlement without changing the deadline.
const waitForTree = (ready: Effect.Effect<boolean, unknown, FlowRuntime.FlowRuntime>, label: string) =>
  Effect.gen(function*() {
    for (let turn = 0; turn < 200 && !(yield* ready); turn++) yield* Effect.yieldNow
    expect(yield* ready, label).toBe(true)
  })

describe("Flow deadline attached tree", () => {
  effect(
    "an attached tree completed in time stays successful after its deadline clock fires",
    () =>
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.register(TreeLeaf, () => DurableDeferred.await(gate))
        yield* engine.register(
          TreeChild,
          () => TreeLeaf.execute({}, { executionId: "in-time-leaf" }).pipe(Effect.orDie)
        )
        yield* engine.register(
          TreeParent,
          () => TreeChild.execute({}, { executionId: "in-time-child" }).pipe(Effect.orDie)
        )
        yield* TreeParent.execute({}, { executionId: "in-time-parent", discard: true })
        const linked = [[TreeChild, "in-time-child"], [TreeLeaf, "in-time-leaf"]] as const
        yield* waitForTree(
          treeResults(linked).pipe(
            Effect.map((results) => results.every(isSuspended)),
            Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeed(false))
          ),
          "tree admitted"
        )
        yield* TestClock.adjust("30 minutes")
        yield* DurableDeferred.succeed(gate, {
          token: DurableDeferred.tokenFromExecutionId(gate, { flow: TreeLeaf, executionId: "in-time-leaf" }),
          value: "done"
        })
        const parent = yield* settle(TreeParent.poll("in-time-parent"), "1 minute")
        expect(Option.isSome(parent) && parent.value._tag === "Complete" && parent.value.exit).toEqual(
          Exit.succeed("done")
        )
        yield* TestClock.adjust("2 hours")
        expect(yield* TreeParent.poll("in-time-parent")).toEqual(parent)
        for (const result of yield* treeResults(linked)) {
          expect(Option.isSome(result) && result.value._tag === "Complete" && result.value.exit).toEqual(
            Exit.succeed("done")
          )
        }
      }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
  )

  effect(
    "explicit cancellation before expiry preserves the interrupt outcome for the whole tree",
    () =>
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.register(TreeLeaf, () => DurableDeferred.await(gate))
        yield* engine.register(TreeChild, () => TreeLeaf.execute({}, { executionId: "cancel-leaf" }).pipe(Effect.orDie))
        yield* engine.register(TreeParent, () =>
          TreeChild.execute({}, { executionId: "cancel-child" }).pipe(Effect.orDie))
        yield* TreeParent.execute({}, { executionId: "cancel-parent", discard: true })
        const linked = [[TreeParent, "cancel-parent"], [TreeChild, "cancel-child"], [TreeLeaf, "cancel-leaf"]] as const
        yield* waitForTree(
          treeResults(linked).pipe(
            Effect.map((results) =>
              results.every(isSuspended)
            ),
            Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeed(false))
          ),
          "tree admitted"
        )
        yield* TestClock.adjust("20 minutes")
        yield* engine.interrupt(TreeParent, "cancel-parent")
        yield* waitForTree(
          treeResults(linked).pipe(Effect.map((results) => results.every(isCancelled))),
          "tree cancelled"
        )
        const results = yield* treeResults(linked)
        yield* TestClock.adjust("2 hours")
        expect(yield* treeResults(linked)).toEqual(results)
      }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
  )

  effect(
    "a late linked admission observes expiry intent without replacing the originator's failure",
    () =>
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        let parentInstance: FlowRuntime.FlowInstance["Service"] | undefined
        let dispatched = 0
        yield* engine.register(
          TreeLeaf,
          () => Effect.sync(() => dispatched++).pipe(Effect.andThen(DurableDeferred.await(gate)))
        )
        yield* engine.register(TreeParent, () =>
          Effect.gen(function*() {
            parentInstance = yield* FlowRuntime.FlowInstance
            return yield* TreeLeaf.execute({}, { executionId: "original-leaf" }).pipe(Effect.orDie)
          }))
        yield* TreeParent.execute({}, { executionId: "late-parent", discard: true })
        yield* waitForTree(
          treeResults([[TreeLeaf, "original-leaf"]]).pipe(
            Effect.map((results) => results.every(isSuspended)),
            Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeed(false))
          ),
          "tree admitted"
        )
        const parent = yield* settle(TreeParent.poll("late-parent"), "10 minutes")
        expect(defect(parent)).toBeInstanceOf(Flow.DeadlineExceeded)
        expect(parentInstance).toBeDefined()
        if (parentInstance === undefined) return yield* Effect.die("parent was not entered")
        // Reuse the admitted parent identity under the still-live engine scope.
        yield* TreeLeaf.execute({}, { executionId: "late-leaf", discard: true }).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, parentInstance)
        )
        yield* waitForTree(
          treeResults([[TreeLeaf, "late-leaf"]]).pipe(Effect.map((results) => results.every(isCancelled))),
          "late admission cancelled"
        )
        expect(dispatched).toBe(1)
        expect(yield* TreeParent.poll("late-parent")).toEqual(parent)
      }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
  )

  for (const mode of ["parked", "running"] as const) {
    effect(
      `expiry cancels the ${mode} attached child and grandchild and preserves the parent failure`,
      () =>
        Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          let stopped = 0
          yield* engine.register(TreeLeaf, () =>
            mode === "parked"
              ? DurableDeferred.await(gate)
              : Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => stopped++))))
          yield* engine.register(TreeChild, () => TreeLeaf.execute({}, { executionId: "tree-leaf" }).pipe(Effect.orDie))
          yield* engine.register(TreeParent, () =>
            TreeChild.execute({}, { executionId: "tree-child" }).pipe(Effect.orDie))
          // A separate root has no edge to the deadline's lineage.
          yield* engine.register(Unrelated, () =>
            DurableDeferred.await(gate))
          yield* Unrelated.execute({}, { executionId: "unrelated", discard: true })
          yield* TreeParent.execute({}, { executionId: "tree-parent", discard: true })
          const linked = [[TreeChild, "tree-child"], [TreeLeaf, "tree-leaf"]] as const
          yield* waitForTree(
            treeResults(linked).pipe(
              Effect.map((results) => mode === "running" ? results.every(Option.isNone) : results.every(isSuspended)),
              Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeed(false))
            ),
            "tree admitted"
          )
          yield* TestClock.adjust("59 minutes")
          expect(defect(yield* TreeParent.poll("tree-parent"))).toBeUndefined()
          const parent = yield* settle(TreeParent.poll("tree-parent"), "1 minute")
          const expired = defect(parent)
          expect(expired).toBeInstanceOf(Flow.DeadlineExceeded)
          expect(expired).toMatchObject({ flowName: TreeParent._tag, startedAtMs: 0, deadlineMs: 3_600_000 })
          yield* waitForTree(
            treeResults(linked).pipe(Effect.map((results) => results.every(isCancelled))),
            "tree cancelled"
          )
          expect(stopped).toBe(mode === "running" ? 1 : 0)
          // Cancellation cannot replace the originator's recorded deadline defect.
          expect(yield* TreeParent.poll("tree-parent")).toEqual(parent)
          expect(isSuspended(yield* Unrelated.poll("unrelated"))).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
    )
  }
})

const NextParent = Flow.make("RunDeadline/tree-next", {
  payload: {},
  success: Schema.String,
  deadline: "1 day",
  body: () => Wait.call({ id: "later-round" })
})
const Spawn = Action.make("RunDeadline/spawn", { payload: {}, success: Schema.Void })
const FirstParent = Flow.make("RunDeadline/tree-first", {
  payload: {},
  success: Schema.String,
  deadline: "1 hour",
  body: () =>
    Spawn.call({}).pipe(Node.branch({
      if: () => false,
      then: () => Flow.done("unused"),
      else: () => NextParent.to({})
    }))
})
effect("a later round's expiry cancels a child linked by an earlier originator round", () =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    yield* engine.register(TreeLeaf, () => DurableDeferred.await(gate))
    const wiring = yield* Layer.build(
      Interpreter.layer(FirstParent).pipe(
        Layer.provideMerge(Spawn.toLayer(() =>
          TreeLeaf.execute({}, { executionId: "earlier-leaf", discard: true }).pipe(
            Effect.orDie,
            Effect.andThen(Effect.sleep("20 minutes"))
          )
        )),
        // The handoff target is auto-registered from its declaration; make that
        // declaration park through the same real action boundary.
        Layer.provideMerge(Wait.toLayer(() => DurableDeferred.await(gate))),
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
      )
    )
    yield* FirstParent.execute({}, { executionId: "round-parent", discard: true }).pipe(Effect.provideContext(wiring))
    for (let turn = 0; turn < 100; turn++) yield* Effect.yieldNow
    expect(defect(yield* FirstParent.poll("round-parent"))).toBeUndefined()
    yield* waitForTree(
      treeResults([[TreeLeaf, "earlier-leaf"]]).pipe(
        Effect.map((results) => results.every(isSuspended)),
        Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeed(false))
      ),
      "earlier child admitted"
    )
    yield* TestClock.adjust("20 minutes")
    const nextId = yield* FlowEngine.Round.executionId({ ...FlowEngine.Round.initial("round-parent"), ordinal: 1 })
    yield* waitForTree(
      treeResults([[NextParent, nextId]]).pipe(
        Effect.map((results) => results.every(isSuspended)),
        Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeed(false))
      ),
      "handoff parked"
    )
    const result = yield* settle(NextParent.poll(nextId), "5 minutes")
    expect(defect(result)).toMatchObject({ flowName: NextParent._tag, startedAtMs: 0, deadlineMs: 3_600_000 })
    yield* waitForTree(
      treeResults([[TreeLeaf, "earlier-leaf"]]).pipe(Effect.map((results) => results.every(isCancelled))),
      "earlier child cancelled"
    )
  }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory)))
