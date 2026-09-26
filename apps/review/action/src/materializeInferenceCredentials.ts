import { SEAT_CREDENTIAL } from "../../src/workflow/reviewSeatResolver.ts";
import { SEAT_VARIABLE } from "../../src/workflow/reviewSeats.ts";

/**
 * Scrubs raw inference credentials and seat overrides out of the environment
 * the review subprocess inherits.
 *
 * The review reads an untrusted pull-request diff, and the environment it runs
 * under is the one channel a prompt-injected model call could read a secret
 * back out of. A hosted review runs only on the metered proxy, which
 * `resolveInferenceEnv` re-supplies, so every provider credential a seat could
 * read and every seat override is deleted here: a caller's key never pays for,
 * and a caller's seat never reroutes, a hosted run.
 *
 * 0.x also wrote a Codex `auth.json` into an isolated `CODEX_HOME`, because the
 * Codex CLI reads a file rather than a variable. rc.0 runs no CLI subprocess,
 * so there is nothing to materialize and nothing on disk to protect.
 *
 * @since 1.0.0
 */

/** The variables a caller may set that must not reach the review subprocess. */
const RAW_CREDENTIALS: ReadonlyArray<string> = [
  "CODEX_AUTH_JSON",
  "CLAUDE_CODE_OAUTH_TOKEN",
  ...Object.values(SEAT_CREDENTIAL),
  ...Object.values(SEAT_VARIABLE),
];

/**
 * Deletes every raw credential variable from `env`, returning the names removed.
 *
 * @since 1.0.0
 * @category constructors
 */
export function materializeInferenceCredentials(input: {
  env: Record<string, string | undefined>;
}): ReadonlyArray<string> {
  const removed: string[] = [];
  for (const name of RAW_CREDENTIALS) {
    if (input.env[name] !== undefined) {
      delete input.env[name];
      removed.push(name);
    }
  }
  return removed;
}
