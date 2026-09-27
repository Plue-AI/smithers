/**
 * Resolves a local owner's configured model from a trusted process environment.
 *
 * @since 1.0.0-rc.0
 */

import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { hostModelCredentials, modelCredentialEnvName, planModelBinding } from "@smthrs/rpc/ConfiguredModel"
import type { ModelCredentialEnv } from "@smthrs/rpc/ConfiguredModel"
import { Effect, Layer, Redacted } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { toModel } from "./ConfiguredModelRoute.ts"
import type { ModelTurnResolver } from "./HostServer.ts"
import { ResolveFailed } from "./ModelHostError.ts"

/**
 * Inputs for the single-owner environment-backed model resolver.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface EnvironmentModelResolverOptions {
  readonly binding: unknown
  readonly env: ModelCredentialEnv
  readonly fetchImpl?: typeof globalThis.fetch
  readonly maxTokens?: number
}

/**
 * Single-owner resolver for the packaged local host. It plans an untrusted
 * binding before reading exactly one named credential from the host environment.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const environmentModelResolver = (options: EnvironmentModelResolverOptions): ModelTurnResolver => (grant) => {
  const binding: unknown = grant.request.model ?? options.binding
  const planned = planModelBinding(binding, hostModelCredentials(options.env), { kind: "generation" })
  if (!planned.ok) return Effect.fail(new ResolveFailed({ message: "configured model is unavailable" }))
  const credential = options.env[modelCredentialEnvName(planned.plan.credential)]?.trim()
  if (credential === undefined || credential === "") {
    return Effect.fail(new ResolveFailed({ message: "configured model credential is unavailable" }))
  }
  const guardedFetch = options.fetchImpl ?? globalThis.fetch
  const transport = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, guardedFetch))
  )
  return toModel(planned.plan, Redacted.make(credential)).pipe(
    Effect.provide(RequestExecutor.layer.pipe(Layer.provide(transport))),
    Effect.map((model) => ({
      model,
      options: {
        modelId: planned.plan.modelId,
        credential,
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens })
      }
    })),
    Effect.mapError(() => new ResolveFailed({ message: "configured model route is unavailable" }))
  )
}
