/**
 * The two records a reader rebuilds one step from: what a model call was
 * asked, and what a classifier decided.
 *
 * `model-settled` journals an answer and `claim-demanded` journals three
 * probabilities, and neither says what was asked. These cases fix the records
 * that do: one `model-requested` per model call carrying the request itself and
 * the keys that join it to its turn, and one `decision-settled` per classifier
 * reading carrying the state, the questions and the answers.
 */
import { ModelRequest } from "@smthrs/model"
import type * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as CompletionClaim from "../src/CompletionClaim.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as EngineLike from "../src/EngineLike.ts"
import { HarnessError } from "../src/HarnessError.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Steering from "../src/Steering.ts"
import { confidentEvaluator, emits, of, prose, run, window } from "./fixtures/cellTurn.ts"
import * as ScriptedEngine from "./fixtures/scriptedEngine.ts"
import * as ScriptedModel from "./fixtures/scriptedModel.ts"

const state = (overrides: Partial<Parameters<typeof CellTurn.make>[0]> = {}) =>
  CellTurn.make({
    session: "session-1",
    seat: "anthropic:test-model",
    modelParams: ModelRequest.GenerationParams.make({ maxTokens: 512, reasoningEffort: "high" }),
    layers: ["layer-a"],
    capabilityEnvelope: [],
    placement: Option.none(),
    contextWindow: window,
    maxFrames: 4,
    readOnlyCap: 0,
    ...overrides
  })

describe("model-requested", () => {
  it("is emitted once per model call, before the call, with the request the engine was handed", async () => {
    const { engine, events } = await run({
      state: state(),
      flows: [],
      script: [emits(`console.log("first")`), emits(`ctx.done("done")`)]
    })

    const requested = of(events, "model-requested")
    expect(requested).toHaveLength(engine.recorder.sealStep.length)
    expect(requested.map((event) => [event.scope, event.frame, event.attempt, event.purpose])).toEqual([
      ["session-1", 0, 1, "frame"],
      ["session-1", 1, 1, "frame"]
    ])
    // The record is the request itself, not a description of it: the same
    // object the sealed step was keyed on, so a reader rebuilds the call the
    // provider actually received.
    expect(requested.map((event) => event.request)).toEqual(engine.recorder.sealStep.map((step) => step.request))
    expect(requested[0]?.seat).toBe("anthropic:test-model")
    expect(requested[0]?.request.params).toEqual(
      ModelRequest.GenerationParams.make({ maxTokens: 512, reasoningEffort: "high" })
    )
    // Inside its own turn, ahead of the settlement it explains.
    const tags = events.map((event) => event._tag).filter((tag) => tag !== "model-delta")
    const opened = tags.indexOf("turn-opened")
    expect(tags.slice(opened, opened + 3)).toEqual(["turn-opened", "model-requested", "model-settled"])
  })

  it("numbers an in-frame re-ask as the next attempt of the same frame", async () => {
    const { events } = await run({
      state: state({ revalidations: 1 }),
      flows: [],
      script: [prose("no cell here"), emits(`ctx.done("done")`)]
    })

    expect(of(events, "model-requested").map((event) => [event.frame, event.attempt])).toEqual([[0, 1], [0, 2]])
    // The attempt a refusal names is the attempt whose request this is.
    expect(of(events, "cell-rejected-in-frame").map((event) => event.attempt)).toEqual([1])
    // The re-ask is a different request: it carries the refusal the first did not.
    const [first, second] = of(events, "model-requested")
    expect(second?.request.messages.length).toBeGreaterThan(first?.request.messages.length ?? 0)
  })

  it("records the request and the route the host resolves, and its own request where the host resolves nothing", async () => {
    const script = [emits(`ctx.done("done")`)]
    const unresolved = await run({ state: state(), flows: [], script })
    expect(of(unresolved.events, "model-requested")[0]?.binding).toBeUndefined()
    expect(of(unresolved.events, "model-requested")[0]?.request).toEqual(
      unresolved.engine.recorder.sealStep[0]?.request
    )

    // A host that rewrites the request on its way out: what is journaled is
    // what the provider is sent, which is no longer what the controller built.
    const built: Array<ModelRequest.ModelRequest> = []
    const rewrite = (request: ModelRequest.ModelRequest) =>
      ModelRequest.ModelRequest.make({
        ...request,
        system: [...request.system, ModelRequest.SystemPart.make({ text: "host addendum" })]
      })
    const resolved = await run({
      state: state(),
      flows: [],
      script,
      resolve: (request) => {
        built.push(request)
        return Effect.succeed(Option.some({
          request: rewrite(request),
          binding: Option.some(
            new EngineLike.Binding({ routeId: "anthropic-direct", protocolId: "anthropic-messages" })
          )
        }))
      }
    })
    const record = of(resolved.events, "model-requested")[0]
    expect(record?.binding).toEqual(
      new EngineLike.Binding({ routeId: "anthropic-direct", protocolId: "anthropic-messages" })
    )
    expect(record?.request.system.at(-1)?.text).toBe("host addendum")
    // Resolved against the request that is about to be sealed, not a copy.
    expect(built).toEqual(resolved.engine.recorder.sealStep.map((step) => step.request))
  })

  it("journals no request where the host cannot say what would be sent, and fails where the sealed step fails", async () => {
    const model = ScriptedModel.make([emits(`ctx.done("done")`)])
    const fixture = ScriptedEngine.make(model.model)
    const events: Array<AgentEvent.AgentEvent> = []
    const error = await CellTurn.run({ state: state(), flows: [] }).pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.provide(EngineLike.layer({
        ...fixture.engine,
        // The host's own rewrite failed: nothing it could answer here is the
        // request a provider would receive, and the sealed step says why.
        resolve: () => Effect.succeed(Option.none()),
        sealStep: () =>
          Stream.fail(new HarnessError({ code: "engine_failed", message: "A cell model-request plugin failed" }))
      })),
      Effect.provide(QuickJSSandbox.layer),
      Effect.provide(Steering.layerNoop()),
      Effect.provide(confidentEvaluator),
      Effect.flip,
      Effect.runPromise
    )

    expect(error).toMatchObject({ code: "engine_failed", message: "A cell model-request plugin failed" })
    expect(of(events, "turn-opened")).toHaveLength(1)
    expect(of(events, "model-requested")).toHaveLength(0)
  })

  it("records the compaction call as a model call of the frame it runs ahead of", async () => {
    const bulk = (label: string): ContextWindow.SegmentInput => ({
      kind: "transcript",
      zone: "tail",
      content: [ModelRequest.Message.user(`${label}: ${"detail ".repeat(6_000)}`)]
    })
    const crowded = ContextWindow.make({
      modelId: "test-model",
      segments: [
        { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
        ...["one", "two", "three", "four", "five"].map(bulk)
      ]
    })
    const { engine, events } = await run({
      state: state({ contextWindow: crowded, contextWindowTokens: 40_000, maxFrames: 2 }),
      flows: [],
      script: [prose("the compacted summary"), emits(`ctx.done("done")`)]
    })

    expect(of(events, "compaction-settled")).toHaveLength(1)
    expect(of(events, "model-requested").map((event) => [event.frame, event.attempt, event.purpose])).toEqual([
      [0, 1, "compaction"],
      [0, 1, "frame"]
    ])
    expect(of(events, "model-requested").map((event) => event.request)).toEqual(
      engine.recorder.sealStep.map((step) => step.request)
    )
  })

  it("round-trips through the event union with its request intact", () => {
    const event = new AgentEvent.ModelRequested({
      eventType: AgentEvent.eventType.modelRequested,
      scope: "session-1",
      frame: 2,
      attempt: 1,
      purpose: "frame",
      seat: "anthropic:test-model",
      binding: new EngineLike.Binding({ routeId: "route", protocolId: "protocol" }),
      request: ModelRequest.ModelRequest.make({
        modelId: "test-model",
        system: [ModelRequest.SystemPart.make({ text: "system" })],
        messages: [ModelRequest.Message.user("hello")],
        tools: [],
        toolChoice: "none",
        params: ModelRequest.GenerationParams.make({ temperature: 0 })
      })
    })
    expect(Schema.decodeUnknownSync(AgentEvent.AgentEvent)(Schema.encodeSync(AgentEvent.AgentEvent)(event)))
      .toEqual(event)
  })
})

describe("decision answers", () => {
  const decoded = {
    done: { value: true, probability: 0.8 },
    role: { value: "lead", probabilities: { lead: 0.7, support: 0.3 }, confidence: 0.7 },
    risk: { value: 1.4, label: "medium", probabilities: { low: 0.1, medium: 0.6, high: 0.3 }, confidence: 0.6 }
  } satisfies Record<string, Classifier.Answer>

  it("carries the provider's confidence when the evaluator reported one", () => {
    expect(AgentEvent.decisionAnswers(decoded, { role: 0.91, risk: 0.42 })).toEqual({
      done: { kind: "boolean", p: 0.8 },
      role: { kind: "choice", value: "lead", probabilities: { lead: 0.7, support: 0.3 }, confidence: 0.91 },
      risk: {
        kind: "score",
        value: 1.4,
        label: "medium",
        probabilities: { low: 0.1, medium: 0.6, high: 0.3 },
        confidence: 0.42
      }
    })
  })

  it("omits confidence when the evaluator reported none, rather than naming the largest probability", () => {
    const answers = AgentEvent.decisionAnswers(decoded, undefined)
    expect(answers.role).toEqual({ kind: "choice", value: "lead", probabilities: { lead: 0.7, support: 0.3 } })
    expect(answers.risk).toEqual({
      kind: "score",
      value: 1.4,
      label: "medium",
      probabilities: { low: 0.1, medium: 0.6, high: 0.3 }
    })
    expect(Object.hasOwn(answers.role!, "confidence")).toBe(false)
    // One question reported, the other not: absence is per question.
    expect(Object.hasOwn(AgentEvent.decisionAnswers(decoded, { role: 0.5 }).risk!, "confidence")).toBe(false)
  })

  it("never attaches a confidence to a boolean, whose probability is the whole answer", () => {
    expect(AgentEvent.decisionAnswers(decoded, { done: 0.99 }).done).toEqual({ kind: "boolean", p: 0.8 })
  })
})

describe("decision-settled from the completion brake", () => {
  const tasked = ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
      {
        kind: "instructions",
        zone: "prefix",
        content: [ModelRequest.SystemPart.make({ text: "The task for this run:\n\nSay hello." })]
      },
      { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("start")] }
    ]
  })
  const scripted = (answers: Readonly<Record<string, Evaluator.ScriptedAnswer>>, asked: Array<Evaluator.Request>) =>
    Evaluator.layerScripted((request) => {
      asked.push(request)
      return answers
    })
  const standing = {
    complete: { probability: 0.94 },
    overclaims: { probability: 0.03 },
    invented: { probability: 0.02 },
    requiresWorkspaceChange: { probability: 0.5 },
    reportsLimitation: { probability: 0 }
  }
  const unrecorded = {
    complete: { probability: 0.1 },
    overclaims: { probability: 0.9 },
    invented: { probability: 0.95 },
    requiresWorkspaceChange: { probability: 0.5 },
    reportsLimitation: { probability: 0 }
  }

  it("journals the state, the questions and the answers of a reading that let the claim stand", async () => {
    const asked: Array<Evaluator.Request> = []
    const { events } = await run({
      state: state({ contextWindow: tasked }),
      flows: [],
      script: [emits(`ctx.done("hello")`)],
      evaluator: scripted(standing, asked)
    })

    const claim = of(events, "claim-demanded")
    const decisions = of(events, "decision-settled")
    expect(decisions).toHaveLength(1)
    const decision = decisions[0]!
    expect(decision).toMatchObject({
      scope: "session-1",
      frame: 0,
      classifier: "completion/claim",
      digest: CompletionClaim.classifier.digest,
      acted: false,
      decidedBy: "jev",
      latencyMs: claim[0]?.latencyMs
    })
    // The state is what the transport was sent, byte for byte.
    expect(decision.state).toEqual(asked[0]?.state)
    expect(Evaluator.encodeQuestions(decision.questions)).toEqual(
      Evaluator.encodeQuestions(CompletionClaim.classifier.questions)
    )
    expect(decision.answers).toEqual({
      complete: { kind: "boolean", p: 0.94 },
      overclaims: { kind: "boolean", p: 0.03 },
      invented: { kind: "boolean", p: 0.02 },
      requiresWorkspaceChange: { kind: "boolean", p: 0.5 },
      reportsLimitation: { kind: "boolean", p: 0 }
    })
    // The compatibility record is still written, unchanged and first.
    expect(claim).toEqual([
      expect.objectContaining({ complete: 0.94, overclaims: 0.03, invented: 0.02, demanded: false, refused: false })
    ])
    const tags = events.map((event) => event._tag)
    expect(tags.indexOf("claim-demanded")).toBeLessThan(tags.indexOf("decision-settled"))
  })

  it("says the reading acted when it handed the completion back, and when it ended the run", async () => {
    const bounced = await run({
      state: state({ contextWindow: tasked, maxFrames: 2 }),
      flows: [],
      script: [emits(`ctx.done("I ran the suite and it passed")`), emits(`ctx.done("hello")`)],
      evaluator: Evaluator.layerScripted((request) =>
        JSON.stringify(request.state).includes("ran the suite") ? unrecorded : standing
      )
    })
    expect(of(bounced.events, "decision-settled").map((event) => [event.frame, event.acted])).toEqual([
      [0, true],
      [1, false]
    ])
    expect(of(bounced.events, "claim-demanded").map((event) => event.demanded)).toEqual([true, false])

    const refused = await run({
      state: state({ contextWindow: tasked, maxFrames: 1 }),
      flows: [],
      script: [emits(`ctx.done("I ran the suite and it passed")`)],
      evaluator: Evaluator.layerScripted(() => unrecorded)
    })
    expect(refused.failure).toMatchObject({ code: "claim_unproven" })
    expect(of(refused.events, "decision-settled").map((event) => event.acted)).toEqual([true])
    expect(of(refused.events, "claim-demanded").map((event) => event.refused)).toEqual([true])
  })

  it("writes no decision where the brake is disarmed, because nothing was asked", async () => {
    const { events } = await run({
      state: state({ contextWindow: tasked, claimCap: 0 }),
      flows: [],
      script: [emits(`ctx.done("hello")`)]
    })
    expect(of(events, "decision-settled")).toEqual([])
    expect(of(events, "claim-demanded")).toEqual([])
  })

  /** A scripted engine whose recorded boundaries persist across attempts. */
  const journaled = (fixture: ScriptedEngine.Fixture, records: Map<string, unknown>) =>
    EngineLike.layer(EngineLike.make({
      ...fixture.engine,
      record: (boundary) => {
        const key = `${boundary.name}\u0000${boundary.identity.frame}\u0000${boundary.identity.boundary}`
        const held = records.get(key)
        if (held !== undefined) {
          return Effect.fromResult(Schema.decodeUnknownResult(boundary.success)(held)).pipe(
            Effect.mapError((cause) => new HarnessError({ code: "engine_failed", message: "did not decode", cause }))
          )
        }
        const encode = Schema.encodeUnknownSync(
          boundary.success as unknown as Schema.Schema<unknown> & { readonly "EncodingServices": never }
        )
        return boundary.execute.pipe(Effect.tap((value) => Effect.sync(() => records.set(key, encode(value)))))
      }
    }))

  const attempt = async (records: Map<string, unknown>, evaluator: Layer.Layer<Evaluator.Evaluator>) => {
    const model = ScriptedModel.make([emits(`ctx.done("hello")`)])
    const events: Array<AgentEvent.AgentEvent> = []
    await CellTurn.run({ state: state({ contextWindow: tasked }), flows: [] }).pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.provide(journaled(ScriptedEngine.make(model.model), records)),
      Effect.provide(QuickJSSandbox.layer),
      Effect.provide(Steering.layerNoop()),
      Effect.provide(evaluator),
      Effect.runPromise
    )
    return events
  }

  it("replays the recorded decision without asking again, latency included", async () => {
    const records = new Map<string, unknown>()
    let requests = 0
    const counting = (latencyMs: number) =>
      Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
        evaluate: () =>
          Effect.sync(() => {
            requests++
            return {
              answers: {
                complete: { type: "boolean" as const, probability: 0.94 },
                overclaims: { type: "boolean" as const, probability: 0.03 },
                invented: { type: "boolean" as const, probability: 0.02 },
                requiresWorkspaceChange: { type: "boolean" as const, probability: 0.5 },
                reportsLimitation: { type: "boolean" as const, probability: 0 }
              },
              latencyMs
            }
          })
      }))
    const original = await attempt(records, counting(7))
    const replay = await attempt(records, counting(9_999))
    expect(of(original, "decision-settled")).toHaveLength(1)
    expect(of(replay, "decision-settled")).toEqual(of(original, "decision-settled"))
    expect(requests).toBe(1)
  })

  it("replays a judgement recorded before decisions existed as one with no decision to report", async () => {
    const records = new Map<string, unknown>()
    await attempt(records, confidentEvaluator)
    const key = [...records.keys()].find((name) => name.startsWith("completion-judgement"))!
    const { decision: _decision, ...legacy } = records.get(key) as Record<string, unknown>
    records.set(key, legacy)

    const replay = await attempt(records, Evaluator.layerUnavailable())
    // Explicitly unavailable: the old reading is still reported, and nothing
    // is reconstructed for the record it never wrote.
    expect(of(replay, "claim-demanded")).toHaveLength(1)
    expect(of(replay, "decision-settled")).toEqual([])
    expect(of(replay, "resolved")).toHaveLength(1)
  })
})
