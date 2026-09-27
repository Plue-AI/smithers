/**
 * Shared validating bank and namespace resolution.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { MemoryError } from "../MemoryError.ts"
import * as Namespace from "../Namespace.ts"

/**
 * Maps a structured namespace to the public bank name recall accepts.
 * {@link namespaceForBank} is its inverse for every prefixed bank.
 *
 * @category constructors
 * @since 0.1.0
 */
export const bankForNamespace = (namespace: Namespace.Namespace): string => `${namespace.kind}-${namespace.id}`

/**
 * Performs the unvalidated syntactic inverse of {@link bankForNamespace}.
 * Prefixes preserve explicit lifetimes; an unprefixed bank is flow-local.
 * The returned `id` is intentionally typed as `string`, not
 * `Namespace.NonEmptyString`. Use {@link resolveNamespace} at every I/O
 * boundary.
 *
 * @category constructors
 * @since 0.1.0
 */
export const namespaceForBank = (
  bank: string
): { readonly kind: Namespace.Kind; readonly id: string } => {
  for (const kind of Namespace.Kind.literals) {
    const prefix = `${kind}-`
    if (bank.startsWith(prefix) && bank.length > prefix.length) {
      return { kind, id: bank.slice(prefix.length) }
    }
  }
  return { kind: "flow", id: bank }
}

/**
 * Resolves a structured namespace or public bank name.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolveNamespace = (
  input: Namespace.Namespace | string
): Effect.Effect<{ readonly namespace: Namespace.Namespace; readonly bank: string }, MemoryError> => {
  if (typeof input !== "string") {
    return Schema.decodeUnknownEffect(Namespace.Namespace)(input).pipe(
      Effect.mapError(() =>
        new MemoryError({
          code: "invalid_namespace",
          message: "memory namespace is invalid"
        })
      ),
      Effect.map((namespace) => ({ namespace, bank: bankForNamespace(namespace) }))
    )
  }
  if (input.length === 0) {
    return Effect.fail(new MemoryError({ code: "invalid_namespace", message: "memory bank must not be empty" }))
  }
  return Effect.succeed({ namespace: namespaceForBank(input), bank: input })
}

/**
 * Resolves and de-duplicates bank names by structured namespace, preserving
 * the first public spelling for result attribution.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolveBanks = (
  banks: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<{ readonly namespace: Namespace.Namespace; readonly bank: string }>, MemoryError> =>
  Effect.forEach(banks, resolveNamespace).pipe(
    Effect.map((resolved) => {
      const unique = new Map<string, { readonly namespace: Namespace.Namespace; readonly bank: string }>()
      for (const entry of resolved) {
        const identity = `${entry.namespace.kind}\u0000${entry.namespace.id}`
        if (!unique.has(identity)) unique.set(identity, entry)
      }
      return [...unique.values()]
    })
  )
