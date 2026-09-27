/**
 * The host snapshot boundary compensable actions are executed against.
 *
 * @since 0.1.0
 */

import type { Flow } from "@smthrs/flow"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * A compensable action was admitted without a snapshot boundary.
 *
 * @category errors
 * @since 1.0.0
 */
export class SnapshotBoundaryRequired extends Schema.TaggedError<SnapshotBoundaryRequired>()(
  "@smthrs/engine/SnapshotBoundaryRequired",
  {
    code: Schema.Literal("snapshot_boundary_required").pipe(
      Schema.withConstructorDefault(Effect.succeed("snapshot_boundary_required"))
    ),
    actionName: Schema.String,
    message: Schema.String
  }
) {}

/**
 * Context passed to a compensable action snapshot boundary.
 *
 * @category models
 * @since 0.1.0
 */
export interface SnapshotBoundaryOptions {
  readonly flow: Flow.Any
  readonly executionId: string
  readonly key: string
  readonly attempt: number
  readonly metadata: unknown
}

/**
 * Minimal host snapshot boundary required by compensable actions.
 *
 * @category services
 * @since 0.1.0
 */
export class SnapshotBoundary extends Context.Service<
  SnapshotBoundary,
  {
    readonly snapshot: (options: SnapshotBoundaryOptions) => Effect.Effect<unknown>
    readonly restore: (
      snapshot: unknown,
      options: SnapshotBoundaryOptions
    ) => Effect.Effect<void>
    readonly diff: (
      snapshot: unknown,
      options: SnapshotBoundaryOptions
    ) => Effect.Effect<unknown>
  }
>()("@smthrs/engine/FlowEngine/SnapshotBoundary") {}
