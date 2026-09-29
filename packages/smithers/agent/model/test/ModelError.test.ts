/**
 * Context overflow is a typed code, not a phrase.
 *
 * Every provider reports an oversized request as an ordinary bad request and
 * says what really happened only in prose. Recognizing that prose is the
 * protocol adapter's job, and it happens exactly once — here — so a consumer
 * deciding whether to compact and retry reads `code` and never a message.
 */
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as AnthropicMessages from "../src/AnthropicMessages.ts"
import { isContextOverflow, isQuotaExhausted, ModelError } from "../src/ModelError.ts"
import * as OpenAIResponses from "../src/OpenAIResponses.ts"

describe("isContextOverflow", () => {
  it("recognizes the overflow vocabulary the shipping providers actually use", () => {
    expect(isContextOverflow("context_length_exceeded", "")).toBe(true)
    expect(isContextOverflow(undefined, "This model's maximum context length is 128000 tokens")).toBe(true)
    expect(isContextOverflow(undefined, "prompt is too long: 250000 tokens > 200000 maximum")).toBe(true)
    expect(isContextOverflow(undefined, "Please reduce the length of the messages")).toBe(true)
  })

  it("does not claim every bad request", () => {
    expect(isContextOverflow("invalid_request_error", "tools.0.name: invalid value")).toBe(false)
    expect(isContextOverflow(undefined, "Unsupported parameter: temperature")).toBe(false)
    expect(isContextOverflow(undefined, "")).toBe(false)
  })
})

describe("isQuotaExhausted", () => {
  it("recognizes provider codes and messages that mean the account has no usable quota", () => {
    for (
      const signal of [
        "insufficient_quota",
        "insufficient-quota",
        "insufficient quota",
        "quota_exceeded",
        "quota-exceeded",
        "quota exceeded",
        "billing_hard_limit",
        "billing-hard-limit",
        "billing hard limit",
        "credit_balance",
        "credit-balance",
        "credit balance",
        "purchase credits",
        "no credits",
        "payment required"
      ]
    ) {
      expect(isQuotaExhausted(signal, "")).toBe(true)
      expect(isQuotaExhausted(undefined, signal.toUpperCase())).toBe(true)
    }
  })

  it("recognizes Anthropic's billing refusal without claiming a plain rate limit", () => {
    expect(
      isQuotaExhausted(
        "invalid_request_error",
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."
      )
    ).toBe(true)
    expect(isQuotaExhausted("rate_limit_error", "Rate limit exceeded")).toBe(false)
    expect(isQuotaExhausted(undefined, "Rate limit exceeded")).toBe(false)
  })
})

describe("ModelError schema", () => {
  it.each(["model", "account"] as const)("round-trips explicit %s quota scope", (quotaScope) => {
    const encoded = Schema.encodeSync(ModelError)(
      new ModelError({
        code: "rate_limited",
        message: "limit reached",
        quotaScope
      })
    )
    expect(Schema.decodeUnknownSync(ModelError)(encoded).quotaScope).toBe(quotaScope)
    expect(
      Schema.decodeUnknownSync(ModelError)({
        _tag: "flows/model/ModelError",
        code: "rate_limited",
        message: "legacy error"
      }).quotaScope
    ).toBeUndefined()
  })

  it("round-trips a key-only request path and omits it when it was not supplied", () => {
    const decoded = Schema.decodeUnknownSync(ModelError)({
      _tag: "flows/model/ModelError",
      code: "invalid_request",
      message: "request validation failed",
      path: "messages[2].content[0].text"
    })
    const encoded = Schema.encodeSync(ModelError)(decoded)
    expect(encoded).toMatchObject({ path: "messages[2].content[0].text" })
    expect(Schema.decodeUnknownSync(ModelError)(encoded).path).toBe("messages[2].content[0].text")

    const withoutPath = Schema.encodeSync(ModelError)(
      new ModelError({ code: "invalid_request", message: "request validation failed" })
    )
    expect(withoutPath).not.toHaveProperty("path")
  })
})

describe("protocol classification", () => {
  it("gives OpenAI's context_length_exceeded the typed code instead of invalid_request", () => {
    expect(
      OpenAIResponses.protocol.classifyError(
        400,
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            code: "context_length_exceeded",
            message: "This model's maximum context length is 128000 tokens."
          }
        })
      )
    ).toMatchObject({
      code: "context_overflow",
      providerCode: "context_length_exceeded",
      httpStatus: 400
    })
  })

  it("leaves an unrelated OpenAI 400 an ordinary bad request", () => {
    expect(
      OpenAIResponses.protocol.classifyError(
        400,
        JSON.stringify({ error: { type: "invalid_request_error", message: "Unknown parameter: foo" } })
      )
    ).toMatchObject({ code: "invalid_request" })
  })

  it("agrees with Anthropic on the same condition, despite different wording", () => {
    expect(
      AnthropicMessages.protocol.classifyError(
        400,
        JSON.stringify({
          error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" }
        })
      )
    ).toMatchObject({ code: "context_overflow" })
  })

  it("keeps an overflow classification ahead of the retryable-status branch", () => {
    // A `context_overflow` is never retryable: retrying the same oversized
    // request just burns another round trip.
    const overflow = OpenAIResponses.protocol.classifyError(
      400,
      JSON.stringify({ error: { code: "context_length_exceeded", message: "too long" } })
    )
    expect(overflow.retryable).toBe(false)
  })

  it("treats a call the caller cut off at its own budget as retryable", () => {
    // Nothing about the task changed when a caller stopped waiting, so the
    // next attempt can still succeed — which is what separates `call_timeout`
    // from the terminal codes and puts it on the same backoff as a dropped
    // connection.
    expect(new ModelError({ code: "call_timeout", message: "budget" }).retryable).toBe(true)
  })
})
