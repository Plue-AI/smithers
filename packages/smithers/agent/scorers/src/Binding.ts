/**
 * Scorer bindings attached to target flow declarations.
 *
 * Package documentation: `packages/smithers/agent/scorers/docs/api.md`.
 *
 * @since 0.1.0
 */

import type { Flow } from "@smthrs/core"
import type { Sampling } from "./Sampling.ts"
import type { Scorer } from "./Scorer.ts"

/**
 * A scorer, optional ground truth, and deterministic sampling policy attached
 * to a target flow. The target value is retained unchanged, so binding never
 * changes its step key.
 *
 * `context` and `groundTruth` are also retained *by reference*, and scoring
 * runs asynchronously, so the scorer sees whatever those objects hold when it
 * executes rather than when the binding was made. `readonly` is a compile-time
 * promise only, and `scorerKey` covers `{id, version, config}` alone, so a
 * durable record gives no way to notice the difference. Pass values that do not
 * change, or copy before binding. Nothing is snapshotted here because a ground
 * truth is frequently a value with no JSON representation, and refusing those
 * at binding time would be the larger break.
 *
 * A binding is where a scorer's declared failure is erased: `scorer` is
 * `Scorer<unknown>`, so a `Scorer<E>` from `Scorer.make` binds without a cast
 * and one list holds scorers that fail in unrelated ways. Nothing is checked
 * away by the erasure, because a binding never runs its scorer and the runner
 * already accepts an unknown scorer failure.
 *
 * @category models
 * @since 0.1.0
 */
export interface Binding {
  readonly scorer: Scorer<unknown>
  readonly appliesTo: Pick<Flow.Any, "name">
  readonly groundTruth?: unknown
  readonly context?: unknown
  readonly sampling: Sampling
}

/**
 * Creates a scorer binding, defaulting to sampling every target step.
 *
 * The copy is shallow: see {@link Binding} for what that means for `context`
 * and `groundTruth`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Omit<Binding, "sampling"> & { readonly sampling?: Sampling | undefined }
): Binding => ({ ...options, sampling: options.sampling ?? "all" })
