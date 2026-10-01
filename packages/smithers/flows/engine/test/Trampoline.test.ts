/**
 * The trampoline on the in-memory engine: a counter that reaches its target by
 * handing off, the derived round identity underneath it, the round budget, and
 * what a handoff to a flow this engine has never been told about does.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

// A round built from raw parts, including malformed ones only validation sees.
const roundOf = (rootExecutionId: string, ordinal: number): FlowEngine.Round.Round => ({
  rootExecutionId: rootExecutionId as FlowEngine.Round.RootExecutionId,
  ordinal
})

const Increment = Action.make("trampoline/increment", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

/** The declaration shape every counter in this suite shares. */
type CounterFlow = Flow.Flow<
  string,
  Schema.Struct<{ value: typeof Schema.Number; target: typeof Schema.Number }>,
  typeof Schema.Number,
  typeof Schema.Never,
  // `.to()` drops the callee's requirements, so a lineage that hands off to
  // itself names only what one round calls and the type stays finite.
  Action.Requirement<"trampoline/increment">
>

/**
 * The declarations a body reaches for by tag. A recursive `.to()` needs the
 * flow inside its own body, which the declaration expression cannot name yet.
 */
const flows = new Map<string, CounterFlow>()

/** A counter that reaches its target one round at a time. */
const counter = (tag: string, maxRounds?: number): CounterFlow =>
  Flow.make(tag, {
    payload: { value: Schema.Number, target: Schema.Number },
    success: Schema.Number,
    ...(maxRounds === undefined ? {} : { maxRounds }),
    body: ({ target, value }: { readonly value: number; readonly target: number }) =>
      Increment.call({ value }).pipe(
        Node.branch({
          if: (next) => next >= target,
          then: (next) => Flow.done(next),
          else: (next) => flows.get(tag)!.to({ value: next, target })
        })
      )
  })

const declare = (tag: string, maxRounds?: number) => {
  const flow = counter(tag, maxRounds)
  flows.set(tag, flow)
  return flow
}

const Counter = declare("trampoline/counter")
const Bounded = declare("trampoline/bounded", 2)
const Single = declare("trampoline/single-round", 1)
const UnboundedTarget = Flow.make("trampoline/unbounded-target", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Increment.call({ value })
})
const OriginBounded = Flow.make("trampoline/origin-bounded", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  maxRounds: 1,
  body: ({ value }) => UnboundedTarget.to({ value })
})
const ParentActionDeclaration = Action.make("trampoline/parent/action", {
  payload: { target: Schema.Number },
  success: Schema.Number
})
const Parent = Flow.make("trampoline/parent", {
  payload: { target: Schema.Number },
  success: Schema.Number,
  body: (payload) => ParentActionDeclaration.call(payload)
})

/** Every increment the lineage dispatched, in order. */
type Registration =
  | Layer.Layer<never, never, unknown>
  | Layer.Layer<Action.Implementations | Action.Requirement<"trampoline/parent/action">, never, unknown>

const wire = <const Registrations extends ReadonlyArray<Registration>>(...registrations: Registrations) => {
  const calls: Array<number> = []
  // The increment goes UNDER the registrations rather than beside them: a
  // registration whose implementation executes a counter asks for it, and a
  // sibling layer answers nobody.
  const layer = Layer.mergeAll(Layer.empty, ...registrations).pipe(
    Layer.provideMerge(
      Increment.toLayer(({ value }) =>
        Effect.sync(() => {
          calls.push(value)
          return value + 1
        })
      )
    ),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory)
  )
  return { calls, layer }
}

describe("FlowEngine.Round", () => {
  it("starts a lineage at ordinal zero under the caller's execution id", () => {
    expect(FlowEngine.Round.initial("run-a")).toEqual({ rootExecutionId: "run-a", ordinal: 0 })
  })

  it.effect("derives the same execution id for the same (lineage, ordinal), and different ids otherwise", () =>
    Effect.gen(function*() {
      const [first, again, later, other] = yield* withCrypto(
        Effect.all([
          FlowEngine.Round.executionId(roundOf("run-a", 1)),
          FlowEngine.Round.executionId(roundOf("run-a", 1)),
          FlowEngine.Round.executionId(roundOf("run-a", 2)),
          FlowEngine.Round.executionId(roundOf("run-b", 1))
        ])
      )

      expect(first).toBe(again)
      expect(first).not.toBe(later)
      expect(first).not.toBe(other)
      expect(first).toMatch(/^[0-9a-f]{64}$/)
    }))

  it.effect("pins the durable round execution-id vectors", () =>
    Effect.gen(function*() {
      // These pin SHA-256(JSON.stringify(["flow-round/v2", rootExecutionId,
      // ordinal])). Changing either value is a durable-identity break that
      // orphans in-flight lineages and therefore requires a migration.
      const [first, second] = yield* withCrypto(
        Effect.all([
          FlowEngine.Round.executionId(roundOf("run-a", 1)),
          FlowEngine.Round.executionId(roundOf("run-a", 2))
        ])
      )
      expect(first).toBe("5a80d3d6fbc2c69076f7407e3763e77a777de0cac9e77bda5b687ade914ba44a")
      expect(second).toBe("8627b589098ec7ce254852fc5064dcc32b0b64e4d04a75e7c774c02222408726")
    }))

  it.effect("advances within an unbounded lineage and within a budget that has room", () =>
    Effect.gen(function*() {
      const unbounded = yield* withCrypto(
        FlowEngine.Round.next(roundOf("run-a", 0), {
          flowName: "f",
          maxRounds: undefined
        })
      )
      expect(unbounded.round).toEqual({ rootExecutionId: "run-a", ordinal: 1 })

      const bounded = yield* withCrypto(
        FlowEngine.Round.next(roundOf("run-a", 0), { flowName: "f", maxRounds: 2 })
      )
      expect(bounded.round.ordinal).toBe(1)
    }))

  it.effect("refuses the round that would spend one past the budget", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(
        Effect.exit(
          FlowEngine.Round.next(roundOf("run-a", 1), { flowName: "f", maxRounds: 2 })
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined
      expect(error).toBeInstanceOf(Flow.MaxRoundsExceeded)
      expect(error instanceof Flow.MaxRoundsExceeded && error.roundOrdinal).toBe(2)
    }))

  it.effect("refuses zero and negative budgets as invalid round inputs", () =>
    Effect.gen(function*() {
      const zero = yield* withCrypto(
        Effect.exit(
          FlowEngine.Round.next(roundOf("run-a", 0), { flowName: "f", maxRounds: 0 })
        )
      )
      const negative = yield* withCrypto(
        Effect.exit(
          FlowEngine.Round.next(roundOf("run-a", 0), { flowName: "f", maxRounds: -1 })
        )
      )

      for (const exit of [zero, negative]) {
        expect(Exit.isFailure(exit)).toBe(true)
        const error = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined
        expect(error).toBeInstanceOf(FlowEngine.Round.InvalidRound)
        expect(error instanceof FlowEngine.Round.InvalidRound && error.code).toBe("invalid_round")
      }
    }))

  it.effect("refuses malformed identities, ordinals, budgets, and overflow", () =>
    Effect.gen(function*() {
      expect(() => FlowEngine.Round.initial("")).toThrow(FlowEngine.Round.InvalidRound)
      expect(() => FlowEngine.Round.initial("\ud800A")).toThrow(FlowEngine.Round.InvalidRound)
      expect(() => FlowEngine.Round.initial("\ud800\uffff")).toThrow(FlowEngine.Round.InvalidRound)
      expect(() => FlowEngine.Round.initial("\udc00")).toThrow(FlowEngine.Round.InvalidRound)
      expect(FlowEngine.Round.initial("round-\ud83d\ude80")).toEqual({
        rootExecutionId: "round-\ud83d\ude80",
        ordinal: 0
      })
      const invalid: ReadonlyArray<Effect.Effect<unknown, unknown, Crypto.Crypto>> = [
        FlowEngine.Round.executionId(roundOf("", 0)),
        FlowEngine.Round.executionId(roundOf("run", -1)),
        FlowEngine.Round.executionId(roundOf("run", Number.NaN)),
        FlowEngine.Round.executionId(roundOf("run", 1.5)),
        FlowEngine.Round.next(roundOf("run", Number.MAX_SAFE_INTEGER), {
          flowName: "f",
          maxRounds: undefined
        }),
        FlowEngine.Round.next(roundOf("run", 0), {
          flowName: "f",
          maxRounds: Number.POSITIVE_INFINITY
        }),
        FlowEngine.Round.next(roundOf("", 0), {
          flowName: "f",
          maxRounds: undefined
        }),
        FlowEngine.Round.next(
          Object.defineProperty({}, "rootExecutionId", {
            get: () => {
              throw new Error("hostile round getter")
            }
          }) as FlowEngine.Round.Round,
          {
            flowName: "f",
            maxRounds: undefined
          }
        )
      ]
      for (const candidate of invalid) {
        const exit = yield* withCrypto(Effect.exit(candidate))
        const error = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined
        expect(error).toBeInstanceOf(FlowEngine.Round.InvalidRound)
      }
    }))

  it.effect("keeps delimiter-bearing round tuples injective", () =>
    Effect.gen(function*() {
      const [left, right] = yield* withCrypto(Effect.all([
        FlowEngine.Round.executionId(roundOf("r-", 1)),
        FlowEngine.Round.executionId(roundOf("r", 1))
      ]))
      expect(left).not.toBe(right)
    }))
})

describe("a lineage on the memory engine", () => {
  // `makeUnsafe` keeps its own per-tag declaration stack beside the driver's
  // registration table, and a handoff resolves its target from the top of it.
  // A closed inner registration must therefore be spliced back out: the round
  // decodes its journaled payload under the OUTER declaration's schema, and a
  // stale inner entry would refuse a payload the lineage is entitled to send.
  it.effect("resolves a handoff under the outer declaration after an inner registration of the same tag closes", () =>
    Effect.gen(function*() {
      const OuterV1 = Flow.make("trampoline/scoped-evolved", {
        payload: { value: Schema.Number },
        success: Schema.Number,
        body: ({ value }) => Increment.call({ value })
      })
      // The same tag under a payload schema the sender's handoff cannot
      // satisfy, so serving it instead of the outer declaration is visible.
      const InnerV2 = Flow.make("trampoline/scoped-evolved", {
        payload: { value: Schema.Number, gate: Schema.String },
        success: Schema.Number,
        body: ({ value }) => Increment.call({ value })
      })
      const Sender = Flow.make("trampoline/scoped-evolved-sender", {
        payload: { value: Schema.Number },
        success: Schema.Number,
        body: ({ value }) => OuterV1.to({ value })
      })
      const { calls, layer } = wire(Interpreter.layer(Sender), Interpreter.layer(OuterV1))

      const exit = yield* withCrypto(
        Effect.gen(function*() {
          const runtime = yield* FlowRuntime.FlowRuntime
          yield* Effect.scoped(runtime.register(InnerV2, () => Effect.succeed(0)))
          // The inner scope is closed; the handoff must land on `OuterV1`.
          return yield* Sender.execute({ value: 1 }, { executionId: "memory-scoped-evolved" }).pipe(Effect.exit)
        }).pipe(Effect.provide(layer))
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(Exit.isSuccess(exit) && exit.value).toBe(2)
      // The outer declaration's body ran, so the next round's work dispatched.
      expect(calls).toEqual([1])
    }))

  it.effect("counts to its target across rounds and answers with the lineage's value", () =>
    Effect.gen(function*() {
      const { calls, layer } = wire(Interpreter.layer(Counter))

      const value = yield* withCrypto(
        Counter.execute({ value: 0, target: 3 }, { executionId: "memory-lineage" }).pipe(
          Effect.provide(layer)
        )
      )

      // One increment per round, and the caller sees only the final answer.
      expect(value).toBe(3)
      expect(calls).toEqual([0, 1, 2])
    }))

  it.effect("follows discarded lineages after the submitting scope closes", () =>
    Effect.gen(function*() {
      const { calls, layer } = wire(Interpreter.layer(Counter))
      yield* withCrypto(
        Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          const id = yield* Effect.scoped(
            Counter.execute({ value: 0, target: 3 }, { executionId: "memory-discard-lineage", discard: true })
          )
          expect(id).toBe("memory-discard-lineage")
          for (const ordinal of [1, 2]) {
            const roundId = yield* FlowEngine.Round.executionId(roundOf(id, ordinal))
            let settled = Option.none<Flow.Result<number, never>>()
            for (let attempt = 0; attempt < 300; attempt++) {
              settled = yield* engine.poll(Counter, roundId).pipe(Effect.catch(() => Effect.succeedNone))
              if (Option.isSome(settled)) break
              yield* Effect.yieldNow
            }
            expect(Option.isSome(settled) && settled.value._tag).toBe(ordinal === 1 ? "Handoff" : "Complete")
            if (Option.isSome(settled) && settled.value._tag === "Complete") {
              expect(settled.value.exit).toEqual(Exit.succeed(3))
            }
          }
          expect(calls).toEqual([0, 1, 2])
        }).pipe(Effect.provide(layer))
      )
    }))

  it.effect("wakes a suspended parent when a later child round completes", () =>
    withCrypto(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        let ready = false
        let parentPasses = 0
        yield* engine.register(Counter, ({ value }) =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            if (value === 0) {
              instance.handoff = new Flow.Handoff({ flow: Counter._tag, payload: { value: 1, target: 2 } })
              return 0
            }
            if (!ready) return yield* Flow.suspend(instance)
            return 2
          }))
        yield* engine.register(Parent, () =>
          Effect.gen(function*() {
            parentPasses++
            return yield* engine.execute(Counter, {
              executionId: "memory-parked-child",
              payload: { value: 0, target: 2 }
            }).pipe(Effect.orDie)
          }))
        const pollTag = (poll: ReturnType<typeof Counter.poll>, tag: string) =>
          Effect.gen(function*() {
            let last = "unsettled"
            for (let attempt = 0; attempt < 300; attempt++) {
              const result = yield* poll.pipe(Effect.catch(() => Effect.succeedNone))
              last = Option.isSome(result) ? result.value._tag : "unsettled"
              if (last === tag) break
              yield* Effect.yieldNow
            }
            return last
          })
        yield* engine.execute(Parent, {
          executionId: "memory-parked-parent",
          payload: { target: 2 },
          discard: true
        })
        const childId = yield* FlowEngine.Round.executionId(roundOf("memory-parked-child", 1))
        expect(yield* pollTag(engine.poll(Parent, "memory-parked-parent"), "Suspended")).toBe("Suspended")
        expect(yield* pollTag(engine.poll(Counter, childId), "Suspended")).toBe("Suspended")
        ready = true
        yield* engine.resume(Counter, childId)
        expect(yield* pollTag(engine.poll(Counter, childId), "Complete")).toBe("Complete")
        expect(yield* pollTag(engine.poll(Parent, "memory-parked-parent"), "Complete")).toBe("Complete")
        expect(parentPasses).toBe(2)
      }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
    ))

  it.effect("fails the lineage with the typed refusal once the round budget is spent", () =>
    Effect.gen(function*() {
      const { calls, layer } = wire(Interpreter.layer(Bounded))

      const exit = yield* withCrypto(
        Bounded.execute({ value: 0, target: 99 }, { executionId: "memory-bounded" }).pipe(
          Effect.exit,
          Effect.provide(layer)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("MaxRoundsExceeded")
      // Two rounds ran — ordinals 0 and 1 — and the third was refused before it
      // could dispatch anything.
      expect(calls).toEqual([0, 1])
    }))

  it.effect("keeps the origin flow's budget across a handoff to another declaration", () =>
    Effect.gen(function*() {
      const { calls, layer } = wire(
        Interpreter.layer(OriginBounded),
        Interpreter.layer(UnboundedTarget)
      )

      const exit = yield* withCrypto(
        OriginBounded.execute({ value: 0 }, { executionId: "memory-origin-budget" }).pipe(
          Effect.exit,
          Effect.provide(layer)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("MaxRoundsExceeded")
      expect(calls).toEqual([])
    }))

  it.effect("follows every round of a lineage executed from a parent flow", () =>
    Effect.gen(function*() {
      const { calls, layer } = wire(
        Interpreter.layer(Counter),
        Layer.mergeAll(
          // The constructed child payload always satisfies its schema, so the
          // typed SchemaError on execute cannot occur and is disposed of as a
          // defect.
          ParentActionDeclaration.toLayer(({ target }) =>
            Effect.orDie(Counter.execute({ value: 0, target }, { executionId: "memory-child-lineage" }))
          ),
          Interpreter.layer(Parent)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations)
        )
      )

      const value = yield* withCrypto(
        Parent.execute({ target: 3 }, { executionId: "memory-parent" }).pipe(
          Effect.provide(layer)
        )
      )

      expect(value).toBe(3)
      expect(calls).toEqual([0, 1, 2])
    }))

  it("refuses zero, negative, and fractional round budgets at declaration time", () => {
    // The round-budget contract starts at 1: `maxRounds: 1` means "no handoff
    // at all" and the engine never has to interpret a budget that promises
    // less than the caller's own execution. Invalid budgets are refused where
    // the declaration is written, so `Round.next`'s `>= budget` arithmetic
    // only ever defends against drivers that bypass `Flow.make`.
    expect(() => counter("trampoline/budget-zero", 0)).toThrow(RangeError)
    expect(() => counter("trampoline/budget-negative", -1)).toThrow(RangeError)
    expect(() => counter("trampoline/budget-fraction", 1.5)).toThrow(RangeError)
  })

  it.effect("runs round 0 in full under the smallest legal budget and refuses its first handoff", () =>
    Effect.gen(function*() {
      // `maxRounds: 1` bounds HANDOFFS, not the caller's own execution: round 0
      // is the execution the caller asked for, so its work runs — the budget is
      // only consulted when the settled round asks to open round 1.
      const { calls, layer } = wire(Interpreter.layer(Single))

      const exit = yield* withCrypto(
        Single.execute({ value: 0, target: 99 }, { executionId: "memory-single-round" }).pipe(
          Effect.exit,
          Effect.provide(layer)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("MaxRoundsExceeded")
      // Round 0 dispatched its increment before the refusal; round 1 never ran.
      expect(calls).toEqual([0])
    }))

  it.effect("refuses a handoff to a flow the engine was never told about", () =>
    Effect.gen(function*() {
      const Stranger = Flow.make("trampoline/stranger", {
        payload: { value: Schema.Number },
        success: Schema.Number,
        body: () => Node.succeed(0)
      })
      const Orphan = Flow.make("trampoline/orphan", {
        payload: { value: Schema.Number },
        success: Schema.Number,
        body: ({ value }) => Stranger.to({ value })
      })
      // A persisted handoff can name a declaration this host never registered.
      // Interpreter.layer would register the statically referenced Stranger.
      const registration = Layer.effectDiscard(Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.register(Orphan, ({ value }) =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            instance.handoff = new Flow.Handoff({ flow: Stranger._tag, payload: { value } })
            return value
          }))
      }))
      const { layer } = wire(registration)

      const exit = yield* withCrypto(
        Orphan.execute({ value: 1 }, { executionId: "memory-orphan" }).pipe(
          Effect.exit,
          Effect.provide(layer)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("is not registered with this engine")
      const defect = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined
      expect(defect).toBeInstanceOf(FlowEngine.FlowNotRegistered)
      expect(defect).toMatchObject({ code: "flow_not_registered", flowName: "trampoline/stranger" })
    }))

  // `layerMemory.register` keeps a per-tag stack with a scope-aware restore,
  // mirroring `make.register`'s declaration table: a closed inner
  // registration is spliced back out, so executions land on the still-open
  // outer registration — and in its still-open scope — rather than on a
  // stale entry whose closed scope would interrupt the round fiber at fork.
  it.effect("serves the outer registration after an inner scoped registration of the same tag closes", () =>
    Effect.gen(function*() {
      yield* withCrypto(
        Effect.gen(function*() {
          const runtime = yield* FlowRuntime.FlowRuntime
          yield* Effect.scoped(
            Effect.gen(function*() {
              yield* runtime.register(Counter, () => Effect.succeed(1))
              yield* Effect.scoped(runtime.register(Counter, () => Effect.succeed(2)))
              // The inner scope is closed; the outer registration must serve
              // this execution.
              yield* runtime.execute(Counter, {
                executionId: "memory-scoped-lifetime",
                payload: { value: 0, target: 1 },
                discard: true
              })
              let polled: Exit.Exit<
                Option.Option<Flow.Result<unknown, unknown>>,
                FlowRuntime.FlowExecutionNotFound
              > = yield* Effect.exit(
                runtime.poll(Counter, "memory-scoped-lifetime")
              )
              for (let index = 0; index < 50; index++) {
                polled = yield* Effect.exit(runtime.poll(Counter, "memory-scoped-lifetime"))
                if (Exit.isFailure(polled) || (Exit.isSuccess(polled) && Option.isSome(polled.value))) break
                yield* Effect.yieldNow
              }
              expect(
                Exit.isSuccess(polled) && Option.isSome(polled.value) &&
                  polled.value.value._tag === "Complete" &&
                  Exit.isSuccess(polled.value.value.exit) && polled.value.value.exit.value
              ).toBe(1)
            })
          )
        }).pipe(Effect.provide(FlowEngine.layerMemory))
      )
    }))

  it.effect("dies on a handoff whose journaled payload no longer decodes under the registered target's schema", () =>
    Effect.gen(function*() {
      // The handoff payload is serializable data that crossed a journal: the
      // sender encodes it under the declaration its body was authored against,
      // and the engine decodes it under the declaration REGISTERED for the tag.
      // When the registered flow's payload schema has since changed shape, the
      // decode is the wiring error `execute` answers with a defect — and the
      // refused round must never dispatch any of the target's work.
      const EvolvedV1 = Flow.make("trampoline/evolved-target", {
        payload: { value: Schema.Number },
        success: Schema.Number,
        body: ({ value }) => Increment.call({ value })
      })
      const EvolvedV2 = Flow.make("trampoline/evolved-target", {
        payload: { value: Schema.Number, gate: Schema.String },
        success: Schema.Number,
        body: ({ value }) => Increment.call({ value })
      })
      const Sender = Flow.make("trampoline/evolved-sender", {
        payload: { value: Schema.Number },
        success: Schema.Number,
        body: ({ value }) => EvolvedV1.to({ value })
      })
      // Emit journaled V1 bytes without automatically registering its declaration.
      const registration = Layer.effectDiscard(Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.register(Sender, ({ value }) =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            instance.handoff = new Flow.Handoff({ flow: EvolvedV1._tag, payload: { value } })
            return value
          }))
      }))
      const { calls, layer } = wire(registration, Interpreter.layer(EvolvedV2))

      const exit = yield* withCrypto(
        Sender.execute({ value: 1 }, { executionId: "memory-evolved-handoff" }).pipe(
          Effect.exit,
          Effect.provide(layer)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      const defect = Exit.isFailure(exit)
        ? exit.cause.reasons.find((reason) => reason._tag === "Die")?.defect
        : undefined
      // The terminal cause is the typed schema error naming the missing field,
      // recorded as the caller's defect rather than a typed flow failure.
      expect(defect).toBeInstanceOf(Schema.SchemaError)
      expect(String(defect)).toContain("gate")
      // No next-round side effect: the target's increment never dispatched.
      expect(calls).toEqual([])
    }))
})
