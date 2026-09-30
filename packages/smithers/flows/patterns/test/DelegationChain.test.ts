/**
 * `DelegationChain` on `@smthrs/flow`'s `Graph.build`.
 *
 * Every assertion is the one it was: how many calls a chain declares, what
 * each declared call is handed, which retry decorator the tier ladder carries,
 * and every refusal. Three readings moved: a call's declared payload is
 * `node.payload` rather than the first `Literal` of `keyMaterial.inputs`, a
 * `Succeed` node's value is its payload too, and a member call is found by the
 * flow tag it names rather than by a capability planted on it.
 *
 * What is NEW is the arm pair at the end: a leaf review is a `Node.branch`,
 * so the plan carries the settled arm and the next tier before anything runs.
 */
import { describe, it } from "@effect/vitest"
import { Action, Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import { expect } from "vitest"
import * as DelegationChain from "../src/DelegationChain.ts"
import { PatternError } from "../src/PatternError.ts"
import * as Trellis from "../src/Trellis.ts"
import { execute } from "./Execute.ts"
import { callsTo, payloadOf } from "./Graphs.ts"

/**
 * One stub member, named by its role.
 *
 * `Graph.build` records a call's payload and the callee's schema IDENTITY; it
 * decodes nothing, and no case here executes the declaration. So one opaque
 * payload stands for every role the chain calls, and what each member is
 * HANDED is asserted from `node.payload`.
 */
/**
 * A scripted member: a real `@smthrs/flow` flow, type-erased.
 *
 * `Flow.Any` states a declaration's schemas and annotations but not `.call`,
 * which is what a pattern member is called through, and a flow's `Requires`
 * names the actions its body reaches. Erasing both is what lets one
 * declaration compose members backed by different actions.
 */
type Scripted = Flow.Any & { readonly call: (payload: never) => Node.Node<unknown, unknown, never> }

const stub = (name: string): Scripted =>
  Flow.make(name, {
    payload: { input: Schema.Unknown },
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture({ name }, (payload: unknown) => Node.succeed(payload))
  }) as unknown as Scripted

const makeOptions: DelegationChain.MakeOptions = {
  refine: stub("refine"),
  plan: stub("plan"),
  derisk: stub("derisk"),
  execute: { weak: stub("weak"), strong: stub("strong") },
  review: stub("review"),
  settle: stub("settle"),
  tierOrder: ["weak", "strong"],
  maxDepth: 2,
  maxDeriskRounds: 2,
  maxAttempts: 3
}

const plan: Trellis.Plan = {
  sequence: [
    { agent: { goal: "a" } },
    { parallel: [{ agent: { goal: "b" } }, { agent: { goal: "c" } }] }
  ]
}

const bounds = { tierOrder: ["weak", "strong"], maxDepth: 3, maxDeriskRounds: 2, maxAttempts: 2 } as const

const budget: DelegationChain.Budget = { maxMinutes: 5 }
// A USD ceiling is the model boundary's `Budget.make({ usd })`; the chain carries none (#1842).
// @ts-expect-error `maxUsd` is not a chain budget field.
void ({ maxUsd: 5 } satisfies DelegationChain.Budget)

const keys = (value: Record<string, unknown>): ReadonlyArray<string> => Object.keys(value).sort()

class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", { tier: Schema.String }) {}

/** Every member call a chain declares, which excludes the entry call itself. */
const memberCalls = (graph: Graph.Graph): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) => node.kind === "FlowCall" && node.id !== "root")

// The declared retry decorator names the policy it carries, so the declaration
// says what a run spends. `@smthrs/flow` keeps a `Succeed`'s value on the
// node's payload, where `@smthrs/core` kept it inside `keyMaterial.body`.
const decorators = (graph: Graph.Graph): ReadonlyArray<string> =>
  Graph.nodes(graph).flatMap((node) => {
    const value = node.payload as { readonly _tag?: string; readonly name?: string } | undefined
    return value?._tag === "Decorator" && typeof value.name === "string" ? [value.name] : []
  })

describe("DelegationChain", () => {
  it.effect("reports every plan refusal before executing any leaf", () =>
    Effect.gen(function*() {
      const invalid = { sequence: [{ agent: { goal: "" } }, { agent: { goal: "ok", seat: 1 } }] }
      const trace: Array<string> = []
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed(invalid),
        derisk: () => Effect.succeed(true),
        execute: {
          weak: () => Effect.sync(() => trace.push("weak")),
          strong: () => Effect.sync(() => trace.push("strong"))
        },
        review: () => Effect.sync(() => (trace.push("review"), true)),
        settle: () => Effect.sync(() => trace.push("settle"))
      }).pipe(Effect.flip)
      const refusals = Trellis.validate(invalid, { fuel: 3, depth: 3, fanout: 3 })

      expect(refusals).toHaveLength(2)
      expect(failure).toBeInstanceOf(Trellis.TrellisError)
      expect(failure.code).toBe(refusals[0]!.code)
      expect(failure.path).toBe(refusals[0]!.path)
      expect(failure.message).toBe(refusals[0]!.message)
      expect(failure.cause).toEqual({ rounds: [], remaining: 3, refusals })
      expect(trace).toEqual([])
    }))

  it.effect("stops the derisk loop at the first approved round", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.sync(() => (calls.push("refine"), "goal")),
        plan: () => Effect.sync(() => (calls.push("plan"), plan)),
        derisk: () => Effect.sync(() => (calls.push("derisk"), { approved: true })),
        execute: { weak: () => Effect.succeed("ok"), strong: () => Effect.succeed("ok") },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      })

      expect(calls).toEqual(["refine", "plan", "derisk"])
    }))

  it.effect("revises the plan while derisk withholds approval", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const settled = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: ({ round }) => Effect.sync(() => (calls.push(`plan-${round}`), { agent: { goal: "a" } })),
        derisk: ({ round }) => Effect.sync(() => (calls.push(`derisk-${round}`), { approved: round === 2 })),
        execute: { weak: () => Effect.succeed("ok"), strong: () => Effect.succeed("ok") },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ deriskExhausted, leaves }) => Effect.succeed({ deriskExhausted, leaves })
      })

      expect(calls).toEqual(["plan-1", "derisk-1", "plan-2", "derisk-2"])
      expect(settled).toEqual({ deriskExhausted: false, leaves: ["ok"] })
    }))

  it.effect("escalates a leaf that fails on the weakest tier and succeeds on the next", () =>
    Effect.gen(function*() {
      const attempted: Array<string> = []
      const settled = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ agent: { goal: "a" } }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: ({ leaf }) =>
            Effect.suspend(() => {
              attempted.push(`weak:${leaf.path}`)
              return Effect.fail("weak tier gave up")
            }),
          strong: ({ leaf }) =>
            Effect.sync(() => {
              attempted.push(`strong:${leaf.path}`)
              return "strong result"
            })
        },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      })

      expect(attempted).toEqual(["weak:root", "weak:root", "strong:root"])
      expect(settled).toEqual(["strong result"])
    }))

  it.effect("escalates a leaf whose result the review rejects", () =>
    Effect.gen(function*() {
      const reviewed: Array<unknown> = []
      const settled = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ agent: { goal: "a" } }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: { weak: () => Effect.succeed("thin"), strong: () => Effect.succeed("thorough") },
        review: (request) =>
          Effect.sync(() => {
            if (request.stage === "leaf") reviewed.push(request.tier)
            return { approved: request.stage === "chain" || request.output === "thorough" }
          }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      })

      expect(reviewed).toEqual(["weak", "strong"])
      expect(settled).toEqual(["thorough"])
    }))

  it.effect("fails with the leaf path once every tier has spent maxAttempts", () =>
    Effect.gen(function*() {
      let attempts = 0
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ sequence: [{ agent: { goal: "a" } }] }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: () => Effect.suspend(() => (attempts += 1, Effect.fail("weak failed"))),
          strong: () => Effect.suspend(() => (attempts += 1, Effect.fail("strong failed")))
        },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
      expect((failure as DelegationChain.DelegationError).code).toBe("leaf_failed")
      expect((failure as DelegationChain.DelegationError).path).toBe("root.sequence[0]")
      expect((failure as DelegationChain.DelegationError).message).toBe(
        "No tier settled the leaf at root.sequence[0] within 2 attempts each"
      )
      expect((failure as DelegationChain.DelegationError & { readonly cause?: unknown }).cause).toEqual([
        { tier: "weak", error: "weak failed" },
        { tier: "strong", error: "strong failed" }
      ])
      expect(attempts).toBe(bounds.tierOrder.length * bounds.maxAttempts)
    }))

  it.effect("fails an exhausted rejected ladder without settling its leaf", () =>
    Effect.gen(function*() {
      const attempts = new Map<string, number>()
      const reviewed: Array<string> = []
      let settled = false
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ sequence: [{ agent: { goal: "a" } }] }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: ({ tier }) =>
            Effect.suspend(() => {
              const attempt = (attempts.get(tier) ?? 0) + 1
              attempts.set(tier, attempt)
              return attempt === bounds.maxAttempts ? Effect.succeed(`${tier}-candidate`) : Effect.fail("retry")
            }),
          strong: ({ tier }) =>
            Effect.suspend(() => {
              const attempt = (attempts.get(tier) ?? 0) + 1
              attempts.set(tier, attempt)
              return attempt === bounds.maxAttempts ? Effect.succeed(`${tier}-candidate`) : Effect.fail("retry")
            })
        },
        review: (request) =>
          Effect.sync(() => {
            if (request.stage === "leaf") reviewed.push(request.tier)
            return { approved: request.stage === "chain" }
          }),
        settle: ({ leaves }) => Effect.sync(() => (settled = true, leaves))
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
      expect((failure as DelegationChain.DelegationError).code).toBe("leaf_failed")
      expect((failure as DelegationChain.DelegationError).path).toBe("root.sequence[0]")
      expect((failure as DelegationChain.DelegationError).message).toBe(
        "No tier settled the leaf at root.sequence[0] within 2 attempts each"
      )
      expect((failure as DelegationChain.DelegationError & { readonly cause?: unknown }).cause).toEqual([
        { tier: "weak", rejected: true },
        { tier: "strong", rejected: true }
      ])
      expect(attempts).toEqual(new Map([["weak", bounds.maxAttempts], ["strong", bounds.maxAttempts]]))
      expect(reviewed).toEqual(["weak", "strong"])
      expect(settled).toBe(false)
    }))

  it.effect("hands settle every leaf output in plan order", () =>
    Effect.gen(function*() {
      const settled = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed(plan),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: ({ leaf }) => Effect.succeed(leaf.goal.toUpperCase()),
          strong: () => Effect.succeed("unused")
        },
        review: () => Effect.succeed({ approved: true }),
        settle: (request) => Effect.succeed(request)
      })

      expect(settled).toMatchObject({
        goal: "goal",
        leaves: ["A", ["B", "C"]].flat(),
        deriskExhausted: false
      })
    }))

  it.effect("refuses a derisked plan that leaves the envelope", () =>
    Effect.gen(function*() {
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        maxDepth: 1,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ sequence: [{ agent: { goal: "a" } }] }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: { weak: () => Effect.succeed("ok"), strong: () => Effect.succeed("ok") },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      }).pipe(Effect.flip)

      expect(failure).toMatchObject({
        code: "depth_exceeded",
        path: "root.sequence[0]",
        message: "Plan depth 2 exceeds the envelope depth 1"
      })
    }))

  it.effect("refuses invalid concurrency before any callback runs", () =>
    Effect.gen(function*() {
      for (const concurrency of [0, -5, 1.5, Number.NaN]) {
        let callbacks = 0
        const called = <A>(value: A) => Effect.sync(() => (callbacks += 1, value))
        const failure = yield* Effect.flip(
          DelegationChain.run("ship it", {
            ...bounds,
            concurrency,
            refine: () => called("goal"),
            plan: () => called({ agent: { goal: "a" } }),
            derisk: () => called({ approved: true }),
            execute: { weak: () => called("ok"), strong: () => called("ok") },
            review: () => called({ approved: true }),
            settle: ({ leaves }) => called(leaves)
          })
        )

        expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
        expect((failure as DelegationChain.DelegationError).code).toBe("invalid_bounds")
        expect((failure as DelegationChain.DelegationError).path).toBe("root")
        expect((failure as DelegationChain.DelegationError).message).toBe(
          `Delegation concurrency must be a positive safe integer, received ${concurrency}`
        )
        expect(callbacks).toBe(0)
      }
    }))

  it.effect("wraps a derisk PatternError with the exact delegation refusal", () =>
    Effect.gen(function*() {
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.fail(new PatternError({ code: "invalid_decorator", message: "planner refused input" })),
        derisk: () => Effect.succeed({ approved: true }),
        execute: { weak: () => Effect.succeed("ok"), strong: () => Effect.succeed("ok") },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
      expect((failure as DelegationChain.DelegationError).code).toBe("derisk_failed")
      expect((failure as DelegationChain.DelegationError).path).toBe("root")
      expect((failure as DelegationChain.DelegationError).message).toBe("planner refused input")
    }))

  it.effect("wraps a leaf-review PatternError with the exact leaf refusal", () =>
    Effect.gen(function*() {
      const reviewFailure = new PatternError({ code: "invalid_decorator", message: "review unavailable" })
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ agent: { goal: "a" } }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: { weak: () => Effect.succeed("candidate"), strong: () => Effect.succeed("unused") },
        review: (request) =>
          request.stage === "leaf"
            ? Effect.fail(reviewFailure)
            : Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
      expect((failure as DelegationChain.DelegationError).code).toBe("leaf_failed")
      expect((failure as DelegationChain.DelegationError).path).toBe("root")
      expect((failure as DelegationChain.DelegationError).message).toBe(
        "No tier settled the leaf at root within 2 attempts each"
      )
      expect((failure as DelegationChain.DelegationError & { readonly cause?: unknown }).cause).toBe(reviewFailure)
    }))

  it("declares the documented number of flow calls", () => {
    const chain = DelegationChain.make(makeOptions)
    const graph = Graph.build(chain, { input: "ship it" })
    expect(Flow.isFlow(chain)).toBe(true)
    expect(memberCalls(graph)).toHaveLength(DelegationChain.bound(makeOptions))
    // 4 fixed calls + 2 per derisk round + one retried escalation ladder per
    // depth slot: 2 + maxAttempts * (1 + 2 * tiers).
    expect(DelegationChain.bound(makeOptions)).toBe(42)
  })

  it.effect("settles with deriskExhausted when derisk never approves", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const settled = yield* DelegationChain.run("ship it", {
        ...bounds,
        maxDeriskRounds: 2,
        refine: () => Effect.succeed("goal"),
        plan: ({ round }) => Effect.sync(() => (calls.push(`plan-${round}`), { agent: { goal: "a" } })),
        derisk: ({ round }) => Effect.sync(() => (calls.push(`derisk-${round}`), { approved: false })),
        execute: { weak: () => Effect.succeed("ok"), strong: () => Effect.succeed("unused") },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ deriskExhausted, leaves }) => Effect.succeed({ deriskExhausted, leaves })
      })

      expect(calls).toEqual(["plan-1", "derisk-1", "plan-2", "derisk-2"])
      expect(settled).toEqual({ deriskExhausted: true, leaves: ["ok"] })
    }))

  it.effect("declares the payloads it executes", () =>
    Effect.gen(function*() {
      const executed: Array<ReadonlyArray<string>> = []
      const reviewed: Array<ReadonlyArray<string>> = []
      let settlement: ReadonlyArray<string> = []
      yield* DelegationChain.run("ship it", {
        ...bounds,
        maxDepth: 2,
        budget,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ agent: { goal: "a" } }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: (work) => Effect.sync(() => (executed.push(keys(work as never)), "ok")),
          strong: () => Effect.succeed("unused")
        },
        review: (request) => Effect.sync(() => (reviewed.push(keys(request as never)), { approved: true })),
        settle: (request) => Effect.sync(() => (settlement = keys(request as never), request.leaves))
      })

      const graph = Graph.build(DelegationChain.make({ ...makeOptions, budget }), { input: "ship it" })
      const declaredWork = callsTo(graph, "weak").map(payloadOf)
      const declaredReviews = callsTo(graph, "review").map(payloadOf)
      const declaredSettle = payloadOf(callsTo(graph, "settle")[0] as Graph.GraphNode)

      // One tier call per slot per declared attempt, each carrying the tier it
      // is and the run budget.
      const attempts = makeOptions.maxAttempts
      const perSlot = <A>(slot0: A, slot1: A): ReadonlyArray<A> => [
        ...Array.from({ length: attempts }, () => slot0),
        ...Array.from({ length: attempts }, () => slot1)
      ]
      expect(declaredWork).toHaveLength(makeOptions.maxDepth * attempts)
      expect(declaredWork.map(keys)).toEqual(declaredWork.map(() => executed[0]))
      expect(declaredWork.map((work) => work.tier)).toEqual(declaredWork.map(() => "weak"))
      expect(declaredWork.map((work) => work.budget)).toEqual(declaredWork.map(() => budget))
      expect(declaredWork.map((work) => keys(work.leaf as Record<string, unknown>))).toEqual(
        declaredWork.map(() => ["goal", "path"])
      )
      expect(declaredWork.map((work) => (work.leaf as { readonly path: string }).path)).toEqual(
        perSlot("slot-0", "slot-1")
      )
      // The leaf review names the tier that produced the output, as run does.
      const leafReviews = declaredReviews.filter((request) => request.stage === "leaf")
      expect(leafReviews.map(keys)).toEqual(leafReviews.map(() => reviewed[0]))
      expect(leafReviews.map((request) => request.tier)).toEqual(
        Array.from({ length: makeOptions.maxDepth * attempts }, () => ["weak", "strong"]).flat()
      )
      // Settle is declared with the keys run settles with.
      expect(keys(declaredSettle)).toEqual(settlement)
    }))

  it.effect("ends a tier at a non-retryable failure and admits the next one", () =>
    Effect.gen(function*() {
      const attempted: Array<string> = []
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        nonRetryable: ["Unauthorized"],
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ sequence: [{ agent: { goal: "a" } }] }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: ({ tier }) => Effect.suspend(() => (attempted.push(tier), Effect.fail(new Unauthorized({ tier })))),
          strong: ({ tier }) => Effect.suspend(() => (attempted.push(tier), Effect.fail(new Unauthorized({ tier }))))
        },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      }).pipe(Effect.flip)

      // One call per tier, not maxAttempts per tier: the tag can never succeed.
      expect(attempted).toEqual(["weak", "strong"])
      expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
      expect((failure as DelegationChain.DelegationError).code).toBe("leaf_failed")
      expect((failure as DelegationChain.DelegationError).path).toBe("root.sequence[0]")
    }))

  it.effect("still spends every attempt on a failure the tags do not name", () =>
    Effect.gen(function*() {
      const attempted: Array<string> = []
      yield* DelegationChain.run("ship it", {
        ...bounds,
        nonRetryable: ["Unauthorized"],
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ sequence: [{ agent: { goal: "a" } }] }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: ({ tier }) => Effect.suspend(() => (attempted.push(tier), Effect.fail("throttled"))),
          strong: ({ tier }) => Effect.suspend(() => (attempted.push(tier), Effect.fail("throttled")))
        },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      }).pipe(Effect.flip)

      expect(attempted).toEqual(["weak", "weak", "strong", "strong"])
    }))

  it("spaces a tier's attempts by the declared backoff", () =>
    Effect.gen(function*() {
      const attempted: Array<string> = []
      const fiber = yield* DelegationChain.run("ship it", {
        ...bounds,
        maxAttempts: 3,
        backoff: { initialMs: 100, factor: 2, maxMs: 150 },
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ agent: { goal: "a" } }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: ({ tier }) => Effect.suspend(() => (attempted.push(tier), Effect.fail("throttled"))),
          strong: ({ tier }) => Effect.suspend(() => (attempted.push(tier), Effect.fail("throttled")))
        },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      }).pipe(Effect.forkChild({ startImmediately: true }))

      expect(attempted).toEqual(["weak"])
      yield* TestClock.adjust("99 millis")
      expect(attempted).toEqual(["weak"])
      yield* TestClock.adjust("1 millis")
      expect(attempted).toEqual(["weak", "weak"])
      // The third wait is the capped 150 ms, and the next tier's first attempt
      // is admitted as soon as the weak tier gives up, without a wait of its own.
      yield* TestClock.adjust("150 millis")
      expect(attempted).toEqual(["weak", "weak", "weak", "strong"])
      yield* TestClock.adjust("99 millis")
      expect(attempted).toEqual(["weak", "weak", "weak", "strong"])
      yield* TestClock.adjust("1 millis")
      expect(attempted).toEqual(["weak", "weak", "weak", "strong", "strong"])
      yield* TestClock.adjust("150 millis")
      expect(attempted).toEqual(["weak", "weak", "weak", "strong", "strong", "strong"])

      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise))

  it("declares the tier ladder with the retry policy run spends", () => {
    const policy = {
      maxAttempts: 3,
      backoff: { initialMs: 100, factor: 2, maxMs: 400 },
      nonRetryable: ["Unauthorized", "Invalid"]
    }
    const graph = Graph.build(DelegationChain.make({ ...makeOptions, maxDepth: 1, ...policy }), { input: "ship it" })

    expect(decorators(graph)).toEqual([
      "withRetry(delegationTiers(weak -> strong), attempts=3, backoff=100x2<=400, nonRetryable=Invalid|Unauthorized)"
    ])
    // A chain that declares no policy still declares the plain attempt budget.
    expect(decorators(Graph.build(DelegationChain.make({ ...makeOptions, maxDepth: 1 }), { input: "ship it" })))
      .toEqual([
        "withRetry(delegationTiers(weak -> strong), attempts=3)"
      ])
  })

  it.effect("refuses an invalid backoff before any callback runs", () =>
    Effect.gen(function*() {
      const invalid = [
        { initialMs: 0, factor: 2, maxMs: 10 },
        { initialMs: 10, factor: 0.5, maxMs: 10 },
        { initialMs: 10, factor: 2, maxMs: 5 },
        { initialMs: Number.NaN, factor: 2, maxMs: 10 }
      ]
      for (const backoff of invalid) {
        let callbacks = 0
        const called = <A>(value: A) => Effect.sync(() => (callbacks += 1, value))
        const failure = yield* Effect.flip(
          DelegationChain.run("ship it", {
            ...bounds,
            backoff,
            refine: () => called("goal"),
            plan: () => called({ agent: { goal: "a" } }),
            derisk: () => called({ approved: true }),
            execute: { weak: () => called("ok"), strong: () => called("ok") },
            review: () => called({ approved: true }),
            settle: ({ leaves }) => called(leaves)
          })
        )

        expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
        expect((failure as DelegationChain.DelegationError).code).toBe("invalid_bounds")
        expect((failure as DelegationChain.DelegationError).message).toBe(
          "backoff must declare a positive initialMs, a factor of at least 1, and a maxMs of at least initialMs"
        )
        expect(callbacks).toBe(0)
      }
      expect(() => DelegationChain.make({ ...makeOptions, backoff: { initialMs: 10, factor: 2, maxMs: 5 } })).toThrow(
        expect.objectContaining({
          code: "invalid_bounds",
          path: "root",
          message:
            "backoff must declare a positive initialMs, a factor of at least 1, and a maxMs of at least initialMs"
        })
      )
    }))

  it("refuses bounds and tiers it cannot honour", () => {
    expect(() => DelegationChain.make({ ...makeOptions, maxDepth: 0 })).toThrow(
      expect.objectContaining({
        code: "invalid_bounds",
        path: "root",
        message: "maxDepth, maxDeriskRounds, and maxAttempts must be positive safe integers"
      })
    )
    expect(() => DelegationChain.make({ ...makeOptions, tierOrder: [] })).toThrow(
      expect.objectContaining({
        code: "invalid_bounds",
        path: "root",
        message: "tierOrder must name at least one tier, weakest first"
      })
    )
    expect(() => DelegationChain.make({ ...makeOptions, tierOrder: ["absent"] })).toThrow(
      expect.objectContaining({
        code: "missing_tier",
        path: "root",
        message: "execute has no flow for tier absent"
      })
    )
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const named = DelegationChain.make({
      ...makeOptions,
      name: "ship-release",
      description: "Delegate a release down the tier ladder."
    })

    expect(named._tag).toBe("ship-release")
    expect(named.description).toBe("Delegate a release down the tier ladder.")
    expect(DelegationChain.make(makeOptions).description).toBeUndefined()
  })
})
/** Every payload a declared chain stage was handed while the plan ran. */
const chainCalls: Array<{ readonly role: string; readonly payload: unknown }> = []
/** The tier whose output the scripted reviewer approves, set per case. */
let approvesTier = "weak"

const chainStep = Action.make("delegation/step", {
  payload: { role: Schema.String, payload: Schema.Unknown },
  success: Schema.Unknown,
  error: Schema.Never
})

const chainLayer = chainStep.toLayer(({ payload, role }) =>
  Effect.sync(() => {
    chainCalls.push({ role, payload })
    switch (role) {
      case "refine":
        return "goal"
      case "plan":
        return { agent: { goal: "a" } }
      case "derisk":
        return { approved: true }
      case "review": {
        const request = payload as { readonly stage?: string; readonly tier?: string }
        return { approved: request.stage === "chain" || request.tier === approvesTier }
      }
      case "settle":
        return "settled"
      default:
        return `${role} result`
    }
  })
)

const opaque = Schema.optionalKey(Schema.Unknown)

/** One scripted chain stage, forwarding whatever payload it is handed. */
const roleFlow = (role: string, fields: Schema.Struct.Fields): Scripted =>
  Flow.make(`delegation/${role}`, {
    payload: fields,
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture({ role }, function(this: { readonly role: string }, payload: unknown) {
      return chainStep.call({ role: this.role, payload })
    })
  }) as unknown as Scripted

const scriptedChain = (): DelegationChain.DelegationChainFlow =>
  DelegationChain.make({
    refine: roleFlow("refine", { prompt: opaque }),
    plan: roleFlow("plan", { input: opaque, output: opaque, review: opaque, round: opaque }),
    derisk: roleFlow("derisk", { output: opaque }),
    execute: {
      weak: roleFlow("weak", { leaf: opaque, tier: opaque, goal: opaque, budget: opaque }),
      strong: roleFlow("strong", { leaf: opaque, tier: opaque, goal: opaque, budget: opaque })
    },
    review: roleFlow("review", {
      stage: opaque,
      leaf: opaque,
      tier: opaque,
      output: opaque,
      goal: opaque,
      plan: opaque,
      leaves: opaque
    }),
    settle: roleFlow("settle", {
      prompt: opaque,
      goal: opaque,
      plan: opaque,
      leaves: opaque,
      review: opaque,
      deriskExhausted: opaque
    }),
    tierOrder: ["weak", "strong"],
    maxDepth: 1,
    maxDeriskRounds: 1,
    maxAttempts: 1
  })

/** Runs one declared chain to settlement against the scripted stages. */
const settle = (approves: string, executionId: string): Promise<unknown> => {
  chainCalls.length = 0
  approvesTier = approves
  return execute(scriptedChain() as never, { input: "ship it" }, executionId, chainLayer)
}

describe("DelegationChain declaration execution", () => {
  it("takes the TRUE arm when the real review approves the weakest tier", async () => {
    const settled = await settle("weak", "delegation-tier-true-arm")

    expect(settled).toBe("settled")
    // The strong tier is declared topology the run did not take.
    expect(chainCalls.map((call) => call.role)).toEqual([
      "refine",
      "plan",
      "derisk",
      "weak",
      "review",
      "review",
      "settle"
    ])
    expect(chainCalls.filter((call) => call.role === "review").map((call) => (call.payload as { tier?: string }).tier))
      .toEqual(["weak", undefined])
  })

  it("takes the FALSE arm when the real review refuses the weakest tier", async () => {
    const settled = await settle("strong", "delegation-tier-false-arm")

    expect(settled).toBe("settled")
    // The weak tier's output was refused on the real review, so the next rung
    // ran. A build-time evaluation of the same predicate cannot produce both.
    expect(chainCalls.map((call) => call.role)).toEqual([
      "refine",
      "plan",
      "derisk",
      "weak",
      "review",
      "strong",
      "review",
      "review",
      "settle"
    ])
    expect(chainCalls.filter((call) => call.role === "review").map((call) => (call.payload as { tier?: string }).tier))
      .toEqual(["weak", "strong", undefined])
  })

  it("declares both arms of every rung, so a plan carries the topology a run may take", () => {
    const graph = Graph.build(scriptedChain(), { input: "ship it" })

    // Three decisions: the derisk loop's one approval round, and one rung
    // decision per tier for the single depth slot.
    expect(Graph.nodes(graph).filter((node) => node.kind === "Branch")).toHaveLength(3)
  })
})
