/**
 * ChatGPT-subscription credentials for the OpenAI provider, read from the
 * codex CLI's auth store — `$CODEX_HOME/auth.json`, `~/.codex/auth.json` by
 * default. `flows` shares the store rather than owning one: `codex login`
 * provisions it, either client may refresh it, and a rewrite here preserves
 * every field codex expects so codex keeps working afterwards.
 *
 * The store implements the model layer's `Auth` contract. `sign` reads the
 * file fresh on every attempt, refreshes proactively when the access token's
 * JWT `exp` is inside the expiry margin, and emits the bearer plus the
 * `chatgpt-account-id` header. `refresh` is the reactive half `Route.stream`
 * runs after a 401. Both funnel into one single-flight section that re-reads
 * the file before spending the refresh token, because codex may have rotated
 * it first and OAuth refresh tokens are not guaranteed reusable.
 *
 * Refresh traffic goes through the composed `RequestExecutor`, never a bare
 * fetch, so the executor's retry ladder and credential redaction apply to the
 * token endpoint exactly as they do to model calls. No token, account id, or
 * endpoint response ever enters an error message, a log, or a journal: errors
 * name the file path and the endpoint, nothing else.
 *
 * Confirmed against the live backend and codex v0.149.1 on 2026-08-25: the
 * refresh endpoint, client id, scope, response shape, and auth.json layout.
 *
 * @since 0.1.0
 */

import { isRecord } from "@smthrs/canonical/Record"
import type * as Auth from "@smthrs/model/Auth"
import { ModelError } from "@smthrs/model/ModelError"
import type * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Clock, Effect, Semaphore } from "effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { randomUUID } from "node:crypto"
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { errorCode } from "./internal/ErrorCode.ts"

/**
 * The OAuth token endpoint the refresh grant is sent to. This is the auth
 * host, not the backend-api host serving model calls.
 *
 * Exported so a test can point the refresh at a local server. A wrong value
 * here surfaces as an authentication failure on the first expired token, not
 * at startup.
 *
 * @category constants
 * @since 0.1.0
 */
export const refreshUrl = "https://auth.openai.com/oauth/token"

/**
 * The codex CLI's public OAuth client id.
 *
 * Not a secret: it names the client whose sessions `auth.json` holds, and a
 * refresh grant is rejected unless it presents the same id the session was
 * minted under. It is pinned to codex's own id because this store reads and
 * rewrites codex's file rather than keeping a session of its own.
 *
 * @category constants
 * @since 0.1.0
 */
export const clientId = "app_EMoamEEZ73f0CkXaXp7hrann"

/** How long before JWT `exp` a token is treated as already stale. */
const EXPIRY_MARGIN_MS = 5 * 60_000

/** Maximum time one refresh waits for another Smithers process. */
const LOCK_WAIT_MS = 30_000

/** Age after which a lock left by a dead process is recoverable. */
const STALE_LOCK_MS = 5 * 60_000

/** Poll interval while another live process owns the refresh lock. */
const LOCK_POLL_MS = 25

/**
 * Where the auth store lives for a given environment: `$CODEX_HOME/auth.json`,
 * defaulting to `~/.codex/auth.json` exactly as codex does.
 *
 * The resolution has to match codex's byte for byte. This store shares one
 * file with a program the operator also runs, so resolving a different path
 * would silently sign with a session the codex CLI has already rotated away.
 * Pure: it reads the environment it is handed and touches no disk.
 *
 * @category constructors
 * @since 0.1.0
 */
export const locate = (
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string = homedir()
): string => {
  const home = environment["CODEX_HOME"]
  return join(home === undefined || home === "" ? join(homeDirectory, ".codex") : home, "auth.json")
}

/**
 * One auth store, shared by every seat that resolves against the same file.
 *
 * Build it once per process with {@link make} and hand the same value to every
 * seat. Sharing is what makes the refresh single-flight: parallel sealed steps
 * signing concurrently await one refresh rather than racing the token endpoint
 * with the same refresh token, which the endpoint answers by invalidating the
 * loser's session.
 *
 * The single flight is per store, so it does not arbitrate against the codex
 * CLI running in another process. That residual race is documented on
 * {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Store {
  readonly auth: (options: { readonly modelId: string }) => Auth.Auth
}

/**
 * What {@link make} needs: the store file and the executor refresh traffic
 * runs through.
 *
 * Both are parameters so a test can point at a scratch file and a scripted
 * executor instead of the operator's real session and the live token endpoint.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly file: string
  readonly executor: RequestExecutor.RequestExecutor
}

interface Tokens {
  readonly access: string
  readonly refresh: string
  readonly accountId: string | undefined
}

interface FileState {
  readonly raw: Readonly<Record<string, unknown>>
  readonly rawTokens: Readonly<Record<string, unknown>>
  readonly tokens: Tokens
}

const authenticationError = (message: string): ModelError => new ModelError({ code: "authentication", message })

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

/**
 * What one `auth.json` text holds: a ChatGPT token set, or the reason it is
 * not one.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Parsed =
  | {
    readonly usable: true
    readonly raw: Readonly<Record<string, unknown>>
    readonly rawTokens: Readonly<Record<string, unknown>>
    readonly access: string
    readonly refresh: string
    readonly accountId: string | undefined
  }
  | { readonly usable: false; readonly reason: "invalid-json" | "no-tokens" }

/**
 * Reads a ChatGPT token set out of the text of one `auth.json`.
 *
 * Pure, and the one parser of the file's layout: the store's own `read` and
 * `Providers.detect` both go through it, so "usable session" means the same
 * thing to the seat that signs with it and to the verb that reports it. An
 * API-key login (`OPENAI_API_KEY` in the file, no `tokens`) is `no-tokens`:
 * it cannot serve the ChatGPT mode.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const parse = (text: string): Parsed => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { usable: false, reason: "invalid-json" }
  }
  const raw = isRecord(parsed) ? parsed : undefined
  const rawTokens = raw === undefined ? undefined : isRecord(raw.tokens) ? raw.tokens : undefined
  const access = rawTokens === undefined ? undefined : nonEmptyString(rawTokens.access_token)
  const refresh = rawTokens === undefined ? undefined : nonEmptyString(rawTokens.refresh_token)
  if (raw === undefined || rawTokens === undefined || access === undefined || refresh === undefined) {
    return { usable: false, reason: "no-tokens" }
  }
  return { usable: true, raw, rawTokens, access, refresh, accountId: nonEmptyString(rawTokens.account_id) }
}

/**
 * The access token's JWT expiry in epoch milliseconds, or undefined for a
 * token whose payload cannot be read. Unreadable expiry means "assume valid":
 * the reactive refresh path recovers from the 401 if the assumption is wrong,
 * while assuming expired would refresh on every request.
 */
const tokenExpiryMillis = (accessToken: string): number | undefined => {
  const payload = accessToken.split(".")[1]
  if (payload === undefined) return undefined
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return isRecord(decoded) && typeof decoded.exp === "number" && Number.isFinite(decoded.exp)
      ? decoded.exp * 1000
      : undefined
  } catch {
    return undefined
  }
}

const isFresh = (accessToken: string, now: number): boolean => {
  const expiry = tokenExpiryMillis(accessToken)
  return expiry === undefined || now < expiry - EXPIRY_MARGIN_MS
}

/** RFC3339 with six fractional digits, the format codex writes. */
const lastRefreshInstant = (now: number): string => new Date(now).toISOString().replace(/Z$/, "000Z")

/**
 * Builds the shared ChatGPT auth store over one `auth.json` file.
 *
 * The returned store hands each seat an `Auth` that reuses the recorded access
 * token until it is within five minutes of its JWT expiry, then refreshes
 * once for every waiter. A refresh re-reads `auth.json` immediately before
 * spending the refresh token, writes the result to a unique fsynced temporary
 * file, and renames it into place, so a crash cannot leave a truncated
 * session behind.
 *
 * A token-owned `O_EXCL` lock serializes this sequence across Smithers
 * processes and recovers a lock left by a dead process after five minutes.
 * The codex CLI also shares this file but does not yet honor that lock, so it
 * can still rotate the refresh token during the endpoint call. The re-read
 * narrows that external window without claiming coordination codex lacks.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Store => {
  const { executor, file } = options
  const gate = Semaphore.makeUnsafe(1)
  const lockFile = `${file}.refresh.lock`

  const lockError = (): ModelError =>
    authenticationError(`ChatGPT credentials at ${file} are busy refreshing; retry the request`)

  /** A lock is recoverable only when its recorded process is provably gone. */
  const lockOwnerAlive = (token: string): boolean => {
    const separator = token.indexOf(":")
    const pid = Number(token.slice(0, separator < 0 ? token.length : separator))
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return errorCode(error) !== "ESRCH"
    }
  }

  /** Creates the cross-process lock, waiting only for a bounded live owner. */
  const acquireLock: Effect.Effect<string, ModelError> = Effect.gen(function*() {
    const token = `${process.pid}:${randomUUID()}`
    const startedAt = yield* Clock.currentTimeMillis
    for (;;) {
      let descriptor: number | undefined
      try {
        descriptor = openSync(lockFile, "wx", 0o600)
        writeFileSync(descriptor, token, "utf8")
        fsyncSync(descriptor)
        closeSync(descriptor)
        return token
      } catch (error) {
        if (descriptor !== undefined) {
          try {
            closeSync(descriptor)
          } catch {
            // The failed write may already have closed it.
          }
          try {
            rmSync(lockFile, { force: true })
          } catch {
            // The acquisition error below is the actionable failure.
          }
        }
        if (errorCode(error) !== "EEXIST") return yield* Effect.fail(lockError())
      }

      const now = yield* Clock.currentTimeMillis
      try {
        const observed = readFileSync(lockFile, "utf8")
        if (now - statSync(lockFile).mtimeMs >= STALE_LOCK_MS && !lockOwnerAlive(observed)) {
          // Recheck the ownership token immediately before removal so an old
          // observation never intentionally deletes a replacement lock.
          if (readFileSync(lockFile, "utf8") === observed) {
            rmSync(lockFile, { force: true })
            continue
          }
        }
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue
        return yield* Effect.fail(lockError())
      }
      if (now - startedAt >= LOCK_WAIT_MS) return yield* Effect.fail(lockError())
      yield* Effect.sleep(`${LOCK_POLL_MS} millis`)
    }
  })

  /** Removes only the lock this acquisition created, never a replacement. */
  const releaseLock = (token: string): Effect.Effect<void> =>
    Effect.sync(() => {
      try {
        if (readFileSync(lockFile, "utf8") === token) rmSync(lockFile, { force: true })
      } catch {
        // Finalization is best effort: a stale-lock recovery may have replaced
        // this token, and deleting that new owner's lock would reopen the race.
      }
    })

  const read: Effect.Effect<FileState, ModelError> = Effect.suspend(() => {
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      return Effect.fail(authenticationError(
        `No ChatGPT credentials at ${file}; sign in with \`codex login\` or use SMITHERS_OPENAI_AUTH=api-key`
      ))
    }
    const parsed = parse(text)
    if (!parsed.usable) {
      return Effect.fail(authenticationError(
        parsed.reason === "invalid-json"
          ? `${file} is not valid JSON; sign in again with \`codex login\``
          : `${file} holds no ChatGPT token set; sign in with \`codex login\` (API-key logins cannot serve this mode)`
      ))
    }
    return Effect.succeed({
      raw: parsed.raw,
      rawTokens: parsed.rawTokens,
      tokens: { access: parsed.access, refresh: parsed.refresh, accountId: parsed.accountId }
    })
  })

  // The rewrite codex expects: every existing field preserved, the three
  // rotating tokens overwritten (`account_id` is not in the refresh response
  // and survives untouched), `last_refresh` restamped, written atomically at
  // mode 0600 so a crash never leaves a truncated store or a readable temp.
  const write = (
    state: FileState,
    refreshed: { readonly access: string; readonly refresh: string | undefined; readonly id: string | undefined },
    now: number
  ): Effect.Effect<void, ModelError> =>
    Effect.suspend(() => {
      const next = {
        ...state.raw,
        tokens: {
          ...state.rawTokens,
          ...(refreshed.id === undefined ? {} : { id_token: refreshed.id }),
          access_token: refreshed.access,
          refresh_token: refreshed.refresh ?? state.tokens.refresh
        },
        last_refresh: lastRefreshInstant(now)
      }
      const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
      let descriptor: number | undefined
      try {
        descriptor = openSync(temporary, "wx", 0o600)
        writeFileSync(descriptor, `${JSON.stringify(next, null, 2)}\n`, "utf8")
        fsyncSync(descriptor)
        closeSync(descriptor)
        descriptor = undefined
        renameSync(temporary, file)
        // Persist the directory entry on filesystems that expose directory
        // descriptors. Windows may refuse to open one; the atomic rename is
        // still the strongest primitive available there.
        let directoryDescriptor: number | undefined
        try {
          directoryDescriptor = openSync(dirname(file), "r")
          fsyncSync(directoryDescriptor)
        } catch {
          // Best effort only on platforms without directory fsync.
        } finally {
          if (directoryDescriptor !== undefined) closeSync(directoryDescriptor)
        }
        return Effect.void
      } catch {
        if (descriptor !== undefined) {
          try {
            closeSync(descriptor)
          } catch {
            // The failed write may already have closed it.
          }
        }
        try {
          rmSync(temporary, { force: true })
        } catch {
          // The rename already failed; a leftover temp is the lesser report.
        }
        return Effect.fail(authenticationError(`Refreshed ChatGPT credentials could not be written back to ${file}`))
      }
    })

  const requestRefresh = (state: FileState, modelId: string): Effect.Effect<string, ModelError> =>
    Effect.scoped(Effect.gen(function*() {
      const body = new TextEncoder().encode(JSON.stringify({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: state.tokens.refresh,
        scope: "openid profile email"
      }))
      const request = HttpClientRequest.post(refreshUrl).pipe(
        HttpClientRequest.bodyUint8Array(body, "application/json")
      )
      // Under the model's own capability and ladder: the refresh exists only
      // to serve this seat's calls, and the executor redacts the refresh
      // token from every diagnostic the attempt can produce.
      const response = yield* executor.execute(request, { modelId }).pipe(
        Effect.mapError((error) =>
          error instanceof ModelError
            ? error
            : authenticationError(`The host did not permit the ChatGPT token refresh at ${refreshUrl}`)
        )
      )
      return yield* response.text.pipe(
        Effect.mapError(() =>
          new ModelError({
            code: "transport",
            message: `The ChatGPT token refresh response from ${refreshUrl} could not be read`
          })
        )
      )
    }))

  const adoptRefresh = (state: FileState, text: string): Effect.Effect<Tokens, ModelError> =>
    Effect.gen(function*() {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      const response = isRecord(parsed) ? parsed : undefined
      const access = response === undefined ? undefined : nonEmptyString(response.access_token)
      if (response === undefined || access === undefined) {
        return yield* Effect.fail(
          authenticationError(`The ChatGPT token endpoint at ${refreshUrl} answered without an access token`)
        )
      }
      const refreshed = {
        access,
        refresh: nonEmptyString(response.refresh_token),
        id: nonEmptyString(response.id_token)
      }
      const now = yield* Clock.currentTimeMillis
      yield* write(state, refreshed, now)
      return { access, refresh: refreshed.refresh ?? state.tokens.refresh, accountId: state.tokens.accountId }
    })

  // The single-flight section. `stale` is the access token the caller found
  // wanting — near expiry, or answered with a 401. Inside the permit the file
  // is read again: a different, fresh token means codex or a concurrent fiber
  // already refreshed and the refresh token must not be spent twice.
  const refreshStale = (stale: string, modelId: string): Effect.Effect<Tokens, ModelError> =>
    gate.withPermits(1)(Effect.scoped(Effect.gen(function*() {
      yield* Effect.acquireRelease(acquireLock, releaseLock)
      const state = yield* read
      const now = yield* Clock.currentTimeMillis
      if (state.tokens.access !== stale && isFresh(state.tokens.access, now)) return state.tokens
      const answer = yield* requestRefresh(state, modelId)
      return yield* adoptRefresh(state, answer)
    })))

  const auth = (authOptions: { readonly modelId: string }): Auth.Auth => ({
    sign: Effect.fn("Auth.sign")((headers) =>
      Effect.gen(function*() {
        const state = yield* read
        const now = yield* Clock.currentTimeMillis
        const tokens = isFresh(state.tokens.access, now)
          ? state.tokens
          : yield* refreshStale(state.tokens.access, authOptions.modelId)
        return {
          ...headers,
          Authorization: `Bearer ${tokens.access}`,
          ...(tokens.accountId === undefined ? {} : { "chatgpt-account-id": tokens.accountId })
        }
      })
    ),
    refresh: Effect.gen(function*() {
      const state = yield* read
      yield* refreshStale(state.tokens.access, authOptions.modelId)
    })
  })

  return { auth }
}
