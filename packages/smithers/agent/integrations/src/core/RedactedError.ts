/** @since 1.0.0 */

import { IntegrationError } from "./IntegrationError.ts"
import { redact } from "./Redact.ts"

/**
 * Constructs client errors only after removing credentials from every retained
 * field. Causes retain a message, never the upstream stack, nested causes, or
 * arbitrary properties that can contain request headers and response bodies.
 * @private
 * @since 1.0.0
 */
export const redactedError =
  (secrets: ReadonlyArray<string | undefined>) =>
  (...[reason, summary, details, options]: ConstructorParameters<typeof IntegrationError>): IntegrationError => {
    const seen = new WeakMap<object, unknown>()
    const sanitize = (value: unknown, redactKeys = true): unknown => {
      if (typeof value === "string") return redact(value, secrets)
      if (value === null || typeof value !== "object") return value
      if (value instanceof Error) return new Error(redact(value.message, secrets))
      if (seen.has(value)) return seen.get(value)
      if (Array.isArray(value)) {
        const result: Array<unknown> = []
        seen.set(value, result)
        for (const item of value) result.push(sanitize(item))
        return result
      }
      const result: Record<string, unknown> = {}
      seen.set(value, result)
      for (const [key, item] of Object.entries(value)) {
        Object.defineProperty(result, redactKeys ? redact(key, secrets) : key, {
          value: sanitize(item),
          enumerable: true,
          configurable: true,
          writable: true
        })
      }
      return result
    }
    // Top-level keys are client-owned classification fields (retryable,
    // outcomeUnknown, etc.), never provider text. Preserve their contract even
    // when a short configured credential coincides with part of a field name.
    const cause = options?.cause
    return new IntegrationError(reason, redact(summary, secrets), sanitize(details, false) as typeof details, {
      cause: cause === undefined
        ? undefined
        : new Error(redact(cause instanceof Error ? cause.message : String(cause), secrets))
    })
  }
