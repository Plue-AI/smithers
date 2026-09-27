/**
 * Initial persisted plan schema.
 *
 * This package owns `flows_plans`, `flows_plan_nodes`, and `flows_plan_edges`
 * and reserves migration id block `4000`, so this migration is id `4001` — see
 * `@smthrs/database`'s `Migrations` for how the blocks compose (the journal,
 * run store, step cache, and engine store hold `0`, `1000`, `2000`, `3000`).
 *
 * **Append-only is enforced in the schema, not by convention.**
 * A plan with dynamic nodes is not invalidated by elaboration, it *grows*; the triggers below make a rewritten or deleted
 * node row an error the database raises rather than a rule a caller can
 * forget. The `flows_plans` row itself moves forward — a generation and a
 * digest advance as subgraphs land — so it accepts an UPDATE, but only one
 * that raises the generation and leaves the approved base digest alone.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the plan tables and the triggers that make them append-only.
 *
 * @private
 * @since 0.1.0
 * @slop
 */
export const initial: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE flows_plans (
    plan_id TEXT PRIMARY KEY CHECK (length(plan_id) > 0),
    flow TEXT NOT NULL CHECK (length(flow) > 0),
    base_digest TEXT NOT NULL CHECK (length(base_digest) > 0),
    digest TEXT NOT NULL CHECK (length(digest) > 0),
    generation ${Dialect.integer(sql)} NOT NULL CHECK (${Dialect.isInteger(sql, sql`generation`)} AND generation >= 0),
    created_at_ms ${Dialect.integer(sql)} NOT NULL CHECK (
      ${Dialect.isInteger(sql, sql`created_at_ms`)} AND
      created_at_ms >= 0 AND
      created_at_ms <= 9007199254740991
    )
  )`

  yield* sql`CREATE TABLE flows_plan_nodes (
    plan_id TEXT NOT NULL CHECK (length(plan_id) > 0),
    node_id TEXT NOT NULL CHECK (length(node_id) > 0),
    generation ${Dialect.integer(sql)} NOT NULL CHECK (${Dialect.isInteger(sql, sql`generation`)} AND generation >= 0),
    ordinal ${Dialect.integer(sql)} NOT NULL CHECK (${Dialect.isInteger(sql, sql`ordinal`)} AND ordinal >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('step', 'agent', 'merge')),
    key_digest TEXT NOT NULL CHECK (length(key_digest) > 0),
    node_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`node_json`)}),
    PRIMARY KEY (plan_id, node_id)
  )`

  yield* sql`CREATE TABLE flows_plan_edges (
    plan_id TEXT NOT NULL CHECK (length(plan_id) > 0),
    from_node TEXT NOT NULL CHECK (length(from_node) > 0),
    to_node TEXT NOT NULL CHECK (length(to_node) > 0),
    PRIMARY KEY (plan_id, from_node, to_node)
  )`

  yield* sql`CREATE INDEX flows_plan_nodes_order ON flows_plan_nodes (plan_id, ordinal)`

  yield* Dialect.trigger(sql, {
    name: `flows_plan_nodes_append_only`,
    table: `flows_plan_nodes`,
    event: "BEFORE UPDATE",
    reject: "flows_plan_nodes is append-only"
  })

  yield* Dialect.trigger(sql, {
    name: `flows_plan_nodes_no_delete`,
    table: `flows_plan_nodes`,
    event: "BEFORE DELETE",
    reject: "flows_plan_nodes is append-only"
  })

  yield* Dialect.trigger(sql, {
    name: `flows_plan_edges_append_only`,
    table: `flows_plan_edges`,
    event: "BEFORE UPDATE",
    reject: "flows_plan_edges is append-only"
  })

  yield* Dialect.trigger(sql, {
    name: `flows_plan_edges_no_delete`,
    table: `flows_plan_edges`,
    event: "BEFORE DELETE",
    reject: "flows_plan_edges is append-only"
  })

  yield* Dialect.trigger(sql, {
    name: `flows_plans_forward_only`,
    table: `flows_plans`,
    event: "BEFORE UPDATE",
    when: `NEW.generation <= OLD.generation OR NEW.base_digest <> OLD.base_digest`,
    reject: "a plan only grows"
  })
})
