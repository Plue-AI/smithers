import { describe, expect, test } from "bun:test";
import { SEAT_CREDENTIAL } from "../../src/workflow/reviewSeatResolver.ts";
import { materializeInferenceCredentials } from "../../action/src/materializeInferenceCredentials.ts";

describe("materializeInferenceCredentials", () => {
  test("scrubs every raw credential the caller may have set", () => {
    const env: Record<string, string | undefined> = {
      CODEX_AUTH_JSON: "{}",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-oai",
      OPENROUTER_API_KEY: "sk-or",
      SMITHERS_REVIEW_SEAT: "openrouter:any",
      SMITHERS_REVIEW_CHEAP_SEAT: "openrouter:any",
      SMITHERS_REVIEW_VERIFY_SEAT: "openrouter:any",
      SMITHERS_REVIEW_NARRATE_SEAT: "openrouter:any",
      SMITHERS_REVIEW_QUIZ_SEAT: "openrouter:any",
      PATH: "/usr/bin",
    };

    const given = { ...env };
    const removed = materializeInferenceCredentials({ env });

    expect(removed.length).toBe(Object.keys(given).length - 1);
    // Everything else is left exactly as it was.
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("scrubs the credential of every provider a seat can route to", () => {
    // A provider the scrub misses is a hosted run billed to the caller's key.
    const env: Record<string, string | undefined> = Object.fromEntries(
      Object.values(SEAT_CREDENTIAL).map((variable) => [variable, "sk-caller"]),
    );
    materializeInferenceCredentials({ env });
    expect(env).toEqual({});
  });

  test("reports nothing when the environment carries no raw credential", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    expect(materializeInferenceCredentials({ env })).toEqual([]);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});
