/**
 * Provider-neutral embeddings used by semantic memory recall.
 *
 * No embedding provider ships with Smithers, so a host injects one through
 * {@link layer}. The built-in {@link inProcessVector} hashes characters into
 * 64 buckets: it is deterministic and lexical, not semantic, and exists for
 * tests and offline runs.
 *
 * @see https://memory.smithers.sh/reference/api/
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as MemoryError from "./MemoryError.ts"

/**
 * A vector returned by an embedding provider.
 *
 * @category models
 * @since 0.1.0
 */
export interface EmbedResponse {
  readonly vector: ReadonlyArray<number>
}

/**
 * Ordered batch embedding response.
 *
 * @category models
 * @since 0.1.0
 */
export interface EmbedManyResponse {
  readonly embeddings: ReadonlyArray<EmbedResponse>
}

/**
 * Injectable provider function.
 *
 * @category models
 * @since 0.1.0
 */
export type EmbedMany = (
  inputs: ReadonlyArray<string>
) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, MemoryError.MemoryError>

/**
 * Embedding service shape, mirroring the unstable Effect EmbeddingModel
 * single-input and ordered batched operations.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  readonly embed: (input: string) => Effect.Effect<EmbedResponse, MemoryError.MemoryError>
  readonly embedMany: (inputs: ReadonlyArray<string>) => Effect.Effect<EmbedManyResponse, MemoryError.MemoryError>
}

/**
 * Context tag for embeddings.
 *
 * @category services
 * @since 0.1.0
 */
export class Embedding extends Context.Service<Embedding, Service>()("flows/memory/Embedding") {}

const unavailable = (message: string): MemoryError.MemoryError =>
  new MemoryError.MemoryError({ code: "embedding_unavailable", message })

const validate = (
  inputs: ReadonlyArray<string>,
  vectors: ReadonlyArray<ReadonlyArray<number>>
): Effect.Effect<EmbedManyResponse, MemoryError.MemoryError> => {
  const invalid = () => Effect.fail(unavailable("embedding provider returned an invalid batch"))
  const dimensions = vectors[0]?.length
  if (vectors.length !== inputs.length || dimensions === undefined || dimensions === 0) return invalid()
  const embeddings: Array<EmbedResponse> = []
  // Array iterators visit missing slots, unlike some/map. Validate the same
  // components that are copied so a sparse provider response cannot become data.
  for (const vector of vectors) {
    if (vector === undefined || vector.length !== dimensions) return invalid()
    const values: Array<number> = []
    for (const value of vector) {
      if (!Number.isFinite(value)) return invalid()
      values.push(value)
    }
    embeddings.push({ vector: values })
  }
  return Effect.succeed({ embeddings })
}

/**
 * Builds the service from an injectable batch provider.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (embedMany: EmbedMany): Service => {
  const service: Service = {
    embed: (input) =>
      service.embedMany([input]).pipe(
        Effect.flatMap((response) => {
          const embedding = response.embeddings[0]
          return embedding === undefined
            ? Effect.fail(unavailable("embedding provider returned an empty batch"))
            : Effect.succeed(embedding)
        })
      ),
    embedMany: (inputs) =>
      inputs.length === 0
        ? Effect.succeed({ embeddings: [] })
        : embedMany(inputs).pipe(Effect.flatMap((vectors) => validate(inputs, vectors)))
  }
  return Embedding.of(service)
}

/**
 * Provides an injectable embedding provider.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (embedMany: EmbedMany): Layer.Layer<Embedding> => Layer.succeed(Embedding)(make(embedMany))

/**
 * Constructs a provider that reports unavailable embeddings.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): Service => make(() => Effect.fail(unavailable("no embedding provider is configured")))

/**
 * Provides the unavailable embedding implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Embedding> = Layer.succeed(Embedding)(makeNoop())

/**
 * Provides a deterministic embedding implementation for tests and local
 * integrations.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerFake = (
  vectors: ReadonlyArray<ReadonlyArray<number>> | ((input: string, index: number) => ReadonlyArray<number>)
): Layer.Layer<Embedding> =>
  layer((inputs) =>
    Effect.succeed(
      inputs.map((input, index) => typeof vectors === "function" ? vectors(input, index) : vectors[index] ?? [])
    )
  )

/**
 * Stable model identity for the built-in projection.
 *
 * @category constants
 * @since 0.1.0
 */
export const inProcessModel = "flows-embedding/in-process-v1"

/**
 * Computes the deterministic local v1 vector: a character hash, so texts
 * rank close when they share characters, not meaning.
 *
 * @category constructors
 * @since 0.1.0
 */
export const inProcessVector = (input: string): ReadonlyArray<number> => {
  const vector = new Array<number>(64).fill(0)
  const normalized = input.normalize("NFKC").toLowerCase()
  for (const [index, character] of [...normalized].entries()) {
    const code = character.codePointAt(0) ?? 0
    const bucket = Math.abs(Math.imul(code + index, 16777619)) % vector.length
    vector[bucket] = (vector[bucket] ?? 0) + (index % 2 === 0 ? 1 : -1)
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude)
}

/**
 * Constructs the deterministic, in-process v1 embedding implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeInProcess = (): Service => make((inputs) => Effect.succeed(inputs.map(inProcessVector)))

/**
 * Provides deterministic in-process embeddings with no provider dependency.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerInProcess: Layer.Layer<Embedding> = Layer.succeed(Embedding)(makeInProcess())
