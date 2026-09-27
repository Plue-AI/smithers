/**
 * The one decoder from a planned model (@smthrs/rpc/ConfiguredModel) to the
 * real @smthrs/model stack: a generation plan becomes a Route, a decision plan
 * becomes an Evaluator layer. The plan never holds a value and the credential
 * arrives already Redacted, so nothing here can name one.
 *
 * Trusted host processes import this module; browser bundles do not carry the
 * kernel-backed model runtime.
 *
 * @since 1.0.0-rc.0
 */

import type * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Endpoint from "@smthrs/model/Endpoint"
import * as Evaluator from "@smthrs/model/Evaluator"
import type * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import type { ModelPlan } from "@smthrs/rpc/ConfiguredModel"
import { Effect, Result } from "effect"
import type { Layer, Redacted } from "effect"

/**
 * Visits a route without erasing its protocol-specific type parameters.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface RouteVisitor<A> {
  <Body, Frame, Event, State>(route: Route.Route<Body, Frame, Event, State>): A
}

/**
 * The plan's Route, handed to `visit`. `Route.anthropic` names its own origin,
 * so the plan's endpoint replaces it and the key header, the framing and the
 * `anthropic-version` header stay the package's own.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const withRoute = <A>(
  plan: ModelPlan,
  apiKey: Redacted.Redacted<string>,
  visit: RouteVisitor<A>
): Result.Result<A, ModelError> => {
  switch (plan.protocol) {
    case "anthropic-messages":
      return Result.flatMap(
        Route.anthropic({ apiKey }),
        (route) =>
          Result.map(
            Endpoint.make({ url: plan.baseUrl, path: plan.path }),
            (endpoint) => visit(Route.make({ ...route, id: plan.protocol, endpoint }))
          )
      )
    case "openai-responses":
      return Result.map(Route.openaiResponsesCompatible({ id: plan.protocol, baseUrl: plan.baseUrl, apiKey }), visit)
    case "openai-chat":
      return Result.map(
        Route.openaiChatCompatible({ id: plan.protocol, baseUrl: plan.baseUrl, path: plan.path, apiKey }),
        visit
      )
    case "evaluation":
      return Result.fail(new ModelError({ code: "no_route", message: "A decision model has no generation route" }))
  }
}

/**
 * Builds a model from a validated generation plan and redacted credential.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const toModel = (
  plan: ModelPlan,
  apiKey: Redacted.Redacted<string>
): Effect.Effect<Model.Model, ModelError, RequestExecutor.RequestExecutor> =>
  Effect.flatMap(Effect.fromResult(withRoute(plan, apiKey, (route) => Route.toModel(route))), (model) => model)

/**
 * Builds the evaluator layer for a validated decision model plan.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const toEvaluatorLayer = (
  plan: ModelPlan,
  apiKey: Redacted.Redacted<string>,
  timeoutMs: number
): Layer.Layer<Evaluator.Evaluator, never, KernelHttpClient.HttpClient> =>
  Evaluator.layerVercelGateway({ apiKey, model: plan.modelId, timeoutMs, baseUrl: plan.url })
