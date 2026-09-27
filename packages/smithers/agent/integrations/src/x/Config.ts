/**
 * X (Twitter) client configuration and resolution.
 *
 * The client speaks API v2 with an OAuth 2.0 user-context bearer token, the
 * kind that can read mentions and direct messages for the account that
 * granted it. Like Gmail, the token never comes from the environment: the host
 * resolves the connection's credential through its broker and hands the
 * client an `AccessTokenSource`. The environment may still name the API
 * origin, for a fixture server.
 *
 * @since 1.0.0
 */

import { Duration } from "effect"
import type { AccessTokenSource } from "../core/AccessToken.ts"
import type { Connection } from "../core/Connection.ts"
import * as Environment from "../Environment.ts"

/**
 * The provider name an X connection carries.
 *
 * @category constants
 * @since 1.0.0
 */
export const PROVIDER = "x"

/**
 * The public API v2 base URL.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_API_BASE_URL = "https://api.x.com/2"

/**
 * The default deadline for one attempt, covering the response headers and the
 * body read.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_REQUEST_TIMEOUT: Duration.Duration = Duration.seconds(30)

/**
 * The longest rate-limit wait the client sits out in process. X windows are
 * fifteen minutes long, so a longer wait fails at once as retryable, carrying
 * the wait, for a scheduler to honor.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_MAX_RETRY_AFTER: Duration.Duration = Duration.seconds(60)

/**
 * The default number of repeated attempts for a rate limit or a failed read.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_MAX_RETRIES = 3

/**
 * What a caller supplies.
 *
 * @category models
 * @since 1.0.0
 */
export interface XConfig {
  /** Where the bearer token comes from. Required: there is no ambient fallback. */
  readonly token: AccessTokenSource
  /**
   * The connection this client acts for. Its provider must be `x`; its scopes
   * gate every operation, and its id stamps records and receipts.
   */
  readonly connection?: Connection | undefined
  /**
   * API base URL, for a fixture server. Falls back to the connection's
   * `apiBaseUrl`, then `SMITHERS_X_API_BASE_URL`.
   */
  readonly apiBaseUrl?: string | undefined
  /** Repeated attempts for a rate limit or a failed read. Defaults to 3, at most 10. */
  readonly maxRetries?: number | undefined
  /** Deadline for one attempt, headers and body. Defaults to 30 seconds. */
  readonly requestTimeout?: Duration.Input | undefined
  /** The longest rate-limit wait sat out in process. Defaults to 60 seconds. */
  readonly maxRetryAfter?: Duration.Input | undefined
}

/**
 * A config with every fallback applied.
 *
 * @category models
 * @since 1.0.0
 */
export interface ResolvedXConfig {
  readonly token: AccessTokenSource
  readonly connection: Connection | undefined
  readonly apiBaseUrl: string
  readonly maxRetries: number
  readonly requestTimeout: Duration.Input
  readonly maxRetryAfter: Duration.Input
}

const firstNonEmpty = (candidates: ReadonlyArray<string | undefined>): string | undefined => {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim()
  }
  return undefined
}

/**
 * Resolves configuration: explicit values, then the connection, then `env`.
 *
 * `env` replaces the ambient environment rather than layering over it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const resolve = (
  config: XConfig,
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): ResolvedXConfig => ({
  token: config.token,
  connection: config.connection,
  apiBaseUrl: firstNonEmpty([config.apiBaseUrl, config.connection?.apiBaseUrl, env["SMITHERS_X_API_BASE_URL"]]) ??
    DEFAULT_API_BASE_URL,
  maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
  requestTimeout: config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT,
  maxRetryAfter: config.maxRetryAfter ?? DEFAULT_MAX_RETRY_AFTER
})
