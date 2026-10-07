/**
 * Resolves a local owner's configured model from a trusted process environment.
 *
 * @since 1.0.0-rc.0
 */

import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { hostModelCredentials, modelCredentialEnvName, planModelBinding } from "@smthrs/rpc/ConfiguredModel"
import type { ModelCredentialEnv } from "@smthrs/rpc/ConfiguredModel"
import { Effect, Layer, Redacted } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { toModel } from "./ConfiguredModelRoute.ts"
import { fastModelFallback } from "./FastModelFallback.ts"
import type { ModelTurnResolver } from "./HostServer.ts"
import { readContextStream } from "./internal/ContextStream.ts"
import { ResolveFailed } from "./ModelHostError.ts"

/**
 * Inputs for the single-owner environment-backed model resolver.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface EnvironmentModelResolverOptions {
  readonly binding: unknown
  /** Owner-resolved fast role; absent bindings reuse the resolved answer model. */
  readonly preflightBinding?: unknown
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
export const environmentModelResolver = (options: EnvironmentModelResolverOptions): ModelTurnResolver =>
(
  grant,
  selection
) => {
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
  const fastExecutor = Layer.effect(
    RequestExecutor.RequestExecutor,
    Effect.flatMap(
      KernelHttpClient.HttpClient,
      (http) => RequestExecutor.makeWith(RequestExecutor.fixed(http), { maxRetries: 0, responseStartMs: 9000 })
    )
  )
  const executorFor = (plan: import("@smthrs/rpc/ConfiguredModel").ModelPlan) =>
    plan.credential === "SMITHERS_FAST_PROXY" ? fastExecutor : RequestExecutor.layer
  return toModel(planned.plan, Redacted.make(credential)).pipe(
    Effect.provide(executorFor(planned.plan).pipe(Layer.provide(transport))),
    Effect.flatMap((model) =>
      Effect.gen(function*() {
        const withFallback = (
          primary: import("@smthrs/model/Model").Model,
          plan: import("@smthrs/rpc/ConfiguredModel").ModelPlan
        ) =>
          Effect.gen(function*() {
            if (plan.credential !== "SMITHERS_FAST_PROXY") return primary
            let bindings: unknown
            try {
              bindings = JSON.parse(options.env.SMITHERS_FAST_FALLBACK_MODELS ?? "[]")
            } catch {
              return yield* Effect.fail(new ResolveFailed({ message: "fast-model fallback unavailable" }))
            }
            if (!Array.isArray(bindings)) {
              return yield* Effect.fail(new ResolveFailed({ message: "fast-model fallback unavailable" }))
            }
            const sources: Array<
              { model: import("@smthrs/model/Model").Model; modelId: string; outputTokenLimitSupported?: boolean }
            > = [{ model: primary, modelId: plan.modelId }]
            for (const binding of bindings) {
              const fallback = planModelBinding(binding, credentials, { kind: "generation" })
              if (!fallback.ok) {
                return yield* Effect.fail(new ResolveFailed({ message: "fast-model fallback unavailable" }))
              }
              const key = options.env[modelCredentialEnvName(fallback.plan.credential)]?.trim()
              if (!key) return yield* Effect.fail(new ResolveFailed({ message: "fast-model fallback unavailable" }))
              const model = yield* toModel(fallback.plan, Redacted.make(key)).pipe(
                Effect.provide(fastExecutor.pipe(Layer.provide(transport)))
              )
              sources.push({
                model,
                modelId: fallback.plan.modelId,
                outputTokenLimitSupported: fallback.plan.protocol !== "openai-responses-chatgpt"
              })
            }
            return fastModelFallback(sources, (index) =>
              Effect.tryPromise({
                try: async (signal) => {
                  const endpoint = new URL(plan.baseUrl)
                  endpoint.pathname = endpoint.pathname.replace(/\/fast$/, "/fast/selected")
                  await refusingRedirects(options.fetchImpl ?? globalThis.fetch)(endpoint, {
                    method: "POST",
                    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
                    body: JSON.stringify({ index }),
                    signal
                  })
                },
                catch: () => undefined
              }).pipe(Effect.ignore))
          })
        const routedModel = yield* withFallback(model, planned.plan)
        const resolved = {
          model: routedModel,
          options: {
            modelId: planned.plan.modelId,
            ...(planned.plan.protocol === "openai-responses-chatgpt" ? { outputTokenLimitSupported: false } : {}),
            credential,
            ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens })
          }
        }
        // A selection-only request brings its own host-read input; a chat
        // turn's preflight reads authorized SharedEntries through the callback.
        if (grant.request.sharedConversation !== true && selection === undefined) return resolved
        const input = selection !== undefined ? selection : yield* Effect.tryPromise({
          try: async (signal) => {
            const response = await refusingRedirects(options.fetchImpl ?? globalThis.fetch)(
              new URL("/internal/chat/context", grant.producerBaseUrl),
              {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${grant.token}` },
                body: JSON.stringify({ turnId: grant.turnId, generation: grant.generation }),
                signal
              }
            )
            if (response.status !== 200) {
              await response.body?.cancel()
              throw new Error("context unavailable")
            }
            return readContextStream(response)
          },
          catch: () => new ResolveFailed({ message: "shared conversation context is unavailable" })
        })
        if (options.preflightBinding === undefined) return { ...resolved, preflight: { ...resolved, input } }
        // This binding is supplied by the host launcher, never by the prompt.
        // It may spend a different owner key, but keeps that key's own origin.
        const fast = planModelBinding(options.preflightBinding, credentials, { kind: "generation" })
        if (!fast.ok) return yield* Effect.fail(new ResolveFailed({ message: "preflight model is unavailable" }))
        const fastCredential = options.env[modelCredentialEnvName(fast.plan.credential)]?.trim()
        if (fastCredential === undefined || fastCredential === "") {
          return yield* Effect.fail(new ResolveFailed({ message: "preflight model credential is unavailable" }))
        }
        const fastModel = yield* toModel(fast.plan, Redacted.make(fastCredential)).pipe(
          Effect.provide(executorFor(fast.plan).pipe(Layer.provide(transport)))
        )
        const routedFast = yield* withFallback(fastModel, fast.plan)
        return {
          ...resolved,
          preflight: {
            input,
            model: routedFast,
            options: {
              modelId: fast.plan.modelId,
              ...(fast.plan.protocol === "openai-responses-chatgpt" ? { outputTokenLimitSupported: false } : {}),
              credential: fastCredential
            }
          }
        }
      })
    ),
    Effect.mapError(() => new ResolveFailed({ message: "configured model route is unavailable" }))
  )
}
