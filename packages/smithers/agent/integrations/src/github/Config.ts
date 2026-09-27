/**
 * GitHub credential and endpoint resolution.
 *
 * Explicit configuration wins over the environment. Smithers 0.x also carried
 * a process-wide `configureGitHub` registry so JSX components could find
 * credentials without being passed any; that registry is gone with the
 * components, because a mutable module global is the wrong way to hand a
 * credential to a service you construct yourself.
 *
 * @since 1.0.0
 */

import { Duration } from "effect"
import * as Environment from "../Environment.ts"

/**
 * The public REST endpoint.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_API_BASE_URL = "https://api.github.com"

/**
 * The default deadline for one attempt, covering the response headers and the
 * body read.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_REQUEST_TIMEOUT: Duration.Duration = Duration.seconds(30)

const DEFAULT_MAX_RETRIES = 3

/**
 * What a caller may supply. Every field is optional; each consumer fails
 * loudly when a value it needs is missing.
 *
 * @category models
 * @since 1.0.0
 */
export interface GitHubConfig {
  /**
   * Personal access or installation token for REST calls. Falls back to
   * `SMITHERS_GITHUB_TOKEN`, then `GITHUB_TOKEN`. Never logged.
   */
  readonly token?: string | undefined
  /**
   * REST base URL, for GitHub Enterprise or a fixture server. Falls back to
   * `SMITHERS_GITHUB_API_BASE_URL`.
   */
  readonly apiBaseUrl?: string | undefined
  /** Retries for rate-limited and 5xx responses. Defaults to 3. */
  readonly maxRetries?: number | undefined
  /**
   * Deadline for one attempt, covering the response headers *and* the body
   * read. Defaults to 30 seconds, and must be a finite, positive duration.
   *
   * The retry budget bounds only completed attempts, so without this a peer
   * that answers with headers and then trickles the body forever holds the
   * call open for as long as it likes.
   */
  readonly requestTimeout?: Duration.Input | undefined
}

/**
 * A config with every fallback applied.
 *
 * @category models
 * @since 1.0.0
 */
export interface ResolvedGitHubConfig {
  readonly token: string | undefined
  readonly apiBaseUrl: string
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
 * `env` replaces the ambient environment rather than layering over it, so a
 * caller that passes one cannot be surprised by an ambient `GITHUB_TOKEN`
 * choosing which account a call runs as.
 *
 * @category constructors
 * @since 1.0.0
 */
export const resolve = (
  config: GitHubConfig = {},
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): ResolvedGitHubConfig => ({
  token: firstNonEmpty([config.token, env["SMITHERS_GITHUB_TOKEN"], env["GITHUB_TOKEN"]]),
  apiBaseUrl: firstNonEmpty([config.apiBaseUrl, env["SMITHERS_GITHUB_API_BASE_URL"]]) ?? DEFAULT_API_BASE_URL,
  maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
  requestTimeout: config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT
})
