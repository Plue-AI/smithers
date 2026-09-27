/**
 * What an X connection can do, stated as data.
 *
 * Each operation this package performs is declared once, with every OAuth 2.0
 * scope X requires for it. A host reads the table to show what a connection's
 * grant allows, and the client consults it before every request, so an
 * operation the grant does not cover fails as `permission-denied` naming the
 * scopes it lacks rather than reaching X.
 *
 * `personalAccount` records that an X connection is, by default, someone's
 * own account. A host may still connect an organization's account and mark
 * that connection otherwise; who may use either is host policy.
 *
 * @since 1.0.0
 */

import { IntegrationError } from "../core/IntegrationError.ts"

/**
 * An operation the X client performs.
 *
 * - `read`: the account itself, its mentions, and a user's posts.
 * - `dm-read`: direct message events.
 * - `post`: create a post.
 * - `dm-write`: send a direct message.
 *
 * @category models
 * @since 1.0.0
 */
export type Operation = "read" | "dm-read" | "post" | "dm-write"

/**
 * Every operation, in declaration order.
 *
 * @category constants
 * @since 1.0.0
 */
export const operations: ReadonlyArray<Operation> = ["read", "dm-read", "post", "dm-write"]

/**
 * The scopes each operation requires: all of them.
 *
 * @category constants
 * @since 1.0.0
 */
export const requiredScopes: Readonly<Record<Operation, ReadonlyArray<string>>> = {
  read: ["tweet.read", "users.read"],
  "dm-read": ["dm.read", "tweet.read", "users.read"],
  post: ["tweet.read", "tweet.write", "users.read"],
  "dm-write": ["dm.read", "dm.write", "tweet.read", "users.read"]
}

/**
 * Whether connections to this provider are, by default, a person's own
 * account.
 *
 * @category constants
 * @since 1.0.0
 */
export const personalAccount = true

/**
 * The scopes `operation` needs that `granted` lacks.
 *
 * @category getters
 * @since 1.0.0
 */
export const missing = (granted: ReadonlyArray<string>, operation: Operation): ReadonlyArray<string> =>
  requiredScopes[operation].filter((scope) => !granted.includes(scope))

/**
 * Whether `granted` allows `operation`.
 *
 * @category refinements
 * @since 1.0.0
 */
export const allows = (granted: ReadonlyArray<string>, operation: Operation): boolean =>
  missing(granted, operation).length === 0

/**
 * The operations `granted` allows, in declaration order.
 *
 * @category getters
 * @since 1.0.0
 */
export const available = (granted: ReadonlyArray<string>): ReadonlyArray<Operation> =>
  operations.filter((operation) => allows(granted, operation))

/**
 * The typed refusal for an operation `granted` does not allow, or `undefined`
 * when it does.
 *
 * @category constructors
 * @since 1.0.0
 */
export const refusal = (granted: ReadonlyArray<string>, operation: Operation): IntegrationError | undefined => {
  const lacking = missing(granted, operation)
  return lacking.length === 0 ? undefined : new IntegrationError(
    "permission-denied",
    `The X connection's grant does not allow "${operation}"; it lacks: ${lacking.join(", ")}.`,
    { operation, missingScopes: [...lacking], retryable: false }
  )
}
