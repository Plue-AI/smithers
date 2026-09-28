/**
 * `Loop` on `@smthrs/flow`'s `Graph.build` and `Interpreter` over the real
 * in-memory engine.
 *
 * The declaration cases assert how many body and predicate calls one declared
 * loop carries, what each one is handed, and which bounds are refused. The
 * loop's stop is a `Node.branch` whose predicate runs on the value the body
 * really produced, so the last two cases assert that the TRUE arm is taken
 * when the real value says so and the FALSE arm when it says otherwise.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Graph, Interpreter } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Glob from "@smthrs/std/Glob"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Loop from "../src/Loop.ts"
import { PatternError } from "../src/PatternError.ts"
import { callsTo, payloadOf } from "./Graphs.ts"

/**
 * The `@smthrs/std` signature, read through `@smthrs/core`'s own sugar.
 *
 * `Glob.flow` is a real, unmodified `@smthrs/core` body-less signature
 * (`agent/std/src/Glob.ts:143`): a name, a struct input, a struct output,
 * `capabilities`, and a sealed hermetic `effects` envelope. Nothing about it
 * changes here; it is read. The signature carries the `Action.Declared` a
 * host implements and the `Flow` whose body is one call to it, which is what
 * this file composes a loop out of. The sugar's own lowering rules are pinned
 * in `flows/core/test/Flow.test.ts`.
 */
const glob = {
  action: Glob.flow.action!,
  flow: Glob.flow.flow,
  payload: Glob.flow.flow.payloadSchema
}

/** The calls the scripted glob implementation received, in order. */
const globbed: Array<string> = []

/** What the scripted glob answers for a pattern, set per case. */
let answers: (pattern: string) => ReadonlyArray<string> = () => []

const globLayer = glob.action.toLayer((payload) =>
  Effect.sync(() => {
    const pattern = (payload as { readonly pattern: string }).pattern
    globbed.push(pattern)
    const paths = answers(pattern)
    return { paths, total: paths.length, truncated: false }
  })
)

/**
 * The loop member: one flow per iteration that calls `glob` and reports
 * whether the round found anything.
 *
 * The `done` field is computed by `Node.map` on the REAL glob result, which is
 * what makes the loop's own predicate a run-time decision rather than a
 * plan-time one.
 */
const body = Flow.make("loop/body", {
  payload: {
    input: Schema.Unknown,
    previous: Schema.Unknown,
    iteration: Schema.Number
  },
  success: Schema.Struct({
    done: Schema.Boolean,
    paths: Schema.Array(Schema.String),
    iteration: Schema.Number
  }),
  error: Schema.String,
  capabilities: ["loop/body"],
  body: ({ iteration }) =>
    Node.map(
      glob.action.call({ pattern: `round-${iteration}/*.ts` }),
      (found) => ({ done: found.paths.length > 0, paths: [...found.paths], iteration })
    )
})

/** The separate predicate member, for the `until` form of the loop. */
const until = Flow.make("loop/until", {
  payload: { value: Schema.Unknown, iteration: Schema.Number },
  success: Schema.Boolean,
  capabilities: ["loop/until"],
  body: ({ value }) => Node.map(Node.succeed(value), (settled) => Loop.done(settled))
})

/**
 * The shallowest members a loop can have, for the bound cases alone.
 *
 * `Compose.sequencedBoundRefusal` bounds the chain the pattern itself nests. A
 * member's own body nests under the deepest call in that chain and spends the
 * same budget, so the bound the pattern publishes is only reachable with
 * members that add nothing. `body` above calls `glob`, which does add.
 */
const shallowBody = Flow.make("loop/shallow-body", {
  payload: { input: Schema.Unknown, previous: Schema.Unknown, iteration: Schema.Number },
  success: Schema.Struct({ done: Schema.Boolean, iteration: Schema.Number }),
  error: Schema.String,
  body: ({ iteration }) => Node.succeed({ done: false, iteration })
})

const shallowUntil = Flow.make("loop/shallow-until", {
  payload: { value: Schema.Unknown, iteration: Schema.Number },
  success: Schema.Boolean,
  error: Schema.String,
  body: ({ value }) => Node.map(Node.succeed(value), (settled) => Loop.done(settled))
})

const services = (loop: Loop.LoopFlow<any>) =>
  Layer.mergeAll(globLayer, Interpreter.layer(loop)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

/** Runs one declared loop to settlement against the scripted glob. */
const execute = (
  loop: Loop.LoopFlow<any>,
  input: unknown,
  executionId: string,
  script: (pattern: string) => ReadonlyArray<string>
): Promise<unknown> => {
  globbed.length = 0
  answers = script
  return Effect.runPromise(
    loop.execute({ input }, { executionId }).pipe(Effect.provide(services(loop)), Effect.scoped) as Effect.Effect<
      unknown,
      unknown,
      never
    >
  )
}

describe("Loop", () => {
  it("declares exactly maxIterations bounded body and predicate calls", () => {
    const loop = Loop.make({ body, until, maxIterations: 3, onMaxReached: "return-last" })

    expect(Flow.isFlow(loop)).toBe(true)
    const graph = Graph.build(loop, { input: "seed" })
    expect(callsTo(graph, "loop/body")).toHaveLength(3)
    expect(callsTo(graph, "loop/until")).toHaveLength(3)
    expect(callsTo(graph, "loop/body").map((node) => payloadOf(node).iteration)).toEqual([1, 2, 3])
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const loop = Loop.make({
      name: "scan-until-found",
      description: "Glob each round until one finds a file.",
      body,
      maxIterations: 2
    })

    expect(loop._tag).toBe("scan-until-found")
    expect(loop.description).toBe("Glob each round until one finds a file.")
    expect(Loop.make({ body, maxIterations: 2 }).description).toBeUndefined()
  })

  it("declares the glob signature it composes as one action call per iteration", () => {
    const graph = Graph.build(Loop.ralph({ body, maxIterations: 3 }), { input: "seed" })

    // The `@smthrs/std` signature reaches the plan as an ActionCall under the
    // spliced body of each iteration, which is what candidate Y claims a
    // body-less core signature becomes.
    expect(callsTo(graph, "glob")).toHaveLength(3)
    expect(callsTo(graph, "glob").map((node) => payloadOf(node).pattern)).toEqual([
      "round-1/*.ts",
      "round-2/*.ts",
      "round-3/*.ts"
    ])
  })

  it("carries the capability ceiling and the sealed envelope the core signature declared", () => {
    // `Graph.build` reads a declared ceiling only off a FLOW declaration
    // (`flow/src/Graph.ts:1068`), which is why the sugar produces a flow beside
    // the action rather than an action alone.
    const graph = Graph.build(glob.flow, { pattern: "*.ts" })
    const root = Graph.nodes(graph).find((node) => node.kind === "ActionCall")

    expect(root).toBeDefined()
    expect(root!.capabilities).toEqual(Glob.capabilities)
    expect(root!.draft.material.kind).toBe("sealed")
    // The envelope the core signature declared is the same annotation key
    // `@smthrs/flow` reads: both are `@smthrs/plan`'s `Effects.Envelope`.
    expect(glob.action.tier).toBe("sealed")
  })

  it("enters the signature's struct input as the payload the declaration states", () => {
    expect(Object.keys(glob.payload.fields)).toEqual(Object.keys(Glob.Input.fields))
  })

  it("rejects a loop bound below one iteration", () => {
    for (const maxIterations of [0, 1.5]) {
      expect(() => Loop.make({ body, until, maxIterations, onMaxReached: "fail" })).toThrow(
        expect.objectContaining({
          code: "invalid_decorator",
          message: "Loop maxIterations must be a positive safe integer"
        })
      )
    }
  })

  it("builds the deepest bound it accepts and refuses the next one", () => {
    // Both numbers are computed from `@smthrs/flow`'s exported
    // `Graph.maximumGraphDepth` (1000), the limit the builder that executes
    // these declarations actually applies. A ralph iteration nests one level,
    // so 998 is the deepest bound whose plan still fits; the `until` form nests
    // two, so its deepest is 498.
    expect(Graph.nodes(Graph.build(Loop.ralph({ body: shallowBody, maxIterations: 998 }), { input: "seed" })).length)
      .toBeGreaterThan(0)
    expect(() => Loop.ralph({ body, maxIterations: 999 })).toThrow(
      new PatternError({
        code: "invalid_decorator",
        message: "Loop maxIterations must be at most 998 to stay inside the plan depth limit, received 999"
      })
    )
    expect(
      Graph.nodes(
        Graph.build(Loop.make({ body: shallowBody, until: shallowUntil, maxIterations: 498 }), { input: "seed" })
      ).length
    ).toBeGreaterThan(0)
    expect(() => Loop.make({ body, until, maxIterations: 499 })).toThrow(
      new PatternError({
        code: "invalid_decorator",
        message: "Loop maxIterations must be at most 498 to stay inside the plan depth limit, received 499"
      })
    )
  })

  it("puts the deepest bound it accepts at the builder's own ceiling", () => {
    // The refusal is the builder's limit rather than a conservative guess: the
    // plan a 998-iteration ralph loop builds sits at the deepest level
    // `Graph.build` admits, so one enclosing call over it is `graph_too_deep`
    // while the same wrapper over 997 iterations still builds.
    const enclosing = (loop: Loop.LoopFlow<never>) =>
      Flow.make("loop/enclosing", {
        payload: { input: Schema.Unknown },
        success: Schema.Unknown,
        error: Schema.Unknown,
        body: ({ input }) => loop.call({ input })
      })

    expect(() => Graph.build(enclosing(Loop.ralph({ body: shallowBody, maxIterations: 998 })), { input: "seed" }))
      .toThrow(expect.objectContaining({ code: "graph_too_deep" }))
    expect(
      Graph.nodes(Graph.build(enclosing(Loop.ralph({ body: shallowBody, maxIterations: 997 })), { input: "seed" }))
        .length
    ).toBeGreaterThan(0)
  })

  it("declares ralph as a body-only bounded loop", () => {
    const loop = Loop.ralph({ body, maxIterations: 3, onMaxReached: "return-last" })
    const graph = Graph.build(loop, { input: "seed" })

    expect(callsTo(graph, "loop/body")).toHaveLength(3)
    expect(callsTo(graph, "loop/until")).toHaveLength(0)
  })

  it("declares ralph with no policy as a body-only bounded loop", () => {
    const graph = Graph.build(Loop.ralph({ body, maxIterations: 3 }), { input: "goal" })

    expect(callsTo(graph, "loop/body")).toHaveLength(3)
    expect(callsTo(graph, "loop/until")).toHaveLength(0)
  })

  it("declares both arms of every iteration, so a plan carries the topology a run may take", () => {
    const graph = Graph.build(Loop.ralph({ body, maxIterations: 3 }), { input: "seed" })

    // Three branches, one per iteration, each carrying its two continuations.
    expect(Graph.nodes(graph).filter((node) => node.kind === "Branch")).toHaveLength(3)
  })

  it("takes the TRUE arm when the real value says the loop is done", async () => {
    const loop = Loop.ralph({ body, maxIterations: 3 })
    const settled = await execute(
      loop,
      "seed",
      "loop-true-arm",
      (pattern) => pattern === "round-1/*.ts" ? ["a.ts"] : []
    )

    expect(settled).toEqual({
      value: { done: true, paths: ["a.ts"], iteration: 1 },
      iterations: 1,
      exhausted: false
    })
    // The second and third iterations are declared topology the run did not
    // take, so glob was called once.
    expect(globbed).toEqual(["round-1/*.ts"])
  })

  it("takes the FALSE arm when the real value says it is not done", async () => {
    const loop = Loop.ralph({ body, maxIterations: 3 })
    const settled = await execute(
      loop,
      "seed",
      "loop-false-arm",
      (pattern) => pattern === "round-3/*.ts" ? ["c.ts"] : []
    )

    // Iterations 1 and 2 found nothing, so the predicate answered false on the
    // real value and the else arm ran. A build-time evaluation of the same
    // predicate cannot tell these three rounds apart: it never sees a path.
    expect(settled).toEqual({
      value: { done: true, paths: ["c.ts"], iteration: 3 },
      iterations: 3,
      exhausted: false
    })
    expect(globbed).toEqual(["round-1/*.ts", "round-2/*.ts", "round-3/*.ts"])
  })

  it("settles exhausted when the FALSE arm is taken at the bound", async () => {
    const loop = Loop.ralph({ body, maxIterations: 2 })
    const settled = await execute(loop, "seed", "loop-exhausted", () => [])

    expect(settled).toEqual({
      value: { done: false, paths: [], iteration: 2 },
      iterations: 2,
      exhausted: true
    })
    expect(globbed).toEqual(["round-1/*.ts", "round-2/*.ts"])
  })

  it("fails exhausted when the FALSE arm is taken at the bound under onMaxReached fail", async () => {
    const loop = Loop.ralph({ body, maxIterations: 2, onMaxReached: "fail" })
    globbed.length = 0
    answers = () => []
    const failure = await Effect.runPromise(
      loop.execute({ input: "seed" }, { executionId: "loop-exhausted-fail" }).pipe(
        Effect.provide(services(loop)),
        Effect.scoped,
        Effect.flip
      ) as Effect.Effect<unknown, never, never>
    )

    expect(failure).toMatchObject({
      code: "exhausted",
      message: "Loop reached its bound of 2 iterations unsatisfied"
    })
    expect(globbed).toEqual(["round-1/*.ts", "round-2/*.ts"])
  })

  it("runs the separate predicate member and stops on its real answer", async () => {
    const loop = Loop.make({ body, until, maxIterations: 3 })
    const settled = await execute(loop, "seed", "loop-until", (pattern) => pattern === "round-2/*.ts" ? ["b.ts"] : [])

    expect(settled).toEqual({
      value: { done: true, paths: ["b.ts"], iteration: 2 },
      iterations: 2,
      exhausted: false
    })
    expect(globbed).toEqual(["round-1/*.ts", "round-2/*.ts"])
  })

  it("reads every supported completion signal", () => {
    expect(Loop.done(true)).toBe(true)
    expect(Loop.done("done")).toBe(true)
    expect(Loop.done({ done: true })).toBe(true)
    expect(Loop.done(false)).toBe(false)
    expect(Loop.done({ done: false })).toBe(false)
    expect(Loop.done(Object.create({ done: true }))).toBe(false)
    expect(Loop.done(undefined)).toBe(false)
    expect(Loop.done("yes")).toBe(false)
    expect(Loop.done("DONE")).toBe(false)
    expect(Loop.done(1)).toBe(false)
    expect(Loop.done({ done: "true" })).toBe(false)
  })
})

describe("Loop.run", () => {
  it("stops at the first satisfied predicate", async () => {
    const observed: Array<number> = []
    const previously: Array<unknown> = []
    const result = await Effect.runPromise(
      Loop.run("seed", {
        maxIterations: 5,
        onMaxReached: "fail",
        body: ({ input, iteration, previous }) =>
          Effect.sync(() => {
            observed.push(iteration)
            previously.push(previous)
            return `${input}-${iteration}`
          }),
        until: ({ iteration }) => Effect.succeed(iteration === 2)
      })
    )

    expect(result).toEqual({ value: "seed-2", iterations: 2, exhausted: false })
    expect(observed).toEqual([1, 2])
    expect(previously).toEqual([undefined, "seed-1"])
  })

  it("runs the body once even when the predicate is satisfied from the start", async () => {
    let ran = 0
    const result = await Effect.runPromise(
      Loop.run("seed", {
        maxIterations: 5,
        onMaxReached: "fail",
        body: () => Effect.sync(() => ++ran),
        until: () => Effect.succeed(true)
      })
    )

    expect(result).toEqual({ value: 1, iterations: 1, exhausted: false })
    expect(ran).toBe(1)
  })

  it("takes a bound past the declaration ceiling at runtime", async () => {
    const result = await Effect.runPromise(
      Loop.runRalph("goal", {
        maxIterations: 100_000,
        body: ({ iteration }) => Effect.succeed({ done: iteration === 3, iteration })
      })
    )
    expect(result.iterations).toBe(3)
    expect(result.exhausted).toBe(false)
  })

  it("returns the last value when the bound is reached under return-last", async () => {
    const result = await Effect.runPromise(
      Loop.run(0, {
        maxIterations: 3,
        onMaxReached: "return-last",
        body: ({ iteration }) => Effect.succeed(iteration * 10),
        until: () => Effect.succeed(false)
      })
    )

    expect(result).toEqual({ value: 30, iterations: 3, exhausted: true })
  })

  it("fails exhausted when the bound is reached under fail", async () => {
    const failure = await Effect.runPromise(
      Loop.run(0, {
        maxIterations: 2,
        onMaxReached: "fail",
        body: ({ iteration }) => Effect.succeed(iteration),
        until: () => Effect.succeed(false)
      }).pipe(Effect.flip)
    )

    expect(failure).toBeInstanceOf(PatternError)
    expect(failure.code).toBe("exhausted")
    expect(failure.message).toBe("Loop reached its bound of 2 iterations unsatisfied")
  })

  it("validates the bound before running any body", async () => {
    let ran = 0
    const failure = await Effect.runPromise(
      Loop.run(0, {
        maxIterations: 0,
        onMaxReached: "fail",
        body: () => Effect.sync(() => ++ran),
        until: () => Effect.succeed(true)
      }).pipe(Effect.flip)
    )

    expect(failure.code).toBe("invalid_decorator")
    expect(failure.message).toBe("Loop maxIterations must be a positive safe integer")
    expect(ran).toBe(0)
  })

  it("hands the body output to the predicate and the next iteration", async () => {
    const judged: Array<string> = []
    const carried: Array<string | undefined> = []
    const result = await Effect.runPromise(
      Loop.run("seed", {
        maxIterations: 4,
        onMaxReached: "fail",
        body: ({ iteration, previous }) =>
          Effect.sync(() => {
            carried.push(previous)
            return `draft-${iteration}`
          }),
        until: ({ value }: { readonly value: string }) =>
          Effect.sync(() => {
            judged.push(value)
            return value === "draft-3"
          })
      })
    )

    expect(judged).toEqual(["draft-1", "draft-2", "draft-3"])
    expect(carried).toEqual([undefined, "draft-1", "draft-2"])
    expect(result).toEqual({ value: "draft-3", iterations: 3, exhausted: false })
  })

  it("stops ralph when the body reports done", async () => {
    const observed: Array<number> = []
    const result = await Effect.runPromise(
      Loop.runRalph("goal", {
        maxIterations: 3,
        onMaxReached: "return-last",
        body: ({ iteration }) =>
          Effect.sync(() => {
            observed.push(iteration)
            return { done: iteration === 2, iteration }
          })
      })
    )

    expect(result).toEqual({ value: { done: true, iteration: 2 }, iterations: 2, exhausted: false })
    expect(observed).toEqual([1, 2])
  })

  it("returns the last value when ralph reaches its bound with no policy", async () => {
    const result = await Effect.runPromise(
      Loop.runRalph("goal", {
        maxIterations: 3,
        body: ({ iteration }) => Effect.succeed({ done: false, iteration })
      })
    )

    expect(result).toEqual({ value: { done: false, iteration: 3 }, iterations: 3, exhausted: true })
  })
})

/** A body whose value never carries the iteration, so an idle round repeats it exactly. */
const stuckBody = Flow.make("loop/stuck-body", {
  payload: { input: Schema.Unknown, previous: Schema.Unknown, iteration: Schema.Number },
  success: Schema.Struct({ done: Schema.Boolean, paths: Schema.Array(Schema.String) }),
  error: Schema.String,
  capabilities: ["loop/body"],
  body: ({ iteration }) =>
    Node.map(
      glob.action.call({ pattern: `round-${iteration}/*.ts` }),
      (found) => ({ done: false, paths: found.paths.length > 0 ? ["same.ts"] : [] })
    )
})

describe("Loop stall", () => {
  it("stops a declared ralph loop once its output repeats", async () => {
    const loop = Loop.ralph({ body: stuckBody, maxIterations: 6, stall: { rounds: 2 } })
    expect(loop._tag).toBe("loop(maxIterations=6, onMaxReached=return-last, stall=2/stop)")
    const settled = await execute(
      loop,
      "seed",
      "loop-stall-stop",
      (pattern) => pattern === "round-1/*.ts" ? [] : ["x.ts"]
    )

    expect(settled).toEqual({
      value: { done: false, paths: ["same.ts"] },
      iterations: 3,
      exhausted: false,
      stalled: { _tag: "Stalled", signal: "output", rounds: 2, on: "stop" }
    })
    expect(globbed).toEqual(["round-1/*.ts", "round-2/*.ts", "round-3/*.ts"])
  })

  it("fails stalled under escalate, and leaves a moving loop alone", async () => {
    const escalating = Loop.make({
      body: stuckBody,
      until: shallowUntil,
      maxIterations: 4,
      stall: { rounds: 3, on: "escalate" }
    })
    globbed.length = 0
    answers = () => []
    const failure = await Effect.runPromise(
      escalating.execute({ input: "seed" }, { executionId: "loop-stall-escalate" }).pipe(
        Effect.provide(services(escalating)),
        Effect.scoped,
        Effect.flip
      ) as Effect.Effect<unknown, never, never>
    )
    expect(failure).toMatchObject({ code: "stalled" })
    expect(globbed).toHaveLength(3)

    const moving = Loop.ralph({ body, maxIterations: 2, stall: { rounds: 2 } })
    expect(await execute(moving, "seed", "loop-stall-moving", () => [])).toEqual({
      value: { done: false, paths: [], iteration: 2 },
      iterations: 2,
      exhausted: true
    })
  })

  it("refuses a stall bound below two and spends one more plan level per iteration", () => {
    expect(() => Loop.ralph({ body, maxIterations: 2, stall: { rounds: 1 } })).toThrow(PatternError)
    expect(Effect.runSync(Effect.flip(Loop.runRalph("goal", {
      maxIterations: 2,
      stall: { rounds: 0 },
      body: () => Effect.succeed(1)
    })))).toMatchObject({ code: "invalid_decorator" })
    // A stalling ralph iteration nests two levels, so 498 is its deepest bound.
    expect(
      Graph.nodes(
        Graph.build(Loop.ralph({ body: shallowBody, maxIterations: 498, stall: { rounds: 2 } }), { input: "x" })
      )
        .length
    ).toBeGreaterThan(0)
    expect(() => Loop.ralph({ body, maxIterations: 499, stall: { rounds: 2 } })).toThrow(PatternError)
  })

  it("stops, parks or escalates the operational loop on a repeated signal", async () => {
    const tree = (value: number) => ({ tree: String(Math.min(value, 2)) })
    const stop = await Effect.runPromise(Loop.runRalph("goal", {
      maxIterations: 9,
      stall: { rounds: 2, on: "park", signals: tree },
      body: ({ iteration }) => Effect.succeed(iteration)
    }))
    expect(stop).toEqual({
      value: 3,
      iterations: 3,
      exhausted: false,
      stalled: { _tag: "Stalled", signal: "tree", rounds: 2, on: "park" }
    })

    const checks = await Effect.runPromise(Effect.flip(Loop.run("goal", {
      maxIterations: 9,
      stall: { rounds: 3, on: "escalate", signals: () => ({ checks: ["lint"] }) },
      body: ({ iteration }) => Effect.succeed(iteration),
      until: () => Effect.succeed(false)
    })))
    expect(checks).toMatchObject({ code: "stalled", message: "Loop stalled: the same result for 3 rounds in a row" })

    const output = await Effect.runPromise(Loop.runRalph("goal", {
      maxIterations: 9,
      stall: { rounds: 2 },
      body: () => Effect.succeed({ done: false })
    }))
    expect(output.stalled?.signal).toBe("output")
    expect(output.iterations).toBe(2)
  })
})
