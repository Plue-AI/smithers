/**
 * Credential handling for a model route: which field names carry secrets,
 * and how a redacted credential is resolved at request time without ever
 * entering the request's canonical, sealed form.
 *
 * @since 0.1.0
 */

import * as ChildProcessEnvironment from "@smthrs/kernel/ChildProcessEnvironment"
import { Effect, Redacted as EffectRedacted } from "effect"
import * as Headers from "effect/unstable/http/Headers"
import { ModelError } from "./ModelError.ts"

/**
 * Credential-bearing field names shared by prepared-request validation and
 * executor diagnostics. Keep this matcher aligned across headers, query
 * parameters, and structured bodies so the sealed-step boundary and logging
 * boundary cannot disagree.
 *
 * `chatgpt-account-id` names an account rather than a secret, but it is an
 * identity the ChatGPT-subscription route must keep out of step keys, journals,
 * and diagnostics, so it is matched here and applied through {@link Auth}.
 * `token` is anchored to a complete or separator-delimited suffix so numeric
 * token-count fields remain public diagnostics rather than false credentials.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const credentialNamePattern = ChildProcessEnvironment.credentialNamePattern

/**
 * Reports whether a field name conventionally carries credentials.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const isCredentialName = ChildProcessEnvironment.isCredentialName

/**
 * A value whose normal string and JSON representations conceal its contents.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Redacted<A = string> = EffectRedacted.Redacted<A>

/**
 * Per-request authentication applied after the secret-free prepared request
 * view has been created. This is the redaction boundary: credentials never
 * enter the harness step key, and signing never logs their values.
 *
 * `sign` may hold rotating state — an OAuth token store is one — but every
 * dependency it needs (host filesystem, HTTP, clock) is captured at
 * construction time: the type has no requirements channel, and the host that
 * composes the route owns the store. The constructors here are the static
 * cases; token-store auths live with their hosts.
 *
 * `refresh` is the optional reactive half of such a store. When present,
 * `Route.stream` runs it after an `authentication` failure and retries the
 * signed request exactly once, so an access token that expired between
 * proactive checks costs one recovery rather than the sealed step. A static
 * credential leaves it undefined and a bad key stays terminal.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Auth {
  readonly sign: (headers: Record<string, string>) => Effect.Effect<Record<string, string>, ModelError>
  readonly refresh?: Effect.Effect<void, ModelError> | undefined
  /** Header names `sign` fills with credentials, including unconventional names. */
  readonly credentialHeaders?: ReadonlyArray<string> | undefined
}

/**
 * Adds Auth's header names and the shared credential matcher to the caller's
 * redaction policy while signing and executing a request. Stream sanitizers
 * must capture this policy before the effect completes.
 *
 * @since 0.1.0
 * @category combinators
 * @slop
 */
export const withRedaction = (auth: Auth) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function*() {
    const names = yield* Headers.CurrentRedactedNames
    return yield* effect.pipe(
      Effect.provideService(Headers.CurrentRedactedNames, [
        ...names,
        credentialNamePattern,
        // `Headers.isRedactedName` compares a string matcher against an
        // already-lowercased header name without lowercasing the matcher.
        ...(auth.credentialHeaders ?? []).map((name) => name.toLowerCase())
      ])
    )
  })

const secret = (key: Redacted<string>): Effect.Effect<string, ModelError> =>
  Effect.suspend(() => {
    const value = EffectRedacted.value(key)
    return value === ""
      ? Effect.fail(new ModelError({ code: "authentication", message: "API key must not be empty" }))
      : Effect.succeed(value)
  })

/**
 * Adds a redacted API key as an exact HTTP header.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const apiKeyHeader = (name: string, key: Redacted<string>): Auth => ({
  sign: Effect.fn("Auth.sign")((headers) => secret(key).pipe(Effect.map((value) => ({ ...headers, [name]: value })))),
  credentialHeaders: [name]
})

/**
 * Adds a redacted API key using the HTTP bearer convention.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const bearer = (key: Redacted<string>): Auth => ({
  sign: Effect.fn("Auth.sign")((headers) =>
    secret(key).pipe(Effect.map((value) => ({ ...headers, Authorization: `Bearer ${value}` })))
  ),
  credentialHeaders: ["Authorization"]
})
