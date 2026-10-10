/**
 * Host-selected fast-model fallbacks over the canonical model stream.
 *
 * @since 1.0.0
 */

import type * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type { ModelEvent } from "@smthrs/model/ModelEvent"
import { ModelRequest } from "@smthrs/model/ModelRequest"
import { Effect, Stream } from "effect"

/**
 * Builds one model that streams from the first host-owned source and falls back
 * to the next only when a source fails as unavailable (authentication, rate limit,
 * quota, transport, call timeout or provider fault) before emitting any output.
 * A failure after output became visible, or on the last source, is returned as is.
 * `onFallback` runs with the index of the source about to be tried. With no
 * sources the stream fails with `no_route`.
 *
 * @since 1.0.0
 * @category constructors
 */
export const fastModelFallback = (
  sources: ReadonlyArray<
    { readonly model: Model.Model; readonly modelId: string; readonly outputTokenLimitSupported?: boolean }
  >,
  onFallback?: (index: number) => Effect.Effect<void>
): Model.Model => ({
  stream: (request) =>
    Stream.suspend(() => {
      if (sources.length === 0) {
        return Stream.fail(new ModelError({ code: "no_route", message: "Fast model unavailable" }))
      }
      const attempt = (
        index: number
      ): Stream.Stream<ModelEvent, Model.ModelFailure> => {
        const source = sources[index]!
        let emitted = false
        const { maxTokens: _maxTokens, ...unlimited } = request.params
        return source.model.stream(
          new ModelRequest({
            ...request,
            modelId: source.modelId,
            params: source.outputTokenLimitSupported === false ? unlimited : request.params
          })
        ).pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              emitted = true
            })
          ),
          Stream.catch((error) => {
            const unavailable = error._tag === "flows/model/ModelError" &&
              ["authentication", "rate_limited", "quota_exceeded", "transport", "call_timeout", "provider_internal"]
                .includes(error.code)
            return !emitted && unavailable && index + 1 < sources.length
              ? Stream.unwrap(Effect.as(onFallback?.(index + 1) ?? Effect.void, attempt(index + 1)))
              : Stream.fail(error)
          })
        )
      }
      return attempt(0)
    })
})
