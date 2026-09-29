/**
 * The structured-output correction policy.
 *
 * `AgentAction.test.ts` covers the re-prompt itself: a decode miss spends a
 * correction slot and the action succeeds or reports a typed failure. These
 * cases cover the policy around it, which is what an operator configures and
 * what a crash has to survive:
 *
 * - the correction budget a composition defaults to, and the per-action
 *   override that beats it;
 * - the journal record each rejection leaves, so a run that answered three
 *   times says why in its own trail rather than only in its final failure;
 * - the bounded repair step after the budget is spent;
 * - and the durable half — a run killed mid-correction resumes at the
 *   correction it had reached and re-issues none of the calls it recorded.
 *
 * The durable cases run on the production engine over one in-memory SQLite
 * database, because replay is the thing under test and the memory engine
 * would answer it from a different mechanism.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import * as Jj from "@smthrs/kernel/Jj"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import * as ObservabilityMetric from "@smthrs/observability/Metric"
import * as Registry from "@smthrs/registry/Registry"
import { RunStore } from "@smthrs/run-store"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import { Cause, Effect, Exit, Fiber, Layer, Metric, Option, Schedule, Schema, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentAction from "../src/AgentAction.ts"
import * as Budget from "../src/Budget.ts"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as InternalFlowEngineLike from "../src/internal/FlowEngineLike.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"
import * as Safety from "./Safety.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

/** A cell that completes immediately with a literal answer. */
const answering = (output: string): string => `ctx.done(${JSON.stringify(output)})`

/**
 * A model that answers with one scripted cell per call and records every
 * prompt it was given.
 *
 * The recorded prompts are the call count: a replayed model step never
 * reaches the provider, so a prompt in this list is a call that was really
 * issued.
 */
const scripted = (cells: ReadonlyArray<string>, requests: Array<string>): Model.Model => {
  let index = 0
  return Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push(
          request.messages.flatMap((message) =>
            message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          ).join("\n") +
            request.system.map((part) => part.text).join("\n")
        )
        const source = cells[index] ?? cells.at(-1)!
        index++
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: `cell-${index}` }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: `cell-${index}`,
            text: "```cell\n" + source + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: `cell-${index}` }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
}

/**
 * A model that answers its first `answers` calls and then never settles.
 *
 * This is the crash: the process is holding a call the provider will not
 * answer, and everything it recorded before that call is already durable.
 */
const hangingAfter = (
  answers: number,
  cells: ReadonlyArray<string>,
  requests: Array<string>
): Model.Model => {
  const answering = scripted(cells, requests)
  return Model.make({
    stream: (request) => requests.length >= answers ? Stream.unwrap(Effect.never) : answering.stream(request)
  })
}

/**
 * A model that refuses to answer, so any call at all is a test failure.
 *
 * It records the request first: the assertion is about how many calls reached
 * a provider, and a refusal that recorded nothing would be indistinguishable
 * from a replay.
 */
const refusing = (requests: Array<string>): Model.Model =>
  Model.make({
    stream: () =>
      Stream.unwrap(
        Effect.sync(() => {
          requests.push("refused")
          return Stream.fail(
            new ModelError({ code: "provider_internal", message: "the replay asked the provider" })
          )
        })
      )
  })

const emptyRegistry: Registry.Registry = Registry.makeNoop({
  list: () => Effect.succeed([]),
  visible: () => Effect.succeed([]),
  getOption: () => Effect.succeed(Option.none())
})

const host = (overrides: Partial<AgentAction.Host> = {}): AgentAction.Host => ({
  registry: emptyRegistry,
  limits: { calls: 8 },
  capabilityEnvelope: [],
  maxFrames: 3,
  ...overrides
})

const resolvedSeats: Array<string> = []

const seats = (model: Model.Model): Layer.Layer<SeatResolver.SeatResolver> =>
  SeatResolver.layer({
    resolve: (id) =>
      Effect.sync(() => {
        resolvedSeats.push(id)
        return Seat.make({ id, modelId: Seat.modelIdOf(id), model, route, contextWindowTokens: 200_000 })
      })
  })

const Review = Schema.Struct({
  approved: Schema.Boolean,
  issues: Schema.Array(Schema.String)
})

/** A step that declares no budget of its own: the composition decides. */
const Inheriting = AgentAction.make("agent/test/policy/Inheriting", {
  payload: { diff: Schema.String },
  output: Review,
  seat: "anthropic:test-model",
  prompt: ({ diff }) => `Review this diff:\n${diff}`
})

const InheritingFlow = Flow.make("agent/test/policy/InheritingFlow", {
  payload: { diff: Schema.String },
  success: Review,
  error: AgentAction.AgentFailure,
  body: ({ diff }) => Inheriting.call({ diff })
})

/** A step whose own budget of zero must beat a generous composition default. */
const Strict = AgentAction.make("agent/test/policy/Strict", {
  payload: { diff: Schema.String },
  output: Review,
  seat: "anthropic:test-model",
  prompt: ({ diff }) => `Review this diff:\n${diff}`,
  corrections: 0
})

const StrictFlow = Flow.make("agent/test/policy/StrictFlow", {
  payload: { diff: Schema.String },
  success: Review,
  error: AgentAction.AgentFailure,
  body: ({ diff }) => Strict.call({ diff })
})

/** A step with a bounded repair after its one correction is spent. */
const repairPrompts: Array<string> = []
const Repairable = AgentAction.make("agent/test/policy/Repairable", {
  payload: { diff: Schema.String },
  output: Review,
  seat: "anthropic:test-model",
  prompt: ({ diff }) => `Review this diff:\n${diff}`,
  corrections: 0,
  repair: {
    prompt: (failure, payload) => {
      const rendered = `Repair the review of ${payload.diff}. Issues: ${failure.issues.join("; ")}`
      repairPrompts.push(rendered)
      return rendered
    }
  }
})

/** A repair that runs on its own seat, with its own teaching. */
const Reseated = AgentAction.make("agent/test/policy/Reseated", {
  payload: { diff: Schema.String },
  output: Review,
  seat: "anthropic:test-model",
  system: ["You review diffs."],
  prompt: ({ diff }) => `Review this diff:\n${diff}`,
  corrections: 0,
  repair: {
    seat: "anthropic:repair-model",
    system: ["You fix malformed JSON and nothing else."],
    prompt: (failure) => `Return the review as JSON. It failed with: ${failure.issues.join("; ")}`
  }
})

const ReseatedFlow = Flow.make("agent/test/policy/ReseatedFlow", {
  payload: { diff: Schema.String },
  success: Review,
  error: AgentAction.AgentFailure,
  body: ({ diff }) => Reseated.call({ diff })
})

const RepairableFlow = Flow.make("agent/test/policy/RepairableFlow", {
  payload: { diff: Schema.String },
  success: Review,
  error: AgentAction.AgentFailure,
  body: ({ diff }) => Repairable.call({ diff })
})

/** The composition under one declared step, on the reference memory engine. */
const memory = <ROut, RIn>(
  step: Layer.Layer<ROut, never, RIn>,
  composition: AgentAction.Host,
  model: Model.Model
) =>
  step.pipe(
    Layer.provideMerge(AgentAction.layerHost(composition)),
    Layer.provideMerge(seats(model)),
    Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
    // Stated rather than inherited: a correction ladder is not the place to
    // discover which ceiling a run is under.
    Layer.provideMerge(Safety.layer),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

describe("the composition's correction default", () => {
  it("decides the budget of a step that declares none", async () => {
    const requests: Array<string> = []
    const result = await Effect.runPromise(
      InheritingFlow.execute({ diff: "-  old\n+  new" }, { executionId: "policy-default-2" }).pipe(
        Effect.provide(
          memory(
            Layer.mergeAll(Inheriting.layer, Interpreter.layer(InheritingFlow)),
            host({ defaultCorrections: 2 }),
            scripted(
              [answering("nope one"), answering("nope two"), answering(`{"approved":true,"issues":[]}`)],
              requests
            )
          )
        )
      )
    )

    expect(result).toEqual({ approved: true, issues: [] })
    // Two corrections were budgeted by the host alone, and both were spent.
    expect(requests).toHaveLength(3)
  })

  it("is one when the composition declares none either", async () => {
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        InheritingFlow.execute({ diff: "-  old\n+  new" }, { executionId: "policy-default-1" }).pipe(
          Effect.provide(
            memory(
              Layer.mergeAll(Inheriting.layer, Interpreter.layer(InheritingFlow)),
              host(),
              scripted([answering("nope one"), answering("nope two")], requests)
            )
          )
        )
      )
    )

    expect(failureOf(exit)).toMatchObject({
      _tag: "/harness/StructuredOutputFailure",
      corrections: 1,
      limit: 1
    })
    expect(requests).toHaveLength(2)
  })

  it("loses to a step that declares its own budget", async () => {
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        StrictFlow.execute({ diff: "-  old\n+  new" }, { executionId: "policy-override-0" }).pipe(
          Effect.provide(
            memory(
              Layer.mergeAll(Strict.layer, Interpreter.layer(StrictFlow)),
              host({ defaultCorrections: 2 }),
              scripted([answering("nope one"), answering(`{"approved":true,"issues":[]}`)], requests)
            )
          )
        )
      )
    )

    expect(failureOf(exit)).toMatchObject({
      _tag: "/harness/StructuredOutputFailure",
      corrections: 0,
      limit: 0
    })
    // The generous default never applied: one call, no correction.
    expect(requests).toHaveLength(1)
  })

  it("refuses an unusable composition default at layer construction", () => {
    for (const defaultCorrections of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(() => AgentAction.layerHost(host({ defaultCorrections }))).toThrow(
        AgentAction.InvalidCorrectionBudget
      )
    }
  })
})

describe("the repair step", () => {
  it("receives the failure and completes the action with its answer", async () => {
    repairPrompts.length = 0
    const requests: Array<string> = []
    const result = await Effect.runPromise(
      RepairableFlow.execute({ diff: "-  old\n+  new" }, { executionId: "policy-repair-ok" }).pipe(
        Effect.provide(
          memory(
            Layer.mergeAll(Repairable.layer, Interpreter.layer(RepairableFlow)),
            host(),
            scripted(
              [answering("not json at all"), answering(`{"approved":false,"issues":["repaired"]}`)],
              requests
            )
          )
        )
      )
    )

    expect(result).toEqual({ approved: false, issues: ["repaired"] })
    // The budget was zero, so the second call is the repair and not a
    // correction, and it was told what failed.
    expect(requests).toHaveLength(2)
    expect(repairPrompts).toHaveLength(1)
    expect(repairPrompts[0]).toContain("Repair the review of")
    expect(repairPrompts[0]!.length).toBeGreaterThan("Repair the review of . Issues: ".length)
  })

  it("runs on its own seat and its own teaching when the declaration says so", async () => {
    resolvedSeats.length = 0
    const requests: Array<string> = []
    const result = await Effect.runPromise(
      ReseatedFlow.execute({ diff: "-  old\n+  new" }, { executionId: "policy-repair-seat" }).pipe(
        Effect.provide(
          memory(
            Layer.mergeAll(Reseated.layer, Interpreter.layer(ReseatedFlow)),
            host(),
            scripted(
              [answering("not json at all"), answering(`{"approved":true,"issues":["reseated"]}`)],
              requests
            )
          )
        )
      )
    )

    expect(result).toEqual({ approved: true, issues: ["reseated"] })
    expect(resolvedSeats).toContain("anthropic:repair-model")
    // The repair's teaching replaced the step's own, and the schema teaching
    // travelled with it.
    expect(requests[1]).toContain("You fix malformed JSON")
    expect(requests[1]).not.toContain("You review diffs.")
    expect(requests[1]).toContain("Required output shape")
  })

  it("runs once: an answer it cannot fix either fails the action", async () => {
    repairPrompts.length = 0
    const requests: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        RepairableFlow.execute({ diff: "-  old\n+  new" }, { executionId: "policy-repair-failed" }).pipe(
          Effect.provide(
            memory(
              Layer.mergeAll(Repairable.layer, Interpreter.layer(RepairableFlow)),
              host(),
              scripted([answering("not json at all"), answering("still not json")], requests)
            )
          )
        )
      )
    )

    expect(failureOf(exit)).toMatchObject({ _tag: "/harness/StructuredOutputFailure" })
    expect(requests).toHaveLength(2)
    expect(repairPrompts).toHaveLength(1)
  })
})

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({
      commitId: "structured-output-snapshot" as never,
      changeId: "structured-output-snapshot" as never
    }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const stores = Layer.mergeAll(
  Layer.sync(DurableEngineState.DurableEngineState)(DurableEngineState.makeMemory),
  StepBoundary.layerTest(),
  Layer.succeed(Jj.Jj)(jj),
  TestStores.layer()
)

/**
 * Runs one body against a fresh database and the real durable stores.
 *
 * Cryptography is provided OUTSIDE the store layers, so the flow body the
 * engine registers keeps it in context: a step key is hashed by the body's own
 * fiber, not by the layer that built the engine.
 */
const durable = <A, E>(
  body: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(body, NodeCrypto.layer)).pipe(Effect.orDie)
  )

/** One engine incarnation over already-provided durable stores. */
const incarnation = (
  hostId: string,
  composition: AgentAction.Host,
  model: Model.Model,
  classifier: Layer.Layer<QuotaPolicy.QuotaClassifier> = QuotaPolicy.layerUnclassified()
) =>
  Effect.gen(function*() {
    const engine = yield* EngineStore.make({
      owner: { hostId },
      journalSource: `structured-output-${hostId}`,
      isAlive: () => Effect.succeed(false)
    })
    return Layer.mergeAll(Inheriting.layer, Interpreter.layer(InheritingFlow)).pipe(
      Layer.provideMerge(AgentAction.layerHost(composition)),
      Layer.provideMerge(seats(model)),
      Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
      Layer.provideMerge(classifier),
      Layer.provideMerge(Budget.layerUnbounded()),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
    )
  })

/**
 * The same body under a TEST clock.
 *
 * The park below is a three-second window, and a case that measured it on the
 * wall clock would spend three seconds proving something the clock can simply
 * be told. The clock goes outside the stores so the classifier, the engine row
 * and the durable timer all read the same time.
 */
const onTestClock = <A, E>(body: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(body, Layer.merge(NodeCrypto.layer, TestClock.layer()))).pipe(Effect.orDie)
  )

/**
 * The quota waiting rows, once the run has parked.
 *
 * Bounded, so a run that never parks fails an assertion instead of hanging.
 * It yields rather than sleeps: parking costs the run fiber turns, not time.
 */
const waitForPark = (state: DurableEngineState.Service) =>
  Effect.gen(function*() {
    for (let poll = 0; poll < 400; poll++) {
      const rows = yield* state.waitingRuns({ reason: "quota" })
      if (rows.length > 0) return rows
      yield* Effect.yieldNow
    }
    return yield* state.waitingRuns({ reason: "quota" })
  })

/** Advances the test clock until one forked run settles, then joins it. */
const settle = <A, E>(fiber: Fiber.Fiber<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function*() {
    for (let step = 0; step < 60 && fiber.pollUnsafe() === undefined; step++) {
      yield* TestClock.adjust("1 second")
    }
    return yield* Fiber.join(fiber)
  })

const rejections = (entries: ReadonlyArray<{ readonly eventType: string; readonly payload: unknown }>) =>
  entries
    .filter((entry) => entry.eventType === AgentAction.structuredOutputRejectedEvent)
    .map((entry) => entry.payload)

/**
 * The durable-channel attempt records the engine wrote for one run.
 *
 * `flows.engine.attempt-started` carries the attempt id — the step key digest
 * and the attempt ordinal — and is written inside the same transaction as the
 * attempt row, so it is the durable evidence that a correction was admitted as
 * its own step rather than folded into the ask it corrects.
 */
interface AttemptRecord {
  readonly stepKeyDigest: string
  readonly attempt: number
  readonly tier: string
}

const attemptRecords = (
  entries: ReadonlyArray<{ readonly eventType: string; readonly payload: unknown }>
): ReadonlyArray<AttemptRecord> =>
  entries
    .filter((entry) => entry.eventType === "flows.engine.attempt-started")
    .map((entry) => entry.payload as AttemptRecord)

/**
 * The correction ordinal each sealed model step of one run wrote down.
 *
 * Read from the ATTEMPT ROWS rather than from the journal, because the
 * recorded outcome — the thing a replay is served and a projection reads — is
 * what has to carry the ordinal. The session that distinguishes two rungs is
 * hashed into the step key, so it proves the rungs are separate steps and
 * nothing more; this is what makes the rung readable.
 */
const recordedCorrections = (runId: string, attempts: ReadonlyArray<AttemptRecord>) =>
  Effect.gen(function*() {
    const store = yield* AttemptStore.AttemptStore
    const corrections: Array<number | undefined> = []
    for (const record of attempts) {
      const row = yield* store.get({
        runId,
        stepKeyDigest: record.stepKeyDigest,
        attempt: record.attempt
      })
      if (Option.isNone(row)) continue
      const decoded = yield* Effect.fromResult(
        Schema.decodeUnknownResult(FlowEngineLike.RecordedModelStep)(row.value.outcome)
      ).pipe(Effect.option)
      if (Option.isNone(decoded)) continue
      const normalized = InternalFlowEngineLike.normalizeRecordedModelStep(decoded.value)
      // A model step is the only outcome with model events in it; an empty
      // array decodes as the legacy branch and is some other action's.
      if (normalized.events.length === 0) continue
      corrections.push(normalized.correction)
    }
    return corrections
  })

/** Flushes the journal and reads back one run's durable and lossy trail. */
const trail = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 500 })
    return { attempts: attemptRecords(page.entries), rejections: rejections(page.entries) }
  })

describe("a rejection on the durable engine", () => {
  it("journals one record per rejection, naming the attempt and the schema", async () => {
    const requests: Array<string> = []
    const observed = await durable(
      Effect.gen(function*() {
        const wiring = yield* incarnation(
          "records",
          host({ defaultCorrections: 2 }),
          scripted(
            [answering("nope one"), answering("nope two"), answering(`{"approved":true,"issues":[]}`)],
            requests
          )
        )
        const value = yield* InheritingFlow.execute({ diff: "-  old\n+  new" }, {
          executionId: "policy-journal"
        }).pipe(Effect.provide(wiring))
        const journal = yield* Journal.Journal
        yield* journal.flush
        const page = yield* journal.entries({ runId: "policy-journal" as never, limit: 200 })
        return { value, records: rejections(page.entries) }
      }).pipe(Effect.provide(stores))
    )

    expect(observed.value).toEqual({ approved: true, issues: [] })
    expect(observed.records).toHaveLength(2)
    expect(observed.records[0]).toMatchObject({
      action: "agent/test/policy/Inheriting",
      attempt: 0,
      limit: 2
    })
    expect(observed.records[1]).toMatchObject({
      action: "agent/test/policy/Inheriting",
      attempt: 1,
      limit: 2
    })
    // The digest identifies the boundary without carrying the answer itself.
    expect(observed.records[0]).toHaveProperty("issuesDigest")
    expect(observed.records[0]).toHaveProperty("schema")
  })

  it("records each correction as its own sealed step, and never re-runs a finished run", async () => {
    const first: Array<string> = []
    const second: Array<string> = []
    // One database, one execution id, two engines. The first incarnation
    // records the ladder and is then CLOSED. What the second incarnation
    // proves is narrow and worth stating exactly: the run it is handed is
    // already COMPLETED, so the engine answers it from its terminal run row
    // and never re-enters the body. Mid-flight replay of a settled sealed
    // step is a different claim, and the park test below is what proves it.
    let replaying = false
    const recording = scripted(
      [answering("nope one"), answering("nope two"), answering(`{"approved":true,"issues":[]}`)],
      first
    )
    const refuses = refusing(second)
    const model = Model.make({
      stream: (request) => replaying ? refuses.stream(request) : recording.stream(request)
    })
    // No transport ladder: a refused call after the boundary is the assertion,
    // and retrying it would only spend the test's wall clock. One frame per
    // run leaves no frame to correct in, so every miss takes the fresh-session
    // fallback this case is about.
    const composition = host({ defaultCorrections: 2, maxFrames: 1, modelRetryPolicy: Schedule.recurs(0) })

    const observed = await durable(
      Effect.gen(function*() {
        const recorded = yield* Effect.scoped(
          Effect.gen(function*() {
            const wiring = yield* incarnation("ladder-before", composition, model)
            return yield* InheritingFlow.execute({ diff: "-  old\n+  new" }, {
              executionId: "policy-boundary"
            }).pipe(Effect.provide(wiring))
          })
        )
        const before = yield* trail("policy-boundary")
        replaying = true
        const replayed = yield* Effect.scoped(
          Effect.gen(function*() {
            const wiring = yield* incarnation("ladder-after", composition, model)
            return yield* InheritingFlow.execute({ diff: "-  old\n+  new" }, {
              executionId: "policy-boundary"
            }).pipe(Effect.provide(wiring))
          })
        )
        const after = yield* trail("policy-boundary")
        const corrections = yield* recordedCorrections("policy-boundary", before.attempts)
        return { recorded, replayed, before, after, corrections }
      }).pipe(Effect.provide(stores))
    )

    expect(observed.recorded).toEqual({ approved: true, issues: [] })
    expect(observed.replayed).toEqual({ approved: true, issues: [] })
    // Three calls before the boundary — the ask and both corrections — and
    // none after it.
    expect(first).toHaveLength(3)
    expect(second).toHaveLength(0)
    // The durable channel carries the ladder: every provider call the ask made
    // is its own sealed step. A correction folded into the ask it corrects
    // would leave one sealed step for all three.
    const sealed = observed.before.attempts.filter((record) => record.tier === "sealed")
    expect(sealed.length).toBeGreaterThanOrEqual(first.length)
    // Every step was admitted exactly once: distinct keys, all on attempt 1.
    const digests = new Set(observed.before.attempts.map((record) => record.stepKeyDigest))
    expect(digests.size).toBe(observed.before.attempts.length)
    expect(observed.before.attempts.every((record) => record.attempt === 1)).toBe(true)
    // The second incarnation admitted nothing: a completed run is answered
    // from its row, so the durable trail is byte-identical after the boundary.
    expect(observed.after.attempts).toEqual(observed.before.attempts)
    // And the rung each sealed step belonged to is READABLE off the durable
    // record, not only implied by the distinctness of three step keys: the ask
    // is correction 0 and the two re-prompts are 1 and 2. This is the half a
    // digest cannot give back — a projection reading the run's steps can say
    // which call was the ask.
    expect(observed.corrections).toEqual([0, 1, 2])
    // The lossy evidence survives the boundary too, and still names which
    // correction each rejection was.
    expect(observed.after.rejections.map((record) => (record as { readonly attempt: number }).attempt))
      .toEqual([0, 1])
  }, 60_000)
})

/** One prompt a provider was really given, and which side of a restart it was on. */
interface Asked {
  readonly phase: "before" | "after"
  readonly text: string
}

/**
 * A ladder that parks mid-correction.
 *
 * The first prompt it sees is the ask, and it answers that one with something
 * the schema rejects. Every prompt after that is a correction: the first
 * correction is refused on quota, which suspends the run, and the next one is
 * answered. The refusal is the seam this suite needs. It leaves the run
 * SUSPENDED with the ask already settled as a sealed step, which is the only
 * state in which a second engine has to replay a settled model step instead of
 * reading a finished run's terminal row.
 */
const parkingMidCorrection = (asked: Array<Asked>, phase: { current: Asked["phase"] }): Model.Model => {
  let refused = false
  const cell = (source: string) =>
    Stream.fromIterable([
      ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
      ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + source + "\n```" }),
      ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
      ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
    ])
  return Model.make({
    stream: (request) =>
      Stream.unwrap(Effect.sync(() => {
        const text = request.messages.flatMap((message) =>
          message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        ).join("\n") + request.system.map((part) =>
          part.text
        ).join("\n")
        const isAsk = asked.length === 0 || text === asked[0]!.text
        asked.push({ phase: phase.current, text })
        if (isAsk) return cell(answering("nope one"))
        if (refused) return cell(answering(`{"approved":true,"issues":[]}`))
        refused = true
        return Stream.fail(
          new ModelError({
            code: "rate_limited",
            message: "Too many requests",
            retryAfterMillis: 3_000,
            httpStatus: 429
          })
        )
      }))
  })
}

describe("a correction ladder interrupted mid-flight", () => {
  it("replays the settled ask on a second engine and re-issues only the correction", async () => {
    const asked: Array<Asked> = []
    const phase = { current: "before" as Asked["phase"] }
    const model = parkingMidCorrection(asked, phase)
    // No transport ladder: the quota refusal is the park, not a hiccup to
    // retry, and the correction budget is one so the ladder is exactly two
    // asks long. One frame per run makes the correction a fresh session.
    const composition = host({ defaultCorrections: 1, maxFrames: 1, modelRetryPolicy: Schedule.recurs(0) })
    const rejections = Metric.value(ObservabilityMetric.structuredOutputRejections)
    const counted = (await Effect.runPromise(rejections)).count

    const observed = await onTestClock(
      Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        yield* Effect.scoped(
          Effect.gen(function*() {
            const wiring = yield* incarnation(
              "ladder-park",
              composition,
              model,
              QuotaPolicy.layerDefault()
            )
            const running = yield* InheritingFlow.execute({ diff: "-  old\n+  new" }, {
              executionId: "policy-midflight"
            }).pipe(Effect.provide(wiring), Effect.forkChild({ startImmediately: true }))
            // The run is durably SUSPENDED here: the ask is a settled sealed
            // step and the correction is the call that was refused.
            yield* waitForPark(state)
            yield* Fiber.interrupt(running)
          })
        )
        const before = yield* trail("policy-midflight")
        phase.current = "after"
        const replayed = yield* Effect.scoped(
          Effect.gen(function*() {
            const wiring = yield* incarnation(
              "ladder-resume",
              composition,
              model,
              QuotaPolicy.layerDefault()
            )
            // Forked: the resumed run waits out the deadline the first engine
            // recorded, and only the test can move the clock past it.
            const resuming = yield* InheritingFlow.execute({ diff: "-  old\n+  new" }, {
              executionId: "policy-midflight"
            }).pipe(Effect.provide(wiring), Effect.forkChild({ startImmediately: true }))
            return yield* settle(resuming)
          })
        )
        return { replayed, before, after: yield* trail("policy-midflight") }
      }).pipe(Effect.provide(stores))
    )

    const before = asked.filter((call) => call.phase === "before").map((call) => call.text)
    const after = asked.filter((call) => call.phase === "after").map((call) => call.text)

    expect(observed.replayed).toEqual({ approved: true, issues: [] })
    // Before the restart: the ask, then the correction the provider refused.
    expect(before).toHaveLength(2)
    expect(before[0]).not.toBe(before[1])
    // After it: ONE call, and it is the correction, not the ask. The ask's
    // sealed step was settled before the restart and the resumed body was
    // handed its recorded answer instead of asking the provider again.
    expect(after).toEqual([before[1]])
    // The ask's admitted attempts are untouched by the resume: the records the
    // first engine wrote are still a prefix of the trail, so nothing about the
    // settled step was re-admitted.
    expect(observed.after.attempts.slice(0, observed.before.attempts.length))
      .toEqual(observed.before.attempts)
    // The rejection record is evidence, not a decision. It is emitted outside
    // any sealed step, so every re-entry of the body writes attempt 0's again
    // and the count is the engine's business, not this policy's. What the
    // policy owns is the ordinal and the budget: the ladder never restarts
    // past correction 0, and the limit stays the one the composition set.
    expect(observed.before.rejections.map((record) => (record as { readonly attempt: number }).attempt))
      .toEqual([0])
    expect(observed.after.rejections.length).toBeGreaterThan(observed.before.rejections.length)
    // The counter is a decision, unlike the record: the resumed body replays
    // the sealed count of the ask's rejection instead of adding it again.
    expect((await Effect.runPromise(rejections)).count - counted).toBe(1)
    expect(
      observed.after.rejections.every((record) =>
        (record as { readonly attempt: number; readonly limit: number }).attempt === 0 &&
        (record as { readonly attempt: number; readonly limit: number }).limit === 1
      )
    ).toBe(true)
  })
})
