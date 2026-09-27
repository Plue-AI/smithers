/**
 * The isolated half of an attempt: run the body in a workspace transaction,
 * copy its diff bundle back, and rebase a bounded number of times when the
 * host moved underneath it.
 *
 * Copy-back has no human review gate.
 *
 * @since 0.1.0
 */

import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import { DerivedKey } from "@smthrs/keys"
import * as Cause from "effect/Cause"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import * as StepBoundary from "../StepBoundary.ts"
import * as StepSandbox from "../StepSandbox.ts"
import * as WorkspaceSandbox from "../WorkspaceSandbox.ts"

/**
 * An isolated execution whose diff bundle is now on the host.
 *
 * @since 0.1.0
 * @category models
 */
export interface Settlement {
  readonly result: unknown
  /**
   * The content address of the applied bundle: a digest over every
   * `(path, beforeDigest, afterDigest)` triple. It is the journal's handle on
   * the copy-back, and the `diffIdentity` a deviation carries.
   */
  readonly bundleIdentity: string
  readonly files: ReadonlyArray<WorkspaceSandbox.FileChange>
  readonly effects: ReadonlyArray<WorkspaceSandbox.QueuedEffect>
  /**
   * Paths the body wrote outside its declared write set. Non-empty only in
   * expected mode — hard mode fails instead — and the whole tree is in view,
   * not just the declared read set `StepBoundary` can re-measure.
   */
  readonly deviations: ReadonlyArray<string>
  /** How many times copy-back lost a race and the attempt re-ran from a fresh base. */
  readonly rebases: number
}

/**
 * How many times a losing copy-back re-runs the body from a fresh base.
 *
 * Bounded on purpose: an unbounded rebase against a workspace under sustained
 * concurrent modification never converges. This retry budget does not
 * recreate the removed worktree-lane surface.
 *
 * @since 0.1.0
 * @category models
 */
export const defaultMaxRebases = 3

const bundleIdentity = (
  entries: ReadonlyArray<readonly [string, string | undefined, string | undefined]>
): Effect.Effect<string, never, Crypto.Crypto> =>
  Schema.decodeUnknownEffect(DerivedKey)({
    kind: "bundle-identity",
    // Canonicalization substitutes undefined array slots with null. Name and
    // normalize each member first so absence is explicit in this durable key.
    entries: entries.map(([path, before, after]) => ({
      path,
      before: before ?? null,
      after: after ?? null
    }))
  }).pipe(Effect.orDie)

const conflicted = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) =>
    Cause.isFailReason(reason) && reason.error instanceof WorkspaceSandbox.MaterializationConflict
  )

/**
 * Runs one action body inside a workspace transaction and copies its result
 * back.
 *
 * The host is untouched until copy-back, so every refusal below leaves the
 * tree exactly as it found it:
 *
 * - a body failure propagates unchanged, because it is the action's own
 *   declared error and the retry policy must still match on it;
 * - an execution the declaration did not predict fails with the boundary's own
 *   {@link StepBoundary.UndeclaredWrite}, which routes it through the caller's
 *   existing hard-violation classification instead of inventing a second one;
 * - a lost copy-back race re-runs the body from a fresh base up to
 *   `maxRebases` times before surfacing the conflict.
 *
 * @since 0.1.0
 * @category constructors
 */
export const execute = (options: {
  readonly sandbox: WorkspaceSandbox.Service
  readonly descriptor: FileBoundary
  /**
   * The action body. The engine's encoded effect erases its requirements, so
   * the sandbox's own surfaces are named here: they are what `execute` seeds,
   * and naming them keeps a caller from having to launder the type.
   */
  readonly workflow: Effect.Effect<unknown, unknown, WorkspaceSandbox.Workspace | FileSystem.FileSystem>
  readonly maxRebases?: number | undefined
}): Effect.Effect<Settlement, unknown, Crypto.Crypto> => {
  const maxRebases = options.maxRebases ?? defaultMaxRebases
  const attempt = (rebases: number): Effect.Effect<Settlement, unknown, Crypto.Crypto> =>
    Effect.gen(function*() {
      const executed = yield* options.sandbox.execute({
        descriptor: options.descriptor,
        workflow: options.workflow
      })
      if (executed._tag === "Invalidated") {
        // NOTHING IS RETURNED FROM AN INVALIDATED EXECUTION. The candidate
        // output, its files, and its queued effects are not on the shape at
        // all; only the violations and the provenance identifying them are.
        const paths = executed.violations.map((violation) => violation.resource.id)
        const identity = yield* bundleIdentity(
          executed.provenance.outputs.map((output) => [output.resource.id, undefined, output.digest])
        )
        if (executed.violations.some((violation) => violation.kind === "undeclared-read")) {
          return yield* Effect.fail(
            new StepSandbox.UndeclaredRead({
              code: "undeclared_read",
              paths: executed.violations
                .filter((violation) => violation.kind === "undeclared-read")
                .map((violation) => violation.resource.id),
              diffIdentity: identity
            })
          )
        }
        return yield* Effect.fail(
          new StepBoundary.UndeclaredWrite({
            code: "undeclared_write",
            paths,
            diffIdentity: identity
          })
        )
      }
      const identity = yield* bundleIdentity(
        executed.result.files.map((change) => [change.path, change.beforeDigest, change.afterDigest])
      )
      const applied = yield* options.sandbox.materialize(executed).pipe(Effect.exit)
      if (Exit.isFailure(applied)) {
        // Only a conflict is rebaseable: it says the base moved, which a fresh
        // execution answers. A host or artifact refusal says the copy-back
        // itself cannot be performed, and re-running the body would not help.
        return conflicted(applied.cause) && rebases < maxRebases
          ? yield* attempt(rebases + 1)
          : yield* Effect.failCause(applied.cause)
      }
      return {
        result: executed.result.output,
        bundleIdentity: identity,
        files: executed.result.files,
        effects: executed.result.effects,
        deviations: executed.violations.map((violation) => violation.resource.id),
        rebases
      }
    })
  return attempt(0)
}
