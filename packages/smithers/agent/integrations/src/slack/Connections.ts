/**
 * Which Slack connection an action reaches the workspace through.
 *
 * A durable Slack action names a `connectionId` and a channel in its payload,
 * and both are journal-safe data. The host decides what they mean: it builds
 * one {@link Resolved} per configured `Connection`, each with a client whose
 * tokens come from the credential broker, and provides them as
 * {@link SlackConnections}. Resolution is where the connection's container
 * allowlist is enforced: an action may only post to a channel the connection
 * lists, and an unknown connection or an unlisted channel is refused
 * `permission-denied` before any request is made. An empty container list
 * admits nothing; `"*"` (`Connection.ANY_CONTAINER`) admits every channel,
 * which is what a host that answers an owner's direct messages needs before
 * it knows their `D…` ids.
 *
 * Two constructors build a {@link Resolved}. {@link fromEnvironment} reads the
 * bot and app tokens from `SMITHERS_SLACK_BOT_TOKEN` and
 * `SMITHERS_SLACK_APP_TOKEN`, for a local host with one Slack app.
 * {@link fromConnection} asks the credential broker for each token at the
 * moment a call needs it, through `Connection.resolveSecret`, so the host
 * policy decides first and the token is never held in configuration. Either
 * way a token stays `Redacted` until it reaches the `Authorization` header.
 *
 * @since 1.0.0
 */

import type { Credential } from "@smthrs/control/Credential"
import { Context, Effect, Layer } from "effect"
import * as AccessToken from "../core/AccessToken.ts"
import { type Authorize, type Connection, containersAllowed, resolveSecret } from "../core/Connection.ts"
import { IntegrationError, isIntegrationError } from "../core/IntegrationError.ts"
import * as Environment from "../Environment.ts"
import { ENV, resolve as resolveConfig, type SlackConfig } from "./Config.ts"
import { make as makeClient, type SlackClient, type Tokens } from "./SlackClient.ts"

/**
 * One configured connection and the client that acts for it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Resolved {
  readonly connection: Connection
  readonly client: SlackClient
}

/**
 * The resolver a Slack action asks for its client.
 *
 * @category services
 * @since 1.0.0
 */
export interface SlackConnections {
  /** The client for `connectionId`, once `channel` is in the connection's containers. */
  readonly resolve: (connectionId: string, channel: string) => Effect.Effect<SlackClient, IntegrationError>
}

/**
 * Service tag for the Slack connection resolver.
 *
 * @category services
 * @since 1.0.0
 */
export const SlackConnections: Context.Service<SlackConnections, SlackConnections> = Context.Service(
  "@smthrs/integrations/SlackConnections"
)

const denied = (message: string, details: Record<string, unknown>): IntegrationError =>
  new IntegrationError("permission-denied", message, { ...details, retryable: false, outcomeUnknown: false })

/**
 * Builds the resolver over configured connections.
 *
 * Throws `IntegrationError` with reason `invalid-config` for a connection
 * whose provider is not `slack` and for a duplicated connection id.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (entries: ReadonlyArray<Resolved>): SlackConnections => {
  const byId = new Map<string, Resolved>()
  for (const entry of entries) {
    const id = entry.connection.id
    if (entry.connection.provider !== "slack" || byId.has(id)) {
      throw new IntegrationError("invalid-config", `Slack connection ${id} is not a distinct Slack connection.`, {
        connectionId: id,
        provider: entry.connection.provider,
        retryable: false
      })
    }
    byId.set(id, entry)
  }
  return SlackConnections.of({
    resolve: (connectionId, channel) => {
      const entry = byId.get(connectionId)
      if (entry === undefined) {
        return Effect.fail(denied(`Slack connection ${connectionId} is not configured.`, { connectionId }))
      }
      return containersAllowed(entry.connection, channel)
        ? Effect.succeed(entry.client)
        : Effect.fail(denied(`Slack connection ${connectionId} does not grant channel ${channel}.`, {
          connectionId,
          channel
        }))
    }
  })
}

const attempt = <A>(build: () => A): Effect.Effect<A, IntegrationError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(build())
    } catch (error) {
      if (isIntegrationError(error)) return Effect.fail(error)
      throw error
    }
  })

/**
 * Layer for the resolver. A config error is a typed layer failure.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (entries: ReadonlyArray<Resolved>): Layer.Layer<SlackConnections, IntegrationError> =>
  Layer.effect(SlackConnections)(attempt(() => make(entries)))

/**
 * A client for one connection: pinned to the connection's API origin, with
 * tokens only from `tokens`, never from the environment.
 *
 * Throws `IntegrationError` with reason `invalid-config` for a bad limit or
 * API origin.
 *
 * @category constructors
 * @since 1.0.0
 */
export const clientFor = (
  connection: Connection,
  tokens: Tokens,
  config: ClientLimits = {}
): SlackClient => makeClient({ ...config, apiBaseUrl: connection.apiBaseUrl }, {}, tokens)

/**
 * Client limits a connection's client may set. Tokens and the API origin come
 * from the connection or the environment, never from here.
 *
 * @category models
 * @since 1.0.0
 */
export type ClientLimits = Omit<SlackConfig, "botToken" | "appToken" | "signingSecret" | "apiBaseUrl">

/**
 * What {@link fromEnvironment} needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface EnvironmentOptions extends ClientLimits {
  /** The connection id actions name. Defaults to `slack`. */
  readonly connectionId?: string | undefined
  /**
   * The channels actions may post to. Required: an empty list admits nothing,
   * and `["*"]` admits every channel, including direct messages.
   */
  readonly containers: ReadonlyArray<string>
  /** The bot scopes the app was granted, recorded on the connection. */
  readonly scopes?: ReadonlyArray<string> | undefined
}

/**
 * The single-app connection a local host configures from the environment.
 *
 * The bot token comes from `SMITHERS_SLACK_BOT_TOKEN` and is required; the
 * app-level token from `SMITHERS_SLACK_APP_TOKEN`, needed only by Socket Mode;
 * the API origin from `SMITHERS_SLACK_API_BASE_URL` when set. The connection's
 * `credential` names the variable, since there is no broker entry.
 *
 * Throws `IntegrationError` with reason `credentials-missing` when there is no
 * bot token, and `invalid-config` for a bad limit or origin.
 *
 * @category constructors
 * @since 1.0.0
 */
export const fromEnvironment = (
  options: EnvironmentOptions,
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): Resolved => {
  const { connectionId = "slack", containers, scopes = [], ...limits } = options
  const resolved = resolveConfig(limits, env)
  if (resolved.botToken === undefined) {
    throw new IntegrationError("credentials-missing", `Slack needs a bot token in ${ENV.botToken}.`, {
      connectionId,
      retryable: false
    })
  }
  const connection: Connection = {
    id: connectionId,
    provider: "slack",
    label: "Slack (environment)",
    credential: { id: "environment", name: ENV.botToken },
    scopes: [...scopes],
    personal: false,
    containers: [...containers],
    apiBaseUrl: resolved.apiBaseUrl
  }
  const tokens: Tokens = {
    bot: AccessToken.fixed(resolved.botToken),
    ...(resolved.appToken === undefined ? {} : { app: AccessToken.fixed(resolved.appToken) })
  }
  return { connection, client: makeClient({ ...limits, apiBaseUrl: resolved.apiBaseUrl }, {}, tokens) }
}

/**
 * Layer for the resolver over the one environment connection.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerFromEnvironment = (
  options: EnvironmentOptions,
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): Layer.Layer<SlackConnections, IntegrationError> =>
  Layer.effect(SlackConnections)(attempt(() => make([fromEnvironment(options, env)])))

/**
 * Who is asking to use a connection, and the host policy that decides.
 *
 * @category models
 * @since 1.0.0
 */
export interface ConnectionAccess {
  /** The principal the running task acts as, from trusted host state. */
  readonly principal: string
  /** The host's decision, such as `Connection.personalPolicy`. */
  readonly authorize: Authorize
}

/**
 * A connection whose tokens the credential broker holds.
 *
 * `connection.credential` names the bot token; `appCredential`, when given,
 * names the app-level token Socket Mode needs. Each call resolves its token
 * through `Connection.resolveSecret`, so `access.authorize` is asked before
 * the broker, and a revoked credential takes effect on the next call. The
 * client is pinned to the connection's API origin.
 *
 * Throws `IntegrationError` with reason `invalid-config` for a connection
 * whose provider is not `slack`, a bad limit, or a bad origin.
 *
 * @category constructors
 * @since 1.0.0
 */
export const fromConnection = (options: {
  readonly connection: Connection
  readonly credentials: Credential
  readonly access: ConnectionAccess
  readonly appCredential?: Connection["credential"] | undefined
  readonly limits?: ClientLimits | undefined
}): Resolved => {
  const { access, appCredential, connection, credentials } = options
  if (connection.provider !== "slack") {
    throw new IntegrationError("invalid-config", `Connection ${connection.id} is not a Slack connection.`, {
      connectionId: connection.id,
      provider: connection.provider,
      retryable: false
    })
  }
  const source = (credential: Connection["credential"]): AccessToken.AccessTokenSource => ({
    token: resolveSecret({
      credentials,
      connection: { ...connection, credential },
      principal: access.principal,
      authorize: access.authorize
    }),
    invalidate: Effect.void
  })
  const tokens: Tokens = {
    bot: source(connection.credential),
    ...(appCredential === undefined ? {} : { app: source(appCredential) })
  }
  return { connection, client: clientFor(connection, tokens, options.limits) }
}
