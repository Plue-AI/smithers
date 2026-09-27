// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Failure raised when executing a flow would close a cycle in the persisted
 * parent-execution chain.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Raised when executing a flow would close a cycle in the persisted
 * parent-execution chain, which is a child asking to execute an execution id
 * that already appears among its own ancestors.
 *
 * This is a **typed failure**, never a defect: the caller is expected to be
 * able to recover from it (see `docs/troubleshooting.md`,
 * "FlowRuntime.FlowCycleDetected"). Detection itself lives in
 * `@smthrs/engine-store`'s `DurableEngineState.recordRunParent`, which
 * inserts the durable parent edge and walks the parent chain in O(depth)
 * inside one storage transaction, rolling back on a hit; the error is
 * declared here because it is part of the `execute` contract this package
 * owns.
 *
 * @category errors
 * @since 0.1.0
 */
export class FlowCycleDetected extends Schema.TaggedError<FlowCycleDetected>()(
  "@smthrs/flow/FlowCycleDetected",
  {
    /** Stable public error code. */
    // This wire shape freezes at 1.0.0-rc.0.
    code: Schema.Literal("flow_cycle_detected").pipe(
      Schema.withConstructorDefault(Effect.succeed("flow_cycle_detected"))
    ),
    /** Ordered execution ids from the cycle's target back to itself. */
    path: Schema.Array(Schema.String)
  }
) {}
