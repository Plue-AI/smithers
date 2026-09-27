/**
 * Linear credential and endpoint resolution.
 *
 * Explicit configuration wins over the environment. As with GitHub, the 0.x
 * process-wide `configureLinear` registry is gone: it existed so JSX
 * components could find credentials they were never passed.
 *
 * @since 1.0.0
 */

import { Duration } from "effect"
import * as Environment from "../Environment.ts"

/**
 * The public GraphQL endpoint.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_API_BASE_URL = "https://api.linear.app/graphql"

/**
 * The default deadline for one attempt, covering the response headers and the
 * body read.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_REQUEST_TIMEOUT: Duration.Duration = Duration.seconds(30)

/**
 * What a caller may supply.
 *
 * @category models
 * @since 1.0.0
 */
export interface LinearConfig {
  /**
   * A personal API key, sent raw in `Authorization`; an OAuth token arrives
   * already prefixed. Falls back to `SMITHERS_LINEAR_API_KEY`. Never logged.
   */
  readonly apiKey?: string | undefined
  /** Signing secret for `Linear-Signature`. Falls back to `SMITHERS_LINEAR_WEBHOOK_SECRET`. */
  readonly webhookSecret?: string | undefined
  /** Endpoint override, for a fixture server. Falls back to `SMITHERS_LINEAR_API_BASE_URL`. */
  readonly apiBaseUrl?: string | undefined
  /**
   * Deadline for one attempt, covering the response headers *and* the body
   * read. Defaults to 30 seconds, and must be a finite, positive duration.
   *
   * The five-attempt budget bounds only completed attempts, so without this a
   * peer that answers with headers and then trickles the body forever holds
   * the call open for as long as it likes.
   */
  readonly requestTimeout?: Duration.Input | undefined
}

/**
 * A config with every fallback applied.
 *
 * @category models
 * @since 1.0.0
 */
export interface ResolvedLinearConfig {
  readonly apiKey: string | undefined
  readonly webhookSecret: string | undefined
  readonly apiBaseUrl: string
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
  config: LinearConfig = {},
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): ResolvedLinearConfig => ({
  apiKey: firstNonEmpty([config.apiKey, env["SMITHERS_LINEAR_API_KEY"]]),
  webhookSecret: firstNonEmpty([config.webhookSecret, env["SMITHERS_LINEAR_WEBHOOK_SECRET"]]),
  apiBaseUrl: firstNonEmpty([config.apiBaseUrl, env["SMITHERS_LINEAR_API_BASE_URL"]]) ?? DEFAULT_API_BASE_URL,
  requestTimeout: config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT
})
