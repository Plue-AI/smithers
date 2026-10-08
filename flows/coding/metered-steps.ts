/**
 * The native coding host's request executor, naming the engine dispatch each
 * model call runs under on requests to the install's metered proxy (T-FLW-07).
 * The attribution itself is shared with the host's judge client
 * (packages/smithers/src/internal/MeteredDispatch.ts).
 */
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer } from "effect"
import * as MeteredDispatch from "../../packages/smithers/src/internal/MeteredDispatch.ts"

/** The proxy reads this header only from a flow host credential. */
export const header = MeteredDispatch.header

/** `executor`, naming the current dispatch on every request to `proxy`. */
export const attribute = MeteredDispatch.attributeExecutor

/** `base`, attributed to the proxy the host's environment names. */
export const layer = (
  base: Layer.Layer<RequestExecutor.RequestExecutor>,
  proxy: string | undefined
): Layer.Layer<RequestExecutor.RequestExecutor> =>
  proxy === undefined || proxy.trim() === "" ? base : Layer.effect(
    RequestExecutor.RequestExecutor,
    Effect.map(RequestExecutor.RequestExecutor, (executor) => attribute(executor, proxy))
  ).pipe(Layer.provide(base))
