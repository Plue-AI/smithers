import { describe, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Trellis from "../src/Trellis.ts"
import { callsTo, payloadOf } from "./Graphs.ts"

// The author is handed the caller's prompt and a leaf is handed a `Leaf`, so
// one payload struct covers both roles: a `@smthrs/flow` flow states the
// payload it takes.
const MemberPayload = {
  input: Schema.optional(Schema.Unknown),
  goal: Schema.optional(Schema.Unknown),
  seat: Schema.optional(Schema.Unknown),
  path: Schema.optional(Schema.Unknown)
}

const author = Flow.make("author", {
  payload: MemberPayload,
  success: Schema.Unknown,
  error: Schema.Unknown,
  capabilities: ["delegate/author"],
  body: (payload) => Node.succeed(payload)
})

const leaf = Flow.make("leaf", {
  payload: MemberPayload,
  success: Schema.Unknown,
  error: Schema.Unknown,
  capabilities: ["delegate/leaf"],
  body: (payload) => Node.succeed(payload)
})

const envelope: Trellis.Envelope = { fuel: 3, depth: 3, fanout: 2 }

const nested: Trellis.Plan = {
  parallel: [
    { agent: { goal: "a" } },
    { sequence: [{ agent: { goal: "b" } }, { agent: { goal: "c" } }] }
  ]
}

const reported = (
  errors: ReadonlyArray<Trellis.TrellisError>
): ReadonlyArray<readonly [string, string, string]> =>
  errors.map((error) => [error.code, error.path, error.message] as const)

// `@smthrs/flow` keeps a call's hydrated payload on the node, where core kept a
// `Literal` entry in key material, and it names a call by the callee's tag,
// where core had only the capability the callee declared.
const payload = (node: Graph.GraphNode): unknown => payloadOf(node)

const leafCalls = (graph: Graph.Graph): ReadonlyArray<Graph.GraphNode> => callsTo(graph, "leaf")

describe("Trellis", () => {
  it("reports depth, fan-out, and fuel overruns at the offending path", () => {
    expect(Trellis.validate(nested, envelope)).toEqual([])
    expect(reported(Trellis.validate(nested, { fuel: 3, depth: 2, fanout: 2 }))).toEqual([
      ["depth_exceeded", "root.parallel[1].sequence[0]", "Plan depth 3 exceeds the envelope depth 2"],
      ["depth_exceeded", "root.parallel[1].sequence[1]", "Plan depth 3 exceeds the envelope depth 2"]
    ])
    expect(reported(Trellis.validate(nested, { fuel: 3, depth: 3, fanout: 1 }))).toEqual([
      ["fanout_exceeded", "root", "parallel declares 2 members, above the envelope fan-out 1"]
    ])
    expect(reported(Trellis.validate(nested, { fuel: 2, depth: 3, fanout: 2 }))).toEqual([
      ["fuel_exhausted", "root", "Plan needs 3 leaf calls but only 2 fuel remains"]
    ])
  })

  it("refuses a value that is not a plan and an envelope that is not bounded", () => {
    expect(reported(Trellis.validate({ agent: { goal: "" } }, envelope))).toEqual([
      ["invalid_plan", "root.agent.goal", "agent.goal must be a non-empty string"]
    ])
    expect(reported(Trellis.validate({ sequence: [{ swarm: [] }] }, envelope))).toEqual([
      ["invalid_plan", "root.sequence[0]", "A plan node must be exactly one of agent, sequence, or parallel"]
    ])
    expect(reported(Trellis.validate(nested, { fuel: 0, depth: 3, fanout: 2 }))).toEqual([
      ["invalid_envelope", "root", "Trellis envelope fuel, depth, and fanout must be positive safe integers"]
    ])
  })

  it("reports every malformed agent and container shape", () => {
    expect(reported(Trellis.validate(null, envelope))).toEqual([
      ["invalid_plan", "root", "A plan node must be exactly one of agent, sequence, or parallel"]
    ])
    expect(reported(Trellis.validate({ agent: null }, envelope))).toEqual([
      ["invalid_plan", "root.agent", "agent must be an object"]
    ])
    expect(reported(Trellis.validate({ agent: { goal: "work", seat: 1 } }, envelope))).toEqual([
      ["invalid_plan", "root.agent.seat", "agent.seat must be a string"]
    ])
    expect(reported(Trellis.validate({ sequence: "not-an-array" }, envelope))).toEqual([
      ["invalid_plan", "root.sequence", "sequence must be an array"]
    ])
  })

  it("refuses a container that holds no members", () => {
    expect(reported(Trellis.validate({ sequence: [] }, envelope))).toEqual([
      ["invalid_plan", "root", "sequence must hold at least one member"]
    ])
    expect(reported(Trellis.validate({ sequence: [{ parallel: [] }] }, envelope))).toEqual([
      ["invalid_plan", "root.sequence[0]", "parallel must hold at least one member"]
    ])
    // The closed grammar shows the constraint to the model that answers in it.
    expect(Schema.decodeUnknownResult(Trellis.Plan)({ sequence: [] })._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(Trellis.Plan)({ parallel: [] })._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(Trellis.Plan)(nested)._tag).toBe("Success")
  })

  it("refuses a container with a missing member and fails run on its typed channel", async () => {
    const generous: Trellis.Envelope = { fuel: 4, depth: 3, fanout: 3 }
    const dense = { agent: { goal: "g" } }
    const holes: ReadonlyArray<readonly [unknown, string]> = [
      [{ parallel: new Array(1) }, "root.parallel[0]"],
      [{ sequence: new Array(1) }, "root.sequence[0]"],
      [{ sequence: [dense, , dense] }, "root.sequence[1]"],
      [{ parallel: [dense, , dense] }, "root.parallel[1]"],
      [{ sequence: [{ parallel: [dense, ,] }] }, "root.sequence[0].parallel[1]"]
    ]
    for (const [plan, path] of holes) {
      expect(Schema.is(Trellis.Plan)(plan)).toBe(false)
      expect(reported(Trellis.validate(plan, generous))).toEqual([
        ["invalid_plan", path, "A plan node must not be a missing member"]
      ])
      let leaves = 0
      const exit = await Effect.runPromiseExit(Trellis.run("prompt", {
        envelope: generous,
        author: () => Effect.succeed(plan),
        leaf: () => Effect.sync(() => ++leaves)
      }))
      expect(exit._tag).toBe("Failure")
      const cause = (exit as { readonly cause: Cause.Cause<unknown> }).cause
      expect(Cause.hasDies(cause)).toBe(false)
      expect(Cause.hasFails(cause)).toBe(true)
      expect(leaves).toBe(0)
    }
    const control = { parallel: [dense] }
    expect(reported(Trellis.validate(control, generous))).toEqual([])
  })

  it("makes codec decoding and runtime validation agree on the closed grammar", () => {
    const generous: Trellis.Envelope = { fuel: 20, depth: 10, fanout: 10 }
    const ambiguous = {
      agent: { goal: "g" },
      parallel: [{ agent: { goal: "h" } }]
    }

    expect(Schema.decodeUnknownExit(Trellis.Plan)(ambiguous)._tag).toBe("Failure")
    expect(reported(Trellis.validate(ambiguous, generous))).toEqual([
      ["invalid_plan", "root", "A plan node must be exactly one of agent, sequence, or parallel"]
    ])

    const accepted = [
      { agent: { goal: "g" } },
      { sequence: [{ agent: { goal: "a" } }, { sequence: [{ agent: { goal: "b" } }] }] },
      { parallel: [{ agent: { goal: "a" } }, { parallel: [{ agent: { goal: "b" } }] }] },
      { agent: { goal: "g", seat: "reviewer" } }
    ]
    for (const value of accepted) {
      const decoded = Schema.decodeUnknownSync(Trellis.Plan)(value)
      expect(Trellis.validate(decoded, generous)).toEqual([])
    }
  })

  it("stops after one fan-out refusal without walking hallucinated members", () => {
    const plan = { parallel: Array.from({ length: 500 }, () => null) }
    const refusals = Trellis.validate(plan, { fuel: 1000, depth: 5, fanout: 2 })

    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.code).toBe("fanout_exceeded")
    expect(refusals[0]?.message).toBe("parallel declares 500 members, above the envelope fan-out 2")
  })

  it.effect("an empty container as a continuation stops the trampoline and is not validated as a plan", () =>
    Effect.gen(function*() {
      let continued = 0
      const trace: Array<string> = []
      const result = yield* Trellis.run("ship it", {
        envelope,
        author: () => Effect.succeed({ agent: { goal: "only" } }),
        continue: () => Effect.sync(() => (continued += 1, { sequence: [] })),
        leaf: ({ goal }) =>
          Effect.sync(() => {
            trace.push(goal)
            return goal
          })
      })

      expect(trace).toEqual(["only"])
      expect(continued).toBe(1)
      expect(result.rounds).toHaveLength(1)
      expect(result.remaining).toBe(envelope.fuel - 1)
    }))

  it.effect("a nested empty continuation stops after visiting every no-work container", () =>
    Effect.gen(function*() {
      const result = yield* Trellis.run("ship it", {
        envelope,
        author: () => Effect.succeed({ agent: { goal: "only" } }),
        continue: () => Effect.succeed({ sequence: [{ parallel: [] }] }),
        leaf: ({ goal }) => Effect.succeed(goal)
      })

      expect(result.rounds).toHaveLength(1)
      expect(result.remaining).toBe(2)
    }))

  it.effect("refuses deeply nested continuations with typed depth errors and completed-round residue", () =>
    Effect.gen(function*() {
      const first: Trellis.Plan = { agent: { goal: "only" } }
      for (const terminal of [{ agent: { goal: "next" } }, { parallel: [] }]) {
        let next: unknown = terminal
        for (let depth = 0; depth < 20_000; depth++) next = { sequence: [next] }
        const trace: Array<string> = []
        const failure = yield* Trellis.run("ship it", {
          envelope,
          author: () => Effect.succeed(first),
          continue: () => Effect.succeed(next),
          leaf: ({ goal }) => Effect.sync(() => (trace.push(goal), goal))
        }).pipe(Effect.flip)

        expect(failure).toBeInstanceOf(Trellis.TrellisError)
        expect(failure.code).toBe("depth_exceeded")
        expect(failure.path).toBe("root.sequence[0].sequence[0].sequence[0]")
        expect(failure.cause).toMatchObject({
          rounds: [{ plan: first, result: "only" }],
          remaining: 2
        })
        expect(trace).toEqual(["only"])
      }
    }))

  it.effect("accepts empty continuations at the envelope depth", () =>
    Effect.gen(function*() {
      const result = yield* Trellis.run("ship it", {
        envelope,
        author: () => Effect.succeed({ agent: { goal: "only" } }),
        continue: () => Effect.succeed({ sequence: [{ parallel: [{ sequence: [] }] }] }),
        leaf: ({ goal }) => Effect.succeed(goal)
      })

      expect(result.rounds).toHaveLength(1)
      expect(result.remaining).toBe(2)
    }))

  it.effect("retains every refusal from initial and continuation plans", () =>
    Effect.gen(function*() {
      const first: Trellis.Plan = { agent: { goal: "only" } }
      const invalid = { sequence: [{ agent: { goal: "" } }, { agent: { goal: "ok", seat: 1 } }] }
      const refusals = Trellis.validate(invalid, envelope)
      expect(refusals.map(({ path }) => path)).toEqual([
        "root.sequence[0].agent.goal",
        "root.sequence[1].agent.seat"
      ])
      for (const initial of [true, false]) {
        const trace: Array<string> = []
        const failure = yield* Trellis.run("ship it", {
          envelope,
          author: () => Effect.succeed(initial ? invalid : first),
          continue: () => Effect.succeed(invalid),
          leaf: ({ goal }) => Effect.sync(() => (trace.push(goal), goal))
        }).pipe(Effect.flip)

        expect(failure.code).toBe(refusals[0]!.code)
        expect(failure.path).toBe(refusals[0]!.path)
        expect(failure.message).toBe(refusals[0]!.message)
        expect(failure.cause).toEqual({
          rounds: initial ? [] : [{ plan: first, result: "only" }],
          remaining: initial ? 3 : 2,
          refusals
        })
        expect(trace).toEqual(initial ? [] : ["only"])
      }
    }))

  it.effect("retains completed-round residue and the original error when a later leaf fails", () =>
    Effect.gen(function*() {
      const first: Trellis.Plan = { agent: { goal: "first" } }
      const next: Trellis.Plan = { sequence: [{ agent: { goal: "second" } }, { agent: { goal: "fail" } }] }
      const error = { reason: "worker failed" }
      const trace: Array<string> = []
      let continued = 0
      const failure = yield* Trellis.run("ship it", {
        envelope,
        author: () => Effect.succeed(first),
        continue: () => Effect.sync(() => (continued += 1, next)),
        leaf: ({ goal }) =>
          Effect.suspend(() => {
            trace.push(goal)
            return goal === "fail" ? Effect.fail(error) : Effect.succeed(goal)
          })
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(Trellis.TrellisError)
      expect(failure).toMatchObject({
        code: "leaf_failed",
        path: "root.sequence[1]",
        cause: { rounds: [{ plan: first, result: "first" }], remaining: 2, error }
      })
      expect((failure as Trellis.TrellisError).cause).toHaveProperty("error", error)
      expect(trace).toEqual(["first", "second", "fail"])
      expect(continued).toBe(1)
    }))

  it.effect("refuses invalid execute concurrency before a leaf callback runs", () =>
    Effect.gen(function*() {
      const plan: Trellis.Plan = { agent: { goal: "a" } }
      for (const concurrency of [0, -5, 1.5, Number.NaN]) {
        let leaves = 0
        const failure = yield* Effect.flip(
          Trellis.execute(plan, {
            concurrency,
            leaf: () => Effect.sync(() => (leaves += 1, "done"))
          })
        )

        expect(failure.code).toBe("invalid_envelope")
        expect(failure.path).toBe("root")
        expect(failure.message).toBe(`Trellis concurrency must be a positive safe integer, received ${concurrency}`)
        expect(leaves).toBe(0)
      }
    }))

  it.effect("valid execute concurrency holds six parallel leaves to two in flight", () =>
    Effect.gen(function*() {
      const plan: Trellis.Plan = {
        parallel: Array.from({ length: 6 }, (_, index) => ({ agent: { goal: String(index) } })) as [
          Trellis.Plan,
          ...Array<Trellis.Plan>
        ]
      }
      const gate = yield* Latch.make(false)
      const saturated = yield* Latch.make(false)
      let started = 0
      let inFlight = 0
      let peak = 0
      const fiber = yield* Effect.forkChild(
        Trellis.execute(plan, {
          concurrency: 2,
          leaf: () =>
            Effect.gen(function*() {
              started += 1
              inFlight += 1
              peak = Math.max(peak, inFlight)
              if (started === 2) yield* saturated.open
              yield* gate.await
              inFlight -= 1
              return "done"
            })
        }),
        { startImmediately: true }
      )

      yield* saturated.await
      expect(started).toBe(2)
      yield* gate.open
      yield* Fiber.join(fiber)
      expect(peak).toBe(2)
    }))

  it.effect("validates every envelope field before authoring or executing", () =>
    Effect.gen(function*() {
      const invalid = [
        { fuel: 0, depth: 1, fanout: 1 },
        { fuel: 1, depth: 0, fanout: 1 },
        { fuel: 1, depth: 1, fanout: 0 }
      ]
      for (const candidate of invalid) {
        let authors = 0
        let leaves = 0
        const failure = yield* Effect.flip(
          Trellis.run("ship it", {
            envelope: candidate,
            author: () => Effect.sync(() => (authors += 1, { agent: { goal: "a" } })),
            leaf: () => Effect.sync(() => (leaves += 1, "done"))
          })
        )

        expect(failure.code).toBe("invalid_envelope")
        expect(failure.path).toBe("root")
        expect(failure.message).toBe("Trellis envelope fuel, depth, and fanout must be positive safe integers")
        expect(authors).toBe(0)
        expect(leaves).toBe(0)
      }
    }))

  it.effect("validates explicit run concurrency before authoring or executing", () =>
    Effect.gen(function*() {
      for (const concurrency of [0, -5, 1.5, Number.NaN]) {
        let authors = 0
        let leaves = 0
        const failure = yield* Effect.flip(
          Trellis.run("ship it", {
            envelope: { fuel: 1, depth: 1, fanout: 1 },
            concurrency,
            author: () => Effect.sync(() => (authors += 1, { agent: { goal: "a" } })),
            leaf: () => Effect.sync(() => (leaves += 1, "done"))
          })
        )

        expect(failure.code).toBe("invalid_envelope")
        expect(failure.path).toBe("root")
        expect(failure.message).toBe(`Trellis concurrency must be a positive safe integer, received ${concurrency}`)
        expect(authors).toBe(0)
        expect(leaves).toBe(0)
      }
    }))

  it.effect("runs the authored plan with real concurrency and charges one fuel unit per leaf", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const gate = yield* Latch.make()
      const result = yield* Trellis.run("ship it", {
        envelope,
        author: () => Effect.succeed(nested),
        leaf: ({ goal }) =>
          Effect.gen(function*() {
            trace.push(`${goal} start`)
            if (goal === "a") yield* gate.await
            if (goal === "b") yield* gate.open
            trace.push(`${goal} end`)
            return goal.toUpperCase()
          })
      })

      expect(result.rounds).toHaveLength(1)
      expect(result.rounds[0]?.result).toEqual(["A", ["B", "C"]])
      expect(result.remaining).toBe(0)
      // "a" is still in flight when "b" starts: the two parallel members overlap.
      expect(trace.indexOf("b start")).toBeLessThan(trace.indexOf("a end"))
      // The sequence stays ordered inside that parallel member.
      expect(trace.indexOf("b end")).toBeLessThan(trace.indexOf("c start"))
    }))

  it.effect("never exceeds the declared concurrency bound", () =>
    Effect.gen(function*() {
      const plan: Trellis.Plan = {
        parallel: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }]
      }
      const peak = (concurrency: number) =>
        Effect.gen(function*() {
          let inFlight = 0
          let observed = 0
          yield* Trellis.run("ship it", {
            envelope: { fuel: 2, depth: 2, fanout: 2 },
            concurrency,
            author: () => Effect.succeed(plan),
            leaf: () =>
              Effect.gen(function*() {
                inFlight += 1
                observed = Math.max(observed, inFlight)
                yield* Effect.yieldNow
                inFlight -= 1
                return "done"
              })
          })
          return observed
        })

      expect(yield* peak(1)).toBe(1)
      expect(yield* peak(2)).toBe(2)
    }))

  it.effect("returns parallel results in declaration order rather than completion order", () =>
    Effect.gen(function*() {
      const plan: Trellis.Plan = {
        parallel: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }, { agent: { goal: "c" } }]
      }
      const gates = yield* Effect.all([Latch.make(), Latch.make(), Latch.make()])
      const finished = yield* Effect.all([Latch.make(), Latch.make(), Latch.make()])
      const allStarted = yield* Latch.make()
      const completionOrder: Array<string> = []
      let started = 0
      const index = new Map([["a", 0], ["b", 1], ["c", 2]])
      const running = yield* Trellis.execute(plan, {
        concurrency: 3,
        leaf: ({ goal }) =>
          Effect.gen(function*() {
            const position = index.get(goal)!
            started += 1
            if (started === 3) yield* Latch.open(allStarted)
            yield* Latch.await(gates[position]!)
            completionOrder.push(goal)
            yield* Latch.open(finished[position]!)
            return goal.toUpperCase()
          })
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Latch.await(allStarted)
      for (const position of [2, 1, 0]) {
        yield* Latch.open(gates[position]!)
        yield* Latch.await(finished[position]!)
      }
      const result = yield* Fiber.join(running)

      expect(completionOrder).toEqual(["c", "b", "a"])
      expect(result).toEqual(["A", "B", "C"])
    }))

  it.effect("fails fuel_exhausted before running the third leaf", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const first: Trellis.Plan = {
        sequence: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }]
      }
      const second: Trellis.Plan = { agent: { goal: "c" } }
      const failure = yield* Trellis.run("ship it", {
        envelope: { fuel: 2, depth: 2, fanout: 2 },
        author: () => Effect.succeed(first),
        continue: () => Effect.succeed(second),
        leaf: ({ goal }) =>
          Effect.sync(() => {
            trace.push(goal)
            return goal
          })
      }).pipe(Effect.flip)

      expect(failure.code).toBe("fuel_exhausted")
      expect(failure.path).toBe("root")
      expect(failure.message).toBe("Round 2 needs 1 leaf calls but only 0 fuel remains")
      expect((failure as Trellis.TrellisError & { readonly cause?: unknown }).cause).toEqual({
        rounds: [{ plan: first, result: ["a", "b"] }],
        remaining: 0
      })
      expect(trace).toEqual(["a", "b"])
    }))

  it.effect("re-authors a second round and stops when continue returns nothing", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const plans: ReadonlyArray<Trellis.Plan> = [
        { agent: { goal: "first" } },
        { agent: { goal: "second" } }
      ]
      const result = yield* Trellis.run("ship it", {
        envelope: { fuel: 3, depth: 1, fanout: 1 },
        author: () => Effect.succeed(plans[0]),
        continue: ({ round }) => Effect.succeed(round === 1 ? plans[1] : undefined),
        leaf: ({ goal }) =>
          Effect.sync(() => {
            trace.push(goal)
            return goal
          })
      })

      expect(trace).toEqual(["first", "second"])
      expect(result.rounds.map((round) => round.plan)).toEqual(plans)
      expect(result.remaining).toBe(1)
    }))

  it.effect("refuses a plan the model authored outside the envelope", () =>
    Effect.gen(function*() {
      const failure = yield* Trellis.run("ship it", {
        envelope: { fuel: 2, depth: 1, fanout: 2 },
        author: () => Effect.succeed({ sequence: [{ agent: { goal: "a" } }] }),
        leaf: ({ goal }) => Effect.succeed(goal)
      }).pipe(Effect.flip)

      expect(failure.code).toBe("depth_exceeded")
      expect(failure.path).toBe("root.sequence[0]")
      expect(failure.message).toBe("Plan depth 2 exceeds the envelope depth 1")
    }))

  it("declares one leaf call per fuel unit, each shaped like the leaf run hands over", () => {
    const trellis = Trellis.make({ author, leaf, envelope })

    expect(Flow.isFlow(trellis)).toBe(true)
    const graph = Graph.build(trellis, { input: "ship it" })
    expect(leafCalls(graph)).toHaveLength(envelope.fuel)
    // The builder enters the declaration as a call of its own, so core's
    // `fuel + 1` FlowCall count is the fuel slots plus the one author call.
    expect(callsTo(graph, "author")).toHaveLength(1)
    // The declared payload is a Leaf, which is what `run` and `execute` hand a
    // leaf flow. A declaration cannot know the goals, so the plan stands in for
    // them and the path names the slot.
    expect(leafCalls(graph).map((node) => Object.keys(payload(node) as object).sort())).toEqual(
      Array.from({ length: envelope.fuel }, () => ["goal", "path"])
    )
    expect(leafCalls(graph).map((node) => (payload(node) as { readonly path: string }).path)).toEqual([
      "slot-0",
      "slot-1",
      "slot-2"
    ])
    expect(() => Trellis.make({ author, leaf, envelope: { fuel: 0, depth: 1, fanout: 1 } })).toThrow(
      expect.objectContaining({
        code: "invalid_envelope",
        path: "root",
        message: "Trellis envelope fuel, depth, and fanout must be positive safe integers"
      })
    )
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const trellis = Trellis.make({ author, leaf, envelope, name: "plan-it", description: "Author and run a plan." })

    expect(trellis._tag).toBe("plan-it")
    expect(trellis.description).toBe("Author and run a plan.")
    expect(Trellis.make({ author, leaf, envelope }).description).toBeUndefined()
  })

  it("compiles a plan into the calls the plan names", () => {
    const compiled = Flow.make("compiled-nested", {
      payload: MemberPayload,
      success: Schema.Unknown,
      error: Schema.Unknown,
      body: () => Trellis.compile(nested, { leaf })
    })
    const graph = Graph.build(compiled, { input: "ship it" })

    expect(leafCalls(graph)).toHaveLength(3)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(1)
    expect(Trellis.leaves(nested)).toEqual([
      { goal: "a", path: "root.parallel[0]" },
      { goal: "b", path: "root.parallel[1].sequence[0]" },
      { goal: "c", path: "root.parallel[1].sequence[1]" }
    ])
  })

  it("preserves an explicitly selected seat in compiled and executed leaves", () => {
    const seated: Trellis.Plan = { agent: { goal: "review", seat: "critic" } }
    const compiled = Flow.make("compiled-seated", {
      payload: MemberPayload,
      success: Schema.Unknown,
      error: Schema.Unknown,
      body: () => Trellis.compile(seated, { leaf })
    })
    const graph = Graph.build(compiled, { input: "ship it" })

    expect(payload(leafCalls(graph)[0]!)).toEqual({ goal: "review", seat: "critic", path: "root" })
    expect(Trellis.leaves(seated)).toEqual([{ goal: "review", seat: "critic", path: "root" }])
  })

  it.effect("hands an explicitly selected seat to execute", () =>
    Effect.gen(function*() {
      const seen: Array<Trellis.Leaf> = []
      yield* Trellis.execute({ agent: { goal: "review", seat: "critic" } }, {
        concurrency: 1,
        leaf: (input) => Effect.sync(() => (seen.push(input), input.goal))
      })

      expect(seen).toEqual([{ goal: "review", seat: "critic", path: "root" }])
    }))
})
