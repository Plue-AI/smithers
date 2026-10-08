/**
 * Names the native engine dispatch each model call runs under on requests to
 * the install's metered model proxy, so the monitor prices every step from
 * the proxy's own rows (T-FLW-07).
 *
 * The header is applied as the request leaves the executor: it never enters a
 * prepared request or a sealed-step key, so a replay is served the same step.
 * Requests to any other origin, and calls outside an engine dispatch, are sent
 * unchanged.
 */
import * as Digest from "@smthrs/core/Digest"
import * as Action from "@smthrs/flow/Action"
import * as FlowRuntime from "@smthrs/flow/FlowRuntime"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer, Option } from "effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

/** The proxy reads this header only from a flow host credential. */
export const header = "X-Smithers-Native-Step"

const executionPattern = /^[A-Za-z0-9._/@#-]{1,256}$/

/** `<execution id>:<step key digest>` of the dispatch running now, when there is one. */
export const currentDispatch: Effect.Effect<string | undefined> = Effect.gen(function*() {
  const instance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
  const key = yield* Action.CurrentInvocationKey
  if (Option.isNone(instance) || key === undefined || !executionPattern.test(instance.value.executionId)) {
    return undefined
  }
  return `${instance.value.executionId}:${Digest.digest(key)}`
})

const onProxy = (url: string, proxy: string): boolean => {
  const base = proxy.replace(/\/+$/, "")
  return url === base || url.startsWith(`${base}/`)
}

/** `executor`, naming the current dispatch on every request to `proxy`. */
export const attribute = (
  executor: RequestExecutor.RequestExecutor,
  proxy: string | undefined
): RequestExecutor.RequestExecutor =>
  proxy === undefined || proxy.trim() === "" ? executor : {
    execute: (request, options) =>
      Effect.flatMap(currentDispatch, (step) =>
        step === undefined || !onProxy(request.url, proxy)
          ? executor.execute(request, options)
          : executor.execute(HttpClientRequest.setHeader(request, header, step), options))
  }

/** `base`, attributed to the proxy the host's environment names. */
export const layer = (
  base: Layer.Layer<RequestExecutor.RequestExecutor>,
  proxy: string | undefined
): Layer.Layer<RequestExecutor.RequestExecutor> =>
  proxy === undefined || proxy.trim() === "" ? base : Layer.effect(
    RequestExecutor.RequestExecutor,
    Effect.map(RequestExecutor.RequestExecutor, (executor) => attribute(executor, proxy))
  ).pipe(Layer.provide(base))
