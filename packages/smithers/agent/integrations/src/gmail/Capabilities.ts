/**
 * What a Gmail connection can do, stated as data.
 *
 * Each operation this package performs is declared once, with the OAuth
 * scopes Google accepts for it. A host reads the table to show what a
 * connection's grant allows, and the client consults it before every request,
 * so an operation the grant does not cover fails as `permission-denied`
 * naming the scopes it needs, instead of reaching Google and failing there or,
 * worse, succeeding under a broader grant than the operator meant to use.
 *
 * `personalAccount` records the nature of the provider: a Gmail connection is
 * someone's own mailbox. Which principal may use it is host policy; this
 * module only states the fact that policy needs.
 *
 * @since 1.0.0
 */

import { IntegrationError } from "../core/IntegrationError.ts"

/**
 * An operation the Gmail client performs.
 *
 * - `metadata`: list messages without a search query, read a message's
 *   headers, read history and the profile.
 * - `read`: read a whole message and search with a query.
 * - `draft`: create a draft.
 * - `send`: send a message.
 *
 * @category models
 * @since 1.0.0
 */
export type Operation = "metadata" | "read" | "draft" | "send"

/**
 * Every operation, in declaration order.
 *
 * @category constants
 * @since 1.0.0
 */
export const operations: ReadonlyArray<Operation> = ["metadata", "read", "draft", "send"]

/**
 * Google's full-access mailbox scope.
 *
 * @category constants
 * @since 1.0.0
 */
export const SCOPE_FULL = "https://mail.google.com/"

/**
 * Read-only mailbox access.
 *
 * @category constants
 * @since 1.0.0
 */
export const SCOPE_READONLY = "https://www.googleapis.com/auth/gmail.readonly"

/**
 * Headers and labels only, no bodies and no search.
 *
 * @category constants
 * @since 1.0.0
 */
export const SCOPE_METADATA = "https://www.googleapis.com/auth/gmail.metadata"

/**
 * Drafts and sending.
 *
 * @category constants
 * @since 1.0.0
 */
export const SCOPE_COMPOSE = "https://www.googleapis.com/auth/gmail.compose"

/**
 * Sending only.
 *
 * @category constants
 * @since 1.0.0
 */
export const SCOPE_SEND = "https://www.googleapis.com/auth/gmail.send"

/**
 * Everything except permanent deletion.
 *
 * @category constants
 * @since 1.0.0
 */
export const SCOPE_MODIFY = "https://www.googleapis.com/auth/gmail.modify"

/**
 * The scopes that each allow an operation: holding any one is enough.
 *
 * @category constants
 * @since 1.0.0
 */
export const acceptedScopes: Readonly<Record<Operation, ReadonlyArray<string>>> = {
  metadata: [SCOPE_METADATA, SCOPE_READONLY, SCOPE_MODIFY, SCOPE_FULL],
  read: [SCOPE_READONLY, SCOPE_MODIFY, SCOPE_FULL],
  draft: [SCOPE_COMPOSE, SCOPE_MODIFY, SCOPE_FULL],
  send: [SCOPE_SEND, SCOPE_COMPOSE, SCOPE_MODIFY, SCOPE_FULL]
}

/**
 * Whether connections to this provider are a person's own account.
 *
 * @category constants
 * @since 1.0.0
 */
export const personalAccount = true

/**
 * Whether `granted` allows `operation`.
 *
 * @category refinements
 * @since 1.0.0
 */
export const allows = (granted: ReadonlyArray<string>, operation: Operation): boolean =>
  acceptedScopes[operation].some((scope) => granted.includes(scope))

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
export const refusal = (granted: ReadonlyArray<string>, operation: Operation): IntegrationError | undefined =>
  allows(granted, operation) ? undefined : new IntegrationError(
    "permission-denied",
    `The Gmail connection's grant does not allow "${operation}"; it needs one of: ${
      acceptedScopes[operation].join(", ")
    }.`,
    { operation, requiredAnyOf: [...acceptedScopes[operation]], retryable: false }
  )
