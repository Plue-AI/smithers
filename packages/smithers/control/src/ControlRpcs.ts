/**
 * Schema-backed RPC projection of the control service.
 *
 * @since 0.1.0
 */

import { NotificationError } from "@smthrs/notifications/NotificationQueue"
import { Context, Effect, Layer, Schema, SchemaTransformation } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/unstable/rpc"
import {
  AlreadyResolved,
  ClaimLost,
  CodeDrift,
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
  Receipt,
  ResumeInputSchema,
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

/**
 * Which authenticated principals read every run.
 *
 * `List` and `Watch` answer a principal this returns `true` for with every
 * run: that principal is an operator. Every other principal reads only the
 * runs it launched (`RunSummary.launchedBy`) and, from `Watch`, only their
 * events. The authentication layer decides, because it is what knows which
 * identities it can stamp: `layerBearerAuth` and `layerNoopAuth` stamp one
 * principal and make it the operator, and `layerAuth` takes the rule as an
 * option. Where nothing provides one, no principal is an operator.
 *
 * @category services
 * @since 1.0.0
 */
export const RunVisibility = Context.Reference<{
  readonly seesAllRuns: (principal: typeof Principal.Type) => boolean
}>("/control/RunVisibility", { defaultValue: () => ({ seesAllRuns: () => false }) })

/**
 * The sentence a client reads when a control handler dies.
 *
 * @category defects
 * @since 1.0.0
 */
export const defectMessage = "Something went wrong on our side. Not your fault."

/**
 * Wire schema for a control RPC defect: an untyped failure that no procedure
 * declares.
 *
 * Encoding replaces a defect value (an `Error`, a failure an `orDie` turned
 * into a defect, any non-string value) with `{ name: "Error", message }`
 * carrying {@link defectMessage}, so a driver message, path, or stack never
 * reaches a client. The server logs the raw defect. A string passes unchanged:
 * the RPC server's own request-decoding sentence, which describes the caller's
 * payload, is one, and so is an author-written `Effect.die` sentence.
 *
 * Decoding is Effect's default `Schema.Defect()` decoding, so a client reads
 * this shape and an older server's shape alike, and an older client reads this
 * shape as an `Error`.
 *
 * @category defects
 * @since 1.0.0
 */
export const ControlDefect = Schema.Json.pipe(Schema.decodeTo(
  Schema.Unknown,
  SchemaTransformation.transform({
    decode: Schema.decodeSync(Schema.Defect()),
    encode: (defect): Schema.Json => typeof defect === "string" ? defect : { name: "Error", message: defectMessage }
  })
))

const mutationErrors = Schema.Union([
  RunNotFound,
  ClaimLost,
  InvalidInput,
  PersistenceError,
  Unavailable,
  TransportError,
  Unauthorized
])

const resumeErrors = Schema.Union([
  RunNotFound,
  ClaimLost,
  CodeDrift,
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
    defect: ControlDefect,
    payload: PlanInputSchema,
    success: PlanCard,
    error: Schema.Union([FlowNotFound, InvalidInput, PersistenceError, Unavailable, TransportError, Unauthorized])
  }),
  Rpc.make("Run", {
    defect: ControlDefect,
    payload: RunInputSchema,
    success: Receipt,
    error: Schema.Union([
      RunNotFound,
      PlanNotFound,
      PlanDenied,
      PlanDigestMismatch,
      EnvelopeMismatch,
      ClaimLost,
      CodeDrift,
      InvalidInput,
      LaunchFailed,
      PersistenceError,
      Unavailable,
      TransportError,
      Unauthorized
    ])
  }),
  Rpc.make("Approve", {
    defect: ControlDefect,
    payload: ApprovalInputSchema,
    success: Receipt,
    error: Schema.Union([
      PlanDigestMismatch,
      EnvelopeMismatch,
      AlreadyResolved,
      PlanNotFound,
      RunNotFound,
      CodeDrift,
      InvalidInput,
      Unauthorized,
      PersistenceError,
      Unavailable,
      TransportError
    ])
  }),
  Rpc.make("Deny", {
    defect: ControlDefect,
    payload: ApprovalInputSchema,
    success: Receipt,
    error: Schema.Union([
      PlanDigestMismatch,
      EnvelopeMismatch,
      AlreadyResolved,
      PlanNotFound,
      RunNotFound,
      CodeDrift,
      InvalidInput,
      Unauthorized,
      PersistenceError,
      Unavailable,
      TransportError
    ])
  }),
  Rpc.make("Steer", {
    defect: ControlDefect,
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
    defect: ControlDefect,
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
  Rpc.make("Cancel", { defect: ControlDefect, payload: CancelInputSchema, success: Receipt, error: mutationErrors }),
  Rpc.make("Resume", {
    defect: ControlDefect,
    payload: ResumeInputSchema,
    success: Receipt,
    error: resumeErrors
  }),
  // `list` and `watch` carry the whole `ControlError` union in their contract,
  // so they name it once rather than restating its members. Two hand-copied
  // lists is how `CredentialConflict` came to be a control error the union did
  // not admit.
  Rpc.make("List", {
    defect: ControlDefect,
    payload: ListRequest,
    success: ListResponse,
    error: ControlErrorSchema
  }),
  Rpc.make("Watch", {
    defect: ControlDefect,
    payload: WatchFilter,
    success: ControlEvent,
    error: ControlErrorSchema,
    stream: true
  })
).middleware(ControlAuth)

/**
 * The call a boundary is authenticating, when it knows one: the procedure's
 * tag and the payload it was sent. An edge authenticating a socket upgrade
 * knows no call and passes none.
 *
 * @category models
 * @since 1.0.0
 */
export interface Call {
  readonly rpc: string
  readonly payload: unknown
}

/**
 * Header authenticator used by the control RPC boundary.
 *
 * `call` is present for an in-band RPC frame and absent at a transport edge.
 * An authenticator that grants everything ignores it; one that grants a
 * scope reads it, and admits an edge on the credential alone.
 *
 * @category models
 * @since 0.1.0
 */
export interface Authenticator {
  readonly authenticate: (
    headers: Readonly<Record<string, string>>,
    call?: Call | undefined
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

/**
 * The bearer credential a request carries, or `undefined` when its
 * `Authorization` header is absent or is not a well-formed bearer scheme.
 *
 * @category getters
 * @since 1.0.0
 */
export const bearerCredential = (headers: Readonly<Record<string, string>>): string | undefined => {
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
    const credential = bearerCredential(headers)
    return options.token.length > 0 && credential !== undefined && constantTimeTokenEqual(options.token, credential)
      ? Effect.succeed({
        ...options.principal,
        stampedAt: options.now?.() ?? Date.now()
      })
      : Effect.fail(new Unauthorized({ message: "A valid bearer credential is required" }))
  }
})

/**
 * The first authenticator to accept a request answers for all of them. Each
 * is asked in order, and a request none accepts fails with the last refusal,
 * or with the plain `Unauthorized` when there is nothing to ask.
 *
 * @category constructors
 * @since 1.0.0
 */
export const anyAuthenticator = (authenticators: ReadonlyArray<Authenticator>): Authenticator => ({
  authenticate: (headers, call) =>
    authenticators.reduce<Effect.Effect<typeof Principal.Type, Unauthorized>>(
      (attempt, authenticator) =>
        Effect.catchTag(attempt, "/control/Unauthorized", () => authenticator.authenticate(headers, call)),
      Effect.fail(new Unauthorized({ message: "A valid bearer credential is required" }))
    )
})

/**
 * Options for {@link layerAuth}.
 *
 * @category models
 * @since 1.0.0
 */
export interface AuthOptions {
  /**
   * The operators: the principals `List` and `Watch` show every run. Omitted,
   * every principal reads only the runs it launched. See {@link RunVisibility}.
   */
  readonly seesAllRuns?: ((principal: typeof Principal.Type) => boolean) | undefined
}

/**
 * Provides `ControlAuth` from a transport-header authenticator, telling it
 * which procedure and payload each frame carries. Each authenticated call
 * also receives the {@link RunVisibility} rule for the principal it stamps.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerAuth = (authenticator: Authenticator, options: AuthOptions = {}) => {
  const visibility = { seesAllRuns: options.seesAllRuns ?? (() => false) }
  return Layer.succeed(
    ControlAuth,
    (effect, call) =>
      Effect.flatMap(
        authenticator.authenticate(call.headers, { rpc: call.rpc._tag, payload: call.payload }),
        (principal) =>
          effect.pipe(
            Effect.provideService(ControlPrincipal, principal),
            Effect.provideService(RunVisibility, visibility)
          )
      )
  )
}

/**
 * Provides `ControlAuth` using one shared bearer token. Its one principal is
 * the operator and reads every run.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerBearerAuth = (options: BearerAuthOptions) =>
  layerAuth(bearerAuthenticator(options), { seesAllRuns: () => true })

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
}) => layerAuth({ authenticate: () => Effect.succeed(principal) }, { seesAllRuns: () => true })
