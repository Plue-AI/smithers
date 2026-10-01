/** Execution identity refusals shared by authoring and engine layers.
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Fault from "../Fault.ts"

/**
 * A caller reused an execution id for different persisted run identity.
 *
 * @category errors
 * @since 1.0.0
 */
export class ExecutionIdentityConflict extends Schema.TaggedError<ExecutionIdentityConflict>()(
  "@smthrs/engine/ExecutionIdentityConflict",
  {
    code: Schema.Literal("execution_identity_conflict").pipe(
      Schema.withConstructorDefault(Effect.succeed("execution_identity_conflict"))
    ),
    executionId: Schema.String,
    field: Schema.Literals(["flow", "payload", "capabilities", "lineage", "round", "parent"]),
    expected: Schema.String,
    actual: Schema.String,
    status: Schema.Literals(["pending", "running", "suspended", "completed", "failed", "cancelled", "unknown"]).pipe(
      Schema.withConstructorDefault(Effect.succeed("unknown"))
    ),
    message: Schema.String
  }
) {}

Fault.register("@smthrs/engine/ExecutionIdentityConflict", "bug")
