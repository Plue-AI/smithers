/**
 * Where a provider client gets its bearer token.
 *
 * A static API token and a short-lived OAuth access token minted from a stored
 * refresh token reach the client the same way: through a source it asks each
 * time it needs one. The client never learns which, and never holds the
 * refresh token. A source that cannot produce a token fails with
 * `credentials-missing` (nothing configured) or `permission-denied` (the grant
 * was revoked), so a client can report the difference.
 *
 * @since 1.0.0
 */

import { Effect, type Redacted } from "effect"
import type { IntegrationError } from "./IntegrationError.ts"

/**
 * A provider of bearer tokens.
 *
 * @category models
 * @since 1.0.0
 */
export interface AccessTokenSource {
  /** The current access token, refreshed by the source when it expires. */
  readonly token: Effect.Effect<Redacted.Redacted<string>, IntegrationError>
  /**
   * Discards the cached token after the provider refused it, so the next
   * `token` mints a fresh one. A static source has nothing to discard.
   */
  readonly invalidate: Effect.Effect<void>
}

/**
 * A source that always answers the same token.
 *
 * @category constructors
 * @since 1.0.0
 */
export const fixed = (token: Redacted.Redacted<string>): AccessTokenSource => ({
  token: Effect.succeed(token),
  invalidate: Effect.void
})
