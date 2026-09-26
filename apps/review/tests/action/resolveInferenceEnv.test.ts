import { describe, expect, test } from "bun:test";
import { resolveInferenceEnv } from "../../action/src/resolveInferenceEnv.ts";
import { PROXY_IN_FLIGHT_LIMIT } from "../../src/server/proxy/proxyInFlightLimit.ts";

const session = { anthropicBaseUrl: "https://review.test/api/anthropic", sessionToken: "srs_tok" };

describe("resolveInferenceEnv", () => {
  test("points the review at the metered proxy under the session token", () => {
    expect(resolveInferenceEnv(session).env).toEqual({
      ANTHROPIC_BASE_URL: "https://review.test/api/anthropic",
      ANTHROPIC_API_KEY: "srs_tok",
    });
  });

  test("never runs more file reviews than the proxy admits at once", () => {
    // More simultaneous calls than the proxy's per-repo in-flight limit only
    // buys 429 parks.
    expect(resolveInferenceEnv(session).concurrency).toBe(PROXY_IN_FLIGHT_LIMIT);
  });
});
