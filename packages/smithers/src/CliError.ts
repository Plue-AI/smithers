/**
 * Failures owned by the command-line projection.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"

/**
 * The operator spelled the invocation wrong: an unparseable flag value, a
 * payload that does not match its schema, an argument outside the accepted
 * set.
 *
 * Raise this when the fix is to retype the command. The message is printed as
 * written, so it must name the flag or argument at fault, the value received,
 * and the accepted form. It carries no cause: a usage error is about the
 * invocation, not about anything that failed underneath it.
 *
 * Exits 2.
 *
 * @category errors
 * @since 0.1.0
 */
export class UsageError extends Schema.TaggedError<UsageError>()("/cli/UsageError", {
  message: Schema.String
}) {}

/**
 * The invocation was spelled correctly and this projection cannot perform it:
 * a verb or flag removed in 1.0.0-rc.0, a reserved system flow, or a local-only
 * operation asked of a `--remote` composition.
 *
 * Raise this when retyping the command cannot help and the operator needs to
 * be told what replaced the thing they asked for. the release policy
 * fixes the wording of the removal messages, so prefer the constructors in
 * `Unsupported` over a hand-written sentence.
 *
 * Exits 1.
 *
 * @category errors
 * @since 0.1.0
 */
export class UnsupportedError extends Schema.TaggedError<UnsupportedError>()("/cli/UnsupportedError", {
  message: Schema.String
}) {}

/**
 * A correctly spelled read would exceed a published in-memory or wire bound.
 *
 * Exits 1. The operation and subject are inert labels chosen by the CLI, never
 * caller-rendered values, so this failure remains safe to print over MCP too.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class ResourceLimitError extends Schema.TaggedError<ResourceLimitError>()("/cli/ResourceLimitError", {
  operation: Schema.String,
  subject: Schema.String,
  limit: Schema.Number,
  unit: Schema.Literals(["events", "bytes"])
}) {
  override get message(): string {
    return `${this.operation} for ${this.subject} exceeds the ${this.limit}-${this.unit} resource limit`
  }
}

/**
 * Caller-controlled output was not inert bounded data.
 *
 * The code is stable for scripts and the path identifies the first refusing
 * member without retaining its value. Rendering failures exit 1.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class RenderingError extends Schema.TaggedError<RenderingError>()("/cli/RenderingError", {
  code: Schema.Literals([
    "accessor",
    "byte_limit",
    "callable",
    "cycle",
    "depth_limit",
    "member_limit",
    "proxy",
    "to_json",
    "unsupported",
    "unreadable"
  ]),
  path: Schema.String,
  message: Schema.String
}) {}

/**
 * Whose problem a refusal is. The same list as `PLUE_FAULTS` in
 * `@smthrs/rpc/PlueFailureCodes`, which this published package cannot depend
 * on; `test/CliError.test.ts` keeps the two equal.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const FAULTS = ["user", "wait", "infra", "dependency", "bug", "factory", "policy"] as const

/**
 * Whose problem a refusal is.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Fault = (typeof FAULTS)[number]

/**
 * A command was spelled correctly and could not finish: the operator is not
 * signed in, a named resource does not exist, a service did not answer.
 *
 * `fault` says whose problem it is, `code` is the stable snake_case word a
 * script greps for, and `message` is the one sentence an operator reads, in
 * product words. Raise `UsageError` instead when retyping the command fixes
 * it.
 *
 * Exits 1.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export class Refused extends Schema.TaggedError<Refused>()("/cli/Refused", {
  fault: Schema.Literals(FAULTS),
  code: Schema.String,
  message: Schema.String,
  /** The HTTP response's status, when this refusal came from HTTP. Older records omit it. */
  httpStatus: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })))
}) {}

/**
 * Every failure the command-line projection adds on top of the control
 * plane's own.
 *
 * A handler's error channel carries these beside the typed control-plane
 * failures; `cli/LegacyBin.ts` and `cli/Entry.ts` print both and this union decides the exit status.
 *
 * @category models
 * @since 0.1.0
 */
export type CliError = UsageError | UnsupportedError | ResourceLimitError | RenderingError | Refused

/**
 * The process exit status one CLI failure ends on.
 *
 * The two codes are part of the released contract, so a script can branch on
 * them: 2 means the operator can fix the command line, 1 means they cannot.
 * Statuses 3, 130, and 143 belong to run outcomes rather than to failures and
 * come from `Output.exitCode` instead.
 *
 * @category getters
 * @since 0.1.0
 */
export const exitCode = (error: CliError): number => error._tag === "/cli/UsageError" ? 2 : 1
