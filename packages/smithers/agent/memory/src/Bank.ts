/**
 * Validating public bank-name constructors.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import { resolveNamespace } from "./internal/ResolveNamespace.ts"
import type * as MemoryError from "./MemoryError.ts"
import type * as Namespace from "./Namespace.ts"

/**
 * Parses a public bank name into a validated structured namespace.
 *
 * This is the validating counterpart to `Recall.namespaceForBank` and rejects
 * an empty bank with `invalid_namespace`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const parse = (bank: string): Effect.Effect<Namespace.Namespace, MemoryError.MemoryError> =>
  resolveNamespace(bank).pipe(Effect.map(({ namespace }) => namespace))
