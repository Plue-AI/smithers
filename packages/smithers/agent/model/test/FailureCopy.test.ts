import { describe, expect, it } from "vitest"
import * as FailureCopy from "../src/FailureCopy.ts"
import { ModelError } from "../src/ModelError.ts"

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
    // Shapes of `@smthrs/agent/Budget` failures, which this package cannot import.
    const exceeded = { _tag: "flows/agent/BudgetExceeded", scope: "tokens", used: 600, max: 1000 }
    const wrapped = { _tag: "/harness/HarnessError", code: "model_failed", cause: exceeded }
    const expected = {
      headline: "Token budget reached",
      fault: "infra",
      line: "600 of 1000 tokens used.",
      actions: ["resume", "details"]
    }
    expect(FailureCopy.describe(wrapped)).toEqual(expected)
    expect(FailureCopy.describe({ _tag: "flows/agent/Skipped", budget: exceeded })).toEqual(expected)
    expect(FailureCopy.describe({ ...exceeded, scope: "latency", used: 12.4, max: 10 })).toMatchObject({
      headline: "Time budget reached",
      line: "12 of 10 ms used."
    })
    expect(FailureCopy.describe({ ...exceeded, scope: "daily", used: 2100, max: 2000 })).toEqual({
      headline: "Daily token cap reached",
      fault: "infra",
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

  it("maps legacy string-only provider limits without exposing their text", () => {
    expect(FailureCopy.describe("The usage limit has been reached", "openai:gpt-6-sol")).toMatchObject({
      headline: "ChatGPT usage limit reached",
      fault: "wait",
      line: "Wait for the provider reset."
    })
    expect(FailureCopy.describe("An unrelated failure", "openai:gpt-6-sol").headline)
      .toBe("Worker stopped unexpectedly")
  })

  it("classifies a wrapped harness engine failure", () => {
    expect(FailureCopy.describe({ cause: { _tag: "/harness/HarnessError", code: "engine_failed", message: "raw" } }))
      .toMatchObject({
        headline: "Worker engine stopped",
        fault: "infra"
      })
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
        ["invalid_request", "user"],
        ["context_overflow", "user"],
        ["no_route", "dependency"],
        ["authentication", "user"],
        ["content_policy", "user"],
        ["provider_internal", "infra"],
        ["transport", "infra"],
        ["call_timeout", "wait"],
        ["invalid_provider_output", "dependency"],
        ["unknown", "dependency"]
      ] as const
    ) {
      const copy = FailureCopy.describe(new ModelError({ code, message: "raw confidential text" }))
      expect(copy.fault).toBe(fault)
      expect(copy.headline).not.toContain("raw")
    }
    for (
      const [code, fault] of [
        ["assembly_failed", "bug"],
        ["incompatible_journal", "bug"],
        ["render_failed", "bug"],
        ["model_failed", "dependency"],
        ["read_only_cap", "user"],
        ["completion_unjudged", "dependency"],
        ["claim_unproven", "user"],
        ["suspended", "wait"]
      ] as const
    ) {
      expect(FailureCopy.describe({ _tag: "/harness/HarnessError", code, message: "raw" }).fault).toBe(fault)
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
