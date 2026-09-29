import { describe, expect, it } from "vitest"
import * as FailureCopy from "../src/FailureCopy.ts"
import { ModelError } from "../src/ModelError.ts"

// Harness and budget failures are classed by their owners, which this package
// cannot import; `agent/test/Fault.sweep.test.ts` asserts their fault with the
// owners loaded. Here only the copy this package owns is asserted.

describe("FailureCopy.describe", () => {
  it("names a provider limit through a wrapping cause and keeps raw text out of the headline", () => {
    const error = new Error("cell frame failed", {
      cause: new ModelError({
        code: "rate_limited",
        message: "secret raw provider response",
        resetAtEpochMillis: Date.UTC(2026, 8, 30, 21)
      })
    })
    expect(FailureCopy.describe(error, "openai:gpt-6-sol")).toMatchObject({
      headline: "ChatGPT usage limit reached",
      fault: "wait",
      actions: ["resume", "switch-model", "wait", "details"]
    })
    expect(FailureCopy.describe(error, "openai:gpt-6-sol").line).toContain("Sep 30")
    expect(FailureCopy.describe(error, "openai:gpt-6-sol").headline).not.toContain("secret")
  })

  it("names a spent run budget through a harness wrapper and a skipped call", () => {
    const exceeded = { _tag: "flows/agent/BudgetExceeded", scope: "tokens", used: 600, max: 1000 }
    const wrapped = { _tag: "/harness/HarnessError", code: "model_failed", cause: exceeded }
    const expected = {
      headline: "Token budget reached",
      line: "600 of 1000 tokens used.",
      actions: ["resume", "details"]
    }
    expect(FailureCopy.describe(wrapped)).toMatchObject(expected)
    expect(FailureCopy.describe({ _tag: "flows/agent/Skipped", budget: exceeded })).toMatchObject(expected)
    expect(FailureCopy.describe({ ...exceeded, scope: "latency", used: 12.4, max: 10 })).toMatchObject({
      headline: "Time budget reached",
      line: "12 of 10 ms used."
    })
    expect(FailureCopy.describe({ ...exceeded, scope: "daily", used: 2100, max: 2000 })).toMatchObject({
      headline: "Daily token cap reached",
      line: "2100 of 2000 tokens used today.",
      actions: ["resume", "details"]
    })
    expect(FailureCopy.describe({ _tag: "flows/agent/BudgetExceeded" }).line).toBe("The run spent its budget.")
  })

  it("uses a generic bug headline for an unknown error", () => {
    expect(FailureCopy.describe(new Error("private stack detail"))).toMatchObject({
      headline: "Worker stopped unexpectedly",
      fault: "bug"
    })
  })

  it("never reads a fault out of prose: a bare string is an untyped failure", () => {
    expect(FailureCopy.describe("The usage limit has been reached", "openai:gpt-6-sol")).toMatchObject({
      headline: "Worker stopped unexpectedly",
      fault: "bug"
    })
  })

  it("classifies a wrapped harness engine failure", () => {
    expect(FailureCopy.describe({ cause: { _tag: "/harness/HarnessError", code: "engine_failed", message: "raw" } }))
      .toMatchObject({ headline: "Worker engine stopped" })
  })

  it.each([
    ["anthropic:claude", "Anthropic"],
    ["gemini:pro", "Gemini"],
    ["kimi-k3:default", "Kimi"],
    ["openrouter:model", "OpenRouter"],
    ["cerebras:qwen", "Cerebras"],
    ["custom:model", "Model"]
  ])("names a %s limit as %s", (seat, name) => {
    expect(FailureCopy.describe(new ModelError({ code: "rate_limited", message: "raw" }), seat).headline)
      .toBe(`${name} usage limit reached`)
  })

  it("uses the error's route and retry-after when the caller did not supply a seat", () => {
    const now = Date.now()
    const error = Object.assign(new ModelError({ code: "rate_limited", message: "raw", retryAfterMillis: 60_000 }), {
      route: "anthropic:claude"
    })
    expect(FailureCopy.describe(error).headline).toBe("Anthropic usage limit reached")
    expect(FailureCopy.describe(error).line).toContain(
      new Date(now + 60_000).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    )
    expect(
      FailureCopy.describe(
        Object.assign(new ModelError({ code: "quota_exceeded", message: "raw" }), { seat: "gemini:pro" })
      ).headline
    ).toBe("Gemini quota exhausted")
  })

  it("maps request, provider, and harness codes without using their messages", () => {
    for (
      const [code, fault] of [
        ["invalid_request", "factory"],
        ["context_overflow", "factory"],
        ["no_route", "dependency"],
        ["authentication", "user"],
        ["content_policy", "user"],
        ["provider_internal", "dependency"],
        ["transport", "dependency"],
        ["call_timeout", "dependency"],
        ["invalid_provider_output", "dependency"],
        ["unknown", "dependency"]
      ] as const
    ) {
      const copy = FailureCopy.describe(new ModelError({ code, message: "raw confidential text" }))
      expect(copy.fault).toBe(fault)
      expect(copy.headline).not.toContain("raw")
    }
    for (
      const code of [
        "assembly_failed",
        "incompatible_journal",
        "render_failed",
        "model_failed",
        "read_only_cap",
        "completion_unjudged",
        "claim_unproven",
        "suspended"
      ]
    ) {
      const copy = FailureCopy.describe({ _tag: "/harness/HarnessError", code, message: "raw" })
      expect(copy.headline).not.toBe("Worker stopped unexpectedly")
      expect(copy.headline).not.toContain("raw")
    }
  })

  it("keeps malformed and cyclic causes in the generic bug class", () => {
    expect(FailureCopy.describe(null).fault).toBe("bug")
    expect(FailureCopy.describe({ _tag: "flows/model/ModelError", code: "invented" }).headline)
      .toBe("Worker stopped unexpectedly")
    expect(FailureCopy.describe({ _tag: "/harness/HarnessError", code: "invented" }).fault).toBe("bug")
    const cycle: { cause?: unknown } = {}
    cycle.cause = cycle
    expect(FailureCopy.describe(cycle).fault).toBe("bug")
  })
})
