/**
 * Intervene pattern: read a target, propose a change, apply it behind an
 * optional approval, and report what happened.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import * as Decorate from "./internal/Decorate.ts"
import type { Member } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import { OpaqueInput } from "./internal/Payload.ts"
import * as WithApproval from "./WithApproval.ts"

const DEFAULT_REASON = "apply the proposed intervention"

/**
 * Configuration for {@link make}.
 *
 * `dryRun` removes the apply call from the declaration itself, so a dry-run
 * plan cannot reach a writing step. `approval` wraps apply with
 * {@link WithApproval.withApproval}, whose approval flow must produce the
 * literal `"approved"`.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly read: Member<R>
  readonly propose: Member<R>
  /**
   * The writing stage. It is a whole flow rather than any member, because
   * `approval` decorates it and a decorator re-declares what it wraps.
   */
  readonly apply: Flow.Any
  readonly report: Member<R>
  readonly dryRun: boolean
  /**
   * Called with `{ input, reason, scope }`; its declared input must be that
   * struct or `Schema.Unknown`; `scope` is currently the string `"run"`.
   */
  readonly approval?: Flow.Any | undefined
  readonly reason?: string | undefined
}

/**
 * Operational callbacks for {@link run}.
 *
 * Each stage receives the same `phase` envelope as its declared flow.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Context, Proposal, Applied, Report, E, R, E2, R2, E3, R3, E4, R4, E5, R5> {
  readonly read: (args: {
    readonly phase: "read"
    readonly input: I
  }) => Effect.Effect<Context, E, R>
  readonly propose: (args: {
    readonly phase: "propose"
    readonly input: I
    readonly context: Context
  }) => Effect.Effect<Proposal, E2, R2>
  readonly apply: (args: {
    readonly phase: "apply"
    readonly input: I
    readonly proposal: Proposal
  }) => Effect.Effect<Applied, E3, R3>
  readonly report: (args: {
    readonly phase: "report"
    readonly input: I
    readonly proposal: Proposal
    readonly applied: Applied | undefined
    readonly dryRun: boolean
  }) => Effect.Effect<Report, E4, R4>
  readonly dryRun: boolean
  readonly approval?:
    | ((args: {
      readonly input: I
      readonly proposal: Proposal
    }) => Effect.Effect<unknown, E5, R5>)
    | undefined
}

const decide = Schema.decodeUnknownEffect(WithApproval.Approved)

/**
 * The declared form of an intervention.
 *
 * @category models
 * @since 0.1.0
 */
export type InterveneFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

/**
 * Builds the intervention topology: read, propose, then either report the
 * proposal alone (dry run) or apply it and report what was written.
 *
 * When `approval` is supplied, the apply flow is wrapped with
 * {@link WithApproval.withApproval}, so the built graph shows the approval call
 * ahead of apply. A denial cannot decode as `"approved"` and therefore fails on
 * the typed schema-error channel before apply starts.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): InterveneFlow<R> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const stages = { read: options.read, propose: options.propose, report: options.report }
  const dryRun = options.dryRun
  const reason = options.reason ?? DEFAULT_REASON
  const apply = options.approval === undefined
    ? options.apply
    : WithApproval.withApproval(options.apply, { reason, approval: options.approval })
  const captures = { dryRun, gated: options.approval !== undefined, reason }
  const { name, description } = Compose.label("intervene", { dryRun }, options)
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> =>
    Node.bindPlanned(
      callMember(stages.read, { phase: "read", input }),
      Node.capture(captures, (context: Planned.Planned<unknown>) =>
        Node.bindPlanned(
          callMember(stages.propose, { phase: "propose", input, context }),
          Node.capture(captures, (proposal: Planned.Planned<unknown>) =>
            dryRun
              ? callMember(stages.report, {
                phase: "report",
                input,
                proposal,
                applied: undefined,
                dryRun: true
              })
              : Node.bindPlanned(
                Decorate.call<R>(apply, { phase: "apply", input, proposal }),
                Node.capture(captures, (applied: Planned.Planned<unknown>) =>
                  callMember(stages.report, {
                    phase: "report",
                    input,
                    proposal,
                    applied,
                    dryRun: false
                  }))
              ))
        ))
    )
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    // `@smthrs/core` carried its error type as a phantom parameter and
    // declared no error schema. `@smthrs/flow` needs a real one, because the
    // engine encodes a typed failure through it, and an intervention fails
    // with whatever the stage it called failed with.
    error: Schema.Unknown,
    body: Node.capture(captures, body)
  })
}

/**
 * Runs an intervention.
 *
 * A dry run reports the proposal and never calls `apply`. Otherwise the
 * approval decision, when one is configured, must decode as the literal
 * `"approved"`; a denial fails on the typed schema-error channel and `apply`
 * never runs.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, Context, Proposal, Applied, Report, E, R, E2, R2, E3, R3, E4, R4, E5 = never, R5 = never>(
  input: I,
  options: RuntimeOptions<I, Context, Proposal, Applied, Report, E, R, E2, R2, E3, R3, E4, R4, E5, R5>
): Effect.Effect<Report, E | E2 | E3 | E4 | E5 | Schema.SchemaError, R | R2 | R3 | R4 | R5> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the option object in between must not reach it.
  const { apply, approval, dryRun, propose, read, report } = options
  return Effect.gen(function*() {
    const context = yield* read({ phase: "read", input })
    const proposal = yield* propose({ phase: "propose", input, context })
    if (dryRun) {
      return yield* report({ phase: "report", input, proposal, applied: undefined, dryRun: true })
    }
    if (approval !== undefined) {
      yield* decide(yield* approval({ input, proposal }))
    }
    const applied = yield* apply({ phase: "apply", input, proposal })
    return yield* report({ phase: "report", input, proposal, applied, dryRun: false })
  })
}
