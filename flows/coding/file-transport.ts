/** Private transport over the existing authenticated workspace file route. */
import { StdError } from "@smthrs/std/StdError"
import { Clock, Effect, Redacted, type Schema, type Scope, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import type { MutationProvider } from "./filesystem.ts"

/** Issuer-owned authority, never a model argument or a landing/terminal token.
 * The issuer must check the live run and its write permissions for this batch.
 * Its bearer must be scoped server-side to that run, workspace and repository;
 * comparing these fields is a binding check, not a substitute for issuance.
 */
export interface Grant {
  readonly session: string
  readonly workspaceId: string
  readonly repositorySlug: string
  readonly expiresAt: number
  readonly token: Redacted.Redacted<string>
}

export interface Options {
  readonly root: string
  readonly apiBaseUrl: string
  readonly repositorySlug: string
  readonly workspaceId: string
  /** Rechecked per commit, held through receipt verification, and released on
   * success, failure or interruption. Never cached or journaled. */
  readonly authorize: (
    session: string,
    paths: ReadonlyArray<string>,
    batchDigest: string
  ) => Effect.Effect<Grant, StdError, Scope.Scope>
}

const unavailable = () =>
  new StdError({
    code: "provider_unavailable",
    message: "Workspace file mutation did not return a verified response"
  })
const denied = () => new StdError({ code: "permission_denied", message: "Coding run file-write authority refused" })
const invalid = () => new StdError({ code: "invalid_input", message: "Invalid workspace file batch" })
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const base = (value: string) => value === "absent" || /^[0-9a-f]{64}$/.test(value)
const pathAllowed = (path: string) =>
  Buffer.byteLength(path, "utf8") <= 4096 && !path.includes("\0") &&
  Buffer.from(path, "utf8").toString("utf8") === path &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
const loopback = (host: string) => host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host)
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const fields = (value: Record<string, unknown>, names: ReadonlyArray<string>) =>
  Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name))

export const readJson = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function*() {
    const captured = yield* Stream.runFoldEffect(
      response.stream,
      () => ({ bytes: 0, text: "", decoder: new TextDecoder("utf-8", { fatal: true }) }),
      (state, chunk) =>
        Effect.try({
          try: () => {
            if (state.bytes + chunk.length > 2 * 1024 * 1024) throw unavailable()
            return {
              bytes: state.bytes + chunk.length,
              text: state.text + state.decoder.decode(chunk, { stream: true }),
              decoder: state.decoder
            }
          },
          catch: unavailable
        })
    )
    return yield* Effect.try({
      try: () => JSON.parse(captured.text + captured.decoder.decode()) as unknown,
      catch: unavailable
    })
  })

/** Uses one authenticated PUT and never retries an ambiguous mutation. */
export const make = (options: Options): Effect.Effect<MutationProvider, StdError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const api = yield* Effect.try({ try: () => new URL(options.apiBaseUrl), catch: unavailable })
    if (
      !(api.protocol === "https:" || api.protocol === "http:" && loopback(api.hostname)) ||
      api.username !== "" || api.password !== "" || api.search !== "" || api.hash !== "" ||
      !api.pathname.endsWith("/api") || !isAbsolute(options.root) || resolve(options.root) !== options.root ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repositorySlug) ||
      options.repositorySlug.split("/").some((part) => part === "." || part === "..") ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(options.workspaceId)
    ) {
      return yield* Effect.fail(unavailable())
    }
    // Copy all binding values; mutation of the operator's input object cannot
    // redirect a credential after construction or after authorization yields.
    const { root, repositorySlug, workspaceId, authorize } = options
    const endpoint = `${api.href}/repos/${
      repositorySlug.split("/").map(encodeURIComponent).join("/")
    }/workspaces/${workspaceId}/files/content`
    return {
      compareWrite: (request) =>
        Effect.gen(function*() {
          if (
            request.root !== root || request.session.length === 0 || request.session.length > 256 ||
            /\s/.test(request.session) || [...request.session].some((character) =>
              character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
            )
          ) {
            return yield* Effect.fail(denied())
          }
          const session = request.session
          if (request.changes.length === 0 || request.changes.length > 256) return yield* Effect.fail(invalid())
          const expected = new Map<string, { base: string; digest: string }>()
          let size = 0
          const changes: Array<Schema.Json> = []
          for (const change of request.changes) {
            if (
              !pathAllowed(change.path) || !base(change.base_digest) || expected.has(change.path) ||
              [...expected.keys()].some((path) =>
                path.startsWith(`${change.path}/`) || change.path.startsWith(`${path}/`)
              )
            ) {
              return yield* Effect.fail(invalid())
            }
            size += change.content?.length ?? 0
            if (size > 1024 * 1024) return yield* Effect.fail(invalid())
            expected.set(change.path, {
              base: change.base_digest,
              digest: change.content === null ? "absent" : hash(change.content)
            })
            changes.push({
              path: change.path,
              base_digest: change.base_digest,
              ...(change.content === null
                ? { content: null }
                : { content: Buffer.from(change.content).toString("base64"), encoding: "base64" })
            })
          }
          // The API bounds decoded content AND the JSON body independently.
          const body = JSON.stringify({ changes })
          if (Buffer.byteLength(body, "utf8") > 1024 * 1024) return yield* Effect.fail(invalid())
          const grant = yield* authorize(session, [...expected.keys()], hash(Buffer.from(body, "utf8")))
          const now = yield* Clock.currentTimeMillis
          if (
            grant.session !== session || grant.workspaceId !== workspaceId || grant.repositorySlug !== repositorySlug ||
            !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now ||
            Redacted.value(grant.token).trim() === ""
          ) {
            return yield* Effect.fail(denied())
          }
          const response = yield* HttpClient.withScope(client).execute(
            HttpClientRequest.put(endpoint).pipe(
              HttpClientRequest.bodyText(body, "application/json"),
              HttpClientRequest.bearerToken(grant.token),
              HttpClientRequest.acceptJson
            )
          )
          if (response.status === 401 || response.status === 403) return yield* Effect.fail(denied())
          if (response.status !== 200 && response.status !== 409) return yield* Effect.fail(unavailable())
          const value = object(yield* readJson(response))
          if (value === undefined) return yield* Effect.fail(unavailable())
          if (response.status === 409) {
            if (
              !fields(value, ["code", "path", "current_digest"]) || value.code !== "stale" ||
              typeof value.path !== "string" || !expected.has(value.path) || typeof value.current_digest !== "string" ||
              !base(value.current_digest)
            ) {
              return yield* Effect.fail(unavailable())
            }
            const before = expected.get(value.path)!.base
            return yield* Effect.fail(
              new StdError({
                code: "stale_read",
                path: value.path,
                base_digest: before,
                current_digest: value.current_digest,
                message:
                  `stale_read: ${value.path}; base_digest=${before}; current_digest=${value.current_digest}. Re-read before retrying`
              })
            )
          }
          if (!fields(value, ["changes"]) || !Array.isArray(value.changes) || value.changes.length !== expected.size) {
            return yield* Effect.fail(unavailable())
          }
          const receipts: Array<{ path: string; digest: string }> = []
          const seen = new Set<string>()
          for (const raw of value.changes) {
            const entry = object(raw)
            if (
              entry === undefined || !fields(entry, ["path", "digest"]) || typeof entry.path !== "string" ||
              seen.has(entry.path) || typeof entry.digest !== "string" ||
              expected.get(entry.path)?.digest !== entry.digest
            ) {
              return yield* Effect.fail(unavailable())
            }
            seen.add(entry.path)
            receipts.push({ path: entry.path, digest: entry.digest })
          }
          return receipts
        }).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: "45 seconds",
            orElse: () => Effect.fail(new StdError({ code: "timeout", message: "Workspace file mutation timed out" }))
          }),
          Effect.mapError((error) => error instanceof StdError ? error : unavailable())
        )
    }
  })
