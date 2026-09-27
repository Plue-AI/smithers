/**
 * Capture the world, compare it to a baseline, and alert when it moved.
 *
 * Drift detection is the shape behind config auditing, index freshness, and
 * dependency pinning: one capture, one comparison against a remembered state,
 * and an action taken only when the comparison says something changed.
 *
 * The pattern detects once. Polling belongs to the caller, because how often
 * to look is a deployment decision rather than a property of the check: wrap
 * {@link run} in `Loop.run` for bounded rounds inside one execution. The recipe
 * is in the loops reference at https://smithers.sh/docs/reference/api/patterns.
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
import type { Member } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import { OpaqueInput } from "./internal/Payload.ts"

/**
 * Configuration for {@link make}.
 *
 * `baseline` is the remembered state every capture is compared against. It is
 * a declared literal, so two detectors watching the same target against
 * different baselines do not share a step key.
 *
 * Omit `alert` for a detector that only reports. Supplying one declares the
 * alert arm of a branch on the comparison: a run takes it only when
 * {@link drifted} reads drift from the real comparison.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly capture: Member<R>
  readonly compare: Member<R>
  readonly alert?: Member<R> | undefined
  readonly baseline: unknown
}

/**
 * Operational callbacks for {@link run}.
 *
 * `alertIf` replaces the default {@link drifted} reader for a comparison that
 * reports a magnitude rather than a verdict, such as a numeric delta against a
 * tolerance.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Baseline, Snapshot, Comparison, Alert, E, R, E2, R2, E3 = never, R3 = never> {
  /**
   * Read once when `run` is called and then handed, as the same reference, to
   * every callback: a callback that mutates it changes what later callbacks
   * see, while replacing it on the option object after the call changes
   * nothing.
   */
  readonly baseline: Baseline
  readonly capture: (input: {
    readonly input: I
    readonly baseline: Baseline
  }) => Effect.Effect<Snapshot, E, R>
  readonly compare: (input: {
    readonly snapshot: Snapshot
    readonly baseline: Baseline
  }) => Effect.Effect<Comparison, E2, R2>
  readonly alertIf?: ((comparison: Comparison) => boolean) | undefined
  readonly alert?:
    | ((input: {
      readonly comparison: Comparison
      readonly snapshot: Snapshot
      readonly baseline: Baseline
    }) => Effect.Effect<Alert, E3, R3>)
    | undefined
}

/**
 * The outcome of one detection.
 *
 * `alert` is absent when nothing drifted and when no alert is configured, so a
 * present `alert` proves the action ran.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result<Snapshot, Comparison, Alert> {
  readonly snapshot: Snapshot
  readonly comparison: Comparison
  readonly drifted: boolean
  readonly alert?: Alert | undefined
}

/**
 * Reads the drift signals a comparison may carry.
 *
 * A comparison answers with `true` or an object carrying `drifted: true`.
 * Anything else reads as no drift, so a comparison that reports a magnitude
 * needs `RuntimeOptions.alertIf` instead.
 *
 * @category predicates
 * @since 0.1.0
 */
export const drifted = (value: unknown): boolean =>
  value === true ||
  (typeof value === "object" && value !== null && "drifted" in value && value.drifted === true)

/**
 * The declared form of a drift detector.
 *
 * @category models
 * @since 0.1.0
 */
export type DriftDetectorFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

/**
 * Declares the detection topology: capture, compare, and the alert arm.
 *
 * The comparison is a `Node.branch`: {@link drifted} reads it at run time, and
 * only a drifted comparison takes the alert arm. The declaration settles to
 * the same {@link Result} {@link run} returns. `alertIf` is run-only, so a
 * declared detector reads drift with {@link drifted}.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): DriftDetectorFlow<R> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again. The baseline is
  // the caller's value: it enters key material as a literal, so an edit
  // inside it after the call is an edit to the declaration's identity.
  const alert = options.alert
  const capture = options.capture
  const compare = options.compare
  const baseline = options.baseline
  const { name, description } = Compose.label("driftDetector", { alerts: alert !== undefined }, options)
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> =>
    Node.bindPlanned(
      callMember(capture, { input, baseline }),
      Node.capture({ baseline }, (snapshot: Planned.Planned<unknown>) =>
        // The verdict is read at run time from the real comparison, so the
        // alert arm is taken only when it reports drift, as in `run`.
        Node.branch(callMember(compare, { snapshot, baseline }), {
          if: Node.capture({ baseline, alerts: alert !== undefined }, (comparison: unknown) => drifted(comparison)),
          then: (comparison: Planned.Planned<unknown>) =>
            alert === undefined
              ? Node.succeed({ snapshot, comparison, drifted: true })
              // The raised alert joins the snapshot and the comparison inside
              // a `Node.succeed`, which resolves all three planned references.
              // Computing the record in a `Node.map` would compute on two
              // planned values a mapper may only pass on.
              : Node.bindPlanned(
                callMember(alert, { comparison, snapshot, baseline }),
                Node.capture(
                  { baseline },
                  (raised: Planned.Planned<unknown>) =>
                    Node.succeed({ snapshot, comparison, drifted: true, alert: raised })
                )
              ),
          else: (comparison: Planned.Planned<unknown>) => Node.succeed({ snapshot, comparison, drifted: false })
        }))
    )
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    // `@smthrs/core` carried its error type as a phantom parameter and
    // declared no error schema. `@smthrs/flow` needs a real one, because the
    // engine encodes a typed failure through it, and a detector fails with
    // whatever the member it called failed with.
    error: Schema.Unknown,
    body: Node.capture({ baseline, alerts: alert !== undefined }, body)
  })
}

/**
 * Captures, compares, and alerts only when the comparison reports drift.
 *
 * The alert runs at most once per detection. Its failure is the run's failure:
 * a detector that cannot page has not detected anything an operator will see.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, Baseline, Snapshot, Comparison, Alert, E, R, E2, R2, E3 = never, R3 = never>(
  input: I,
  options: RuntimeOptions<I, Baseline, Snapshot, Comparison, Alert, E, R, E2, R2, E3, R3>
): Effect.Effect<Result<Snapshot, Comparison, Alert>, E | E2 | E3, R | R2 | R3> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the option object in between must not reach it.
  const { alert, alertIf, baseline, capture, compare } = options
  return Effect.gen(function*() {
    const snapshot = yield* capture({ input, baseline })
    const comparison = yield* compare({ snapshot, baseline })
    const moved = alertIf === undefined ? drifted(comparison) : alertIf(comparison)
    if (!moved || alert === undefined) {
      return { snapshot, comparison, drifted: moved }
    }
    const raised = yield* alert({ comparison, snapshot, baseline })
    return { snapshot, comparison, drifted: moved, alert: raised }
  })
}
