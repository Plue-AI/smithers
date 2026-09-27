/**
 * Spans and metrics for a service record whose members are Effects or
 * Effect-returning functions.
 *
 * Attributes carry shapes only: a namespace kind, a limit, a row count. Never
 * a key, a text, or a value.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"

/**
 * Memory store operations by method and outcome.
 *
 * @category metrics
 * @since 1.0.0
 */
export const operations = Metric.counter("smithers_memory_operations", {
  description: "MemoryStore operations by method and outcome"
})

const inputAttributes = (input: unknown): Record<string, unknown> => {
  if (typeof input !== "object" || input === null) return {}
  const attributes: Record<string, unknown> = {}
  const namespace = (input as { readonly namespace?: unknown }).namespace
  if (typeof namespace === "object" && namespace !== null) {
    const kind = (namespace as { readonly kind?: unknown }).kind
    if (typeof kind === "string") attributes["memory.namespace_kind"] = kind
  }
  const limit = (input as { readonly limit?: unknown }).limit
  if (typeof limit === "number") attributes["memory.limit"] = limit
  return attributes
}

const resultAttributes = (result: unknown): Record<string, unknown> =>
  Array.isArray(result)
    ? { "memory.rows": result.length }
    : typeof result === "number"
    ? { "memory.count": result }
    : {}

const observe = <A, E, R>(
  method: string,
  input: unknown,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.tap((result) => Effect.annotateCurrentSpan(resultAttributes(result))),
    Effect.onExit((exit) =>
      Metric.update(
        Metric.withAttributes(operations, { method, outcome: exit._tag === "Success" ? "success" : "failure" }),
        1
      )
    ),
    Effect.withSpan(`MemoryStore.${method}`, { attributes: inputAttributes(input) })
  )

/**
 * Wraps every member of `service` in a span named `MemoryStore.<method>` and
 * counts its outcome.
 *
 * @category constructors
 * @since 1.0.0
 */
export const instrument = <S extends object>(service: S): S => {
  const instrumented: Record<string, unknown> = {}
  for (const [method, member] of Object.entries(service)) {
    instrumented[method] = typeof member === "function"
      ? (input: unknown, ...rest: ReadonlyArray<unknown>) =>
        observe(method, input, (member as (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(input, ...rest))
      : Effect.isEffect(member)
      ? observe(method, undefined, member)
      : member
  }
  return instrumented as S
}
