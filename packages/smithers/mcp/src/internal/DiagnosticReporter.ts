/**
 * Internal optional-observer capture; never publishes an unredacted detail.
 *
 * @since 1.0.0-rc.0
 */

import { Effect, Option, Redacted } from "effect"
import * as Diagnostics from "../Diagnostics.ts"

/**
 * Captures the optional host observer without introducing a required service.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = (server: string) =>
  Effect.map(
    Effect.serviceOption(Diagnostics.Diagnostics),
    (observer) => (source: Diagnostics.Event["source"], detail: unknown): void => {
      if (Option.isNone(observer)) return
      try {
        const text = typeof detail === "string" ? detail : JSON.stringify(detail)
        const bytes = new TextEncoder().encode(text)
        const truncated = bytes.byteLength > 16_384
        observer.value.report({
          server,
          source,
          detail: Redacted.make(new TextDecoder().decode(bytes.subarray(0, 16_384), { stream: truncated })),
          truncated
        })
      } catch {
        // Observer failures are not MCP failures. Their messages can themselves
        // contain the diagnostic, so neither attach nor log the thrown value.
      }
    }
  )
