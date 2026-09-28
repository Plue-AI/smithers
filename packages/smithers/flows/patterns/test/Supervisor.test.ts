import { describe, it } from "@effect/vitest"
import { Action, Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Planned from "@smthrs/plan/Planned"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as Supervisor from "../src/Supervisor.ts"
import { execute } from "./Execute.ts"
import { payloadOf } from "./Graphs.ts"

// The payload a supervisor hands its members: one struct covers the plan,
// work, review, and finalize phases, because a `@smthrs/flow` flow states the
// payload it takes.
const StepPayload = {
  phase: Schema.optional(Schema.Unknown),
  input: Schema.optional(Schema.Unknown),
  task: Schema.optional(Schema.Unknown),
  round: Schema.optional(Schema.Unknown),
  rounds: Schema.optional(Schema.Unknown),
  plan: Schema.optional(Schema.Unknown),
  review: Schema.optional(Schema.Unknown),
  retriable: Schema.optional(Schema.Unknown),
  results: Schema.optional(Schema.Unknown)
}

const member = (tag: string, answer: (payload: any) => Node.Node<unknown, unknown, any>) =>
  Flow.make(tag, {
    payload: StepPayload,
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: answer
  })

const step = member("step", (payload) => Node.succeed(payload))

const phase = (node: Graph.GraphNode): unknown => payloadOf(node).phase

// The builder enters the declaration as a call of its own, so `root` is the
// supervisor itself rather than a member call.
const calls = (graph: Graph.Graph): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) => node.kind === "FlowCall" && node.id !== "root")

const inPhase = (graph: Graph.Graph, name: string): ReadonlyArray<Graph.GraphNode> =>
  calls(graph).filter((node) => phase(node) === name)

const flowOf = (node: Graph.GraphNode): string => (node.ast as { readonly flow?: string }).flow!

const plan = {
  tasks: [
    { id: "a", workerType: "coder" },
    { id: "b", workerType: "coder" },
    { id: "c", workerType: "tester" }
  ]
}

const goal = { input: { goal: "ship the feature", tasks: plan.tasks } }

// Recording actions, because which ARM of the review decision a run takes is a
// run-time fact: a branch declares both arms, and only an execution says which
// one ran.
const recorded: Array<string> = []
let scriptedReviews: ReadonlyArray<unknown> = []

const workerAction = Action.make("supervisor/worker", {
  payload: Schema.Struct({ round: Schema.Number, task: Schema.String }),
  success: Schema.Unknown,
  error: Schema.Never,
  tier: "irreversible"
})

const reviewAction = Action.make("supervisor/review", {
  payload: Schema.Struct({ round: Schema.Number }),
  success: Schema.Unknown,
  error: Schema.Never,
  tier: "irreversible"
})

const finalizeAction = Action.make("supervisor/finalize", {
  payload: Schema.Struct({ rounds: Schema.Number }),
  success: Schema.Unknown,
  error: Schema.Never,
  tier: "irreversible"
})

const recordingLayers = [
  workerAction.toLayer(({ round, task }) =>
    Effect.sync(() => {
      recorded.push(`work:${round}:${task}`)
      return `${task}-done`
    })
  ),
  reviewAction.toLayer(({ round }) =>
    Effect.sync(() => {
      recorded.push(`review:${round}`)
      return scriptedReviews[round - 1]
    })
  ),
  finalizeAction.toLayer(({ rounds }) =>
    Effect.sync(() => {
      recorded.push(`finalize:${rounds}`)
      return "final"
    })
  )
]

const recordingWorker = member(
  "recording-worker",
  (payload) => workerAction.call({ round: payload.round, task: payload.task.id })
)
const recordingReview = member("recording-review", (payload) => reviewAction.call({ round: payload.round }))
const recordingFinalize = member("recording-finalize", (payload) => finalizeAction.call({ rounds: payload.rounds }))

describe("Supervisor", () => {
  it("declares one worker call per plan task per round and one finalize per decided round", () => {
    const supervisor = Supervisor.make({
      plan: step,
      workers: { coder: step, tester: step },
      review: step,
      finalize: step,
      maxRounds: 3,
      maxTasks: 16,
      concurrency: 2
    })

    expect(Flow.isFlow(supervisor)).toBe(true)
    const graph = Graph.build(supervisor, goal)
    // The review decision is a `Node.branch`: every round declares the
    // finalize its accepted arm would call. An exhausted supervision does not
    // finalize, as in `run`, so the last round's other arm declares none.
    expect(calls(graph)).toHaveLength(16)
    expect(inPhase(graph, "plan")).toHaveLength(1)
    expect(inPhase(graph, "work")).toHaveLength(9)
    expect(inPhase(graph, "review")).toHaveLength(3)
    expect(inPhase(graph, "finalize")).toHaveLength(3)
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it("routes each declared worker call to the task's workerType", () => {
    const coder = member("coder", (payload) => Node.succeed(payload))
    const tester = member("tester", () => Node.succeed("tested"))
    const workers = { coder, tester }
    const tasks = [
      { id: "a", workerType: "coder" },
      { id: "b", workerType: "tester" },
      { id: "c", workerType: "tester" },
      { id: "d", workerType: "coder" }
    ] as const
    const graph = Graph.build(
      Supervisor.make({
        plan: step,
        workers,
        review: step,
        finalize: step,
        maxRounds: 1,
        maxTasks: 16,
        concurrency: 3
      }),
      { input: { ...goal.input, tasks } }
    )
    const routed = inPhase(graph, "work").map((node) => payloadOf(node).task)

    expect(routed).toEqual(tasks)
    // Core compared the callee's echoed body against a graph built from calling
    // the worker directly, because it had no tag to read. `@smthrs/flow` names
    // a call by the callee's tag, and each worker is tagged with its own
    // workerType, so the routing is read straight off the node.
    for (const [index, node] of inPhase(graph, "work").entries()) {
      expect(flowOf(node)).toBe(tasks[index]!.workerType)
    }
  })

  it.each([1, 2, 3])("declares every prototype-shaped task id at concurrency %i", (concurrency) => {
    const tasks = ["__proto__", "constructor", "toString"].map((id) => ({ id, workerType: "coder" }))
    const graph = Graph.build(
      Supervisor.make({
        plan: step,
        workers: { coder: step },
        review: step,
        finalize: step,
        maxRounds: 1,
        maxTasks: 16,
        concurrency
      }),
      { input: { tasks } }
    )

    expect(inPhase(graph, "work").map((node) => payloadOf(node).task)).toEqual(tasks)
    // One plan call, one review call, and the finalize the single round's
    // accepted arm makes.
    expect(calls(graph)).toHaveLength(tasks.length + 3)
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it.each([1, 2, 3])("executes each task with its selected worker at concurrency %i", async (concurrency) => {
    const tasks = [
      { id: "__proto__", workerType: "tester" },
      { id: "constructor", workerType: "coder" },
      { id: "toString", workerType: "tester" }
    ]
    const coder = member("coder", () => Node.succeed("coded"))
    const tester = member("tester", () => Node.succeed("tested"))
    const finalize = member("finalize", (payload) => Node.succeed(payload.results))
    const accept = member("accept", () => Node.succeed(true))
    const supervisor = Supervisor.make({
      plan: step,
      workers: { coder, tester },
      review: accept,
      finalize,
      maxRounds: 1,
      maxTasks: 16,
      concurrency
    })
    const result = await execute(supervisor, { input: { tasks } }, `supervisor-routing-${concurrency}`)

    // The results the finalize call receives are `run`'s: one `Done` outcome
    // per task, in plan order.
    expect(result).toEqual({
      exhausted: false,
      rounds: 1,
      final: tasks.map((task) => ({
        _tag: "Done",
        id: task.id,
        workerType: task.workerType,
        round: 1,
        output: task.workerType === "coder" ? "coded" : "tested"
      }))
    })
  })

  it("threads the previous round's review into the next round's worker calls", () => {
    const graph = Graph.build(
      Supervisor.make({
        plan: step,
        workers: { coder: step, tester: step },
        review: step,
        finalize: step,
        maxRounds: 2,
        maxTasks: 16,
        concurrency: 3
      }),
      goal
    )
    const firstReview = inPhase(graph, "review").find((node) => payloadOf(node).round === 1)
    const second = inPhase(graph, "work").filter((node) => payloadOf(node).round === 2)

    expect(firstReview).toBeDefined()
    expect(second).toHaveLength(3)
    // Core recorded the dependency as `keyMaterial.inputs` entries tagged `Ref`
    // with a path. `@smthrs/flow` keeps the planned reference itself on the call
    // payload, so the same two references are read off the payload: the whole
    // review, and its `retriable` field.
    for (const node of second) {
      const payload = payloadOf(node)
      expect(Planned.reference(payload.review)).toEqual({ node: firstReview!.id, path: [] })
      expect(Planned.reference(payload.retriable)).toEqual({ node: firstReview!.id, path: ["retriable"] })
    }
    for (const node of inPhase(graph, "work").filter((node) => payloadOf(node).round === 1)) {
      expect(Object.keys(payloadOf(node))).not.toContain("review")
      expect(Object.keys(payloadOf(node))).not.toContain("retriable")
    }
  })

  it("batches declared worker calls at the concurrency bound", () => {
    const workers = { coder: step, tester: step }
    const wide = Graph.build(
      Supervisor.make({
        plan: step,
        workers,
        review: step,
        finalize: step,
        maxRounds: 1,
        maxTasks: 16,
        concurrency: 3
      }),
      goal
    )
    const narrow = Graph.build(
      Supervisor.make({
        plan: step,
        workers,
        review: step,
        finalize: step,
        maxRounds: 1,
        maxTasks: 16,
        concurrency: 1
      }),
      goal
    )

    expect(Graph.nodes(wide).filter((node) => node.kind === "All")).toHaveLength(1)
    expect(Graph.nodes(narrow).filter((node) => node.kind === "All")).toHaveLength(3)
    expect(calls(wide)).toHaveLength(calls(narrow).length)
  })

  // The review decision reads the REAL review value, so the declaration carries
  // both arms and an execution takes one. These two cases pin which one, by the
  // members the run called and the arguments it called them with.
  it("takes the accepted arm: an allDone review finalizes without another round", async () => {
    recorded.length = 0
    scriptedReviews = [{ allDone: true, retriable: [] }]
    const supervisor = Supervisor.make({
      plan: step,
      workers: { coder: recordingWorker },
      review: recordingReview,
      finalize: recordingFinalize,
      maxRounds: 2,
      maxTasks: 16,
      concurrency: 1
    })

    const result = await execute(
      supervisor,
      { input: { tasks: [{ id: "a", workerType: "coder" }] } },
      "supervisor-true-arm",
      ...recordingLayers
    )

    expect(recorded).toEqual(["work:1:a", "review:1", "finalize:1"])
    expect(result).toEqual({ exhausted: false, rounds: 1, final: "final" })
  })

  it("takes the unfinished arm: a review that is not done delegates another round", async () => {
    recorded.length = 0
    scriptedReviews = [{ allDone: false, retriable: ["a"] }, { allDone: true, retriable: [] }]
    const supervisor = Supervisor.make({
      plan: step,
      workers: { coder: recordingWorker },
      review: recordingReview,
      finalize: recordingFinalize,
      maxRounds: 2,
      maxTasks: 16,
      concurrency: 1
    })

    const result = await execute(
      supervisor,
      { input: { tasks: [{ id: "a", workerType: "coder" }] } },
      "supervisor-false-arm",
      ...recordingLayers
    )

    expect(recorded).toEqual(["work:1:a", "review:1", "work:2:a", "review:2", "finalize:2"])
    expect(result).toEqual({ exhausted: false, rounds: 2, final: "final" })
  })

  it("refuses to declare a plan it cannot route", () => {
    const supervisor = Supervisor.make({
      plan: step,
      workers: { coder: step },
      review: step,
      finalize: step,
      maxRounds: 1,
      maxTasks: 16,
      concurrency: 1
    })

    expect(() => Graph.build(supervisor, { input: "ship the feature" })).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message: "Supervisor input must contain a tasks array"
      })
    )
    expect(() => Graph.build(supervisor, { input: { tasks: [] } })).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message: "Supervisor input must contain at least one task"
      })
    )
    expect(() => Graph.build(supervisor, { input: { tasks: [{ id: "a" }] } })).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message: "Supervisor tasks must each carry a string id and a string workerType"
      })
    )
    expect(() =>
      Graph.build(supervisor, {
        input: { tasks: [{ id: "a", workerType: "coder" }, { id: "a", workerType: "coder" }] }
      })
    )
      .toThrow(expect.objectContaining({
        code: "invalid_input",
        message: "Supervisor task ids must be unique"
      }))
    expect(() => Graph.build(supervisor, { input: { tasks: [{ id: "a", workerType: "painter" }] } })).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message: "Supervisor has no worker named \"painter\""
      })
    )
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const options = {
      plan: step,
      workers: { coder: step },
      review: step,
      finalize: step,
      maxRounds: 1,
      maxTasks: 16,
      concurrency: 1
    }
    const supervisor = Supervisor.make({ ...options, name: "ship-it", description: "Plan, delegate, review." })

    expect(supervisor._tag).toBe("ship-it")
    expect(supervisor.description).toBe("Plan, delegate, review.")
    expect(Supervisor.make(options).description).toBeUndefined()
  })

  it("rejects invalid bounds", () => {
    expect(() =>
      Supervisor.make({
        plan: step,
        workers: { coder: step },
        review: step,
        finalize: step,
        maxRounds: 0,
        maxTasks: 16,
        concurrency: 1
      })
    ).toThrow(expect.objectContaining({
      code: "invalid_decorator",
      message: "Supervisor maxRounds must be a positive safe integer"
    }))
    expect(() =>
      Supervisor.make({
        plan: step,
        workers: { coder: step },
        review: step,
        finalize: step,
        maxRounds: 1,
        maxTasks: 16,
        concurrency: 0
      })
    ).toThrow(expect.objectContaining({
      code: "invalid_decorator",
      message: "Supervisor concurrency must be a positive safe integer"
    }))
    expect(() =>
      Supervisor.make({
        plan: step,
        workers: {},
        review: step,
        finalize: step,
        maxRounds: 1,
        maxTasks: 16,
        concurrency: 1
      })
    ).toThrow(expect.objectContaining({
      code: "invalid_decorator",
      message: "Supervisor requires at least one worker"
    }))
  })

  it.effect("re-delegates only the retriable tasks and finalizes every output", () =>
    Effect.gen(function*() {
      const attempts: Array<string> = []
      const reviews = [{ allDone: false, retriable: ["b"] }, { allDone: true, retriable: [] }]
      let bFailures = 0

      const result = yield* Supervisor.run("goal", {
        maxRounds: 3,
        maxTasks: 16,
        concurrency: 2,
        plan: () => Effect.succeed(plan),
        worker: ({ round, task }) =>
          Effect.suspend(() => {
            attempts.push(`${round}:${task.id}`)
            if (task.id === "b" && bFailures === 0) {
              bFailures += 1
              return Effect.fail("b exploded")
            }
            return Effect.succeed(`${task.id}-done`)
          }),
        review: ({ round }) => Effect.succeed(reviews[round - 1]!),
        finalize: ({ results }) =>
          Effect.succeed(results.map((outcome) => outcome._tag === "Done" ? outcome.output : `${outcome.id}-failed`))
      })

      expect(attempts).toEqual(["1:a", "1:b", "1:c", "2:b"])
      expect(result.exhausted).toBe(false)
      expect(result).toMatchObject({ rounds: 2, final: ["a-done", "b-done", "c-done"] })
    }))

  it.effect("reports the last review as exhausted when the round bound is reached", () =>
    Effect.gen(function*() {
      let finalized = 0
      const review = { allDone: false, retriable: ["a", "b", "c"] }

      const result = yield* Supervisor.run("goal", {
        maxRounds: 2,
        maxTasks: 16,
        concurrency: 3,
        plan: () => Effect.succeed(plan),
        worker: ({ task }) => Effect.succeed(`${task.id}-done`),
        review: () => Effect.succeed(review),
        finalize: () =>
          Effect.sync(() => {
            finalized += 1
            return "never"
          })
      })

      expect(result).toEqual({ exhausted: true, rounds: 2, review })
      expect(finalized).toBe(0)
    }))

  it.effect("stops when an unfinished review names nothing to re-delegate", () =>
    Effect.gen(function*() {
      const review = { allDone: false, retriable: [] }
      const rounds: Array<number> = []

      const result = yield* Supervisor.run("goal", {
        maxRounds: 5,
        maxTasks: 16,
        concurrency: 3,
        plan: () => Effect.succeed(plan),
        worker: ({ round, task }) =>
          Effect.suspend(() => {
            rounds.push(round)
            return Effect.succeed(`${task.id}-done`)
          }),
        review: () => Effect.succeed(review),
        finalize: () => Effect.succeed("never")
      })

      expect(result).toEqual({ exhausted: true, rounds: 1, review })
      expect(rounds).toEqual([1, 1, 1])
    }))

  it.effect("never runs more workers at once than the concurrency bound", () =>
    Effect.gen(function*() {
      // The test holds every started worker on `held`, so the round cannot make
      // progress on its own: what runs concurrently is what the bound admits,
      // not what the scheduler happened to interleave.
      const held = yield* Latch.make()
      const saturated = yield* Latch.make()
      const entered: Array<string> = []
      let inFlight = 0
      let peak = 0

      const running = yield* Supervisor.run("goal", {
        maxRounds: 1,
        maxTasks: 16,
        concurrency: 2,
        plan: () =>
          Effect.succeed({
            tasks: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, workerType: "coder" }))
          }),
        worker: ({ task }) =>
          Effect.gen(function*() {
            inFlight += 1
            peak = Math.max(peak, inFlight)
            entered.push(task.id)
            if (entered.length === 2) yield* Latch.open(saturated)
            yield* Latch.await(held)
            inFlight -= 1
            return "ok"
          }),
        review: () => Effect.succeed({ allDone: true, retriable: [] }),
        finalize: () => Effect.succeed("done")
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Latch.await(saturated)

      // Both slots are taken and neither can finish, so no third worker started.
      expect(entered).toEqual(["a", "b"])
      expect(inFlight).toBe(2)

      yield* Latch.open(held)
      const result = yield* Fiber.join(running)

      expect(result).toEqual({ exhausted: false, rounds: 1, final: "done" })
      expect(entered).toEqual(["a", "b", "c", "d", "e", "f"])
      expect(peak).toBe(2)
    }))

  it.effect("propagates a worker defect instead of capturing it as a Failed outcome", () =>
    Effect.gen(function*() {
      const defect = new Error("the worker threw")
      const exit = yield* Effect.exit(
        Supervisor.run("goal", {
          maxRounds: 1,
          maxTasks: 16,
          concurrency: 2,
          plan: () => Effect.succeed({ tasks: [{ id: "a", workerType: "coder" }, { id: "b", workerType: "coder" }] }),
          worker: ({ task }) => task.id === "b" ? Effect.die(defect) : Effect.succeed(`${task.id}-done`),
          review: () => Effect.succeed({ allDone: true }),
          finalize: ({ results }) => Effect.succeed(results)
        })
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        // Only a typed failure is an outcome the review can read. A defect is a
        // broken worker, so it fails the supervision as it would any other join.
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(Result.getOrThrow(Cause.findDefect(exit.cause))).toBe(defect)
      }
    }))

  it.effect("rejects a plan whose task ids repeat instead of reviewing one outcome twice", () =>
    Effect.gen(function*() {
      let ran = 0

      const failure = yield* Supervisor.run("goal", {
        maxRounds: 2,
        maxTasks: 16,
        concurrency: 2,
        plan: () => Effect.succeed({ tasks: [{ id: "a", workerType: "coder" }, { id: "a", workerType: "coder" }] }),
        worker: () =>
          Effect.sync(() => {
            ran += 1
            return "ok"
          }),
        review: () => Effect.succeed({ allDone: true }),
        finalize: () => Effect.succeed("done")
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
      expect((failure as PatternError).code).toBe("invalid_input")
      expect((failure as PatternError).message).toBe("Supervisor task ids must be unique")
      expect(ran).toBe(0)
    }))

  it.effect("rejects an empty runtime plan through the typed channel", () =>
    Effect.gen(function*() {
      let callbacks = 0
      const failure = yield* Supervisor.run("goal", {
        maxRounds: 2,
        maxTasks: 16,
        concurrency: 1,
        plan: () => Effect.succeed({ tasks: [] }),
        worker: () => Effect.sync(() => (callbacks += 1, "ok")),
        review: () => Effect.sync(() => (callbacks += 1, { allDone: true })),
        finalize: () => Effect.sync(() => (callbacks += 1, "done"))
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
      expect((failure as PatternError).code).toBe("invalid_input")
      expect((failure as PatternError).message).toBe("Supervisor input must contain at least one task")
      expect(callbacks).toBe(0)
    }))

  it.effect("rejects malformed runtime plans through the typed channel", () =>
    Effect.gen(function*() {
      const malformedPlans: ReadonlyArray<unknown> = [{ tasks: "nope" }, {}]
      for (const malformed of malformedPlans) {
        let callbacks = 0
        const failure = yield* Supervisor.run("goal", {
          maxRounds: 2,
          maxTasks: 16,
          concurrency: 1,
          plan: () => Effect.succeed(malformed as Supervisor.Plan),
          worker: () => Effect.sync(() => (callbacks += 1, "ok")),
          review: () => Effect.sync(() => (callbacks += 1, { allDone: true })),
          finalize: () => Effect.sync(() => (callbacks += 1, "done"))
        }).pipe(Effect.flip)

        expect(failure).toBeInstanceOf(PatternError)
        expect((failure as PatternError).code).toBe("invalid_input")
        expect((failure as PatternError).message).toBe("Supervisor input must contain a tasks array")
        expect(callbacks).toBe(0)
      }
    }))

  it.effect("rejects invalid runtime bounds", () =>
    Effect.gen(function*() {
      const failure = yield* Supervisor.run("goal", {
        maxRounds: 0,
        maxTasks: 16,
        concurrency: 1,
        plan: () => Effect.succeed(plan),
        worker: () => Effect.succeed("ok"),
        review: () => Effect.succeed({ allDone: true }),
        finalize: () => Effect.succeed("done")
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
      expect(failure.code).toBe("invalid_decorator")
      expect(failure.message).toBe("Supervisor maxRounds, maxTasks and concurrency must be positive safe integers")
    }))

  it.effect("ignores malformed retriable values without re-delegating", () =>
    Effect.gen(function*() {
      const reviews: ReadonlyArray<unknown> = [null, { retriable: "a" }, { retriable: [1, false] }]

      for (const review of reviews) {
        let workers = 0
        const result = yield* Supervisor.run("goal", {
          maxRounds: 2,
          maxTasks: 16,
          concurrency: 1,
          plan: () => Effect.succeed({ tasks: [{ id: "a", workerType: "coder" }] }),
          worker: () =>
            Effect.sync(() => {
              workers += 1
              return "done"
            }),
          review: () => Effect.succeed(review),
          finalize: () => Effect.succeed("unused")
        })

        expect(result).toEqual({ exhausted: true, rounds: 1, review })
        expect(workers).toBe(1)
      }
    }))

  it("gives two concurrency bounds different step identity at the same topology", () => {
    const material = (concurrency: number) =>
      Graph.nodes(Graph.build(
        Supervisor.make({
          plan: step,
          workers: { coder: step },
          review: step,
          finalize: step,
          maxRounds: 1,
          maxTasks: 16,
          concurrency
        }),
        { input: { goal: "ship the feature", tasks: [{ id: "a", workerType: "coder" }] } }
      ))

    const one = material(1)
    const two = material(2)

    expect(one.map((node) => node.kind)).toEqual(two.map((node) => node.kind))
    expect(one.map((node) => node.draft.material.body)).not.toEqual(two.map((node) => node.draft.material.body))
  })

  it("declares from the snapshot make took of its options", () => {
    const other = member("other", () => Node.succeed("other"))
    const workers: Record<string, typeof step> = { coder: step, tester: step }
    const options = { plan: step, workers, review: step, finalize: step, maxRounds: 2, maxTasks: 16, concurrency: 2 }
    const supervisor = Supervisor.make(options)
    const before = Graph.nodes(Graph.build(supervisor, goal)).map((node) => node.draft.material.body)

    // Every edit a caller can make after the call: a swapped worker, a removed
    // worker the plan still routes to, swapped boss flows, and tighter bounds.
    workers.coder = other
    delete workers.tester
    options.plan = other
    options.review = other
    options.finalize = other
    options.maxRounds = 1
    options.concurrency = 1

    const after = Graph.nodes(Graph.build(supervisor, goal))
    expect(after.map((node) => node.draft.material.body)).toEqual(before)
    expect(inPhase(Graph.build(supervisor, goal), "work")).toHaveLength(6)
  })

  it.effect("runs the snapshot run took of its callbacks", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const options = {
        maxRounds: 1,
        maxTasks: 16,
        concurrency: 1,
        plan: () => Effect.succeed({ tasks: [{ id: "a", workerType: "coder" }] }),
        worker: ({ task }: { readonly task: Supervisor.Task }) =>
          Effect.sync(() => (trace.push(`work ${task.id}`), "done")),
        review: () => Effect.succeed({ allDone: true, retriable: [] }),
        finalize: () => Effect.succeed("final")
      }
      const supervision = Supervisor.run("goal", options)

      // A swapped worker, a swapped finalizer, and a widened round bound,
      // between the call and the execution.
      options.worker = () => Effect.sync(() => (trace.push("swapped"), "swapped"))
      options.finalize = () => Effect.succeed("swapped")
      options.maxRounds = 5

      const result = yield* supervision
      expect(trace).toEqual(["work a"])
      expect(result).toEqual({ exhausted: false, rounds: 1, final: "final" })
    }))
})

describe("Supervisor stall", () => {
  it("settles exhausted with the verdict once declared rounds leave every outcome unchanged", async () => {
    recorded.length = 0
    const review = { allDone: false, retriable: ["a"] }
    scriptedReviews = [review, review, review, review]
    const supervisor = Supervisor.make({
      plan: step,
      workers: { coder: recordingWorker },
      review: recordingReview,
      finalize: recordingFinalize,
      maxRounds: 4,
      maxTasks: 16,
      concurrency: 1,
      stall: { rounds: 2 }
    })
    expect(supervisor._tag).toBe("supervisor(workers=coder, maxRounds=4, concurrency=1, stall=2/stop)")

    const result = await execute(
      supervisor,
      { input: { tasks: [{ id: "a", workerType: "coder" }] } },
      "supervisor-stall",
      ...recordingLayers
    )

    expect(recorded).toEqual(["work:1:a", "review:1", "work:2:a", "review:2"])
    expect(result).toEqual({
      exhausted: true,
      rounds: 2,
      review,
      stalled: { _tag: "Stalled", signal: "output", rounds: 2, on: "stop" }
    })
  })

  it("fails a declared escalate and refuses a stall bound below two", async () => {
    const review = { allDone: false, retriable: ["a"] }
    scriptedReviews = [review, review, review]
    const options = {
      plan: step,
      workers: { coder: recordingWorker },
      review: recordingReview,
      finalize: recordingFinalize,
      maxRounds: 3,
      maxTasks: 16,
      concurrency: 1
    }
    await expect(execute(
      Supervisor.make({ ...options, stall: { rounds: 2, on: "escalate" } }),
      { input: { tasks: [{ id: "a", workerType: "coder" }] } },
      "supervisor-stall-escalate",
      ...recordingLayers
    )).rejects.toMatchObject({ code: "stalled" })
    expect(() => Supervisor.make({ ...options, stall: { rounds: 1 } })).toThrow(PatternError)
  })

  it.effect("stops, parks or escalates the operational supervision on a repeated signal", () =>
    Effect.gen(function*() {
      const review = { allDone: false, retriable: ["a", "b", "c"] }
      const options = {
        maxRounds: 9,
        maxTasks: 16,
        concurrency: 3,
        plan: () => Effect.succeed(plan),
        worker: ({ task }: { readonly task: Supervisor.Task }) => Effect.succeed(`${task.id}-done`),
        review: () => Effect.succeed(review),
        finalize: () => Effect.succeed("never")
      }
      expect(yield* Supervisor.run("goal", { ...options, stall: { rounds: 3, on: "park" } })).toEqual({
        exhausted: true,
        rounds: 3,
        review,
        stalled: { _tag: "Stalled", signal: "output", rounds: 3, on: "park" }
      })
      const checks = yield* Supervisor.run("goal", {
        ...options,
        stall: { rounds: 2, signals: () => ({ checks: ["b", "a"] }) }
      })
      expect(checks).toMatchObject({ rounds: 2, stalled: { signal: "checks" } })
      const failing = yield* Supervisor.run("goal", {
        ...options,
        worker: ({ task }: { readonly task: Supervisor.Task }): Effect.Effect<string, unknown> =>
          task.id === "a"
            ? Effect.fail(new Error("flaky"))
            : task.id === "b"
            ? Effect.fail({ reason: "down" })
            : Effect.succeed(`${task.id}-done`),
        stall: { rounds: 2 }
      })
      expect(failing).toMatchObject({ rounds: 2, stalled: { signal: "output" } })
      expect(yield* Effect.flip(Supervisor.run("goal", { ...options, stall: { rounds: 2, on: "escalate" } })))
        .toMatchObject({ code: "stalled" })
      expect(yield* Effect.flip(Supervisor.run("goal", { ...options, stall: { rounds: 1 } })))
        .toMatchObject({ code: "invalid_decorator" })
    }))

  it.effect("refuses a boss plan longer than maxTasks before any worker runs", () =>
    Effect.gen(function*() {
      let workers = 0
      const oversized = { tasks: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, workerType: "coder" })) }
      const failure = yield* Supervisor.run("goal", {
        maxRounds: 3,
        maxTasks: 4,
        concurrency: 2,
        plan: () => Effect.succeed(oversized),
        worker: () => Effect.sync(() => (workers += 1, "ok")),
        review: () => Effect.succeed({ allDone: false, retriable: oversized.tasks.map((task) => task.id) }),
        finalize: () => Effect.succeed("done")
      }).pipe(Effect.flip)

      expect(failure).toMatchObject({
        code: "invalid_input",
        message: "Supervisor plan names 5 tasks, more than maxTasks 4"
      })
      expect(workers).toBe(0)
    }))

  it("refuses a declared task list longer than maxTasks and an out-of-range maxTasks", () => {
    const supervisor = Supervisor.make({
      plan: step,
      workers: { coder: step },
      review: step,
      finalize: step,
      maxRounds: 2,
      maxTasks: 1,
      concurrency: 1
    })
    expect(() =>
      Graph.build(supervisor, { input: { tasks: plan.tasks.filter((task) => task.workerType === "coder") } })
    )
      .toThrow(expect.objectContaining({
        code: "invalid_input",
        message: "Supervisor plan names 2 tasks, more than maxTasks 1"
      }))
    for (const maxTasks of [0, Infinity, 1.5]) {
      expect(() =>
        Supervisor.make({
          plan: step,
          workers: { coder: step },
          review: step,
          finalize: step,
          maxRounds: 1,
          maxTasks,
          concurrency: 1
        })
      ).toThrow(expect.objectContaining({
        code: "invalid_decorator",
        message: "Supervisor maxTasks must be a positive safe integer"
      }))
    }
  })

  it.effect("reads allDone and retriable as own properties only", () =>
    Effect.gen(function*() {
      let finalized = 0
      const inherited = Object.create({ allDone: true, retriable: ["a"] }) as object
      const result = yield* Supervisor.run("goal", {
        maxRounds: 3,
        maxTasks: 16,
        concurrency: 1,
        plan: () => Effect.succeed(plan),
        worker: () => Effect.succeed("ok"),
        review: () => Effect.succeed(inherited),
        finalize: () => Effect.sync(() => (finalized += 1, "done"))
      })

      expect(finalized).toBe(0)
      expect(result).toMatchObject({ exhausted: true, rounds: 1 })
    }))
})
