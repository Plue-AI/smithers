/**
 * Pass typed output from a research action into a writing action.
 *
 * Both steps use `AgentAction.make`. The research step returns a summary and key
 * points; the writing step consumes those fields. The output schema is included
 * in the agent's instructions and validates its final answer, with a bounded
 * correction attempt for invalid output.
 *
 * `AgentAction.Host` supplies the callable registry and sandbox budget.
 * `SeatResolver` supplies a scripted model, so this example needs no provider
 * credential.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

const ResearchResult = Schema.Struct({
  summary: Schema.String,
  keyPoints: Schema.Array(Schema.String)
})

const ArticleResult = Schema.Struct({
  article: Schema.String,
  wordCount: Schema.Number
})

/** The research step: a model call whose answer must be a `ResearchResult`. */
export const Research = AgentAction.make("examples/Research", {
  payload: { topic: Schema.String },
  output: ResearchResult,
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You are a research assistant. Provide concise, accurate summaries."],
  prompt: ({ topic }) => `Research the topic "${topic}" and report what matters about it.`
})

/** The writing step, which consumes the first step's typed fields. */
export const Write = AgentAction.make("examples/Write", {
  payload: {
    summary: Schema.String,
    keyPoints: Schema.Array(Schema.String)
  },
  output: ArticleResult,
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You are a technical writer. Write clear, engaging content."],
  prompt: ({ keyPoints, summary }) =>
    `Write a short article from this research.\n\nSummary: ${summary}\n\nKey points:\n${
      keyPoints.map((point) => `- ${point}`).join("\n")
    }`
})

/**
 * The workflow. Nothing executes at plan time: `Research.call` records one
 * node, and `Node.bindPlanned` feeds its planned result into `Write.call`.
 */
export const SimpleWorkflow = Flow.make("examples/SimpleWorkflow", {
  payload: { topic: Schema.String },
  success: ArticleResult,
  error: AgentAction.AgentFailure,
  body: ({ topic }) =>
    Research.call({ topic }).pipe(
      Node.bindPlanned((research) => Write.call({ summary: research.summary, keyPoints: research.keyPoints }))
    )
})

const prepared: Route.PreparedRequest = {
  routeId: "examples",
  protocolId: "examples",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

/**
 * A scripted model: it answers each call with one fenced `cell` block.
 *
 * A cell does not return its transition. It runs in a REPL realm that outlives
 * the frame and states its intent by calling: `ctx.done(output)` completes the
 * run, `ctx.park(reason, message)` waits durably, and a cell that calls neither
 * gets another frame. The host renders a structured `output` as canonical JSON,
 * which is the text the declared schema decodes. A real seat streams the same
 * events from a provider.
 *
 * The research answer is a parameter, and every writing request is reported to
 * `onWriterRequest`. The writing step is selected by its instruction, which a
 * run that dropped the research fields would still carry, so the reported
 * request text is where the handoff is actually visible.
 */
const scripted = (
  research: typeof ResearchResult.Type,
  onWriterRequest: (asked: string) => void
): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        // The loop keeps the task in a stable system prefix and rebuilds the
        // message tail every frame, so both halves of the request have to be read
        // to see what was asked, which is what a real model does too.
        const asked = [
          ...request.system.map((part) => part.text),
          ...request.messages.flatMap((message) =>
            message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          )
        ].join("\n")
        const writing = asked.includes("Write a short article")
        if (writing) onWriterRequest(asked)
        const answer = writing
          ? {
            article: "Durable workflows survive restarts because their steps are recorded, not remembered.",
            wordCount: 12
          }
          : research
        const cell = `ctx.done(${JSON.stringify(answer)})`
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })

/**
 * The host: one registry and one sandbox budget, shared by every model-backed
 * action in the composition.
 */
const host = AgentAction.layerHost({
  registry: Registry.makeNoop({
    list: () => Effect.succeed([]),
    visible: () => Effect.succeed([]),
    getOption: () => Effect.succeed(Option.none())
  }),
  limits: { calls: 8 },
  capabilityEnvelope: [],
  maxFrames: 4
})

/**
 * The credentialed half, and the only seam between this deterministic run and a
 * live one: every declared seat resolves to the scripted model above. A real
 * host answers with a provider route and a real context window instead.
 */
const seats = (model: Model.Model) =>
  SeatResolver.layer({
    resolve: (id) =>
      Effect.succeed(
        Seat.make({
          id,
          modelId: Seat.modelIdOf(id),
          model,
          route: { prepare: () => Effect.succeed(prepared) },
          contextWindowTokens: 200_000
        })
      )
  })

const SimpleWorkflowLayer = (model: Model.Model) =>
  Layer.mergeAll(
    Research.layer,
    Write.layer,
    Interpreter.layer(SimpleWorkflow)
  ).pipe(
    // The agent itself is the production loop; only the host services around it
    // are scripted.
    Layer.provideMerge(Layer.mergeAll(host, seats(model), Agent.layer)),
    // Pointing the resolver at a provider should park reset-bearing refusals.
    // This standalone flow has no approved envelope from which to derive a cap.
    // eslint-disable-next-line no-restricted-syntax -- this standalone flow has no approved envelope
    Layer.provideMerge(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded())),
    // The sandbox a cell's code runs in and the steering source it drains. Both
    // are browser-safe defaults; a host that accepts mid-run messages provides
    // its own `Steering.layer` instead.
    Layer.provideMerge(Agent.layerDefaults),
    // The completion brake judges every claim, and never falls back to the
    // model. This example scripts the judge the way it scripts the seat, so it
    // still needs no key. A host with a resolved seat binds
    // `Evaluator.layerFromSeat(judgeSeat)` instead.
    Layer.provideMerge(
      ScriptedJudge.layer
    ),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

/** What one run observed: the typed article, and every request the writing step was given. */
export interface Handoff {
  readonly article: typeof ArticleResult.Type
  readonly writerPrompts: ReadonlyArray<string>
}

/** The research answer the default run reports. */
export const defaultResearch: typeof ResearchResult.Type = {
  summary: "Durable workflows record every step so a restart resumes instead of repeating.",
  keyPoints: ["steps are journaled", "replay is deterministic"]
}

/**
 * Runs the workflow against one research answer.
 *
 * The article is `ArticleResult`-typed all the way out: no caller parses model
 * text. The reported writing requests carry the fields `Write.call` passed on,
 * which is the handoff this example is about. `orDie` runs after the layer is
 * provided, so a sandbox that fails to build is a defect here too rather than
 * an error the caller has to handle.
 */
export const run = (
  research: typeof ResearchResult.Type,
  executionId: string
): Effect.Effect<Handoff> =>
  Effect.gen(function*() {
    const writerPrompts: Array<string> = []
    const article = yield* SimpleWorkflow.execute({ topic: "durable workflows" }, { executionId }).pipe(
      Effect.provide(SimpleWorkflowLayer(scripted(research, (asked) => writerPrompts.push(asked))))
    )
    return { article, writerPrompts } satisfies Handoff
  }).pipe(Effect.orDie)

/** The default run: the research answer above, handed to the writing step. */
export const main: Effect.Effect<Handoff> = run(defaultResearch, "agent-step-1")
