/**
 * Internal optional-observer capture. Every detail is redacted with
 * `Redaction.redact` (stderr by the transport, before its cap) and then
 * wrapped in `Redacted`.
 *
 * @since 1.0.0-rc.0
 */

import * as Redaction from "@smthrs/journal/Redaction"
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
        // A remote error can echo a credential and an argument snapshot can
        // carry one under a secret key, so every source is redacted here.
        // StdioTransport already redacts stderr BEFORE capping it to
        // `maxStderrBytes` (a cap first could cut a credential's recognizable
        // prefix); redacting its capped tail again would regrow it past the cap.
        const redacted = source === "stderr" ? detail : Redaction.redact(detail, { onTooDeep: "name" })
        const text = typeof redacted === "string" ? redacted : JSON.stringify(redacted)
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
