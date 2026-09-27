/**
 * Pins plan identity in the forward-only trigger.
 *
 * The hardened trigger from `0002_append_only_hardening` guards `generation`,
 * `base_digest`, `flow`, and `created_at_ms`, but not `plan_id`. A forward
 * UPDATE could therefore rename a plan while raising its generation, stranding
 * the plan's immortal node and edge rows under the old id and making that id
 * unrecordable — the same stranding class `0002` closed for DELETE, left open
 * on the identity column. Append-only is enforced in the schema, not by
 * convention, so this migration recreates the trigger with the `plan_id` pin.
 *
 * This package reserves migration id block `4000`, so this migration is id
 * `4003`. See `@smthrs/database`'s `Migrations` for namespaced composition.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Recreates the forward-only trigger so a plan row can never change identity.
 *
 * @private
 * @since 0.1.0
 * @slop
 */
export const forwardOnlyIdentity: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* Dialect.dropTrigger(sql, "flows_plans_forward_only", "flows_plans")

  yield* Dialect.trigger(sql, {
    name: `flows_plans_forward_only`,
    table: `flows_plans`,
    event: "BEFORE UPDATE",
    when: `NEW.plan_id <> OLD.plan_id OR
      NEW.generation <= OLD.generation OR
      NEW.base_digest <> OLD.base_digest OR
      NEW.flow <> OLD.flow OR
      NEW.created_at_ms <> OLD.created_at_ms`,
    reject: "a plan only grows"
  })
})
