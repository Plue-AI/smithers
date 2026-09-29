/**
 * The shared refusal gate every outward-effect rule runs before it acts.
 *
 * `S.Npm.Publish`, `S.Github.Pr`, `S.Github.Release`, `S.Github.Pages`,
 * `S.Git.Pr`, and `S.Changesets.Publish` all push bytes to somebody else's
 * machine. They share one contract, so they share one gate:
 *
 * - **Never cached.** An outward effect has no result to replay: the second
 *   invocation is a second publish. The rules opt out of the cache in the
 *   package executor and this module exists so the reason is written once.
 * - **Declared secrets.** Each rule names the credential it needs. A
 *   declaration that omits it is refused here, before anything is spawned.
 *   Only the declaration is read: a variable that is declared but carries no
 *   value on this host is refused later, at the transport boundary that
 *   resolves it, so no value is ever read here.
 * - **Approval.** `approval: "required"` refuses until a durable approval is
 *   granted. Package mode has no approval store, so the refusal is the
 *   honest answer there and the invocation has no side effect to undo.
 *
 * No rule has an outward transport yet. The package planner refuses each
 * one as not implemented, before this gate or any rule gate runs, so a
 * plannable outward target never spends a gate run on a certain failure.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import type * as Secret from "./Secret.ts"

/**
 * Why one outward invocation was refused.
 *
 * `missing_secret` covers a declaration that never names the required
 * variable; a variable that is declared but unset is refused later, at the
 * transport boundary. `approval_unsatisfied` covers `approval: "required"`
 * with no granted approval.
 *
 * @category models
 * @since 0.1.0
 */
export const RefusalCode = Schema.Literals(["missing_secret", "approval_unsatisfied"])

/**
 * Why one outward invocation was refused.
 *
 * @category models
 * @since 0.1.0
 */
export type RefusalCode = typeof RefusalCode.Type

/**
 * An outward invocation was refused before any outward action.
 *
 * The message is `{rule}: {code}: {detail}`.
 *
 * @category errors
 * @since 0.1.0
 */
export class Refused extends Schema.TaggedError<Refused>()("smithers-build/Refused", {
  rule: Schema.String,
  code: RefusalCode,
  detail: Schema.String
}) {
  override readonly name = "Refused"
  override get message(): string {
    return `${this.rule}: ${this.code}: ${this.detail}`
  }
}

/**
 * Checks whether a value is an outward {@link Refused} refusal.
 *
 * @category guards
 * @since 0.1.0
 */
export const isRefused = (value: unknown): value is Refused => value instanceof Refused

/**
 * The facts one outward invocation presents to the gate.
 *
 * @category models
 * @since 0.1.0
 */
export interface Invocation {
  readonly approvalGranted: boolean
}

/**
 * What one outward rule requires before it may act.
 *
 * @category models
 * @since 0.1.0
 */
export interface Requirements {
  /** The rule id, used in the refusal text. */
  readonly rule: string
  /** The environment-variable names the declaration must name and satisfy. */
  readonly required: ReadonlyArray<string>
  /** The secrets the declaration actually names. */
  readonly declared: ReadonlyArray<Secret.HttpCredential> | undefined
  /** The declared approval attr, if any. */
  readonly approval: "required" | undefined
}

/**
 * Returns the refusal one outward invocation earns, or undefined when every
 * precondition is satisfied.
 *
 * Only declarations are checked here. Reading a value before an outbound
 * request would move secret resolution into the job instead of its transport
 * boundary.
 *
 * @category validation
 * @since 0.1.0
 */
export const refuse = (requirements: Requirements, invocation: Invocation): Refused | undefined => {
  const declared = requirements.declared ?? []
  for (const name of requirements.required) {
    const secret = declared.find((entry) => entry.secret.env === name)
    if (secret === undefined) {
      return new Refused({
        rule: requirements.rule,
        code: "missing_secret",
        detail: `declares no S.HttpSecret(S.Secret(${JSON.stringify(name)}), [...]) in secrets`
      })
    }
  }
  if (requirements.approval === "required" && !invocation.approvalGranted) {
    return new Refused({
      rule: requirements.rule,
      code: "approval_unsatisfied",
      detail: "declares approval: \"required\" and no approval was granted"
    })
  }
  return undefined
}
