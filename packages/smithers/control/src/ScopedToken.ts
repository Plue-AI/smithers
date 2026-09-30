/**
 * Scoped, expiring gateway tokens.
 *
 * A gateway's configured bearer credential grants everything the gateway
 * serves, for as long as it is configured. A scoped token is a grant the
 * holder of that credential mints for someone else: a closed list of
 * procedures, optionally confined to one run or one flow, and an expiry. It
 * is signed with HMAC-SHA256 under the bearer credential, so a gateway
 * verifies it with the key it already holds and stores nothing; rotating the
 * bearer credential revokes every token minted under it.
 *
 * The wire form is `smt1.<claims>.<signature>`, both parts unpadded base64url,
 * the claims a canonical JSON document. A token names procedures rather than
 * scope words so that what it authorizes is readable off the token itself and
 * does not change when a scope grows.
 *
 * Web Crypto does the signing, so the same module runs on Node, Bun, and in a
 * browser that holds a token.
 *
 * @since 1.0.0
 */

import { Effect, Encoding, Result, Schema } from "effect"
import { Unauthorized } from "./ControlError.ts"
import { type Authenticator, bearerCredential, type Call } from "./ControlRpcs.ts"
import type { Principal } from "./ControlSchema.ts"

/**
 * The version prefix every scoped token starts with.
 *
 * @category constants
 * @since 1.0.0
 */
export const prefix = "smt1"

/**
 * The scopes `smthrs token mint --scope` accepts, and the procedures each
 * one names.
 *
 * `read:runs` covers every read the control plane and the gateway serve.
 * `write:runs` covers the mutations that start, steer, signal, cancel, and
 * resume a run. `approve:runs` covers the approval decisions on both mounts.
 * A token holding `approve:runs` still needs the host's `ApprovalAuthority`
 * to delegate to its principal, exactly as the bearer does.
 *
 * @category constants
 * @since 1.0.0
 */
export const scopes = {
  "read:runs": ["List", "Watch", "Projection.Snapshot", "Projection.Subscribe"],
  "write:runs": ["Plan", "Run", "Steer", "Signal", "Cancel", "Resume"],
  "approve:runs": ["Approve", "Deny", "Approval.Submit"]
} as const satisfies Record<string, ReadonlyArray<string>>

/**
 * One scope name.
 *
 * @category models
 * @since 1.0.0
 */
export type Scope = keyof typeof scopes

/**
 * Every scope name, in the order {@link scopes} declares them.
 *
 * @category constants
 * @since 1.0.0
 */
export const scopeNames: ReadonlyArray<Scope> = Object.keys(scopes) as Array<Scope>

/**
 * What a token grants, as signed.
 *
 * @category models
 * @since 1.0.0
 */
export const Claims = Schema.Struct({
  v: Schema.Literal(1),
  /** A random identifier, so two tokens with the same grant differ. */
  id: Schema.String,
  procedures: Schema.Array(Schema.String),
  runId: Schema.optional(Schema.String),
  flowId: Schema.optional(Schema.String),
  /** Minted at, milliseconds since the epoch. */
  iat: Schema.Number,
  /** Expires at, milliseconds since the epoch; refused once `now >= exp`. */
  exp: Schema.Number
})

/**
 * What a token grants, as signed.
 *
 * @category models
 * @since 1.0.0
 */
export type Claims = typeof Claims.Type

/**
 * What `mint` needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface MintOptions {
  /** The signing key: the gateway's configured bearer credential. */
  readonly key: string
  readonly scopes: ReadonlyArray<Scope>
  /** How long the token lives, in milliseconds; must be positive. */
  readonly ttlMillis: number
  /** Confine every call to this run. */
  readonly runId?: string | undefined
  /** Confine every call to this flow. */
  readonly flowId?: string | undefined
  readonly now?: (() => number) | undefined
}

/**
 * A minted token beside the claims it carries.
 *
 * @category models
 * @since 1.0.0
 */
export interface Minted {
  readonly token: string
  readonly claims: Claims
}

const encodeClaims = Schema.encodeUnknownSync(Claims)
const decodeClaims = Schema.decodeUnknownResult(Claims)
const encoder = new TextEncoder()

const subtle = (): SubtleCrypto => {
  const available = (globalThis.crypto as Crypto | undefined)?.subtle
  if (available === undefined) throw new Error("Web Crypto is not available on this host")
  return available
}

const hmacKey = (key: string, usage: "sign" | "verify") =>
  subtle().importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [usage])

/**
 * Whether a bearer credential is spelled as a scoped token.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isScopedToken = (credential: string): boolean => credential.startsWith(`${prefix}.`)

/**
 * The procedures a list of scopes names, each once, in scope order.
 *
 * @category getters
 * @since 1.0.0
 */
export const procedures = (
  names: ReadonlyArray<Scope>
): ReadonlyArray<string> => [...new Set(names.flatMap((name) => scopes[name]))]

/**
 * Mints one token under the key.
 *
 * An empty key, no scopes, or a non-positive lifetime is a caller defect: it
 * cannot produce a token anyone should hold, so it dies rather than signs.
 *
 * @category constructors
 * @since 1.0.0
 */
export const mint = (options: MintOptions): Effect.Effect<Minted> =>
  Effect.suspend(() => {
    if (options.key.length === 0) return Effect.die(new Error("A scoped token needs a non-empty signing key"))
    if (options.scopes.length === 0) return Effect.die(new Error("A scoped token needs at least one scope"))
    if (!Number.isFinite(options.ttlMillis) || options.ttlMillis <= 0) {
      return Effect.die(new Error("A scoped token needs a positive lifetime"))
    }
    const now = options.now?.() ?? Date.now()
    const id = Encoding.encodeHex(crypto.getRandomValues(new Uint8Array(12)))
    const claims: Claims = {
      v: 1,
      id,
      procedures: procedures(options.scopes),
      ...(options.runId === undefined ? {} : { runId: options.runId }),
      ...(options.flowId === undefined ? {} : { flowId: options.flowId }),
      iat: now,
      exp: now + Math.floor(options.ttlMillis)
    }
    const body = Encoding.encodeBase64Url(JSON.stringify(encodeClaims(claims)))
    return Effect.promise(async () => {
      const key = await hmacKey(options.key, "sign")
      const signature = new Uint8Array(await subtle().sign("HMAC", key, encoder.encode(`${prefix}.${body}`)))
      return { token: `${prefix}.${body}.${Encoding.encodeBase64Url(signature)}`, claims }
    })
  })

const refused = (message: string) => Effect.fail(new Unauthorized({ message }))

/**
 * Verifies a token's signature and expiry under the key and returns its
 * claims. Every malformation, a wrong key, and an expired token all fail with
 * the same `Unauthorized`, so the token is not a parsing oracle.
 *
 * @param now the moment to judge `exp` against, in milliseconds
 * @category verification
 * @since 1.0.0
 */
export const verify = (key: string, token: string, now: number): Effect.Effect<Claims, Unauthorized> =>
  Effect.suspend(() => {
    const parts = token.split(".")
    if (key.length === 0 || parts.length !== 3 || parts[0] !== prefix || parts[1]!.length === 0) {
      return refused("A valid scoped token is required")
    }
    const signature = Encoding.decodeBase64Url(parts[2]!)
    if (Result.isFailure(signature)) return refused("A valid scoped token is required")
    return Effect.promise(async () => {
      const hmac = await hmacKey(key, "verify")
      return subtle().verify("HMAC", hmac, new Uint8Array(signature.success), encoder.encode(`${prefix}.${parts[1]}`))
    }).pipe(
      Effect.flatMap((valid) => {
        if (!valid) return refused("A valid scoped token is required")
        const text = Encoding.decodeBase64UrlString(parts[1]!)
        if (Result.isFailure(text)) return refused("A valid scoped token is required")
        let parsed: unknown
        try {
          parsed = JSON.parse(text.success)
        } catch {
          return refused("A valid scoped token is required")
        }
        const claims = decodeClaims(parsed)
        if (Result.isFailure(claims)) return refused("A valid scoped token is required")
        if (!(now < claims.success.exp)) return refused("The scoped token has expired")
        return Effect.succeed(claims.success)
      })
    )
  })

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined

/** The run a payload names, wherever the control and gateway schemas put it. */
const namedRun = (payload: unknown): unknown =>
  field(payload, "runId") ??
    field(field(payload, "target"), "runId") ??
    field(field(payload, "selector"), "runId") ??
    field(field(payload, "filters"), "runId")

/** The flow a payload names. */
const namedFlow = (payload: unknown): unknown => field(payload, "flowId") ?? field(field(payload, "filters"), "flowId")

/**
 * Whether verified claims authorize one call.
 *
 * The procedure must be named. A token confined to a run authorizes only a
 * call that names that run, and one confined to a flow only a call that names
 * that flow: a call that names neither, such as an unfiltered `List`, is
 * refused rather than widened.
 *
 * @category verification
 * @since 1.0.0
 */
export const authorizes = (claims: Claims, call: Call): boolean =>
  claims.procedures.includes(call.rpc) &&
  (claims.runId === undefined || namedRun(call.payload) === claims.runId) &&
  (claims.flowId === undefined || namedFlow(call.payload) === claims.flowId)

/**
 * What the scoped-token authenticator needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface AuthenticatorOptions {
  /** The verifying key: the gateway's configured bearer credential. */
  readonly key: string
  /** The principal every valid scoped token is stamped as. */
  readonly principal: Omit<Principal, "stampedAt">
  readonly now?: (() => number) | undefined
}

/**
 * Authenticates a bearer credential spelled as a scoped token: the signature
 * and expiry always, and the procedure plus run or flow confinement whenever
 * the boundary knows which call it is guarding. An edge that authenticates an
 * upgrade knows no call, so it admits the socket and leaves each frame to the
 * in-band check.
 *
 * A credential that is not a scoped token is refused here; compose with
 * `ControlRpcs.bearerAuthenticator` through `ControlRpcs.anyAuthenticator`
 * to accept both.
 *
 * @category constructors
 * @since 1.0.0
 */
export const authenticator = (options: AuthenticatorOptions): Authenticator => ({
  authenticate: (headers, call) => {
    const credential = bearerCredential(headers)
    if (credential === undefined || !isScopedToken(credential)) return refused("A valid scoped token is required")
    const now = options.now?.() ?? Date.now()
    return verify(options.key, credential, now).pipe(
      Effect.flatMap((claims) =>
        call !== undefined && !authorizes(claims, call)
          ? refused(`The scoped token does not authorize ${call.rpc}`)
          : Effect.succeed({ ...options.principal, stampedAt: now })
      )
    )
  }
})
