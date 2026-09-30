/**
 * Safe, compact copy for typed model and harness failures.
 *
 * @since 1.0.0-rc.1
 */

import * as Faults from "@smthrs/flow/Fault"
import * as Schema from "effect/Schema"
import * as Evaluator from "./Evaluator.ts"
// A value import, so the model rows register wherever this copy is read.
import { ModelErrorCode } from "./ModelError.ts"

/**
 * Whose action can repair a stopped run: the registered class of the failure.
 * @category models
 * @since 1.0.0-rc.1
 */
export type Fault = Faults.Class
/**
 * Keys a failure surface can offer.
 * @category models
 * @since 1.0.0-rc.1
 */
export type Action = "resume" | "switch-model" | "wait" | "details"
/**
 * Safe copy shown outside technical details.
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Description {
  readonly headline: string
  readonly fault: Fault
  readonly line: string
  readonly actions: ReadonlyArray<Action>
}

type ErrorRecord = {
  readonly _tag?: unknown
  readonly code?: unknown
  readonly reason?: unknown
  readonly message?: unknown
  readonly cause?: unknown
  readonly resetAtEpochMillis?: unknown
  readonly retryAfterMillis?: unknown
  readonly status?: unknown
  readonly seat?: unknown
  readonly route?: unknown
  readonly budget?: unknown
  readonly scope?: unknown
  readonly used?: unknown
  readonly max?: unknown
}
const record = (value: unknown): ErrorRecord | undefined =>
  typeof value === "object" && value !== null ? value : undefined

const provider = (seat: string | undefined): string => {
  const prefix = seat?.split(":")[0]
  return prefix === "openai" ? "ChatGPT" : prefix === "anthropic" ?
    "Anthropic" :
    prefix === "gemini" ?
    "Gemini" :
    prefix === "kimi-k3" ?
    "Kimi" :
    prefix === "openrouter"
    ? "OpenRouter"
    : prefix === "cerebras"
    ? "Cerebras"
    : "Model"
}

const isModelCode = Schema.is(ModelErrorCode)
const isEvaluatorCode = Schema.is(Evaluator.EvaluatorErrorCode)

const model: Record<ModelErrorCode, readonly [string, string, ReadonlyArray<Action>]> = {
  invalid_request: ["Model rejected the request", "Change the request and resume.", [
    "resume",
    "switch-model",
    "details"
  ]],
  context_overflow: ["Model context is full", "Shorten the context and resume.", [
    "resume",
    "switch-model",
    "details"
  ]],
  no_route: ["Model route unavailable", "Choose another model.", ["switch-model", "resume", "details"]],
  authentication: ["Model sign-in required", "Sign in and resume.", ["resume", "switch-model", "details"]],
  rate_limited: ["usage limit reached", "Wait for the provider reset.", [
    "resume",
    "switch-model",
    "wait",
    "details"
  ]],
  quota_exceeded: ["quota exhausted", "Restore account quota and resume.", [
    "resume",
    "switch-model",
    "wait",
    "details"
  ]],
  out_of_credit: ["Hosted credit exhausted", "Add credit and resume.", [
    "resume",
    "details"
  ]],
  content_policy: ["Model declined the request", "Change the request and resume.", [
    "resume",
    "switch-model",
    "details"
  ]],
  provider_internal: ["Model service failed", "The provider had a problem.", [
    "resume",
    "switch-model",
    "details"
  ]],
  transport: ["Model connection failed", "The connection closed before a response.", [
    "resume",
    "switch-model",
    "details"
  ]],
  call_timeout: ["Model call timed out", "The response took too long.", ["resume", "switch-model", "details"]],
  invalid_provider_output: ["Model response was invalid", "Choose another model or resume.", [
    "resume",
    "switch-model",
    "details"
  ]],
  unknown: ["Model call failed", "The provider did not give a usable response.", [
    "resume",
    "switch-model",
    "details"
  ]]
}
const harness: Record<string, readonly [string, string]> = {
  assembly_failed: ["Worker setup failed", "The worker could not start."],
  incompatible_journal: ["Worker history could not load", "The saved run could not be read."],
  render_failed: ["Worker output failed", "The worker could not render its result."],
  model_failed: ["Model call failed", "The model did not complete."],
  engine_failed: ["Worker engine stopped", "The worker engine failed."],
  read_only_cap: ["Worker stopped at its read limit", "Resume after narrowing the task."],
  completion_unjudged: ["Worker result could not be checked", "The result was not verified."],
  claim_unproven: ["Worker claim was unproven", "The worker could not verify its claim."],
  suspended: ["Worker paused", "Resume when ready."]
}

/** Causes that name what happened better than the model or harness wrapper around them. */
const causes: Readonly<Record<string, readonly [string, string, ReadonlyArray<Action>]>> = {
  FramesExhausted: ["Worker ran out of frames", "It stopped without an answer.", ["resume", "switch-model", "details"]],
  "/harness/CellTurn/RepeatedFailure": ["Worker repeated one failure", "It stopped after five identical frames.", [
    "resume",
    "switch-model",
    "details"
  ]],
  // Another model cannot change a person's answer, or their silence.
  "@smthrs/flow/HumanTaskFailed/rejected": ["Answer rejected", "The person did not accept the answer.", [
    "resume",
    "details"
  ]],
  "@smthrs/flow/HumanTaskFailed/timeout": ["No answer in time", "Nobody answered before the deadline.", [
    "resume",
    "details"
  ]]
}

/**
 * Walks wrapped causes and turns typed failure codes into safe UI copy.
 * @category utilities
 * @since 1.0.0-rc.1
 */
export const describe = (error: unknown, seat?: string): Description => {
  const fault = Faults.of(error).class
  let current: unknown = error
  let found: ErrorRecord | undefined
  let budget: ErrorRecord | undefined
  let unresolved: ErrorRecord | undefined
  let unrouted: ErrorRecord | undefined
  let evaluator: ErrorRecord | undefined
  let named: readonly [string, string, ReadonlyArray<Action>] | undefined
  const seen = new Set<unknown>()
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    const value = record(current)
    if (value === undefined) break
    if (value._tag === "flows/model/ModelError" || value._tag === "/harness/HarnessError") found = value
    // A spent run budget, reported at the refused call or at a later skipped one.
    if (value._tag === "flows/agent/BudgetExceeded") budget = value
    if (value._tag === "flows/agent/Skipped") budget = record(value.budget)
    // A seat the host could not resolve: its message is the host's own sign-in instruction.
    if (value._tag === "@smthrs/agent/Seat/SeatUnresolved") unresolved = value
    // An `auto` seat the router could not pick: no model ran, so another one is the way on.
    if (value._tag === "@smthrs/agent/Seat/SeatUnrouted") unrouted = value
    if (value._tag === "flows/model/EvaluatorError" || value._tag === "flows/model/ClassifierError") evaluator = value
    const key = typeof value.code === "string" ? `${String(value._tag)}/${value.code}` : String(value._tag)
    named = causes[key] ?? causes[String(value._tag)] ?? named
    current = value.cause
  }
  if (named !== undefined) return { headline: named[0], fault, line: named[1], actions: named[2] }
  if (unresolved !== undefined) {
    const message = (unresolved as { readonly message?: unknown }).message
    return {
      headline: "Model sign-in required",
      fault,
      line: typeof message === "string" && message !== "" ? message.slice(0, 240) : "Sign in and resume.",
      actions: ["resume", "switch-model", "details"]
    }
  }
  if (unrouted !== undefined) {
    return {
      headline: "Model could not be chosen",
      fault,
      line: unrouted.reason === "no_candidates"
        ? "No model is set up to route to."
        : unrouted.reason === "unconfigured" && typeof unrouted.message === "string" && unrouted.message !== ""
        // The host's own words: a missing catalog or a variant it stopped offering.
        ? unrouted.message.slice(0, 240)
        : unrouted.reason === "unconfigured"
        ? "No model router is set up."
        : unrouted.reason === "interrupted"
        ? "Choosing a model was interrupted."
        : isEvaluatorCode(unrouted.reason) && typeof unrouted.message === "string" && unrouted.message !== ""
        ? Evaluator.publicMessage({ code: unrouted.reason, message: unrouted.message }).slice(0, 240)
        : "The model router could not pick a model.",
      actions: ["switch-model", "resume", "details"]
    }
  }
  if (budget !== undefined) {
    const measured = typeof budget.used === "number" && typeof budget.max === "number"
    if (budget.scope === "usd") {
      return {
        headline: "Spend budget reached",
        fault,
        line: measured
          ? `$${(budget.used as number).toFixed(2)} of $${(budget.max as number).toFixed(2)} used.`
          : "The run spent its budget.",
        actions: ["resume", "details"]
      }
    }
    const daily = budget.scope === "daily"
    const tokens = budget.scope !== "latency"
    return {
      headline: daily ? "Daily token cap reached" : tokens ? "Token budget reached" : "Time budget reached",
      fault,
      line: measured
        ? `${Math.round(budget.used as number)} of ${budget.max} ${tokens ? "tokens" : "ms"} used${
          daily ? " today" : ""
        }.`
        : "The run spent its budget.",
      actions: ["resume", "details"]
    }
  }
  if (evaluator !== undefined && isEvaluatorCode(evaluator.code) && typeof evaluator.message === "string") {
    return {
      headline: "Worker result could not be checked",
      fault,
      line: Evaluator.publicMessage({
        code: evaluator.code,
        message: evaluator.message,
        status: typeof evaluator.status === "number" ? evaluator.status : undefined,
        resetAtEpochMillis: typeof evaluator.resetAtEpochMillis === "number" ? evaluator.resetAtEpochMillis : undefined
      }),
      actions: ["resume", "details"]
    }
  }
  const code = found?.code
  if (found?._tag === "flows/model/ModelError" && isModelCode(code)) {
    const [headline, line, actions] = model[code]
    const route = typeof found.seat === "string" ? found.seat : typeof found.route === "string" ? found.route : seat
    const reset = typeof found.resetAtEpochMillis === "number" ?
      found.resetAtEpochMillis :
      typeof found.retryAfterMillis === "number"
      ? Date.now() + found.retryAfterMillis
      : undefined
    return {
      headline: code === "rate_limited" || code === "quota_exceeded" ? `${provider(route)} ${headline}` : headline,
      fault,
      line: reset === undefined
        ? line
        : `Resets ${
          new Date(reset).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
          }).replace(",", "")
        }.`,
      actions
    }
  }
  if (found?._tag === "/harness/HarnessError" && typeof code === "string" && code in harness) {
    const [headline, line] = harness[code]!
    return { headline, fault, line, actions: ["resume", "switch-model", "details"] }
  }
  return {
    headline: "Worker stopped unexpectedly",
    fault,
    line: "The worker stopped before finishing.",
    actions: ["resume", "switch-model", "details"]
  }
}
