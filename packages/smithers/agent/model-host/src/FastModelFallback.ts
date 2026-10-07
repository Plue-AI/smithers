/** Host-selected fast-model fallbacks over the canonical model stream. */
import type * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import { ModelRequest } from "@smthrs/model/ModelRequest"
import { Effect, Stream } from "effect"

/** Retry another host-owned source only before any output became visible. */
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
      ): Stream.Stream<import("@smthrs/model/ModelEvent").ModelEvent, Model.ModelFailure> => {
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
