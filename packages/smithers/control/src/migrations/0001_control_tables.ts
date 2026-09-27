/**
 * Initial durable control-plane schema.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const statements = (sql: SqlClient.SqlClient) =>
  [
    sql`CREATE TABLE IF NOT EXISTS control_plans (
    ${Dialect.rowId(sql)}
    plan_id TEXT PRIMARY KEY,
    card_json TEXT NOT NULL,
    decoded_input_json TEXT NOT NULL,
    decision TEXT NOT NULL
  )`,
    sql`CREATE TABLE IF NOT EXISTS control_plan_keys (
    idempotency_key TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    plan_id TEXT NOT NULL
  )`,
    sql`CREATE TABLE IF NOT EXISTS control_tokens (
    target_tag TEXT NOT NULL,
    run_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    target_json TEXT NOT NULL,
    resolved ${Dialect.integer(sql)} NOT NULL,
    decision_principal_json TEXT,
    PRIMARY KEY (target_tag, run_id, target_id),
    CHECK (target_tag IN ('Plan', 'Node')),
    CHECK ((target_tag = 'Plan' AND run_id = '') OR (target_tag = 'Node' AND length(run_id) > 0)),
    CHECK (length(target_id) > 0 AND token_id = target_id)
  )`,
    sql`CREATE TABLE IF NOT EXISTS control_grants (
    target_tag TEXT NOT NULL,
    run_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    scope TEXT NOT NULL,
    installed_at_ms ${Dialect.integer(sql)} NOT NULL,
    PRIMARY KEY (target_tag, run_id, target_id),
    CHECK (target_tag IN ('Plan', 'Node')),
    CHECK ((target_tag = 'Plan' AND run_id = '') OR (target_tag = 'Node' AND length(run_id) > 0)),
    CHECK (length(target_id) > 0 AND token_id = target_id)
  )`,
    sql`CREATE TABLE IF NOT EXISTS control_mutations (
    mutation_key TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    receipt_json TEXT NOT NULL
  )`,
    sql`CREATE TABLE IF NOT EXISTS control_runs (
    run_id TEXT PRIMARY KEY,
    created_seq ${Dialect.integer(sql)} NOT NULL
  )`,
    sql`CREATE TABLE IF NOT EXISTS control_run_resumes (
    run_id TEXT PRIMARY KEY,
    requested_seq ${Dialect.integer(sql)} NOT NULL,
    requested_at_ms ${Dialect.integer(sql)} NOT NULL
  )`,
    sql`CREATE TABLE IF NOT EXISTS control_run_messages (
    seq ${Dialect.identity(sql)},
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`,
    sql`CREATE TABLE IF NOT EXISTS control_sequences (
    name TEXT PRIMARY KEY,
    value ${Dialect.integer(sql)} NOT NULL
  )`,
    sql`CREATE TABLE IF NOT EXISTS control_credentials (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    version ${Dialect.integer(sql)} NOT NULL,
    updated_at_ms ${Dialect.integer(sql)} NOT NULL
  )`
  ] as const

/**
 * Creates every table owned by `@smthrs/control`.
 *
 * `IF NOT EXISTS` lets the recorded migration and each standalone adapter's
 * bootstrap share this exact schema without competing over table creation.
 *
 * @category migrations
 * @since 0.1.0
 */
export const initial: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  for (const statement of statements(sql)) {
    yield* statement
  }
})
