/**
 * Identifies the owner and requested configuration of a crash-left machine.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import { providerFailure } from "./localProcess.ts"

/** A stable SHA-256 fingerprint, encoded to fit a Kubernetes label value.
 * @since 0.1.0
 * @private
 */
export const configurationFingerprint = (configuration: unknown) =>
  Effect.tryPromise({
    try: async () => {
      const canonical = JSON.stringify(configuration, (_key, value) =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
          : value)
      const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
      return "v1-" + btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
    },
    catch: providerFailure("unavailable", "could not fingerprint the sandbox configuration")
  })
