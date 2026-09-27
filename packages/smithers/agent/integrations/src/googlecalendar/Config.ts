/**
 * Google Calendar credential and endpoint resolution.
 *
 * Explicit configuration wins over the environment, and an environment passed
 * in replaces the ambient one rather than layering over it, the same rule the
 * other providers follow.
 *
 * A client needs a bearer token, and there are three ways to supply one, in
 * this order: an `AccessTokenSource` (such as `OAuthToken.make` over a stored
 * credential), a static access token, or an OAuth client id plus a refresh
 * token the client exchanges itself. The variables are:
 *
 * | Variable                                 | Meaning                                         |
 * | ---------------------------------------- | ----------------------------------------------- |
 * | `SMITHERS_GOOGLE_ACCESS_TOKEN`           | A static access token. Expires within the hour. |
 * | `SMITHERS_GOOGLE_CLIENT_ID`              | The OAuth client id.                            |
 * | `SMITHERS_GOOGLE_CLIENT_SECRET`          | The OAuth client secret, for a confidential app. |
 * | `SMITHERS_GOOGLE_REFRESH_TOKEN`          | A refresh token. Rotation is not persisted.     |
 * | `SMITHERS_GOOGLE_TOKEN_URL`              | The token endpoint, for a fixture server.       |
 * | `SMITHERS_GOOGLE_CALENDAR_API_BASE_URL`  | The API root, for a fixture server.             |
 *
 * None of them is ever logged.
 *
 * @since 1.0.0
 */

import { Duration } from "effect"
import type { AccessTokenSource } from "../core/AccessToken.ts"
import * as Environment from "../Environment.ts"

/**
 * The public Calendar API root.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_API_BASE_URL = "https://www.googleapis.com/calendar/v3"

/**
 * Google's OAuth 2.0 token endpoint.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token"

/**
 * The default deadline for one attempt, covering the response headers and the
 * body read.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_REQUEST_TIMEOUT: Duration.Duration = Duration.seconds(30)

/**
 * The OAuth scopes the operations in this package need.
 *
 * `events` reads and writes events, `readonly` reads events, and `freeBusy`
 * reads availability only.
 *
 * @category constants
 * @since 1.0.0
 */
export const SCOPES = {
  events: "https://www.googleapis.com/auth/calendar.events",
  readonly: "https://www.googleapis.com/auth/calendar.events.readonly",
  freeBusy: "https://www.googleapis.com/auth/calendar.freebusy"
} as const

const DEFAULT_MAX_RETRIES = 3

/**
 * What a caller may supply. Every field is optional; a request fails with
 * `credentials-missing` when no token source can be formed.
 *
 * @category models
 * @since 1.0.0
 */
export interface GoogleCalendarConfig {
  /** Where the client gets bearer tokens. Wins over every other credential field. */
  readonly tokens?: AccessTokenSource | undefined
  /** A static access token. Falls back to `SMITHERS_GOOGLE_ACCESS_TOKEN`. */
  readonly accessToken?: string | undefined
  /** The OAuth client id. Falls back to `SMITHERS_GOOGLE_CLIENT_ID`. */
  readonly clientId?: string | undefined
  /** The OAuth client secret. Falls back to `SMITHERS_GOOGLE_CLIENT_SECRET`. */
  readonly clientSecret?: string | undefined
  /** A refresh token. Falls back to `SMITHERS_GOOGLE_REFRESH_TOKEN`. */
  readonly refreshToken?: string | undefined
  /** The token endpoint. Falls back to `SMITHERS_GOOGLE_TOKEN_URL`, then Google's. */
  readonly tokenUrl?: string | undefined
  /** The API root. Falls back to `SMITHERS_GOOGLE_CALENDAR_API_BASE_URL`, then Google's. */
  readonly apiBaseUrl?: string | undefined
  /**
   * The calendars this client may touch. A request naming any other calendar
   * fails with `permission-denied` before it is sent, and an empty list
   * allows none. Omitted, every calendar the token can reach is allowed.
   */
  readonly allowedCalendars?: ReadonlyArray<string> | undefined
  /** Retries for rate-limited responses, and for a read's 5xx. Defaults to 3. */
  readonly maxRetries?: number | undefined
  /** Deadline for one attempt, headers and body. Defaults to 30 seconds. */
  readonly requestTimeout?: Duration.Input | undefined
}

/**
 * A config with every fallback applied.
 *
 * @category models
 * @since 1.0.0
 */
export interface ResolvedGoogleCalendarConfig {
  readonly tokens: AccessTokenSource | undefined
  readonly accessToken: string | undefined
  readonly clientId: string | undefined
  readonly clientSecret: string | undefined
  readonly refreshToken: string | undefined
  readonly tokenUrl: string
  readonly apiBaseUrl: string
  readonly allowedCalendars: ReadonlyArray<string> | undefined
  readonly maxRetries: number
  readonly requestTimeout: Duration.Input
}

const firstNonEmpty = (candidates: ReadonlyArray<string | undefined>): string | undefined => {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim()
  }
  return undefined
}

/**
 * Resolves configuration: explicit values, then `env`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const resolve = (
  config: GoogleCalendarConfig,
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): ResolvedGoogleCalendarConfig => ({
  tokens: config.tokens,
  accessToken: firstNonEmpty([config.accessToken, env["SMITHERS_GOOGLE_ACCESS_TOKEN"]]),
  clientId: firstNonEmpty([config.clientId, env["SMITHERS_GOOGLE_CLIENT_ID"]]),
  clientSecret: firstNonEmpty([config.clientSecret, env["SMITHERS_GOOGLE_CLIENT_SECRET"]]),
  refreshToken: firstNonEmpty([config.refreshToken, env["SMITHERS_GOOGLE_REFRESH_TOKEN"]]),
  tokenUrl: firstNonEmpty([config.tokenUrl, env["SMITHERS_GOOGLE_TOKEN_URL"]]) ?? DEFAULT_TOKEN_URL,
  apiBaseUrl: firstNonEmpty([config.apiBaseUrl, env["SMITHERS_GOOGLE_CALENDAR_API_BASE_URL"]]) ??
    DEFAULT_API_BASE_URL,
  allowedCalendars: config.allowedCalendars,
  maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
  requestTimeout: config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT
})
