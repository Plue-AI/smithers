/**
 * A configured provider connection, as journal-safe data.
 *
 * A connection names a provider account the host holds a credential for, the
 * scopes the provider actually granted, and the containers (channels,
 * repositories, calendars) it may be used with. It never carries the secret:
 * `credential` is a control-plane `CredentialRef`, resolved through the
 * credential broker only at dispatch, so the value can appear in a flow
 * payload, a plan, or a journal entry.
 *
 * `personal` marks a connection to a person's own account. Which principals
 * may resolve its credential is a host authorization decision: `resolveSecret`
 * asks the host's `authorize` hook for the principal and the connection before
 * it touches the credential broker, and `personalPolicy` is the fail-closed
 * shape of that hook, under which only the named principals resolve personal
 * connections.
 *
 * @since 1.0.0
 */

import type { Credential } from "@smthrs/control/Credential"
import { Effect, type Redacted, Schema } from "effect"
import { IntegrationError } from "./IntegrationError.ts"

/**
 * The shape a connection id must have: lowercase, digits, and single hyphens.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ConnectionId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/))

/**
 * A journal-safe reference to a stored credential.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CredentialReference = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString
})

/**
 * One configured provider connection.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Connection = Schema.Struct({
  id: ConnectionId,
  /** The provider: `github`, `slack`, `googlecalendar`. */
  provider: Schema.NonEmptyString,
  /** A human label for operators. */
  label: Schema.String,
  credential: CredentialReference,
  /** The provider scopes the credential actually holds. */
  scopes: Schema.Array(Schema.NonEmptyString),
  /** Whether this is a person's own account rather than an organization identity. */
  personal: Schema.Boolean,
  /** The containers the connection may be used with. Empty means none: allowlists fail closed. */
  containers: Schema.Array(Schema.NonEmptyString),
  /** A provider API origin override, for enterprise hosts and fixture servers. */
  apiBaseUrl: Schema.optionalKey(Schema.String)
})

/**
 * One configured provider connection.
 *
 * @category models
 * @since 1.0.0
 */
export type Connection = typeof Connection.Type

/**
 * Decodes an unknown value as a {@link Connection}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const decode = Schema.decodeUnknownEffect(Connection)

/**
 * The container id that allows every container of a connection.
 *
 * @category constants
 * @since 1.0.0
 */
export const ANY_CONTAINER = "*"

/**
 * Whether `connection` may be used with `container`: the connection lists it,
 * or lists {@link ANY_CONTAINER}. An empty list allows nothing.
 *
 * @category authorization
 * @since 1.0.0
 */
export const containersAllowed = (connection: Pick<Connection, "containers">, container: string): boolean =>
  connection.containers.includes(ANY_CONTAINER) || connection.containers.includes(container)

/**
 * The host's decision whether `principal` may use `connection`'s credential.
 *
 * Answers `true` to allow. `false` is refused as `permission-denied`; a
 * failure is passed through.
 *
 * @category models
 * @since 1.0.0
 */
export type Authorize = (principal: string, connection: Connection) => Effect.Effect<boolean, IntegrationError>

/**
 * A fail-closed host policy.
 *
 * A personal connection is resolvable only by a principal in
 * `personalPrincipals`, whatever `shared` says. Any other connection is decided
 * by `shared`, which defaults to allowing every principal.
 *
 * @category authorization
 * @since 1.0.0
 */
export const personalPolicy = (options: {
  readonly personalPrincipals: ReadonlyArray<string>
  readonly shared?: Authorize | undefined
}): Authorize => {
  const personal = new Set(options.personalPrincipals)
  const shared = options.shared ?? (() => Effect.succeed(true))
  return (principal, connection) =>
    connection.personal ? Effect.succeed(personal.has(principal)) : shared(principal, connection)
}

/**
 * Resolves `connection`'s secret for `principal`, at the transport boundary.
 *
 * `authorize` runs first, so a refused principal never reaches the broker. The
 * broker then authenticates the credential reference itself. A refusal by
 * either is `permission-denied`; a broker with no storage, or a stored value it
 * cannot open, is `credentials-missing`. Neither carries the secret, and the
 * resolved value stays `Redacted`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const resolveSecret = (options: {
  readonly credentials: Credential
  readonly connection: Connection
  readonly principal: string
  readonly authorize: Authorize
}): Effect.Effect<Redacted.Redacted<string>, IntegrationError> => {
  const { connection, principal } = options
  const details = { connectionId: connection.id, provider: connection.provider, principal, retryable: false }
  return Effect.gen(function*() {
    const allowed = yield* options.authorize(principal, connection)
    if (allowed !== true) {
      return yield* Effect.fail(
        new IntegrationError(
          "permission-denied",
          `Principal "${principal}" may not use connection "${connection.id}".`,
          details
        )
      )
    }
    return yield* options.credentials.resolve({ id: connection.credential.id, name: connection.credential.name }).pipe(
      Effect.mapError((error) =>
        new IntegrationError(
          // A refused or unknown reference is a denial; storage that is absent
          // or cannot open the sealed value leaves the connection unusable.
          error._tag === "/control/Unauthorized" ? "permission-denied" : "credentials-missing",
          `The credential for connection "${connection.id}" could not be resolved.`,
          { ...details, credentialFailure: error.code },
          { cause: error }
        )
      )
    )
  })
}
