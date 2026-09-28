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
 * A fetch that never follows a redirect. A provider 3xx rejects the call, so
 * a custom key header such as x-api-key cannot ride a redirect to another
 * origin; fetch strips only Authorization on a cross-origin hop.
 */
const refusingRedirects = (base: typeof globalThis.fetch): typeof globalThis.fetch => {
  const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await base(input, { ...init, redirect: "manual" })
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel()
      throw new Error("model provider redirect refused")
    }
    return response
  }) as typeof globalThis.fetch
  return guarded
}

/**
 * Single-owner resolver for the packaged local host. It plans the configured
 * binding before reading exactly one named credential from the host
 * environment. A request may choose another model only on the configured
 * binding's credential and origin, and provider redirects are refused.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const environmentModelResolver = (options: EnvironmentModelResolverOptions): ModelTurnResolver => (grant) => {
  const credentials = hostModelCredentials(options.env)
  const configured = planModelBinding(options.binding, credentials, { kind: "generation" })
  // The wire may carry null for an absent model, as the Go resolver reads it.
  const requested: unknown = grant.request.model ?? undefined
  const planned = requested === undefined
    ? configured
    : planModelBinding(requested, credentials, { kind: "generation" })
  if (
    !configured.ok || !planned.ok || planned.plan.credential !== configured.plan.credential ||
    planned.plan.origin !== configured.plan.origin
  ) return Effect.fail(new ResolveFailed({ message: "configured model is unavailable" }))
  const credential = options.env[modelCredentialEnvName(planned.plan.credential)]?.trim()
  if (credential === undefined || credential === "") {
    return Effect.fail(new ResolveFailed({ message: "configured model credential is unavailable" }))
  }
  const transport = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, refusingRedirects(options.fetchImpl ?? globalThis.fetch)))
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
