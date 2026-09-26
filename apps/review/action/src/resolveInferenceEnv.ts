import { PROXY_IN_FLIGHT_LIMIT } from "../../src/server/proxy/proxyInFlightLimit.ts";

/**
 * Points the review subprocess at the metered proxy: the service mints a
 * session-scoped key and `ANTHROPIC_BASE_URL` names its own origin. Hosted
 * review has no bring-your-own-key mode; a repository that pays for its own
 * inference runs the CLI directly (CONTRIBUTING.md, "Self-hosted CI").
 *
 * 0.x offered two subscription modes instead, one per CLI agent: it wrote the
 * repository owner's `~/.codex/auth.json` for the Codex CLI, or forwarded
 * `CLAUDE_CODE_OAUTH_TOKEN` to the Claude Code CLI. rc.0 runs no CLI
 * subprocess: a seat resolves to a provider route, so the credential is an API
 * key and there is nothing to materialize on disk.
 *
 * @since 1.0.0
 */

/**
 * The session the review runs under.
 *
 * @since 1.0.0
 * @category models
 */
export interface ResolveInferenceEnvInput {
  anthropicBaseUrl: string;
  sessionToken: string;
}

/**
 * The environment overrides and concurrency the proxy needs.
 *
 * @since 1.0.0
 * @category models
 */
export interface ResolvedInferenceEnv {
  /** Env overrides for the review subprocess (merged over `process.env`). */
  env: Record<string, string>;
  /** The CLI's `--concurrency`. */
  concurrency: number;
}

/**
 * Builds the proxy environment for a review session.
 *
 * @since 1.0.0
 * @category constructors
 */
export function resolveInferenceEnv(input: ResolveInferenceEnvInput): ResolvedInferenceEnv {
  return {
    // The proxy refuses calls beyond its per-repo in-flight limit.
    concurrency: PROXY_IN_FLIGHT_LIMIT,
    env: {
      ANTHROPIC_BASE_URL: input.anthropicBaseUrl,
      ANTHROPIC_API_KEY: input.sessionToken,
    },
  };
}
