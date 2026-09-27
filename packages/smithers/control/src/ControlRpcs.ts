/**
 * Schema-backed RPC projection of the control service.
 *
 * @since 0.1.0
 */

import { NotificationError } from "@smthrs/notifications/NotificationQueue"
import { Context, Effect, Layer, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/unstable/rpc"
import {
  AlreadyResolved,
  ClaimLost,
  ControlErrorSchema,
  EnvelopeMismatch,
  FlowNotFound,
  InvalidInput,
  LaunchFailed,
  NoMatchingWait,
  PersistenceError,
  PlanDenied,
  PlanDigestMismatch,
  PlanNotFound,
  RunNotFound,
  TransportError,
  Unauthorized,
  Unavailable
} from "./ControlError.ts"
import {
  ApprovalInputSchema,
  CancelInputSchema,
  ControlEvent,
  ListRequest,
  ListResponse,
  PlanCard,
  PlanInputSchema,
  type Principal,
  ReasonedMutationInputSchema,
  Receipt,
  RunInputSchema,
  SignalInputSchema,
  SteerInputSchema,
  WatchFilter
} from "./ControlSchema.ts"

/**
 * Authenticated principal made available to control RPC handlers.
 *
 * @category services
 * @since 0.1.0
 */
export class ControlPrincipal extends Context.Service<ControlPrincipal, typeof Principal.Type>()(
  "/control/ControlPrincipal"
) {}

/**
 * Middleware boundary that authenticates control RPC requests.
 *
 * @category middleware
 * @since 0.1.0
 */
export class ControlAuth extends RpcMiddleware.Service<ControlAuth, {
  provides: ControlPrincipal
}>()("/control/ControlAuth", { error: Unauthorized }) {}

const mutationErrors = Schema.Union([
  RunNotFound,
  ClaimLost,
  InvalidInput,
  PersistenceError,
  Unavailable,
  TransportError,
  Unauthorized
])

/**
 * The ten remote procedures corresponding to `Control` operations.
 *
 * @category groups
 * @since 0.1.0
 */
export const ControlRpcs = RpcGroup.make(
  Rpc.make("Plan", {
    payload: PlanInputSchema,
    success: PlanCard,
    error: Schema.Union([FlowNotFound, InvalidInput, PersistenceError, Unavailable, TransportError, Unauthorized])
  }),
  Rpc.make("Run", {
    payload: RunInputSchema,
    success: Receipt,
    error: Schema.Union([
      RunNotFound,
      PlanNotFound,
      PlanDenied,
      PlanDigestMismatch,
      EnvelopeMismatch,
      ClaimLost,
      InvalidInput,
      LaunchFailed,
      PersistenceError,
      Unavailable,
      TransportError,
      Unauthorized
    ])
  }),
  Rpc.make("Approve", {
    payload: ApprovalInputSchema,
    success: Receipt,
    error: Schema.Union([
      PlanDigestMismatch,
      EnvelopeMismatch,
      AlreadyResolved,
      PlanNotFound,
      RunNotFound,
      InvalidInput,
      Unauthorized,
      PersistenceError,
      Unavailable,
      TransportError
    ])
  }),
  Rpc.make("Deny", {
    payload: ApprovalInputSchema,
    success: Receipt,
    error: Schema.Union([
      PlanDigestMismatch,
      EnvelopeMismatch,
      AlreadyResolved,
      PlanNotFound,
      RunNotFound,
      InvalidInput,
      Unauthorized,
      PersistenceError,
      Unavailable,
      TransportError
    ])
  }),
  Rpc.make("Steer", {
    payload: SteerInputSchema,
    success: Receipt,
    error: Schema.Union([
      RunNotFound,
      InvalidInput,
      PersistenceError,
      Unavailable,
      TransportError,
      Unauthorized,
      NotificationError
    ])
  }),
  Rpc.make("Signal", {
    payload: SignalInputSchema,
    success: Receipt,
    error: Schema.Union([
      RunNotFound,
      NoMatchingWait,
      InvalidInput,
      PersistenceError,
      Unavailable,
      TransportError,
      Unauthorized
    ])
  }),
  Rpc.make("Cancel", { payload: CancelInputSchema, success: Receipt, error: mutationErrors }),
  Rpc.make("Resume", { payload: ReasonedMutationInputSchema, success: Receipt, error: mutationErrors }),
  // `list` and `watch` carry the whole `ControlError` union in their contract,
  // so they name it once rather than restating its members. Two hand-copied
  // lists is how `CredentialConflict` came to be a control error the union did
  // not admit.
  Rpc.make("List", {
    payload: ListRequest,
    success: ListResponse,
    error: ControlErrorSchema
  }),
  Rpc.make("Watch", {
    payload: WatchFilter,
    success: ControlEvent,
    error: ControlErrorSchema,
    stream: true
  })
).middleware(ControlAuth)

/**
 * Header authenticator used by the control RPC boundary.
 *
 * @category models
 * @since 0.1.0
 */
export interface Authenticator {
  readonly authenticate: (
    headers: Readonly<Record<string, string>>
  ) => Effect.Effect<typeof Principal.Type, Unauthorized>
}

/**
 * Configuration for the single-token bearer authenticator.
 *
 * Every request carrying the configured token receives the same principal.
 * This is the intentionally small alpha trust boundary, not a per-user
 * authorization system.
 *
 * @category models
 * @since 0.1.0
 */
export interface BearerAuthOptions {
  readonly token: string
  readonly principal: Omit<typeof Principal.Type, "stampedAt">
  readonly now?: (() => number) | undefined
}

const authorizationHeader = (headers: Readonly<Record<string, string>>): string | undefined => {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization") return value
  }
  return undefined
}

const bearerToken = (headers: Readonly<Record<string, string>>): string | undefined => {
  const authorization = authorizationHeader(headers)
  if (authorization === undefined) return undefined
  const match = /^Bearer[\t ]+([^\t ]+)$/i.exec(authorization)
  return match?.[1]
}

const encoder = new TextEncoder()

/**
 * Compares UTF-8 credentials without returning early for a secret-dependent
 * byte or length difference.
 */
const constantTimeTokenEqual = (expected: string, actual: string): boolean => {
  const expectedBytes = encoder.encode(expected)
  const actualBytes = encoder.encode(actual)
  const length = Math.max(expectedBytes.length, actualBytes.length)
  let difference = expectedBytes.length ^ actualBytes.length

  for (let index = 0; index < length; index++) {
    difference |= (expectedBytes[index] ?? 0) ^ (actualBytes[index] ?? 0)
  }

  return difference === 0
}

/**
 * Authenticates one shared bearer token and stamps its server-owned principal.
 * Missing, malformed, empty, and incorrect credentials all fail closed with
 * the same `Unauthorized` response.
 *
 * @category constructors
 * @since 0.1.0
 */
export const bearerAuthenticator = (options: BearerAuthOptions): Authenticator => ({
  authenticate: (headers) => {
    const credential = bearerToken(headers)
    return options.token.length > 0 && credential !== undefined && constantTimeTokenEqual(options.token, credential)
      ? Effect.succeed({
        ...options.principal,
        stampedAt: options.now?.() ?? Date.now()
      })
      : Effect.fail(new Unauthorized({ message: "A valid bearer credential is required" }))
  }
})

/**
 * Provides `ControlAuth` from a transport-header authenticator.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerAuth = (authenticator: Authenticator) =>
  Layer.succeed(
    ControlAuth,
    (effect, options) =>
      Effect.flatMap(
        authenticator.authenticate(options.headers),
        (principal) => Effect.provideService(effect, ControlPrincipal, principal)
      )
  )

/**
 * Provides `ControlAuth` using one shared bearer token.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerBearerAuth = (options: BearerAuthOptions) => layerAuth(bearerAuthenticator(options))

/**
 * Permissive authentication middleware for tests and trusted in-process use.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoopAuth = (principal: typeof Principal.Type = {
  id: "test-principal",
  kind: "test",
  stampedAt: 0
}) => layerAuth({ authenticate: () => Effect.succeed(principal) })
