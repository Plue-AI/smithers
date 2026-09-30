import { describe, expect, test } from "vitest"
import {
  isCloudScopeRefusal,
  machineReadableRefusal,
  upstreamProse,
  upstreamRefusalMessage
} from "../src/UpstreamProse.ts"

/**
 * Smithers Cloud's refusal envelope in its own wire order: the machine-readable
 * verdict first, the sentence after (plue pkg/errors/errors.go `APIError`).
 */
const envelope = (code: string, fault: string, message: string) => JSON.stringify({ code, fault, message })

/** The sentence plue's `RequireScope` writes (internal/middleware/scope.go). */
const SCOPE_SENTENCE = "insufficient token scope"

describe("isCloudScopeRefusal", () => {
  test("plue's scope gate: its `forbidden` verdict carrying its own sentence", () => {
    expect(isCloudScopeRefusal(envelope("forbidden", "user", SCOPE_SENTENCE))).toBe(true)
  })

  test("the other refusals plue answers this route with are not a scope shortage", () => {
    // Three gates share the `forbidden` code, so the verdict alone cannot
    // separate them; another code carries the scope sentence in a body that
    // is not the scope gate's.
    for (
      const body of [
        envelope("forbidden", "user", "feature not available"),
        envelope("forbidden", "user", "repository-bound token cannot access resources outside its repository"),
        envelope("org_membership_required", "user", SCOPE_SENTENCE)
      ]
    ) {
      expect(isCloudScopeRefusal(body)).toBe(false)
    }
  })

  test("a body carrying no plue verdict never classifies, whatever English it holds", () => {
    for (
      const body of [
        `{"message":"${SCOPE_SENTENCE}"}`,
        `{"error":{"message":"${SCOPE_SENTENCE}"}}`,
        `<!DOCTYPE html><title>403 Forbidden</title><p>${SCOPE_SENTENCE}</p>`,
        `{"code":"insufficient_scope","message":"${SCOPE_SENTENCE}"}`,
        SCOPE_SENTENCE,
        ""
      ]
    ) {
      expect(isCloudScopeRefusal(body)).toBe(false)
    }
  })

  test("the sentence is matched whole, never for the words it contains", () => {
    for (
      const message of [
        "Insufficient token scope",
        "insufficient token scope for this repository",
        "this token's scope is insufficient"
      ]
    ) {
      expect(isCloudScopeRefusal(envelope("forbidden", "user", message))).toBe(false)
    }
    // Surrounding whitespace is the one difference forgiven, because
    // `upstreamProse` trims before anyone reads the sentence.
    expect(isCloudScopeRefusal(envelope("forbidden", "user", `  ${SCOPE_SENTENCE}\n`))).toBe(true)
  })
})

describe("upstream refusal boundary", () => {
  test("accepts only a nonblank sentence field, preferring the top-level message", () => {
    expect(upstreamProse(JSON.stringify({ message: "  Account limit reached. \n", error: { message: "Other error" } })))
      .toBe("Account limit reached.")
    expect(upstreamProse(JSON.stringify({ message: "  ", error: { message: "  Nested refusal  " } })))
      .toBe("Nested refusal")
    expect(upstreamProse(JSON.stringify({ error: "  Plain refusal  " }))).toBe("Plain refusal")
    expect(upstreamProse(JSON.stringify({ message: "x".repeat(205) }))).toBe("x".repeat(200))
  })

  test.each([
    "",
    "  ",
    "<html><body>upstream error</body></html>",
    "404 page not found",
    "null",
    "42",
    "[]",
    JSON.stringify({ message: " ", error: { message: "\n" } }),
    JSON.stringify({ message: 42, error: { message: false } }),
    JSON.stringify({ detail: "Do not show this internal detail" })
  ])("does not render an untrusted or non-sentence body (%s)", (body) => {
    expect(upstreamProse(body)).toBeUndefined()
  })

  test("retains typed machine fields without forwarding prose or unknown keys", () => {
    expect(machineReadableRefusal(JSON.stringify({
      code: "  quota_exceeded ",
      retry_after: 0,
      plan_key: "basic",
      limit_kind: "runs",
      upgrade_plan_key: "pro",
      message: "private text",
      internal_trace: "secret"
    }))).toEqual({
      code: "quota_exceeded",
      retry_after: 0,
      plan_key: "basic",
      limit_kind: "runs",
      upgrade_plan_key: "pro"
    })
    expect(machineReadableRefusal(JSON.stringify({ code: "c".repeat(70), retry_after: 1.5 })))
      .toEqual({ code: "c".repeat(64), retry_after: 1.5 })
  })

  test.each([
    "not JSON",
    "null",
    "42",
    JSON.stringify({ code: "  ", retry_after: "30", plan_key: 1, limit_kind: null, upgrade_plan_key: false }),
    JSON.stringify({ code: null, retry_after: null }),
    "{\"retry_after\":1e999}",
    "{\"retry_after\":-1e999}"
  ])("omits absent or mistyped machine fields (%s)", (body) => {
    expect(machineReadableRefusal(body)).toEqual({})
  })

  test.each(
    [
      [404, "Cloud doesn't serve that request."],
      [401, "Cloud refused that request for your account."],
      [403, "Cloud refused that request for your account."],
      [429, "Cloud is rate-limiting this account right now. Try again in a minute."],
      [500, "Cloud is having trouble right now (HTTP 500)."],
      [503, "Cloud is having trouble right now (HTTP 503)."],
      [400, "Cloud refused that request (HTTP 400)."]
    ] as const
  )("uses a specific fallback for HTTP %s", (status, expected) => {
    expect(upstreamRefusalMessage("Cloud", status, "<html>internal error</html>")).toBe(expected)
  })

  test("uses a safe upstream sentence ahead of a status fallback", () => {
    expect(upstreamRefusalMessage("Cloud", 503, JSON.stringify({ message: "  Maintenance in progress. " })))
      .toBe("Maintenance in progress.")
  })
})
