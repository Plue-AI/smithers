import { describe, expect, it } from "vitest"
import * as Evaluator from "../src/Evaluator.ts"
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
      headline: "OpenAI usage limit reached",
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
    expect(FailureCopy.describe({ ...exceeded, scope: "usd", used: 5.25, max: 5 })).toMatchObject({
      headline: "Spend budget reached",
      line: "$5.25 of $5.00 used.",
      actions: ["resume", "details"]
    })
    expect(FailureCopy.describe({ _tag: "flows/agent/BudgetExceeded", scope: "usd" })).toMatchObject({
      headline: "Spend budget reached",
      line: "The run spent its budget."
    })
    expect(FailureCopy.describe({ _tag: "flows/agent/BudgetExceeded" }).line).toBe("The run spent its budget.")
  })

  it("says a seat needs a sign-in in the host's own words, bounded", () => {
    const unresolved = {
      _tag: "@smthrs/agent/Seat/SeatUnresolved",
      seat: "claude-code:opus",
      message: "Run `claude auth login`."
    }
    expect(FailureCopy.describe(new Error("launch", { cause: unresolved }))).toMatchObject({
      headline: "Model sign-in required",
      line: "Run `claude auth login`.",
      actions: ["resume", "switch-model", "details"]
    })
    expect(FailureCopy.describe({ ...unresolved, message: "x".repeat(500) }).line).toHaveLength(240)
    expect(FailureCopy.describe({ ...unresolved, message: "" }).line).toBe("Sign in and resume.")
  })

  it("says no model was chosen when the router could not pick one, and offers another model first", () => {
    const unrouted = {
      _tag: "@smthrs/agent/Seat/SeatUnrouted",
      seat: "auto",
      reason: "unreachable",
      message: "Jev was unavailable: the judge this host binds did not answer."
    }
    expect(FailureCopy.describe(new Error("turn", { cause: unrouted }))).toMatchObject({
      headline: "Model could not be chosen",
      line: Evaluator.unreachableMessage,
      actions: ["switch-model", "resume", "details"]
    })
    expect(FailureCopy.describe({ ...unrouted, reason: "no_candidates" })).toMatchObject({
      headline: "Model could not be chosen",
      line: "No model is set up to route to."
    })
    // The host's own reason, never a claim that a router was asked.
    const gone = "The seat catalog no longer offers the variant terse"
    expect(FailureCopy.describe({ ...unrouted, reason: "unconfigured", message: gone }).line).toBe(gone)
    expect(FailureCopy.describe({ ...unrouted, reason: "unconfigured", message: "x".repeat(500) }).line).toHaveLength(
      240
    )
    expect(FailureCopy.describe({ ...unrouted, reason: "unconfigured", message: "" }).line).toBe(
      "No model router is set up."
    )
    expect(FailureCopy.describe({ ...unrouted, reason: "interrupted" }).line).toBe("Choosing a model was interrupted.")
  })

  it("names the router when an unrouted reason carries no words the copy can show", () => {
    const unrouted = { _tag: "@smthrs/agent/Seat/SeatUnrouted", seat: "auto" }
    const fallback = "The model router could not pick a model."
    // A judge reason without its message, and a reason this copy has never met, whatever it says.
    expect(FailureCopy.describe(new Error("turn", { cause: { ...unrouted, reason: "timeout" } }))).toMatchObject({
      headline: "Model could not be chosen",
      line: fallback,
      actions: ["switch-model", "resume", "details"]
    })
    expect(FailureCopy.describe({ ...unrouted, reason: "refused", message: "" }).line).toBe(fallback)
    expect(FailureCopy.describe({ ...unrouted, reason: "refused", message: 429 }).line).toBe(fallback)
    expect(FailureCopy.describe({ ...unrouted, reason: "retired", message: "private router diagnostic" }).line).toBe(
      fallback
    )
  })

  it("shows native judge setup and quota reasons through wrapped worker failures", () => {
    const unconfigured = new Evaluator.EvaluatorError({
      code: "unconfigured",
      message: Evaluator.unconfiguredMessage
    })
    const limit = new Evaluator.EvaluatorError({
      code: "refused",
      status: 429,
      resetAtEpochMillis: Date.UTC(2026, 8, 30, 21),
      message: "private account diagnostic"
    })
    const wrapped = (cause: Evaluator.EvaluatorError) => ({
      _tag: "/harness/HarnessError",
      code: "completion_unjudged",
      message: "The result was not verified.",
      cause
    })

    expect(FailureCopy.describe(wrapped(unconfigured))).toMatchObject({
      headline: "Worker result could not be checked",
      fault: "policy",
      line: Evaluator.unconfiguredMessage,
      actions: ["resume", "details"]
    })
    const quota = FailureCopy.describe(wrapped(limit))
    expect(quota.line).toContain("usage limit")
    expect(quota.line).toContain("2026-09-30T21:00:00.000Z")
    expect(quota.line).not.toContain("private account diagnostic")
  })

  it("names a plan that did not converge, and a person's refusal, instead of the model wrapper", () => {
    const frames = {
      _tag: "/harness/HarnessError",
      code: "model_failed",
      message: "m",
      cause: { _tag: "FramesExhausted", frames: 6 }
    }
    expect(FailureCopy.describe(frames)).toMatchObject({
      headline: "Worker ran out of frames",
      line: "It stopped without an answer."
    })
    const loop = {
      _tag: "/harness/HarnessError",
      code: "model_failed",
      message: "m",
      cause: { _tag: "/harness/CellTurn/RepeatedFailure" }
    }
    expect(FailureCopy.describe(loop).headline).toBe("Worker repeated one failure")
    expect(FailureCopy.describe({ _tag: "@smthrs/flow/HumanTaskFailed", code: "rejected" })).toMatchObject({
      headline: "Answer rejected",
      actions: ["resume", "details"]
    })
    expect(FailureCopy.describe({ _tag: "@smthrs/flow/HumanTaskFailed", code: "timeout" }).headline).toBe(
      "No answer in time"
    )
    expect(FailureCopy.describe({ _tag: "@smthrs/flow/HumanTaskFailed", code: "request_invalid" }).headline)
      .toBe("Worker stopped unexpectedly")
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
    ["moonshot:kimi-k3", "Kimi"],
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

  it("offers another model first when an account has no credit left", () => {
    for (const code of ["quota_exceeded", "out_of_credit"] as const) {
      expect(FailureCopy.describe(new ModelError({ code, message: "raw" }), "openai:gpt-6.1-sol").actions).toEqual([
        "switch-model",
        "resume",
        "details"
      ])
    }
    expect(FailureCopy.describe(new ModelError({ code: "quota_exceeded", message: "raw" }), "anthropic").headline)
      .toBe("Anthropic quota exhausted")
  })

  it.each([
    { resetAtEpochMillis: Date.UTC(2030, 0, 1) },
    { retryAfterMillis: 60_000 },
    { quotaScope: "model" as const },
    { quotaScope: "account" as const, retryAfterMillis: 60_000 }
  ])("offers waiting for a recoverable quota refusal %j", (detail) => {
    const error = new ModelError({ code: "quota_exceeded", message: "raw", ...detail })
    // Durable errors and live class instances expose the same recovery actions.
    for (const value of [error, JSON.parse(JSON.stringify(error))]) {
      expect(FailureCopy.describe({ cause: value }, "openai:gpt-6.1-sol").actions).toEqual([
        "switch-model",
        "resume",
        "wait",
        "details"
      ])
    }
  })

  it.each([
    { code: "quota_exceeded" as const, httpStatus: 402 },
    { code: "quota_exceeded" as const, quotaScope: "account" as const },
    { code: "out_of_credit" as const }
  ])("omits waiting when a quota refusal requires intervention %j", (detail) => {
    const timed = detail.httpStatus === 402 || detail.code === "out_of_credit"
      ? { resetAtEpochMillis: Date.UTC(2030, 0, 1), retryAfterMillis: 60_000 }
      : {}
    expect(FailureCopy.describe(new ModelError({ message: "raw", ...detail, ...timed })).actions).toEqual([
      "switch-model",
      "resume",
      "details"
    ])
  })

  it("names an account by its seat's provider prefix, as the model picker does", () => {
    expect(
      [
        "openai:gpt-6.1-sol",
        "anthropic:claude-opus-5-5",
        "claude-code:opus",
        "moonshot:kimi-k3",
        "gemini:pro",
        "openrouter:x",
        "cerebras:qwen-3.8-27b",
        "openai",
        "unknown:model",
        "constructor:x",
        undefined
      ].map(FailureCopy.provider)
    ).toEqual([
      "OpenAI",
      "Anthropic",
      "Claude Code",
      "Kimi",
      "Gemini",
      "OpenRouter",
      "Cerebras",
      "OpenAI",
      "Model",
      "Model",
      "Model"
    ])
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
        ["out_of_credit", "user"],
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
        "completion_incomplete",
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
