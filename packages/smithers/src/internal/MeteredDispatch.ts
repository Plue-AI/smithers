/**
 * Names the native engine dispatch each model call runs under on requests to
 * the install's metered model proxy (`SMITHERS_MODEL_PROXY_URL`), so the
 * install prices every monitor step from the proxy's own rows (T-FLW-07).
 *
 * The header is applied as a request leaves: it never enters a prepared
 * request or a sealed-step key, so a replay is served the same step. Requests
 * to any other origin, and calls outside an engine dispatch, are unchanged.
 *
 * @since 1.0.0
 */
import { digestSync } from "@smthrs/crypto"
import * as Action from "@smthrs/flow/Action"
import * as FlowRuntime from "@smthrs/flow/FlowRuntime"
import type * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Option } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

/**
 * The proxy reads this header only from a flow host credential.
 *
 * @category constants
 * @since 1.0.0
 */
export const header = "X-Smithers-Native-Step"

const executionPattern = /^[A-Za-z0-9._/@#-]{1,256}$/

/**
 * `<execution id>:<step key digest>` of the dispatch running now, when there
 * is one. The digest is the engine's own `stepKeyDigest` for the invocation.
 *
 * @category getters
 * @since 1.0.0
 */
export const currentDispatch: Effect.Effect<string | undefined> = Effect.gen(function*() {
  const instance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
  const key = yield* Action.CurrentInvocationKey
  if (Option.isNone(instance) || key === undefined || !executionPattern.test(instance.value.executionId)) {
    return undefined
  }
  return `${instance.value.executionId}:${digestSync(key)}`
})

const proxyOf = (proxy: string | undefined): string | undefined => {
  const base = proxy?.trim().replace(/\/+$/, "")
  return base === undefined || base === "" ? undefined : base
}

/**
 * `request`, naming the current dispatch when it goes to `proxy`.
 *
 * @category combinators
 * @since 1.0.0
 */
export const attributeRequest = (
  request: HttpClientRequest.HttpClientRequest,
  proxy: string | undefined
): Effect.Effect<HttpClientRequest.HttpClientRequest> => {
  const base = proxyOf(proxy)
  if (base === undefined || (request.url !== base && !request.url.startsWith(`${base}/`))) return Effect.succeed(request)
  return Effect.map(currentDispatch, (step) =>
    step === undefined ? request : HttpClientRequest.setHeader(request, header, step))
}

/**
 * `executor`, naming the current dispatch on every request to `proxy`.
 *
 * @category combinators
 * @since 1.0.0
 */
export const attributeExecutor = (
  executor: RequestExecutor.RequestExecutor,
  proxy: string | undefined
): RequestExecutor.RequestExecutor =>
  proxyOf(proxy) === undefined ? executor : {
    execute: (request, options) =>
      Effect.flatMap(attributeRequest(request, proxy), (attributed) => executor.execute(attributed, options))
  }

/**
 * `client`, naming the current dispatch on every request to `proxy`.
 *
 * @category combinators
 * @since 1.0.0
 */
export const attributeClient = <E, R>(
  client: HttpClient.HttpClient.With<E, R>,
  proxy: string | undefined
): HttpClient.HttpClient.With<E, R> =>
  proxyOf(proxy) === undefined ? client : HttpClient.mapRequestEffect(client, (request) => attributeRequest(request, proxy))
