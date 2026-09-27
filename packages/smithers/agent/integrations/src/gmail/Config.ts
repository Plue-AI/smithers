/**
 * Gmail client configuration and resolution.
 *
 * A Gmail connection is a person's own mailbox, so its bearer token never
 * comes from the environment: the host resolves the connection's credential
 * through its broker and hands the client an `AccessTokenSource`, which is
 * where an OAuth refresh happens. The environment may still name the API
 * origin, for a fixture server.
 *
 * Binding a `Connection` gives the client the connection id its receipts and
 * records carry, and the scopes the provider actually granted, so an
 * operation the grant does not cover fails as `permission-denied` before any
 * request is sent.
 *
 * @since 1.0.0
 */

import { Duration } from "effect"
import type { AccessTokenSource } from "../core/AccessToken.ts"
import type { Connection } from "../core/Connection.ts"
import * as Environment from "../Environment.ts"

/**
 * The provider name a Gmail connection carries.
 *
 * @category constants
 * @since 1.0.0
 */
export const PROVIDER = "gmail"

/**
 * The public Gmail API origin.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_API_BASE_URL = "https://gmail.googleapis.com"

/**
 * The mailbox a client reads and writes when none is named: the account the
 * token belongs to.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_USER_ID = "me"

/**
 * The default deadline for one attempt, covering the response headers and the
 * body read.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_REQUEST_TIMEOUT: Duration.Duration = Duration.seconds(30)

/**
 * The longest rate-limit wait the client sits out in process. A longer one
 * fails at once as retryable, carrying the wait, so a scheduler can come back
 * later instead of a call holding its caller.
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
export interface GmailConfig {
  /** Where the bearer token comes from. Required: there is no ambient fallback. */
  readonly token: AccessTokenSource
  /**
   * The connection this client acts for. Its provider must be `gmail`; its
   * scopes gate every operation, and its id stamps records and receipts.
   */
  readonly connection?: Connection | undefined
  /**
   * API origin, for a fixture server. Falls back to the connection's
   * `apiBaseUrl`, then `SMITHERS_GMAIL_API_BASE_URL`.
   */
  readonly apiBaseUrl?: string | undefined
  /** The mailbox, `me` or the account's address. Defaults to `me`. */
  readonly userId?: string | undefined
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
export interface ResolvedGmailConfig {
  readonly token: AccessTokenSource
  readonly connection: Connection | undefined
  readonly apiBaseUrl: string
  readonly userId: string
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
  config: GmailConfig,
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): ResolvedGmailConfig => ({
  token: config.token,
  connection: config.connection,
  apiBaseUrl: firstNonEmpty([config.apiBaseUrl, config.connection?.apiBaseUrl, env["SMITHERS_GMAIL_API_BASE_URL"]]) ??
    DEFAULT_API_BASE_URL,
  userId: firstNonEmpty([config.userId]) ?? DEFAULT_USER_ID,
  maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
  requestTimeout: config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT,
  maxRetryAfter: config.maxRetryAfter ?? DEFAULT_MAX_RETRY_AFTER
})
