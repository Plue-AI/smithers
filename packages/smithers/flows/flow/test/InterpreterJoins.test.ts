/**
 * `Node.race`, `Node.any`, and `Node.quorum` driven by the body interpreter:
 * each join settles as soon as its rule can, interrupts the members it no
 * longer waits for, and journals the members that decided so a restarted
 * process reaches the same verdict without running a loser again.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node, type Planned } from "@smthrs/plan"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { withCrypto } from "./Crypto.ts"
import { layerWired, makeInstance, makeMemoryState, type MemoryState } from "./MemoryFlowRuntime.ts"

/** Succeeds with `value`. */
const Value = Action.make("joins/value", {
  payload: { name: Schema.String, value: Schema.Number },
  success: Schema.Number
})

/** Fails with `<name> refused`. */
const Refuse = Action.make("joins/refuse", {
  payload: { name: Schema.String },
  success: Schema.Number,
  error: Schema.String
})

/** Never settles until interrupted. */
const Block = Action.make("joins/block", { payload: { name: Schema.String }, success: Schema.Number })

/** Dies: a defect, not a decision. */
const Crash = Action.make("joins/crash", { payload: {}, success: Schema.Number })

/** Interrupts itself, as a parked dispatch does. */
const Park = Action.make("joins/park", { payload: {}, success: Schema.Number })

/** Parks until {@link Open} runs, then succeeds with 9. */
const Hold = Action.make("joins/hold", { payload: {}, success: Schema.Number })

/** Releases {@link Hold} and succeeds with 1. */
const Open = Action.make("joins/open", { payload: { after: Schema.Number }, success: Schema.Number })

/** What the implementations saw, in order. */
interface Trace {
  readonly started: Array<string>
  readonly interrupted: Array<string>
  /** Opens once a `Block` named `gate` has started. */
  readonly gate: Deferred.Deferred<void>
}

const tracing = (options: { readonly blockSucceeds?: boolean } = {}) => {
  const trace: Trace = { started: [], interrupted: [], gate: Deferred.makeUnsafe<void>() }
  const opened = Deferred.makeUnsafe<void>()
  const layer = Layer.mergeAll(
    Value.toLayer(({ name, value }) =>
      Effect.sync(() => {
        trace.started.push(name)
        return value
      })
    ),
    Refuse.toLayer(({ name }) =>
      Effect.suspend(() => {
        trace.started.push(name)
        return Effect.fail(`${name} refused`)
      })
    ),
    Block.toLayer(({ name }) =>
      Effect.suspend(() => {
        trace.started.push(name)
        if (options.blockSucceeds === true) return Effect.succeed(100)
        if (name === "gate") Deferred.doneUnsafe(trace.gate, Exit.void)
        if (name === "child") Deferred.doneUnsafe(opened, Exit.void)
        return Effect.never
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => trace.interrupted.push(name))))
    ),
    Crash.toLayer(() => Effect.die("crashed")),
    Park.toLayer(() => Effect.interrupt),
    Hold.toLayer(() =>
      Effect.sync(() => trace.started.push("hold")).pipe(
        Effect.andThen(Deferred.await(opened)),
        Effect.as(9),
        Effect.onInterrupt(() => Effect.sync(() => trace.interrupted.push("hold")))
      )
    ),
    Open.toLayer(() => Effect.sync(() => Deferred.doneUnsafe(opened, Exit.void)).pipe(Effect.as(1)))
  )
  return { trace, layer }
}

type Needs = Crypto.Crypto | FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime | Action.Implementations

/** One process: the implementations, over a durable record a later process can reopen. */
const run = <A, E>(
  effect: Effect.Effect<A, E, Needs>,
  layer: Layer.Layer<never, never, FlowRuntime.FlowRuntime | Action.Implementations>,
  state: MemoryState = makeMemoryState()
) =>
  withCrypto(
    effect.pipe(
      Effect.provideService(
        FlowRuntime.FlowInstance,
        makeInstance(Flow.make("joins/host", { payload: {}, body: () => Node.succeed(undefined) }), "joins")
      ),
      Effect.provide(layerWired(layer, state))
    )
  )

/**
 * What a restarted process finds: every recorded dispatch but the ones that
 * ended interrupted. The fixture memoizes an interrupt; a real journal writes
 * no outcome for an attempt that never finished.
 */
const restarted = (state: MemoryState): MemoryState => ({
  actions: new Map(
    [...state.actions].filter(([, exit]) =>
      !(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) &&
      !(Exit.isSuccess(exit) && exit.value._tag === "Complete" && Exit.isFailure(exit.value.exit) &&
        Cause.hasInterruptsOnly(exit.value.exit.cause))
    )
  ),
  deferredResults: new Map(state.deferredResults),
  nodeRecords: []
})

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail") : undefined

describe("Node.any", () => {
  it.effect("ignores a failed member and settles with the surviving success", () =>
    Effect.gen(function*() {
      const { layer } = tracing()
      const result = yield* run(
        Interpreter.interpret(Node.any({ rejected: Node.fail("rejected"), accepted: Node.succeed(7) })),
        layer
      )
      expect(result.value).toBe(7)
    }))

  it.effect("fails with the last failure when every member fails", () =>
    Effect.gen(function*() {
      const { layer } = tracing()
      const exit = yield* run(
        Effect.exit(Interpreter.interpret(Node.any({
          first: Refuse.call({ name: "first" }),
          second: Refuse.call({ name: "second" }).pipe(Node.priority(-1))
        }))),
        layer
      )
      expect(failureOf(exit)).toMatchObject({ error: expect.stringMatching(/refused$/) })
    }))

  it.effect("interrupts the member still running once one succeeds, and reports it skipped", () =>
    Effect.gen(function*() {
      const { layer, trace } = tracing()
      const result = yield* run(
        Interpreter.interpret(Node.any({
          slow: Block.call({ name: "slow" }),
          fast: Value.call({ name: "fast", value: 3 })
        })),
        layer
      )
      expect(result.value).toBe(3)
      expect(trace.interrupted).toEqual(["slow"])
      expect(result.skipped).toContain("root.race.slow")
    }))

  it.effect("propagates a member's defect instead of treating it as a decision", () =>
    Effect.gen(function*() {
      const { layer, trace } = tracing()
      const exit = yield* run(
        Effect.exit(Interpreter.interpret(Node.any({ crash: Crash.call({}), slow: Block.call({ name: "slow" }) }))),
        layer
      )
      expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true)
      expect(trace.interrupted).toEqual(["slow"])
    }))

  it.effect("propagates an interpreter refusal from a member", () =>
    Effect.gen(function*() {
      const { layer } = tracing()
      const unwired = Action.make("joins/unwired", { payload: {}, success: Schema.Number })
      const exit = yield* run(
        Effect.exit(Interpreter.interpret(Node.any({ ok: Node.succeed(1), missing: unwired.call({}) }))),
        layer
      )
      expect(failureOf(exit)).toMatchObject({ error: { code: "unresolved_action" } })
    }))
})

describe("Node.race", () => {
  it.effect("settles with the first settlement, a failure included, and interrupts the rest", () =>
    Effect.gen(function*() {
      const { layer, trace } = tracing()
      const exit = yield* run(
        Effect.exit(Interpreter.interpret(Node.race({
          slow: Block.call({ name: "slow" }),
          refused: Refuse.call({ name: "refused" })
        }))),
        layer
      )
      expect(failureOf(exit)).toMatchObject({ error: "refused refused" })
      expect(trace.interrupted).toEqual(["slow"])
    }))

  it.effect("lets an enclosing catch recover a failed race", () =>
    Effect.gen(function*() {
      const { layer } = tracing()
      const result = yield* run(
        Interpreter.interpret(
          Node.race({ refused: Refuse.call({ name: "refused" }) }).pipe(
            Node.catch({ onFailure: () => Node.succeed(-1) })
          )
        ),
        layer
      )
      expect(result.value).toBe(-1)
    }))

  it.effect("keeps racing past a member that parked", () =>
    Effect.gen(function*() {
      const { layer } = tracing()
      const result = yield* run(
        Interpreter.interpret(Node.race({ parked: Park.call({}), ready: Value.call({ name: "ready", value: 5 }) })),
        layer
      )
      expect(result.value).toBe(5)
    }))

  it.effect("ends interrupted, journaling nothing, when every member parked", () =>
    Effect.gen(function*() {
      const { layer } = tracing()
      const state = makeMemoryState()
      const exit = yield* run(Effect.exit(Interpreter.interpret(Node.race({ parked: Park.call({}) }))), layer, state)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect([...state.deferredResults.keys()]).toEqual([])
    }))

  it.effect("settles its other dependencies before racing", () =>
    Effect.gen(function*() {
      const { layer, trace } = tracing()
      const result = yield* run(
        Interpreter.interpret(
          Value.call({ name: "before", value: 2 }).pipe(
            Node.andThen(Node.race({ after: Value.call({ name: "after", value: 4 }) }))
          )
        ),
        layer
      )
      expect(result.value).toBe(4)
      expect(trace.started).toEqual(["before", "after"])
    }))

  it.effect("keeps a loser's node running when something outside the loser reads it", () =>
    Effect.gen(function*() {
      const { layer, trace } = tracing()
      let leaked: Planned.Planned<number> | undefined
      // `slow` loses while `hold` is still parked, and `reader` — outside the
      // race — reads the map over `hold`, so both keep running. Only `opened`,
      // which runs after the race, unparks it.
      const body = Node.race({
        slow: Hold.call({}).pipe(
          Node.map((value) => value),
          Node.bindPlanned((value) => {
            leaked = value
            return Block.call({ name: "slow" })
          })
        ),
        fast: Value.call({ name: "fast", value: 1 })
      }).pipe(
        Node.bindPlanned((raced) =>
          Node.all({
            raced: Node.succeed(raced),
            opened: Open.call({ after: raced }),
            reader: Value.call({ name: "reader", value: leaked as unknown as number })
          })
        )
      )
      const result = yield* run(Interpreter.interpret(body), layer)
      expect(result.value).toEqual({ raced: 1, opened: 1, reader: 9 })
      expect(trace.started.filter((name) => name === "hold")).toEqual(["hold"])
      expect(trace.interrupted).not.toContain("hold")
    }))
})

describe("a losing child execution", () => {
  it.effect("is cancelled through the runtime, not only its join", () =>
    Effect.gen(function*() {
      const { layer, trace } = tracing()
      const Slow = Flow.make("joins/slow-child", {
        payload: {},
        success: Schema.Number,
        body: () => Block.call({ name: "child" })
      })
      const Parent = Flow.make("joins/parent", {
        payload: {},
        success: Schema.Number,
        // `hold` settles only once the child's body has started.
        body: () => Node.race({ child: Slow.child({}), hold: Hold.call({}) })
      })
      const value = yield* withCrypto(
        Effect.gen(function*() {
          const settled = yield* Parent.execute({}, { executionId: "joins-parent" })
          // The cancellation is a request; the child's body observes it on a
          // later turn.
          for (let turn = 0; turn < 100 && !trace.interrupted.includes("child"); turn++) yield* Effect.yieldNow
          // Read before the runtime's own scope closes and interrupts everything.
          return { settled, interrupted: [...trace.interrupted] }
        }).pipe(
          Effect.provide(
            layerWired(Layer.mergeAll(layer, Interpreter.layer(Parent), Interpreter.layer(Slow)))
          )
        )
      )
      expect(value.settled).toBe(9)
      expect([...trace.started].sort()).toEqual(["child", "hold"])
      expect(value.interrupted).toEqual(["child"])
    }))
})

describe("a losing child execution after a crash (#2892)", () => {
  const Slow = Flow.make("joins/crash-slow-child", {
    payload: {},
    success: Schema.Number,
    body: () => Block.call({ name: "child" })
  })
  const Host = Flow.make("joins/host", { payload: {}, body: () => Node.succeed(undefined) })
  const racing = Node.race({ child: Slow.child({}), hold: Hold.call({}) })

  /** One process whose runtime reports every cancellation it is asked for. */
  const drive = <A, E>(
    effect: Effect.Effect<A, E, Needs>,
    layer: Layer.Layer<never, never, FlowRuntime.FlowRuntime | Action.Implementations>,
    state: MemoryState,
    interrupts: Array<string>
  ) => {
    const reporting = Layer.effect(FlowRuntime.FlowRuntime)(Effect.gen(function*() {
      const runtime = yield* FlowRuntime.FlowRuntime
      return {
        ...runtime,
        interrupt: (flow: Flow.Any, executionId: string) =>
          Effect.sync(() => interrupts.push(executionId)).pipe(Effect.andThen(runtime.interrupt(flow, executionId)))
      }
    }))
    return withCrypto(
      effect.pipe(
        Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Host, "joins")),
        Effect.provide(
          reporting.pipe(Layer.provideMerge(layerWired(Layer.mergeAll(layer, Interpreter.layer(Slow)), state)))
        )
      )
    )
  }

  it.effect("journals the child a loser opened and cancels it again on replay without reopening it", () =>
    Effect.gen(function*() {
      const state = makeMemoryState()
      const first = tracing()
      const live: Array<string> = []
      const settled = yield* drive(Interpreter.interpret(racing), first.layer, state, live)
      expect(settled.value).toBe(9)
      expect(first.trace.started.sort()).toEqual(["child", "hold"])
      expect(live).toHaveLength(1)
      const opened = live[0]!
      expect(state.deferredResults.get("joins/join/root")).toEqual(
        Exit.succeed({ members: ["hold"], children: [{ node: "root.race.child", executionId: opened }] })
      )

      // A process that died after the journal write never asked the runtime
      // to cancel: the resumed walk asks from the record, and never demands
      // the loser, so its body does not start again.
      const second = tracing()
      const replayed: Array<string> = []
      const resumed = yield* drive(Interpreter.interpret(racing), second.layer, restarted(state), replayed)
      expect(resumed.value).toBe(9)
      expect(replayed).toEqual([opened])
      expect(second.trace.started).toEqual([])
      expect(resumed.skipped).toContain("root.race.child")
    }))

  it.effect("replays a member list recorded before losing children were journaled", () =>
    Effect.gen(function*() {
      const state = makeMemoryState()
      const { layer } = tracing()
      const race = Node.race({ fast: Node.succeed(1), child: Slow.child({}) })
      yield* drive(Interpreter.interpret(race), layer, state, [])
      state.deferredResults.set("joins/join/root", Exit.succeed(["fast"]))
      const interrupts: Array<string> = []
      const resumed = yield* drive(Interpreter.interpret(race), layer, restarted(state), interrupts)
      expect(resumed.value).toBe(1)
      expect(interrupts).toEqual([])
    }))

  it.effect("refuses a journaled losing child the plan no longer holds", () =>
    Effect.gen(function*() {
      const state = makeMemoryState()
      const { layer } = tracing()
      const race = Node.race({ fast: Node.succeed(1) })
      yield* drive(Interpreter.interpret(race), layer, state, [])
      state.deferredResults.set(
        "joins/join/root",
        Exit.succeed({ members: ["fast"], children: [{ node: "root.race.gone", executionId: "orphan" }] })
      )
      const interrupts: Array<string> = []
      const exit = yield* drive(Effect.exit(Interpreter.interpret(race)), layer, restarted(state), interrupts)
      expect(failureOf(exit)).toMatchObject({ error: { code: "join_mismatch", node: "root" } })
      expect(interrupts).toEqual([])
    }))
})

describe("Node.quorum", () => {
  it.effect("succeeds with exactly the first two of three successes", () =>
    Effect.gen(function*() {
      const { layer, trace } = tracing()
      const result = yield* run(
        Interpreter.interpret(Node.quorum(2, {
          a: Value.call({ name: "a", value: 1 }),
          b: Value.call({ name: "b", value: 2 }),
          c: Block.call({ name: "c" })
        })),
        layer
      )
      expect(result.value).toEqual({ a: 1, b: 2 })
      expect(Object.getPrototypeOf(result.value)).toBe(null)
      expect(trace.interrupted).toEqual(["c"])
    }))

  it.effect("fails once too few members are left to reach the count", () =>
    Effect.gen(function*() {
      const { layer, trace } = tracing()
      const exit = yield* run(
        Effect.exit(Interpreter.interpret(Node.quorum(2, {
          a: Refuse.call({ name: "a" }),
          b: Refuse.call({ name: "b" }),
          c: Block.call({ name: "c" })
        }))),
        layer
      )
      expect(failureOf(exit)).toMatchObject({ error: expect.stringMatching(/^[ab] refused$/) })
      expect(trace.interrupted).toEqual(["c"])
    }))

  it.effect("tolerates failures while the count is still reachable", () =>
    Effect.gen(function*() {
      const { layer } = tracing()
      const result = yield* run(
        Interpreter.interpret(Node.quorum(2, {
          a: Refuse.call({ name: "a" }),
          b: Value.call({ name: "b", value: 2 }),
          c: Value.call({ name: "c", value: 3 })
        })),
        layer
      )
      expect(result.value).toEqual({ b: 2, c: 3 })
    }))
})

describe("join journal", () => {
  /** A join the process crashes after: `gate` is still running when it dies. */
  const crashing = Node.quorum(2, {
    a: Value.call({ name: "a", value: 1 }),
    b: Value.call({ name: "b", value: 2 }),
    c: Block.call({ name: "c" })
  }).pipe(Node.bindPlanned((joined) => Node.all({ joined: Node.succeed(joined), gate: Block.call({ name: "gate" }) })))

  it.effect("replays the journaled members after a crash without redispatching a loser", () =>
    Effect.gen(function*() {
      const state = makeMemoryState()
      const first = tracing()
      yield* run(
        Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(Interpreter.interpret(crashing))
          yield* Deferred.await(first.trace.gate)
          yield* Fiber.interrupt(fiber)
        }),
        first.layer,
        state
      )
      expect(first.trace.started).toEqual(["a", "b", "c", "gate"])
      expect(first.trace.interrupted).toContain("c")
      expect([...state.deferredResults.keys()]).toEqual(["joins/join/root.andThen"])

      // The restarted process would now pick `c` first: it succeeds at once.
      const second = tracing({ blockSucceeds: true })
      const result = yield* run(Interpreter.interpret(crashing), second.layer, restarted(state))
      expect(result.value).toEqual({ joined: { a: 1, b: 2 }, gate: 100 })
      expect(second.trace.started).toEqual(["gate"])
      expect(result.skipped).toContain("root.andThen.race.c")
    }))

  it.effect("refuses a journal that names members the plan no longer holds", () =>
    Effect.gen(function*() {
      const state = makeMemoryState()
      const { layer } = tracing()
      yield* run(Interpreter.interpret(Node.race({ fast: Node.succeed(1) })), layer, state)
      const exit = yield* run(
        Effect.exit(Interpreter.interpret(Node.race({ quick: Node.succeed(1) }))),
        layer,
        restarted(state)
      )
      expect(failureOf(exit)).toMatchObject({ error: { code: "join_mismatch", node: "root" } })
    }))

  it.effect("refuses a journal its members no longer reproduce", () =>
    Effect.gen(function*() {
      const state = makeMemoryState()
      const { layer } = tracing()
      yield* run(Interpreter.interpret(Node.quorum(1, { a: Node.succeed(1), b: Node.fail("b") })), layer, state)
      const exit = yield* run(
        Effect.exit(Interpreter.interpret(Node.quorum(1, { a: Node.fail("a"), b: Node.fail("b") }))),
        layer,
        restarted(state)
      )
      expect(failureOf(exit)).toMatchObject({ error: { code: "join_mismatch" } })
    }))

  it.effect("refuses a journal whose verdict would close before its last member", () =>
    Effect.gen(function*() {
      const state = makeMemoryState()
      const { layer } = tracing()
      const members = { a: Node.succeed(1), b: Node.succeed(2), c: Node.succeed(3) }
      yield* run(Interpreter.interpret(Node.quorum(2, members)), layer, state)
      const exit = yield* run(Effect.exit(Interpreter.interpret(Node.quorum(1, members))), layer, restarted(state))
      expect(failureOf(exit)).toMatchObject({ error: { code: "join_mismatch" } })
    }))

  it.effect("replays a journaled member that parks as a parked join", () =>
    Effect.gen(function*() {
      const state = makeMemoryState()
      const { layer } = tracing()
      yield* run(Interpreter.interpret(Node.race({ a: Node.succeed(1) })), layer, state)
      const exit = yield* run(
        Effect.exit(Interpreter.interpret(Node.race({ a: Park.call({}) }))),
        layer,
        restarted(state)
      )
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }))
})
