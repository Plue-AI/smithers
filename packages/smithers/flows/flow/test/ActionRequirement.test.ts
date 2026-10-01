/**
 * The requirement channel: what a plan demands, what an execution demands, and
 * the gap between them.
 *
 * The rule this suite buys is one sentence: PLANNING is requirement-free and
 * EXECUTING is not. A body that names an action records a node and nothing
 * else, so building, keying, and diffing a plan never ask for an
 * implementation; asking to RUN that plan is what makes a forgotten
 * `toLayer` a compile error instead of a run that dies partway through.
 *
 * Most of it is therefore a TYPE test. The repo's convention for those is
 * vitest's `expectTypeOf` beside `@ts-expect-error`, checked by
 * `tsc -p tsconfig.test.json` in `pnpm run check`, so a red type assertion
 * fails the gate whether or not the suite is run.
 */
import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Graph, Interpreter, Sleep, WaitFor } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import type * as Crypto from "effect/Crypto"
import { withCrypto } from "./Crypto.ts"
import { layerMemory } from "./MemoryFlowRuntime.ts"

const Charge = Action.make("requirement/charge", {
  payload: { cents: Schema.Number },
  success: Schema.Number,
  error: Schema.String
})

const Refund = Action.make("requirement/refund", {
  payload: { cents: Schema.Number },
  success: Schema.Number
})

const Audit = Action.make("requirement/audit", {
  payload: { note: Schema.String },
  success: Schema.String
})

type ChargeNeeded = Action.Requirement<"requirement/charge">
type RefundNeeded = Action.Requirement<"requirement/refund">
type AuditNeeded = Action.Requirement<"requirement/audit">

const charges = Charge.toLayer(({ cents }) => Effect.succeed(cents))
const refunds = Refund.toLayer(({ cents }) => Effect.succeed(-cents))
const audits = Audit.toLayer(({ note }) => Effect.succeed(note))

describe("planning is requirement-free", () => {
  it("builds and keys a graph with nothing provided", () => {
    const Paying = Flow.make("requirement/paying", {
      payload: { cents: Schema.Number },
      success: Schema.Number,
      error: Schema.String,
      body: ({ cents }) => Charge.call({ cents })
    })

    // `Graph.build` takes the flow and the payload and answers with a plan. It
    // is a pure function: no Effect, so no channel to demand anything through.
    const graph = Graph.build(Paying, { cents: 100 })

    expect(Graph.diagnostics(graph)).toEqual([])
    expect(Graph.nodes(graph).map((observed) => observed.kind)).toEqual(["ActionCall", "FlowCall"])
    expectTypeOf(graph).not.toBeNever()
  })

  it("keeps the channel off the node's data, so the AST is unchanged by it", () => {
    const node = Charge.call({ cents: 100 })

    expectTypeOf(node).toEqualTypeOf<Node.Node<number, string, ChargeNeeded>>()
    expect(node.ast).toEqual({
      _tag: "ActionCall",
      action: "requirement/charge",
      payload: { cents: 100 }
    })
  })
})

describe("combinators union what their parts require", () => {
  it("unions across all, map, and andThen", () => {
    const both = Node.all({ charged: Charge.call({ cents: 1 }), refunded: Refund.call({ cents: 2 }) })
    expectTypeOf<Node.Services<typeof both>>().toEqualTypeOf<ChargeNeeded | RefundNeeded>()

    const mapped = Charge.call({ cents: 1 }).pipe(Node.map((value) => value + 1))
    expectTypeOf<Node.Services<typeof mapped>>().toEqualTypeOf<ChargeNeeded>()

    const sequenced = Charge.call({ cents: 1 }).pipe(Node.bindPlanned(() => Refund.call({ cents: 2 })))
    expectTypeOf<Node.Services<typeof sequenced>>().toEqualTypeOf<ChargeNeeded | RefundNeeded>()
  })

  it("unions BOTH arms of a branch, because both are topology the plan carries", () => {
    const decided = Charge.call({ cents: 1 }).pipe(
      Node.branch({
        if: (value) => value > 0,
        then: () => Refund.call({ cents: 2 }),
        else: () => Audit.call({ note: "declined" })
      })
    )

    expectTypeOf<Node.Services<typeof decided>>().toEqualTypeOf<
      ChargeNeeded | RefundNeeded | AuditNeeded
    >()
  })

  it("unions a catch's failure arm with the graph it protects", () => {
    const recovered = Charge.call({ cents: 1 }).pipe(
      Node.catch({ onFailure: () => Audit.call({ note: "failed" }) })
    )

    expectTypeOf<Node.Services<typeof recovered>>().toEqualTypeOf<ChargeNeeded | AuditNeeded>()
  })

  it("requires nothing of a constant", () => {
    expectTypeOf<Node.Services<ReturnType<typeof Node.succeed<number>>>>().toEqualTypeOf<never>()
  })
})

describe("a flow carries what its body requires", () => {
  const Paying = Flow.make("requirement/execute", {
    payload: { cents: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
    body: ({ cents }) => Charge.call({ cents })
  })

  it("puts it in execute, and nowhere a plan is only being described", () => {
    expectTypeOf<Flow.Requirements<typeof Paying>>().toEqualTypeOf<ChargeNeeded>()
    expectTypeOf<Effect.Services<ReturnType<typeof Paying.execute>>>().toEqualTypeOf<
      Crypto.Crypto | FlowRuntime.FlowRuntime | ChargeNeeded
    >()
    expectTypeOf<Effect.Error<ReturnType<typeof Paying.execute>>>().toEqualTypeOf<
      Schema.SchemaError | FlowRuntime.FlowCycleDetected | FlowRuntime.ExecutionIdentityConflict | string
    >()

    // Neither reading an execution's state nor cancelling one drives a body,
    // and a re-drive runs under the context the flow was REGISTERED with.
    expectTypeOf<Effect.Services<ReturnType<typeof Paying.poll>>>().toEqualTypeOf<
      FlowRuntime.FlowRuntime
    >()
    expectTypeOf<Effect.Services<ReturnType<typeof Paying.interrupt>>>().toEqualTypeOf<
      FlowRuntime.FlowRuntime
    >()
    expectTypeOf<Effect.Services<ReturnType<typeof Paying.resume>>>().toEqualTypeOf<
      FlowRuntime.FlowRuntime
    >()
  })

  it("refuses to run without the implementation layer", () => {
    const engineOnly = Interpreter.layer(Paying).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(layerMemory)
    )

    // Never invoked: the assertion is that this expression does not compile.
    const unimplemented = () =>
      Paying.execute({ cents: 100 }, { executionId: "unimplemented" }).pipe(
        Effect.provide(engineOnly)
      )

    expectTypeOf(unimplemented).toBeFunction()
  })

  it.effect("has the requirement erased by the action's own layer", () =>
    Effect.gen(function*() {
      const wired = Layer.mergeAll(charges, Interpreter.layer(Paying)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(layerMemory)
      )
      const run = Paying.execute({ cents: 100 }, { executionId: "implemented" }).pipe(
        Effect.provide(wired)
      )

      expectTypeOf<Effect.Services<typeof run>>().toEqualTypeOf<Crypto.Crypto>()
      expect(yield* withCrypto(run)).toBe(100)
    }))
})

describe("requirements travel the way the plan does", () => {
  const Inner = Flow.make("requirement/inner", {
    payload: { cents: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
    body: ({ cents }) => Charge.call({ cents })
  })

  const Middle = Flow.make("requirement/middle", {
    payload: { cents: Schema.Number },
    success: Schema.String,
    error: Schema.String,
    body: ({ cents }) => Inner.call({ cents }).pipe(Node.bindPlanned(() => Audit.call({ note: "ok" })))
  })

  it("propagates transitively through an inline call", () => {
    // The callee's steps join the caller's plan, so the callee's obligations
    // are the caller's, however many levels down they were declared.
    expectTypeOf<Flow.Requirements<typeof Middle>>().toEqualTypeOf<ChargeNeeded | AuditNeeded>()
  })

  it("drops them at a child boundary and at a handoff", () => {
    expectTypeOf<Node.Services<ReturnType<typeof Middle.child>>>().toEqualTypeOf<never>()
    expectTypeOf<Node.Services<ReturnType<typeof Middle.to>>>().toEqualTypeOf<never>()

    const Boundary = Flow.make("requirement/boundary", {
      payload: { cents: Schema.Number },
      success: Schema.String,
      error: Schema.String,
      body: ({ cents }) => Middle.child({ cents })
    })

    expectTypeOf<Flow.Requirements<typeof Boundary>>().toEqualTypeOf<never>()
  })

  it("keeps a self-looping lineage's type finite", () => {
    // A body cannot name its own flow inside its own declaration, so the shape
    // is declared first. It terminates only because `.to()` drops what the next
    // round requires; propagating it would make this alias name itself.
    type SelfFlow = Flow.Flow<
      "requirement/self",
      Schema.Struct<{ value: typeof Schema.Number; target: typeof Schema.Number }>,
      typeof Schema.Number,
      typeof Schema.String,
      ChargeNeeded
    >

    const Self: SelfFlow = Flow.make("requirement/self", {
      payload: { value: Schema.Number, target: Schema.Number },
      success: Schema.Number,
      error: Schema.String,
      body: ({ target, value }: { readonly value: number; readonly target: number }) =>
        Charge.call({ cents: value }).pipe(
          Node.branch({
            if: (next) => next >= target,
            then: (next) => Flow.done(next),
            else: (next) => Self.to({ value: next, target })
          })
        )
    })

    expectTypeOf<Flow.Requirements<typeof Self>>().toEqualTypeOf<ChargeNeeded>()
    expectTypeOf<Effect.Services<ReturnType<typeof Self.execute>>>().toEqualTypeOf<
      Crypto.Crypto | FlowRuntime.FlowRuntime | ChargeNeeded
    >()
  })
})

describe("system actions require nothing of a caller", () => {
  it("keeps Sleep and WaitFor out of a body's channel", () => {
    expectTypeOf<Node.Services<ReturnType<typeof Sleep.action.call>>>().toEqualTypeOf<never>()
    expectTypeOf<Node.Services<ReturnType<typeof WaitFor.action.call>>>().toEqualTypeOf<never>()

    const Waiting = Flow.make("requirement/waiting", {
      payload: { millis: Schema.Number },
      success: Schema.Unknown,
      error: Schema.Union([Sleep.SleepRequestInvalid, WaitFor.WaitForRequestInvalid]),
      body: ({ millis }) =>
        Sleep.action.call({ millis }).pipe(
          Node.bindPlanned(() => WaitFor.action.call({ name: "approval" }))
        )
    })

    // The engine owns these implementations, so an author cannot be the one who
    // forgot them, and a body that waits pushes nothing onto its callers.
    expectTypeOf<Flow.Requirements<typeof Waiting>>().toEqualTypeOf<never>()
  })
})

describe("toLayer provides the requirement it mints", () => {
  // A nested provision reuses the enclosing table through layer memoization,
  // so its same-tag registration must shadow for its own lifetime and restore
  // the enclosing entry when its scope closes, never leak the replacement.
  it.effect("confines a duplicate tag replacement to its nested implementation table", () =>
    Effect.gen(function*() {
      const Duplicate = Action.make("requirement/duplicate", {
        payload: { value: Schema.Number },
        success: Schema.Number
      })
      const outer = Duplicate.toLayer(({ value }) => Effect.succeed(value + 1)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(layerMemory)
      )
      const inner = Duplicate.toLayer(({ value }) => Effect.succeed(value + 2), { override: true }).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(layerMemory)
      )

      const observed = yield* withCrypto(
        Effect.gen(function*() {
          const outerTable = yield* Action.Implementations
          const before = yield* outerTable.get(Duplicate.name)
          const nested = yield* Effect.gen(function*() {
            const innerTable = yield* Action.Implementations
            return yield* innerTable.get(Duplicate.name)
          }).pipe(Effect.provide(inner))
          const after = yield* outerTable.get(Duplicate.name)
          return { before, nested, after }
        }).pipe(Effect.provide(outer))
      )

      expect(Option.isSome(observed.before)).toBe(true)
      expect(Option.isSome(observed.nested)).toBe(true)
      expect(Option.isSome(observed.after)).toBe(true)
      if (Option.isSome(observed.before) && Option.isSome(observed.nested) && Option.isSome(observed.after)) {
        expect(observed.after.value).toBe(observed.before.value)
        expect(observed.nested.value).not.toBe(observed.before.value)
      }
    }))

  it.effect("leaves a successor registration in place when an earlier sibling scope closes first", () =>
    Effect.gen(function*() {
      // Closing a sibling must neither clobber a live successor nor let that
      // successor later resurrect an implementation whose scope is closed.
      const table = yield* Action.Implementations
      const older: Action.Implementation = { name: "requirement/sibling", action: () => Effect.succeed(1) }
      const newer: Action.Implementation = { name: "requirement/sibling", action: () => Effect.succeed(2) }
      const olderScope = yield* Scope.make()
      const newerScope = yield* Scope.make()
      yield* table.add(older).pipe(Scope.provide(olderScope))
      yield* table.add(newer, { override: true }).pipe(Scope.provide(newerScope))

      yield* Scope.close(olderScope, Exit.void)
      const surviving = yield* table.get("requirement/sibling")
      yield* Scope.close(newerScope, Exit.void)
      const unwound = yield* table.get("requirement/sibling")

      expect(Option.isSome(surviving) && surviving.value).toBe(newer)
      expect(unwound).toEqual(Option.none())
    }).pipe(Effect.provide(Action.layerImplementations)))

  it.effect("answers with the same implementation the name-keyed table holds", () =>
    Effect.gen(function*() {
      const both = Layer.mergeAll(charges, refunds).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(layerMemory)
      )

      const observed = yield* withCrypto(
        Effect.gen(function*() {
          const charge = yield* Charge.requirement
          const table = yield* Action.Implementations
          const filed = yield* table.get("requirement/charge")
          return {
            provided: charge.name,
            filed: Option.isSome(filed) ? filed.value.name : undefined,
            same: Option.isSome(filed) && filed.value === charge,
            refund: (yield* Refund.requirement).name
          }
        }).pipe(Effect.provide(both))
      )

      expect(observed).toEqual({
        provided: "requirement/charge",
        filed: "requirement/charge",
        same: true,
        refund: "requirement/refund"
      })
    }))

  it("keys the requirement by the action tag, so two declarations name one slot", () => {
    const again = Action.make("requirement/charge", {
      payload: { cents: Schema.Number },
      success: Schema.Number,
      error: Schema.String
    })

    expect(again.requirement.key).toBe(Charge.requirement.key)
    expect(Charge.requirement.key).toBe("@smthrs/flow/Action/Requirement/requirement/charge")
    // An annotated copy is still the same declaration, and names the same slot.
    expect(Charge.annotate(Action.CurrentAttempt, 1).requirement.key).toBe(Charge.requirement.key)
  })

  it.effect("still files into the table when no requirement is being collected", () =>
    Effect.gen(function*() {
      // The direct path: a composition that never asks for the tag. Filing is
      // what a driver expanding a persisted plan resolves through, so it happens
      // whether or not the type channel was consulted.
      const audited = audits.pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(layerMemory)
      )

      const filed = yield* withCrypto(
        Effect.gen(function*() {
          const table = yield* Action.Implementations
          return yield* table.get("requirement/audit")
        }).pipe(Effect.provide(audited))
      )

      expect(Option.isSome(filed) && filed.value.name).toBe("requirement/audit")
    }))

  it.effect("skips filing when a composition wired no table, and still provides the tag", () =>
    Effect.gen(function*() {
      const untabled = audits.pipe(Layer.provideMerge(layerMemory))

      const provided = yield* withCrypto(
        Audit.requirement.pipe(Effect.provide(untabled))
      )

      expect(provided.name).toBe("requirement/audit")
    }))
})

describe("a hand annotation on a toLayer result", () => {
  // The requirement channel is only as honest as its annotation: a layer type
  // that under-declares still typechecks at Effect.provide and dies at
  // runtime as a missing service. Never invoked — every assertion here is
  // about what compiles.
  const chargeNeedingCrypto: (
    payload: { readonly cents: number }
  ) => Effect.Effect<number, string, Crypto.Crypto> = () => Effect.die("type-only witness")

  it("cannot drop a requirement while every member is concrete", () => {
    const dropped = (): Layer.Layer<ChargeNeeded, never, FlowRuntime.FlowRuntime> =>
      // @ts-expect-error the implementation also needs Crypto.Crypto
      Charge.toLayer(chargeNeedingCrypto)

    expectTypeOf(dropped).toBeFunction()
  })

  it("CAN drop one behind a deferred schema member, so generic wrappers pin concretely", () => {
    // The witness: the same drop compiles once the annotated union keeps
    // `Output["DecodingServices"]`, a deferred indexed access constrained only
    // as `unknown` through `Schema.Top` — TypeScript lets it absorb any
    // concrete service the annotation lost. This is the caveat documented on
    // `Action.Declared.toLayer`; if a TypeScript upgrade starts refusing the
    // witness, delete this case and that caveat together.
    const witness = <Output extends Schema.Top>(
      _output: Output
    ): Layer.Layer<ChargeNeeded, never, FlowRuntime.FlowRuntime | Output["DecodingServices"]> =>
      Charge.toLayer(chargeNeedingCrypto)

    // What the lie costs: at a concrete instantiation the layer's type no
    // longer names Crypto.Crypto, though the implementation still needs it.
    const annotated = () => witness(Schema.String)
    type Annotated = Layer.Services<ReturnType<typeof annotated>>
    expectTypeOf<Crypto.Crypto extends Annotated ? true : false>().toEqualTypeOf<false>()

    // The recipe: a wrapper that must annotate pins its requirement set where
    // the schema arguments are concrete, and membership checks work again.
    const inferred = () => Charge.toLayer(chargeNeedingCrypto)
    type Inferred = Layer.Services<ReturnType<typeof inferred>>
    expectTypeOf<Crypto.Crypto extends Inferred ? true : false>().toEqualTypeOf<true>()
    expectTypeOf<FlowRuntime.FlowRuntime extends Inferred ? true : false>().toEqualTypeOf<true>()
  })
})
