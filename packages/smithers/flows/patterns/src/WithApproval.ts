/**
 * Run-local approval decoration.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
import * as Decorate from "./internal/Decorate.ts"
import * as Pattern from "./Pattern.ts"
import { PatternError } from "./PatternError.ts"

/**
 * The sole value accepted from an approval step.
 *
 * A denial cannot decode as this schema and therefore fails on the typed
 * schema-error channel before the inner flow starts.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Approved = Schema.Literal("approved")

/**
 * An accepted approval decision.
 *
 * @category models
 * @since 0.1.0
 */
export type Approved = typeof Approved.Type

/**
 * Approval declaration options.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly reason: string
  /**
   * Called with `{ input, reason, scope }`; its declared input must be that
   * struct or `Schema.Unknown`. `scope` is currently the string `"run"`.
   */
  readonly approval: Flow.Any
}

const ApprovalInput = Schema.Struct({
  input: Schema.Unknown,
  reason: Schema.String,
  scope: Schema.String
})

const declaration = (inner: Flow.Any, options: Options): Flow.Any => {
  // The body runs when the graph builds, later than this call, so it reads
  // this snapshot and never the caller's options again.
  const reason = options.reason
  if (reason.trim().length === 0) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "Approval reason must not be empty"
    })
  }
  const approval = Pattern.bind(
    Pattern.slot({ input: ApprovalInput, output: Approved }),
    options.approval
  )
  const envelope = Decorate.envelopeOf(inner)
  return Flow.make(`withApproval(${Decorate.displayName(inner)})`, {
    ...(inner.description === undefined ? {} : { description: inner.description }),
    payload: inner.payloadSchema,
    success: inner.successSchema,
    error: inner.errorSchema,
    capabilities: Decorate.capabilitiesOf(inner),
    ...(envelope === undefined ? {} : { effects: envelope }),
    body: Node.capture({ reason }, (payload: unknown) =>
      Node.andThen(
        Decorate.call(approval, { input: payload, reason, scope: "run" }),
        Decorate.call(inner, payload)
      ))
  })
}

/**
 * Builds a run-scoped approval decorator.
 *
 * `make` snapshots the options at the call, so a later edit to the caller's
 * object does not change the decorator it returned.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): Pattern.Decorator => {
  const snapshot: Options = { reason: options.reason, approval: options.approval }
  return (inner) => declaration(inner, snapshot)
}

/**
 * Runs a caller-supplied, typed approval flow before the wrapped flow.
 *
 * The approval flow must decode its output as the literal `"approved"`;
 * denial therefore fails that flow and cannot advance to the inner flow.
 *
 * @category combinators
 * @since 0.1.0
 */
export const withApproval = (inner: Flow.Any, options: Options): Flow.Any => Pattern.decorate(inner, make(options))
