/** Host composition reuses model routing and the existing runtime store. */
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import type * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Action, Interpreter } from "@smthrs/flow"
import type * as Evaluator from "@smthrs/model/Evaluator"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer } from "effect"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import { evaluatorLayer } from "../repository/jev-checks.ts"
import Wiki from "./flow.ts"
import { checkCitations, unsupportedCitations } from "./jev-citations.ts"
import { operations } from "./operations.ts"
import { WikiError } from "./schema.ts"
import { Assess, CheckCitations, Collect, ReviewPage, ValidateReview, Write } from "./workflow.ts"

/** The same subscription judge and proxy-aware transport as the native host. */
export const hostEvaluator = (
  environment: Readonly<Record<string, string | undefined>>,
  jevHttp?: Layer.Layer<HttpClient.HttpClient>
): Layer.Layer<Evaluator.Evaluator> => evaluatorLayer(environment, jevHttp)

export const agentLayers = (
  seats: Layer.Layer<SeatResolver.SeatResolver>,
  maxReviewMillis: number,
  evaluator: Layer.Layer<Evaluator.Evaluator> = hostEvaluator(process.env)
) => {
  const host = Layer.effect(
    AgentAction.Host,
    Effect.gen(function*() {
      const registry = yield* Registry.Registry
      return {
        registry,
        limits: { memoryBytes: 128 * 1024 * 1024, steps: 25_000_000, calls: 8 },
        capabilityEnvelope: [],
        maxFrames: 8,
        defaultCorrections: 2,
        judged: true
      }
    })
  ).pipe(Layer.provide(Registry.layerFromDescriptors([])))
  return ReviewPage.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(host, seats, Agent.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        QuotaPolicy.layerDefault(),
        Budget.layer({ latency: { maxMillis: maxReviewMillis, onExceeded: "fail" } })
      )
    ),
    Layer.provideMerge(Agent.layerDefaults),
    Layer.provideMerge(evaluator)
  )
}
export const registration = (
  options: { readonly root: string; readonly output: string; readonly evaluator: Layer.Layer<Evaluator.Evaluator> },
  reviewers: ReturnType<typeof agentLayers>
) =>
  Layer.mergeAll(actionLayers(options), reviewers, Interpreter.layer(Wiki)).pipe(
    Layer.provideMerge(Action.layerImplementations)
  )

/** Verified hosts select their judge before any resources open. Preview has
 * no agent or semantic verification path; a test supplies a scripted judge. */
export const actionLayers = (
  options: Parameters<typeof operations>[0] & {
    readonly verify?: boolean
    readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
  }
) => {
  const ops = operations(options)
  return Layer.mergeAll(
    Collect.toLayer(({ spec }) => ops.collect(spec)),
    Assess.toLayer(ops.assess),
    ValidateReview.toLayer(({ evidence, review }) =>
      review === null
        ? Effect.fail(new WikiError({ code: "review-failed", message: "Semantic validation requires a review" }))
        : ops.assess({ evidence, review, reviewer: null }).pipe(Effect.map((page) => page.review!))
    ),
    options.verify === false ?
      CheckCitations.toLayer(() =>
        Effect.fail(new WikiError({ code: "review-failed", message: "A preview host cannot verify citations" }))
      ) :
      CheckCitations.toLayer(({ evidence, review }) =>
        checkCitations(evidence, review).pipe(
          Effect.flatMap((citations) =>
            citations.verdict === "unsupported"
              ? Effect.fail(unsupportedCitations(evidence, citations)) :
              Effect.succeed({ review, citations })
          )
        )
      ).pipe(Layer.provide(options.evaluator ?? hostEvaluator(process.env))),
    Write.toLayer(({ pages, mode }) =>
      ops.write(
        Object.keys(pages).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))).map((key) => pages[key]!),
        mode
      )
    )
  )
}
