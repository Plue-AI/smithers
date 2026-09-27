/**
 * Bind source observations to the runtime identity that admitted them.
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Older heads retain NULL: their original runtime environment is unknowable.
 * New heads require an environment fingerprint, immutable for their lifetime.
 * @since 1.0.0
 * @category migrations
 */
export const planEnvironment: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE flows_plan_input_heads ADD COLUMN environment_digest TEXT
    CHECK (environment_digest IS NULL OR length(environment_digest) > 0)`
  yield* Dialect.trigger(sql, {
    name: `flows_plan_input_heads_environment_required`,
    table: `flows_plan_input_heads`,
    event: "BEFORE INSERT",
    when: `NEW.environment_digest IS NULL`,
    reject: "new plan input heads require an environment identity"
  })
  yield* Dialect.trigger(sql, {
    name: `flows_plan_input_heads_environment_immutable`,
    table: `flows_plan_input_heads`,
    event: "BEFORE UPDATE",
    when: `NEW.environment_digest IS DISTINCT FROM OLD.environment_digest`,
    reject: "plan input environment identity is immutable"
  })
})
