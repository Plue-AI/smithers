/** Private S1 host issuance; a grant lives only for one exact file batch. */
import * as Capability from "@smthrs/capability/Capability"
import type * as GrantStore from "@smthrs/kernel/GrantStore"
import { StdError } from "@smthrs/std/StdError"
import { Effect, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { resolve } from "node:path"
import * as Transport from "./file-transport.ts"
import type { MutationProvider } from "./filesystem.ts"

export interface Options extends Omit<Transport.Options, "authorize"> {
  readonly gatewayId: string
  readonly credential: string
}

const unavailable = (reason = "issuer transport failed") =>
  new StdError({ code: "provider_unavailable", message: `Coding file grant unavailable: ${reason}` })
const denied = () => new StdError({ code: "permission_denied", message: "Coding run file-write authority refused" })

/** Check the same store and current fiber ceiling as the guarded filesystem,
 * before any issuer call. A readable snapshot never implies write permission. */
export const protect = (
  provider: MutationProvider,
  root: string,
  grants: Option.Option<GrantStore.Service>
): MutationProvider => ({
  compareWrite: (request) =>
    Effect.gen(function*() {
      if (Option.isNone(grants)) return yield* Effect.fail(unavailable("write-grant store missing"))
      const pinned = {
        ...request,
        changes: request.changes.map((change) => ({
          ...change,
          content: change.content === null ? null : Uint8Array.from(change.content)
        }))
      }
      if (pinned.root !== root) return yield* Effect.fail(denied())
      for (const change of pinned.changes) {
        const capability = yield* Effect.try({
          try: () => Capability.make("fs:write", resolve(root, change.path)),
          catch: denied
        })
        yield* grants.value.check(capability).pipe(Effect.mapError(denied))
      }
      return yield* provider.compareWrite(pinned)
    })
})

export const make = (input: Options): Effect.Effect<MutationProvider, StdError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const options = { ...input }
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(options.gatewayId) || options.credential.trim() === "") {
      return yield* Effect.fail(unavailable("host binding invalid"))
    }
    const client = yield* HttpClient.HttpClient
    const hostToken = Redacted.make(options.credential)
    const endpoint = `${options.apiBaseUrl}/gateways/${options.gatewayId}/file-write-grants`
    const send = (request: HttpClientRequest.HttpClientRequest, token: Redacted.Redacted<string>) =>
      HttpClient.withScope(client).execute(
        request.pipe(HttpClientRequest.bearerToken(token), HttpClientRequest.acceptJson)
      )
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }), Effect.mapError(() => unavailable()))
    return yield* Transport.make({
      ...options,
      authorize: (session, _paths, batchDigest) =>
        Effect.gen(function*() {
          const issued = yield* Effect.acquireRelease(
            Effect.gen(function*() {
              const response = yield* send(
                HttpClientRequest.post(endpoint).pipe(
                  HttpClientRequest.bodyJsonUnsafe({ run_id: session, batch_digest: batchDigest })
                ),
                hostToken
              )
              if (response.status === 401 || response.status === 403) return yield* Effect.fail(denied())
              if (response.status !== 201) return yield* Effect.fail(unavailable(`issuer returned HTTP ${response.status}`))
              const value = yield* Transport.readJson(response).pipe(Effect.mapError(() => unavailable("invalid issuer response")))
              if (typeof value !== "object" || value === null || Array.isArray(value)) {
                return yield* Effect.fail(unavailable("invalid issuer response"))
              }
              const raw = value as Record<string, unknown>
              if (
                typeof raw.token_id !== "number" || !Number.isSafeInteger(raw.token_id) || raw.token_id <= 0 ||
                typeof raw.token !== "string" || !/^smithers_[0-9a-f]{40}$/.test(raw.token)
              ) return yield* Effect.fail(unavailable("invalid issued token"))
              return { raw, tokenId: raw.token_id, token: Redacted.make(raw.token) }
            }).pipe(Effect.interruptible),
            (issued) =>
              send(HttpClientRequest.delete(`${endpoint}/${issued.tokenId}`), issued.token).pipe(
                Effect.flatMap((response) => response.status === 204 ? Effect.void : Effect.fail(unavailable())),
                Effect.scoped,
                Effect.timeout("10 seconds"),
                Effect.catch(() =>
                  Effect.logWarning("Coding file grant cleanup failed; short-lived grant will expire", {
                    tokenId: issued.tokenId
                  })
                )
              )
          )
          // Install cleanup before validating metadata so a malformed response
          // with a usable token identity cannot strand its credential.
          const raw = issued.raw
          const keys = ["token_id", "token", "run_id", "workspace_id", "repository_slug", "expires_at", "batch_digest"]
          if (
            Object.keys(raw).length !== keys.length || !keys.every((key) => Object.hasOwn(raw, key)) ||
            raw.run_id !== session || raw.workspace_id !== options.workspaceId ||
            raw.repository_slug !== options.repositorySlug ||
            raw.batch_digest !== batchDigest || typeof raw.expires_at !== "number" ||
            !Number.isSafeInteger(raw.expires_at)
          ) {
            return yield* Effect.fail(denied())
          }
          return {
            session,
            workspaceId: options.workspaceId,
            repositorySlug: options.repositorySlug,
            expiresAt: raw.expires_at,
            token: issued.token
          }
        })
    })
  })
