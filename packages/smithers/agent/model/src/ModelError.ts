/**
 * The provider-neutral failure vocabulary, and the refinements that recognize
 * a context overflow and an exhausted account in a provider's own wording.
 *
 * A consumer branches on `ModelError.code`. Provider message text is not a
 * contract, and reading it is the mistake these codes exist to prevent.
 *
 * @since 0.1.0
 */

import * as Fault from "@smthrs/flow/Fault"
import { Schema } from "effect"

/**
 * The provider-neutral failure vocabulary. A consumer branches on these
 * codes; provider message text is not a contract.
 *
 * All but one describe something the provider did. `call_timeout` describes
 * what the caller did: it exceeded a wall-clock budget it declared for the
 * call and interrupted the request itself, so the request never settled and
 * nothing about it is known. It is a distinct code rather than `transport`
 * because the two are repaired differently — a transport failure is waited
 * out unchanged, and an overrun is re-issued with the model told to be
 * shorter.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ModelErrorCode = Schema.Literals([
  "invalid_request",
  "context_overflow",
  "no_route",
  "authentication",
  "rate_limited",
  "quota_exceeded",
  "out_of_credit",
  "content_policy",
  "provider_internal",
  "transport",
  "call_timeout",
  "invalid_provider_output",
  "unknown"
])

/**
 * The decoded form of {@link ModelErrorCode}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ModelErrorCode = typeof ModelErrorCode.Type

/**
 * Wire signals that mean "this request did not fit the model's context window".
 *
 * Providers report overflow as an ordinary bad request, so the distinction only
 * exists in prose on the wire. It is recognized here, once, at the boundary that
 * owns provider vocabulary, and published as the `context_overflow` code. A
 * consumer deciding whether to compact and retry branches on that code — never
 * on message text, which is not a contract and changes without notice.
 */
const overflowSignal =
  /context(?:[-_ ](?:length|window))?[-_ ](?:exceeded|overflow)|context[-_ ]length[-_ ]exceeded|maximum context length|prompt (?:is )?too long|too many (?:input )?tokens|reduce the length of the messages/i

/**
 * Whether a provider's own error code and message describe a context overflow.
 *
 * Protocol adapters call this while classifying a wire failure, ahead of the
 * generic `invalid_request` branch, so overflow reaches consumers as a typed
 * code rather than as text they would have to re-parse.
 *
 * @category refinements
 * @since 0.1.0
 * @slop
 */
export const isContextOverflow = (providerCode: string | undefined, message: string): boolean =>
  overflowSignal.test(`${providerCode ?? ""} ${message}`)

/**
 * Wire signals that mean an account has exhausted its paid balance or quota.
 */
const quotaExhaustedSignal =
  /insufficient[-_ ]?quota|quota[-_ ]?exceeded|billing[-_ ]?hard[-_ ]?limit|credit[-_ ]?balance|purchase credits|no credits|payment required/i

/**
 * Whether a provider's own error code and message describe an exhausted
 * account balance or quota rather than a transient rate limit.
 *
 * Protocol adapters call this before their generic bad-request and rate-limit
 * branches so a durable consumer can park the run until the account is funded
 * instead of retrying or terminating it as malformed.
 *
 * @category refinements
 * @since 0.1.0
 * @slop
 */
export const isQuotaExhausted = (providerCode: string | undefined, message: string): boolean =>
  quotaExhaustedSignal.test(`${providerCode ?? ""} ${message}`)

/**
 * Normalized provider failure. Its fields intentionally exclude credentials,
 * headers, request bodies, and client objects.
 *
 * `code` is the stable serialized field and the public error contract; the
 * table of codes and their meanings is in `packages/smithers/agent/model/docs/api.md`. There
 * is no separate `reason` field: this package deliberately flattens opencode's
 * tagged reason union into one literal code set plus typed optional detail
 * fields, so a consumer branches on one value instead of destructuring a union.
 * Kernel permission and journal failures are separate typed error classes,
 * never `ModelError` codes.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class ModelError extends Schema.TaggedError<ModelError>()("flows/model/ModelError", {
  code: ModelErrorCode,
  message: Schema.String,
  // A key path only (for example `messages[2].content[0].text` or
  // `$.thinking.budget_tokens`), never a value: request values may contain
  // credentials or user content.
  path: Schema.optional(Schema.String),
  retryAfterMillis: Schema.optional(Schema.Number),
  resetAtEpochMillis: Schema.optional(Schema.Number),
  resetSource: Schema.optional(Schema.String),
  // An explicit shared limit cools every model on the account's route.
  // Without scope, a rate limit only establishes that the requested model failed.
  quotaScope: Schema.optional(Schema.Literals(["model", "account"])),
  providerCode: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  httpStatus: Schema.optional(Schema.Number)
}) {
  /**
   * The failed provider response body, redacted and capped at 16 KiB, present
   * only on an error the shared request executor raised from an HTTP response.
   *
   * It is deliberately outside the schema above and defined non-enumerably, so
   * a journal, a `JSON.stringify`, and a structural comparison all see the same
   * value they saw before it existed: a provider body is diagnostic text, not
   * durable state, and copying it into a run's history is how a long body
   * becomes a permanent one.
   */
  declare readonly body: string | undefined
  /**
   * Whether {@link body} is a prefix of what the provider sent, either because
   * the read stopped at 64 KiB or because the redacted text exceeded the 16 KiB
   * kept here.
   */
  declare readonly bodyTruncated: boolean | undefined

  /** @category getters @since 0.1.0 */
  get retryable(): boolean {
    if (this.code === "quota_exceeded" || this.code === "out_of_credit") return false
    return this.code === "rate_limited" || this.code === "provider_internal" || this.code === "transport" ||
      this.code === "call_timeout" ||
      this.httpStatus === 429 || (this.httpStatus !== undefined && this.httpStatus >= 500 && this.httpStatus <= 599)
  }
}

const terminalCodes: ReadonlySet<string> = new Set([
  "authentication",
  "invalid_request",
  "no_route",
  "content_policy",
  "context_overflow",
  "out_of_credit",
  "invalid_provider_output"
])
const terminalStatuses: ReadonlySet<number> = new Set([400, 401, 402, 403, 404, 405, 409, 410, 413, 422])

/**
 * Whether a refusal requires intervention rather than a quota cooldown.
 * A model-scoped quota or a named reset can recover; terminal HTTP statuses
 * and exhausted credit cannot be waited out.
 * @category classification
 * @since 1.0.0-rc.1
 */
export const isTerminalRefusal = (
  error: Pick<ModelError, "code" | "httpStatus" | "quotaScope" | "resetAtEpochMillis" | "retryAfterMillis">
): boolean => {
  if (error.httpStatus !== undefined && terminalStatuses.has(error.httpStatus)) return true
  if (terminalCodes.has(error.code)) return true
  if (error.code !== "quota_exceeded" || error.quotaScope === "model") return false
  return error.resetAtEpochMillis === undefined && error.retryAfterMillis === undefined
}

/**
 * Whose problem each model failure is. The request is our agent's own
 * construction, so a rejected or overflowing one is the factory's, never the
 * person's; a limit is a wait, and a call that ran past its own deadline is a
 * dependency another seat or a retry may answer.
 */
Fault.register(
  "flows/model/ModelError",
  {
    invalid_request: "factory",
    context_overflow: "factory",
    no_route: "dependency",
    authentication: "user",
    rate_limited: "wait",
    quota_exceeded: "wait",
    // Hosted credit is spent: the person adds credit, then resumes.
    out_of_credit: "user",
    content_policy: "user",
    provider_internal: "dependency",
    transport: "dependency",
    call_timeout: "dependency",
    invalid_provider_output: "dependency",
    unknown: "dependency"
  } satisfies Fault.Rows<ModelErrorCode>
)
