/** Host composition reuses model routing and the existing runtime store. */
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import type * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Action, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as EgressHttpClient from "@smthrs/platform-node/EgressHttpClient"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer } from "effect"
import { checkCitations, unsupportedCitations } from "./jev-citations.ts"
import { operations } from "./operations.ts"
import { WikiError } from "./schema.ts"
import Wiki from "./flow.ts"
import { Assess, CheckCitations, Collect, ReviewPage, ValidateReview, Write } from "./workflow.ts"

/** Select a real judge or refuse composition before opening host resources.
 * Offline hosts pass an evidence-based scripted evaluator explicitly. The
 * gateway is reached over the egress proxy this process's environment names,
 * so the judge works inside a sandbox whose only way out is that proxy. */
export const hostEvaluator = (): Layer.Layer<Evaluator.Evaluator> =>
  Evaluator.layerFromEnvironment(process.env, "smithers wiki").pipe(Layer.provide(EgressHttpClient.layer(process.env)))

export const agentLayers = (
  seats: Layer.Layer<SeatResolver.SeatResolver>,
  maxReviewMillis: number,
  evaluator: Layer.Layer<Evaluator.Evaluator> = hostEvaluator()
) => {
  const host = Layer.effect(AgentAction.Host, Effect.gen(function*() {
    const registry = yield* Registry.Registry
    return { registry, limits: { memoryBytes: 128 * 1024 * 1024, steps: 25_000_000, calls: 8 }, capabilityEnvelope: [], maxFrames: 8, defaultCorrections: 2, judged: true }
  })).pipe(Layer.provide(Registry.layerFromDescriptors([])))
  return ReviewPage.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(host, seats, Agent.layer)),
    Layer.provideMerge(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layer({ latency: { maxMillis: maxReviewMillis, onExceeded: "fail" } }))),
    Layer.provideMerge(Agent.layerDefaults),
    Layer.provideMerge(evaluator)
  )
}
export const registration = (options: { readonly root: string; readonly output: string; readonly evaluator: Layer.Layer<Evaluator.Evaluator> }, reviewers: ReturnType<typeof agentLayers>) =>
  Layer.mergeAll(actionLayers(options), reviewers, Interpreter.layer(Wiki)).pipe(Layer.provideMerge(Action.layerImplementations))

/** Verified hosts select their judge before any resources open. Preview has
 * no agent or semantic verification path; a test supplies a scripted judge. */
export const actionLayers = (options: Parameters<typeof operations>[0] & {
  readonly verify?: boolean
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
}) => {
  const ops = operations(options)
  return Layer.mergeAll(Collect.toLayer(({ spec }) => ops.collect(spec)), Assess.toLayer(ops.assess),
    ValidateReview.toLayer(({ evidence, review }) => review === null
      ? Effect.fail(new WikiError({ code: "review-failed", message: "Semantic validation requires a review" }))
      : ops.assess({ evidence, review, reviewer: null }).pipe(Effect.map(page => page.review!))),
    options.verify === false ? CheckCitations.toLayer(() => Effect.fail(new WikiError({ code: "review-failed", message: "A preview host cannot verify citations" }))) : CheckCitations.toLayer(({ evidence, review }) => checkCitations(evidence, review).pipe(
      Effect.flatMap(citations => citations.verdict === "unsupported"
        ? Effect.fail(unsupportedCitations(evidence, citations)) : Effect.succeed({ review, citations }))
    )).pipe(Layer.provide(options.evaluator ?? hostEvaluator())),
    Write.toLayer(({ pages, mode }) => ops.write(Object.keys(pages).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))).map((key) => pages[key]!), mode)))
}
