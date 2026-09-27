/**
 * Commit-owned process-local updates shared by stores.
 *
 * @since 1.0.0
 */

import { Context, Effect, Option } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Registrations owned by one write attempt or nested savepoint.
 *
 * @category internal
 * @since 1.0.0
 */
export interface CommitScope {
  readonly key: SqlClient.SqlClient["transactionService"]
  readonly transaction: SqlClient.TransactionConnection.Service
  readonly effects: Array<Effect.Effect<void>>
  open: boolean
}

/**
 * The transaction owner inherited by effects inside a managed write.
 *
 * @category internal
 * @since 1.0.0
 */
export const Current = Context.Reference<CommitScope | undefined>("@smthrs/database/CommitScope", {
  defaultValue: () => undefined
})

/**
 * Checks ownership, including depth: a raw SQL savepoint is not owned by the
 * enclosing writer. Closed scopes cannot accept work from an escaped fiber.
 *
 * @category internal
 * @since 1.0.0
 */
export const matches = (
  scope: CommitScope | undefined,
  key: SqlClient.SqlClient["transactionService"],
  transaction: SqlClient.TransactionConnection.Service
): scope is CommitScope =>
  scope !== undefined && scope.open && scope.key === key &&
  scope.transaction[0] === transaction[0] && scope.transaction[1] === transaction[1]

/**
 * Registers optional publication only when the current transaction is owned.
 *
 * @category internal
 * @since 1.0.0
 */
export const afterCommit = (
  effect: Effect.Effect<void>,
  client?: SqlClient.SqlClient
): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    const scope = yield* Current
    if (scope === undefined || (client !== undefined && scope.key !== client.transactionService)) return false
    const transaction = yield* Effect.serviceOption(scope.key)
    if (Option.isNone(transaction) || !matches(scope, scope.key, transaction.value)) return false
    scope.effects.push(effect)
    return true
  })
