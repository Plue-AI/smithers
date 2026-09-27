import { WORKER_REFUSAL_COPY } from "@smthrs/rpc/RefusalCopy"
import { machineReadableRefusal, upstreamRefusalMessage } from "@smthrs/rpc/UpstreamProse"
import type { WorkerFailureCode } from "@smthrs/rpc/WorkerFailureCodes"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import { runDurable } from "./Boundary"
import { configLayer, ServerConfig } from "./Config"
import type { ServerEnvVars } from "./Config"
import { DurableStorage, namespaceCall, storageLayer } from "./DurableStorage"
import type { NativeNamespace, NativeStorage } from "./DurableStorage"
import { BodyUnreadable } from "./Failures"
import type { UpstreamFailure } from "./Failures"
import { discardBody, fetchWithDeadline, readJsonOrUndefined, readRefusalDetail, TransportLive } from "./Http"
import type { Transport } from "./Http"
import { logSeamFailure } from "./RefusalLog"
import { upstreamProse } from "./Responses"
import { pendingSetupRequests, repositorySetupStorageRequest, setupRequestsLayer, SetupStorageMutex, setupStorageMutexLayer } from "./repositorySetupStore"
import { advanceRepositorySetup } from "./repositorySetupExecution"

/*
 * Wave 11 — the per-user gateway seam. The product Worker provisions (or
 * resumes) the signed-in user's workspace gateway on Smithers Cloud and
 * relays RPC/event calls to it, implementing the WAVE4-RELAY-RECEIPT §5
 * contract faithfully:
 *
 *   - provision-or-resume is idempotent: POST /api/repos/{owner}/{repo}/gateway
 *     is re-called freely; a warm resume returns the same gateway with a fresh
 *     expires_at,
 *   - re-call before expires_at (half-life cadence) and ALWAYS adopt the
 *     returned gateway_id/token/base_url — a reprovision legitimately hands
 *     back different values,
 *   - the error taxonomy is distinct: 401 (re-provision once), 409 (still
 *     provisioning — the caller polls, never stampedes), 500 no_capacity
 *     (surfaced honestly, never retry-looped).
 *
 * Gateway tokens live server-side ONLY: per-user records are held in the
 * GatewaySessionRegistry Durable Object (keyed by login) and never reach a
 * browser response body. The browser talks to /api/workflow/*; the Worker
 * holds the token and sets the Authorization header the relay requires.
 *
 * The relay address is pinned: a record's baseUrl is exactly
 * `<Cloud origin>/api/gateways/<gatewayId>` (`gatewayBaseUrl`). A provision
 * answer or stored row naming any other address is refused before the bearer
 * and the user's relayed frame can leave for it (`gatewayRecordFrom`).
 *
 * Every call out of this seam is bounded (`ServerConfig.upstreamTimeoutMs`,
 * headers only). Smithers Cloud accepts the provision POST and can then take
 * an unbounded time to build a sandbox: on canary the route never answered at
 * all, so `POST /api/workflow/provision` hung past 70s and the product left
 * "Preparing your <repo> workspace…" standing with no timeout, no run card and
 * no error (repro apps/app/canary-repros/honesty/22.6). A deadline turns that
 * into one of the seam's own honest states.
 */

export interface GatewayRecord {
  readonly gatewayId: string
  readonly baseUrl: string
  readonly token: string
  readonly vmId: string | null
  readonly workspaceId: string
  readonly expiresAt: number
  /** Half-life cadence (§5): re-resolve at the midpoint of the issued window. */
  readonly renewAfter: number
  /** When this record was minted — the floor under a forced re-provision. */
  readonly provisionedAt: number
  /** Last forced resume attempt; an ordinary fresh record still gets its first wake. */
  readonly resumeAttemptedAt?: number
  /** A sleeping resume that may be retried after the attempt's cooldown. */
  readonly resumeOutcome?: { readonly status: "provisioning" | "unavailable"; readonly detail: string }
  /** Capabilities verified by the owning host's live provision response. */
  readonly verifiedCapabilities?: ReadonlyArray<string>
}

/** The persisted row: `provisionedAt` is absent on records written before it existed. */
interface GatewayRecordRow {
  readonly gatewayId: string
  readonly baseUrl: string
  readonly token: string
  readonly vmId: string | null
  readonly workspaceId: string
  readonly expiresAt: number
  readonly renewAfter: number
  readonly provisionedAt?: number
  readonly resumeAttemptedAt?: number
  readonly resumeOutcome?: GatewayRecord["resumeOutcome"]
  readonly verifiedCapabilities?: ReadonlyArray<string>
}
type GatewayCapability = "repository-jobs/v1"
type GatewayRefresh = boolean | "sleeping"

const resumeCoolingDown = (record: GatewayRecord, now: number): boolean =>
  record.resumeAttemptedAt !== undefined && now - record.resumeAttemptedAt < FORCED_REPROVISION_FLOOR_MS

/*
 * A separator no login or repo can contain (NUL): `${login}${repo}` alone would
 * let ("ab", "c/d") and ("a", "bc/d") share one entry — a cross-account record.
 * Written as the `\u0000` ESCAPE, never as a literal byte: a raw NUL made
 * this whole file binary to git, grep and the editors, so its diffs were
 * unreadable and a review of the seam holding the user's Cloud token could not
 * be read.
 */
/** The Durable Object storage key of one box's gateway: a persisted identity, never changed. */
export const gatewayStorageKey = (repo: string, workspaceId: string): string => `gateway:${repo}\u0000${workspaceId}`

/*
 * Canonical non-nil lowercase UUID text; matches the Plue route. Upstream
 * main (b40e8f6523) moved this guard to `@smthrs/rpc/GatewayWorkspace`; this
 * checkout's packages/rpc does not carry that file yet, so the guard stays
 * here until it lands, then becomes an import + re-export.
 */
export const isGatewayWorkspaceId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000"

const answer = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

/**
 * The one relay address a gateway may have: `<Cloud origin>/api/gateways/<id>`,
 * which is what Smithers Cloud mints. `candidate` must name exactly that
 * address (same scheme, host and port as the configured Cloud origin; no
 * credentials, query, fragment or other path), else undefined. The gateway
 * bearer never leaves for another host, the rule src/proxies.ts applies to
 * the Cloud token.
 */
export const gatewayBaseUrl = (cloudApiBaseUrl: string, gatewayId: string, candidate: string): string | undefined => {
  if (!/^[A-Za-z0-9._-]+$/.test(gatewayId)) return undefined
  try {
    const origin = new URL(cloudApiBaseUrl).origin
    const url = new URL(candidate)
    const expected = `/api/gateways/${gatewayId}`
    return origin !== "null" && url.origin === origin && url.username === "" && url.password === "" &&
        url.search === "" && url.hash === "" && url.pathname === expected
      ? origin + expected
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The one place a stored row or provision answer becomes a record: the fields
 * the relay reads must have their types and the address must be the pinned
 * one, else undefined. A row written before `provisionedAt` existed is old by
 * definition, so it has already earned the right to be re-provisioned on a
 * tunnel failure.
 */
export const gatewayRecordFrom = (cloudApiBaseUrl: string, row: unknown): GatewayRecord | undefined => {
  if (typeof row !== "object" || row === null) return undefined
  const fields = row as { readonly [K in keyof GatewayRecordRow]?: unknown }
  if (
    typeof fields.gatewayId !== "string" || typeof fields.baseUrl !== "string" || typeof fields.token !== "string" ||
    typeof fields.expiresAt !== "number" || typeof fields.renewAfter !== "number" ||
    (fields.vmId !== null && typeof fields.vmId !== "string") ||
    !isGatewayWorkspaceId(fields.workspaceId)
  ) return undefined
  const baseUrl = gatewayBaseUrl(cloudApiBaseUrl, fields.gatewayId, fields.baseUrl)
  if (baseUrl === undefined) return undefined
  const stored = row as GatewayRecordRow
  return { ...stored, baseUrl, provisionedAt: typeof stored.provisionedAt === "number" ? stored.provisionedAt : 0 }
}

/** A stored row as a record, or undefined with one log line naming its key (never its token). */
const decodeStored = (key: string, row: unknown): Effect.Effect<GatewayRecord | undefined, never, ServerConfig> =>
  Effect.gen(function* () {
    if (row === undefined || row === null) return undefined
    const config = yield* ServerConfig
    const record = gatewayRecordFrom(config.cloudApiBaseUrl, row)
    if (record === undefined) logSeamFailure("gateway record", `${key} is not a gateway record under the Cloud origin; it is treated as cold`)
    return record
  })

/**
 * The resolutions one registry object has in flight, keyed exactly like the
 * record they mint. workerd runs one instance per login, so this map is the
 * join point: concurrent cold or expired misses for one login/repo share a
 * single token-door + provision sequence, and every joiner reads back the
 * record the leader persisted. The native class creates it once per object
 * (a per-request map would join nothing).
 */
export class GatewayResolutions
  extends Context.Service<GatewayResolutions, Map<string, Deferred.Deferred<ProvisionOutcome>>>()("smithers-server/GatewayResolutions") {}

export const makeGatewayResolutions = (): Map<string, Deferred.Deferred<ProvisionOutcome>> => new Map()

export const gatewayResolutionsLayer = (resolutions: Map<string, Deferred.Deferred<ProvisionOutcome>>): Layer.Layer<GatewayResolutions> =>
  Layer.succeed(GatewayResolutions, resolutions)

/** Everything the registry object runs under: its storage, the deployment's config and transport, its join map. */
export type GatewayRegistryServices = DurableStorage | Transport | ServerConfig | GatewayResolutions | SetupStorageMutex

/**
 * The Layer one registry object runs under, built ONCE per in-memory object
 * (the join map is the object's memory). `env` is the deployment's vars and
 * secrets: the registry mints the Cloud token and provisions the workspace
 * itself, so it needs the identity door, the Cloud origin and the deadline.
 */
export const gatewayRegistryLayers = (storage: NativeStorage, env: ServerEnvVars): Layer.Layer<GatewayRegistryServices> =>
  Layer.mergeAll(storageLayer(storage), configLayer(env), TransportLive, gatewayResolutionsLayer(makeGatewayResolutions()), setupStorageMutexLayer())

/** A record the object holds, or undefined: a store that cannot answer a read is cold, as the Worker side treats it. */
const readStored = (repo: string, workspaceId: string): Effect.Effect<GatewayRecord | undefined, never, DurableStorage | ServerConfig> =>
  DurableStorage.use((storage) => storage.get<unknown>(gatewayStorageKey(repo, workspaceId))).pipe(
    Effect.flatMap((row) => decodeStored(gatewayStorageKey(repo, workspaceId), row)),
    Effect.catch(() => Effect.succeed(undefined))
  )

/**
 * The leader's half of a resolution: the Cloud token door, the provision
 * POST, exactly one re-mint on a 401, then persistence. A record that cannot
 * be stored is not reported ready.
 */
const provisionAndStore = (
  login: string,
  repo: string,
  workspaceId: string,
  force: GatewayRefresh,
  requiredCapability?: GatewayCapability
): Effect.Effect<ProvisionOutcome, never, DurableStorage | Transport | ServerConfig> =>
  Effect.gen(function* () {
    const storage = yield* DurableStorage
    const previous = yield* readStored(repo, workspaceId)
    const now = yield* Clock.currentTimeMillis
    // Recheck under the registry's claimed resolution: another sleeping reply
    // may have been in flight while a previous caller already resumed the host.
    if (previous !== undefined && resumeCoolingDown(previous, now)) {
      if (previous.resumeOutcome !== undefined) return previous.resumeOutcome
      if (force === "sleeping" && now < previous.renewAfter &&
        (requiredCapability === undefined || previous.verifiedCapabilities?.includes(requiredCapability))) {
        return { status: "ready", record: previous } as const
      }
    }
    const sleepingResume = force === "sleeping" || previous?.resumeOutcome !== undefined
    const resumeAttemptedAt = force || sleepingResume ? now : previous?.resumeAttemptedAt
    const resuming = { status: "provisioning", detail: "The workspace gateway is resuming." } as const
    // Persist before the attempt: a pending/failed resume and an object restart
    // must not let each sleeping poll spend another token-door/provision call.
    // A refreshed host must prove its capabilities again before setup can use it.
    if ((force || sleepingResume) && previous !== undefined) {
      const marked = yield* Effect.result(storage.put(gatewayStorageKey(repo, workspaceId), {
        ...previous, resumeAttemptedAt, verifiedCapabilities: undefined,
        resumeOutcome: sleepingResume ? resuming : undefined
      }))
      if (Result.isFailure(marked)) return { status: "unavailable", detail: "The gateway resume attempt could not be persisted." } as const
    }
    const outcome = yield* provisionWithRemint(login, repo, workspaceId, requiredCapability)
    if (outcome.status !== "ready") {
      if (sleepingResume && previous !== undefined) {
        const resumeOutcome = outcome.status === "provisioning" || (outcome.status === "unavailable" && outcome.retryable === true)
          ? { status: outcome.status, detail: outcome.detail } : undefined
        const retained = yield* Effect.result(storage.put(gatewayStorageKey(repo, workspaceId), {
          ...previous, resumeAttemptedAt, verifiedCapabilities: undefined, resumeOutcome
        }))
        if (Result.isFailure(retained)) return { status: "unavailable", detail: "The gateway resume result could not be persisted." } as const
      }
      return outcome
    }
    const record = { ...outcome.record, ...(resumeAttemptedAt === undefined ? {} : { resumeAttemptedAt }) }
    const stored = yield* Effect.result(storage.put(gatewayStorageKey(repo, workspaceId), record))
    if (Result.isFailure(stored)) {
      return {
        status: "unavailable",
        detail: `The gateway session store is unavailable: ${
          stored.failure.cause instanceof Error ? stored.failure.cause.message : "unknown error"
        }`
      } as const
    }
    return { ...outcome, record }
  })

/**
 * The §5 provision-or-resume cadence, coordinated per login/repo inside the
 * object: a cached record inside its half-life answers directly; anything
 * else joins the in-flight resolution if one exists, and only the first
 * caller provisions. A joiner re-reads what the leader persisted rather than
 * trusting the join: the stored record is the hand-off a recreated instance
 * would serve. The leader's work is detached from its request, so a caller
 * that hangs up mid-provision leaves the (idempotent, deadline-bounded)
 * provision to finish for the others.
 */
const resolveRecord = (
  login: string,
  repo: string,
  workspaceId: string,
  force: GatewayRefresh,
  requiredCapability?: GatewayCapability
): Effect.Effect<ProvisionOutcome, never, GatewayRegistryServices> =>
  Effect.gen(function* () {
    const cached = yield* readStored(repo, workspaceId)
    const now = yield* Clock.currentTimeMillis
    if (cached !== undefined && cached.resumeOutcome !== undefined && resumeCoolingDown(cached, now)) return cached.resumeOutcome
    if (!force) {
      if (cached !== undefined && cached.resumeOutcome === undefined && now < cached.renewAfter &&
        (requiredCapability === undefined || cached.verifiedCapabilities?.includes(requiredCapability))) return { status: "ready", record: cached } as const
    }
    const key = gatewayStorageKey(repo, workspaceId) + (requiredCapability === undefined ? "" : `\u0000capability:${requiredCapability}`)
    const resolutions = yield* GatewayResolutions
    const pending = resolutions.get(key)
    if (pending !== undefined) {
      const outcome = yield* Deferred.await(pending)
      if (outcome.status !== "ready") return outcome
      const persisted = yield* readStored(repo, workspaceId)
      return persisted === undefined || (requiredCapability !== undefined && !persisted.verifiedCapabilities?.includes(requiredCapability))
        ? outcome : { status: "ready", record: persisted } as const
    }
    // Claimed in one synchronous step: no other caller can slip between the
    // lookup above and this registration.
    const claimed = yield* Effect.sync(() => {
      const deferred = Deferred.makeUnsafe<ProvisionOutcome>()
      resolutions.set(key, deferred)
      return deferred
    })
    yield* Effect.forkDetach(
      provisionAndStore(login, repo, workspaceId, force, requiredCapability).pipe(
        // A detached leader must complete the join even when malformed
        // upstream data or configuration causes an unexpected defect.
        Effect.catchCause((cause) => Effect.sync(() => {
          logSeamFailure("gateway resolution", cause)
          return { status: "unavailable", detail: "The gateway resolution failed. Try again." } as const
        })),
        // Cleared only once the record write inside the task has settled, so
        // a later caller either joins this task or reads the fresh record.
        Effect.ensuring(Effect.sync(() => {
          resolutions.delete(key)
        })),
        Effect.flatMap((outcome) => Deferred.succeed(claimed, outcome))
      )
    )
    return yield* Deferred.await(claimed)
  })

/**
 * Per-user gateway records, one Durable Object per login, keyed inside by
 * repo. The record carries the relay token, so it must never leave the
 * server: the read route is consumed by this Worker's own handlers only.
 *
 * The registry is also where a resolution is COORDINATED (`POST /resolve`):
 * see `resolveRecord`. The persisted key layout
 * (`gateway:<repo>\u0000<workspaceId>`) is the deployed namespace's and never
 * changes. Every record belongs to a box (#2194).
 */
export const gatewaySessionRequest = (request: Request): Effect.Effect<Response, never, GatewayRegistryServices> =>
  Effect.gen(function* () {
    const storage = yield* DurableStorage
    const url = new URL(request.url)
    if (url.pathname === "/repository-setup" && request.method === "POST") return yield* repositorySetupStorageRequest(request)
    if (url.pathname === "/record" && request.method === "GET") {
      const workspaceId = url.searchParams.get("workspace_id")
      if (!isGatewayWorkspaceId(workspaceId)) return new Response("bad request", { status: 400 })
      const key = gatewayStorageKey(url.searchParams.get("repo") ?? "", workspaceId)
      const record = yield* decodeStored(key, yield* storage.get<unknown>(key))
      return answer({ record: record ?? null })
    }
    if (url.pathname === "/resolve" && request.method === "POST") {
      const body = (yield* readJsonOrUndefined(request)) as
        | { login?: unknown; repo?: unknown; workspaceId?: unknown; force?: unknown; requiredCapability?: unknown }
        | undefined
      if (typeof body?.login !== "string" || body.login === "" || typeof body.repo !== "string" || body.repo === "" ||
        !isGatewayWorkspaceId(body.workspaceId)) {
        return new Response("bad request", { status: 400 })
      }
      if (body.requiredCapability !== undefined && body.requiredCapability !== "repository-jobs/v1") return new Response("bad capability", { status: 400 })
      const outcome = yield* resolveRecord(
        body.login,
        body.repo,
        body.workspaceId,
        body.force === "sleeping" ? "sleeping" : body.force === true,
        body.requiredCapability
      )
      return answer(outcome)
    }
    return new Response("not found", { status: 404 })
  }).pipe(
    // A storage failure inside the object answers 500 with its message, so
    // the Worker side reports "the session store answered HTTP 500: …"
    // rather than the object's fetch rejecting.
    Effect.catchTag("StorageFailure", (failure) => Effect.succeed(new Response(failure.message, { status: 500 })))
  )

/**
 * The native class, as workerd constructs it: `(ctx, env)`. The join map is
 * a field, made once per object; the config and transport come from the
 * deployment's env.
 */
export class GatewaySessionRegistry {
  private readonly services: Layer.Layer<GatewayRegistryServices>

  constructor(ctx: { readonly storage: NativeStorage }, env: ServerEnvVars = {}) {
    this.services = gatewayRegistryLayers(ctx.storage, env)
  }

  fetch(request: Request): Promise<Response> {
    return runDurable(gatewaySessionRequest(request).pipe(Effect.provide(this.services)))
  }

  /** Durable continuation: closing the browser cannot strand admitted setup work. */
  alarm(): Promise<void> {
    const registry = this
    return runDurable(Effect.gen(function* () {
      const queue = yield* pendingSetupRequests()
      if (!queue || !Object.keys(queue.requests).length) return
      // In-process doors reuse this object's locks and storage. No recursive
      // network call to the same Durable Object and no credential in its queue.
      const local: NativeNamespace = { idFromName: name => name, get: id => ({ fetch: request =>
        id === queue.login ? registry.fetch(request) : Promise.resolve(new Response("Wrong setup owner", { status: 403 })) }) }
      const execution = Layer.mergeAll(registry.services, setupRequestsLayer(local), gatewaySessionsLayer(local))
      yield* Effect.forEach(Object.keys(queue.requests), requestId => advanceRepositorySetup(queue.login, requestId), { concurrency: 2, discard: true }).pipe(
        Effect.provide(execution), Effect.timeoutOrElse({ duration: 25_000, orElse: () => Effect.void }))
    }).pipe(Effect.provide(this.services), Effect.catch(error => Effect.die(error))))
  }
}

/**
 * owner/repo, and nothing that could rewrite the upstream path. `.` and `..`
 * match the character class a repository name allows, but URL parsing resolves
 * them away: `../admin` would aim the user's server-held Cloud token at a route
 * outside this seam, which is exactly what holding the token server-side is for.
 * Dot-PREFIXED names (`.github`) are real repositories and stay legal.
 */
export const isRelayRepoName = (value: string): boolean =>
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(value)

/*
 * The Worker-side view of the registry: read a record, or ask the login's
 * object to resolve one (the §5 cadence, coordinated in the object). Both
 * answer through the login's Durable Object; there is no other store.
 */
export interface GatewaySessionsShape {
  readonly read: (login: string, repo: string, workspaceId: string) => Effect.Effect<GatewayRecord | undefined>
  readonly resolve: (login: string, repo: string, workspaceId: string, force: GatewayRefresh, requiredCapability?: GatewayCapability) => Effect.Effect<ProvisionOutcome>
}

export class GatewaySessions extends Context.Service<GatewaySessions, GatewaySessionsShape>()("smithers-server/GatewaySessions") {}

/**
 * The first `limit` characters of a response body, for an error detail. A
 * long body is cut, not refused (a 500 past the ceiling must still show its
 * `no_capacity`), and a body that cannot be read is simply absent.
 */
const readBoundedResponseText = (response: Response, limit = 240): Effect.Effect<string> => {
  const stream = response.body
  if (stream === null) return Effect.succeed("")
  return Effect.acquireUseRelease(
    Effect.sync(() => ({ reader: stream.getReader(), finished: false })),
    (held) =>
      Effect.gen(function* () {
        const decoder = new TextDecoder()
        let detail = ""
        const read = Effect.tryPromise({ try: () => held.reader.read(), catch: (cause) => new BodyUnreadable({ cause }) })
        for (;;) {
          const { done, value } = yield* read
          if (done) {
            held.finished = true
            break
          }
          detail += decoder.decode(value, { stream: true })
          if (detail.length >= limit) break
        }
        return detail.slice(0, limit).trim()
      }),
    (held) =>
      Effect.promise(() => (held.finished ? Promise.resolve() : held.reader.cancel().catch(() => undefined))).pipe(
        Effect.ensuring(Effect.sync(() => held.reader.releaseLock()))
      )
  ).pipe(Effect.catch(() => Effect.succeed("")))
}

const isProvisionOutcome = (value: unknown): value is ProvisionOutcome =>
  typeof value === "object" && value !== null && typeof (value as { status?: unknown }).status === "string"

const durableGatewaySessions = (namespace: NativeNamespace): GatewaySessionsShape => ({
  read: (login, repo, workspaceId) =>
    Effect.gen(function* () {
      const response = yield* namespaceCall(
        "gateway.ts:read",
        namespace,
        login,
        new Request(
          `https://gateway-sessions.internal/record?repo=${encodeURIComponent(repo)}&workspace_id=${encodeURIComponent(workspaceId)}`
        )
      )
      // The registry answers only records its decoder admitted.
      const body = (yield* readJsonOrUndefined(response)) as { record?: GatewayRecord | null } | undefined
      const record = body?.record
      if (record === undefined || record === null || record.workspaceId !== workspaceId) return undefined
      return record
    }).pipe(Effect.catch(() => Effect.succeed(undefined))),
  resolve: (login, repo, workspaceId, force, requiredCapability) =>
    Effect.gen(function* () {
      const answered = yield* Effect.result(namespaceCall(
        "gateway.ts:resolve",
        namespace,
        login,
        new Request("https://gateway-sessions.internal/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ login, repo, workspaceId, force,
            ...(requiredCapability === undefined ? {} : { requiredCapability }) })
        })
      ))
      if (Result.isFailure(answered)) {
        return {
          status: "unavailable",
          detail: `The gateway session store is unavailable: ${
            answered.failure.cause instanceof Error ? answered.failure.cause.message : "unknown error"
          }`
        } as const
      }
      const response = answered.success
      if (!response.ok) {
        const detail = yield* readBoundedResponseText(response)
        return {
          status: "unavailable",
          detail: `The gateway session store answered HTTP ${response.status}${detail === "" ? "." : `: ${detail}`}`
        } as const
      }
      const outcome = yield* readJsonOrUndefined(response)
      if (!isProvisionOutcome(outcome)) {
        return { status: "unavailable", detail: "The gateway session store answered in a shape the gateway seam did not understand." } as const
      }
      return outcome
    })
})

/** The session store: the login's Durable Object. Bound on every deployment; tests bind the real class over memory. */
export const gatewaySessionsLayer = (namespace: NativeNamespace): Layer.Layer<GatewaySessions> =>
  Layer.succeed(GatewaySessions, durableGatewaySessions(namespace))

/**
 * The sentence an upstream failure is reported with: the cause's own message
 * where it has one, and the configured deadline in milliseconds (the number
 * the deployment set, never a rounded second) when the deadline won.
 */
const failureMessage = (failure: UpstreamFailure): string =>
  failure._tag === "UpstreamTimeout"
    ? `${failure.seam} did not answer within ${failure.timeoutMs}ms.`
    : failure.cause instanceof Error
    ? failure.cause.message
    : "unknown error"

export type CloudTokenOutcome =
  | { readonly status: "ok"; readonly token: string }
  | { readonly status: "not_configured"; readonly detail: string }
  | { readonly status: "unavailable"; readonly detail: string }
  /*
   * Smithers Cloud refused this ACCOUNT: it is not off the closed-alpha
   * waitlist. A fact about the person, not about the bridge, so it is not an
   * outage and no retry helps. Only the machine-readable codes Cloud itself
   * publishes land here; anything else stays `not_found`, which is what this
   * Worker did with every tokenless answer before.
   */
  | { readonly status: "not_eligible"; readonly detail: string }
  | { readonly status: "not_found"; readonly detail: string }

/**
 * Smithers Cloud's own machine-readable "not on the list yet" codes, carried
 * through the identity worker verbatim. Matched against both fields the door
 * can put one in, so this Worker and the identity worker can ship in either
 * order.
 */
const CLOUD_ELIGIBILITY_REFUSALS = ["NOT_ON_WAITLIST", "access_not_granted"] as const

/**
 * The per-user Cloud token door (wave-11b): POST /api/identity/cloud-token on
 * the identity worker, service-token only, by login. The token mints lazily
 * upstream; a typed failure is surfaced, never fabricated.
 */
export const fetchCloudToken = (login: string): Effect.Effect<CloudTokenOutcome, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    if (config.identityUpstreamUrl === undefined) {
      return { status: "not_configured", detail: "IDENTITY_UPSTREAM_URL is unset on this deployment." } as const
    }
    if (config.identityServiceToken === undefined) {
      return { status: "not_configured", detail: "IDENTITY_SERVICE_TOKEN is unset on this deployment." } as const
    }
    const answered = yield* Effect.result(fetchWithDeadline(
      "The Cloud token door",
      new URL("/api/identity/cloud-token", config.identityUpstreamUrl).toString(),
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-smithers-service-token": Redacted.value(config.identityServiceToken) },
        body: JSON.stringify({ login })
      },
      config.upstreamTimeoutMs
    ))
    if (Result.isFailure(answered)) {
      return {
        status: "unavailable",
        detail: `The identity service is unreachable: ${failureMessage(answered.failure)}`
      } as const
    }
    const response = answered.success
    if (!response.ok) {
      const detail = (yield* readRefusalDetail(response)).trim().slice(0, 200)
      return {
        status: "unavailable",
        detail: `The Cloud token door answered HTTP ${response.status}${detail === "" ? "." : `: ${detail}`}`
      } as const
    }
    const body = (yield* readJsonOrUndefined(response)) as
      | { found?: unknown; token?: unknown; cloud?: { status?: unknown; reason?: unknown } }
      | undefined
    if (body?.found === true && typeof body.token === "string" && body.token !== "") {
      return { status: "ok", token: body.token } as const
    }
    const cloudStatus = typeof body?.cloud?.status === "string" ? body.cloud.status : "unknown"
    const cloudReason = typeof body?.cloud?.reason === "string" ? body.cloud.reason : null
    const refusal = CLOUD_ELIGIBILITY_REFUSALS.find((code) => code === cloudStatus || code === cloudReason)
    if (refusal !== undefined) {
      return { status: "not_eligible", detail: `Smithers Cloud has not let this account in yet (${refusal}).` } as const
    }
    return {
      status: "not_found",
      detail: `No Smithers Cloud identity is available for this account (${cloudStatus}${
        cloudReason === null ? "" : `: ${cloudReason}`
      }).`
    } as const
  })

/**
 * The one reading of a Cloud token outcome that is not a token. Eligibility is
 * a fact about the ACCOUNT and takes the allowlist code with its written copy;
 * everything else is the bridge, and the caller words that as it always has.
 *
 * It lives beside `fetchCloudToken` because a consumer that reclassifies the
 * same fact for itself is how a closed-alpha refusal came to read as a setup
 * failure on two of these routes and as an outage on a third.
 */
export const cloudTokenRefusal = (
  outcome: Exclude<CloudTokenOutcome, { readonly status: "ok" }>,
  unavailable: string
): { readonly code: WorkerFailureCode; readonly message: string } =>
  outcome.status === "not_eligible"
    ? { code: "account_not_allowlisted", message: WORKER_REFUSAL_COPY.account_not_allowlisted.lead }
    : { code: "cloud_token_unavailable", message: unavailable }

/**
 * The same refusal for a failure channel that carries only a sentence — a
 * setup receipt's error, which the card renders and `agentFaultNote` reads the
 * leading code from. The bridge's own words keep the wording their route gave
 * them.
 */
export const cloudTokenRefusalMessage = (
  outcome: Exclude<CloudTokenOutcome, { readonly status: "ok" }>,
  unavailable: string
): string => {
  const refusal = cloudTokenRefusal(outcome, unavailable)
  return refusal.code === "account_not_allowlisted" ? `${refusal.code} — ${refusal.message}` : refusal.message
}

/**
 * The one sentence for a pinned workspace Smithers Cloud no longer has, in the
 * same `<code> — <words>` shape the setup receipt's error already carries.
 */
export const WORKSPACE_GONE_REFUSAL = `workspace_gone — ${WORKER_REFUSAL_COPY.workspace_gone.lead}`

export type ProvisionOutcome =
  | { readonly status: "ready"; readonly record: GatewayRecord }
  | { readonly status: "provisioning"; readonly detail: string }
  | { readonly status: "no_capacity"; readonly detail: string }
  /*
   * The account is already holding every workspace it is allowed. A DIFFERENT
   * fact from `no_capacity`, about a different party: the fleet is fine, this
   * user's own cap is spent. The product answers the two in opposite voices
   * ("not your fault" vs "your boxes"), so folding them together tells a user
   * at their limit that the infrastructure failed them.
   */
  | { readonly status: "quota_exceeded"; readonly detail: string }
  | { readonly status: "plan_limit_exceeded"; readonly detail: string; readonly refusal: ReturnType<typeof machineReadableRefusal> }
  | { readonly status: "unavailable"; readonly detail: string; readonly retryable?: boolean }
  | { readonly status: "no_cloud_token"; readonly detail: string }
  /*
   * Wave 12 §4: the watched set is a GITHUB set, but a gateway needs a
   * Smithers Cloud repository. When the two don't coincide Cloud answers 404,
   * and that is a distinct, honest, un-retryable state — not the generic
   * "provisioning answered HTTP 404" the raw seam used to leak.
   */
  | { readonly status: "no_cloud_repo"; readonly detail: string }
  /*
   * The pinned workspace is gone from Cloud — deleted, or lost with its VM.
   * A DIFFERENT fact from `no_cloud_repo`: the repository is there and the box
   * is not, so an unbound caller may select a replacement instead of being
   * told its repository was never on Smithers Cloud.
   */
  | { readonly status: "workspace_gone"; readonly detail: string }
  /*
   * The workspace is there and is not serving yet: a resumed VM whose gateway
   * process has not bound its port, or a fresh box still booting. A DIFFERENT
   * fact from `unavailable`, which says an upstream failed us. Here nothing
   * failed and nothing refused; the answer is "not yet", and the caller's move
   * is to wait rather than to look for something broken.
   */
  | { readonly status: "workspace_starting"; readonly detail: string }

const NO_CAPACITY_DETAIL = "Smithers Cloud has no free workspace capacity right now — nothing was queued; try again in a bit."

/** Said only when Cloud refused for quota and wrote no message of its own. */
const QUOTA_EXCEEDED_DETAIL = "Smithers Cloud says this account is already at its workspace limit."

/**
 * The refusal `code` a failing provision names, read out of the bounded body
 * text. Smithers Cloud states which refusal this is in the body, not in the
 * status line — `503 {"code":"no_capacity","fault":"infra"}` for a full pool,
 * `429 {"code":"quota_exceeded"}` for an account at its own cap — so the code
 * is what the taxonomy turns on and the status is only a fallback.
 *
 * Matched in the text rather than parsed: the body is read to a ceiling
 * (`readBoundedResponseText`) and a long one arrives truncated, which no JSON
 * parser will accept. `code` is the first field in every shape seen live.
 */
const refusalCode = (detail: string): string | undefined => /"code"\s*:\s*"([A-Za-z0-9_.-]+)"/.exec(detail)?.[1]

/**
 * Provision-or-resume (§5): POST {cloud}/api/repos/{owner}/{repo}/gateway with
 * the user's Cloud token. Idempotent; on success ALWAYS adopt the returned
 * gateway_id/token/base_url. The taxonomy: 401 = the Cloud token was rejected
 * (the caller may re-mint and retry once), 409 = mid-provision (poll, don't
 * stampede), `no_capacity` = pool exhausted (surface honestly, never
 * retry-loop), `quota_exceeded` = this account's own cap.
 */
const provisionGateway = (
  repo: string,
  cloudToken: string,
  workspaceId: string,
  requiredCapability?: GatewayCapability
): Effect.Effect<ProvisionOutcome | { readonly status: "cloud_token_rejected" }, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const answered = yield* Effect.result(fetchWithDeadline(
      "Smithers Cloud",
      new URL(`/api/repos/${repo}/gateway`, config.cloudApiBaseUrl).toString(),
      {
        method: "POST",
        headers: { authorization: `Bearer ${cloudToken}`, "content-type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId,
          ...(requiredCapability === undefined ? {} : { required_capability: requiredCapability }) })
      },
      config.upstreamTimeoutMs
    ))
    if (Result.isFailure(answered)) {
      /*
       * A provision POST that never answers is not a dead end: the route is
       * idempotent, and Cloud may well still be building the sandbox behind
       * the silence. So a deadline lands in the seam's `provisioning` state —
       * the caller polls to its own bounded deadline and then says so — and
       * only a real connection failure is reported as unreachable. Either way
       * the request ANSWERS, which is the whole point.
       */
      if (answered.failure._tag === "UpstreamTimeout") {
        return {
          status: "provisioning",
          detail: `Smithers Cloud hasn't finished preparing the workspace for ${repo} yet — it took longer than ${
            answered.failure.timeoutMs
          }ms to answer.`
        } as const
      }
      return {
        status: "unavailable",
        retryable: true,
        detail: `Smithers Cloud is unreachable: ${failureMessage(answered.failure)}`
      } as const
    }
    const response = answered.success
    if (response.status === 401) {
      yield* discardBody(response)
      return { status: "cloud_token_rejected" } as const
    }
    if (response.status === 409) {
      const refusal = (yield* readJsonOrUndefined(response)) as { code?: unknown; message?: unknown } | undefined
      return {
        status: refusal?.code === "coding_host_unavailable" || refusal?.code === "coding_host_upgrade_required" ? "unavailable" : "provisioning",
        detail: typeof refusal?.message === "string" ? refusal.message : `The workspace for ${repo} is still being prepared.`
      } as const
    }
    if (response.status === 404) {
      /*
       * The route answers a workspace it no longer has with the same status as
       * a repository it never had, and states which one it means in the body's
       * code. A call that pinned a workspace and got plue's typed not-found is
       * reading a stale pin, not a repository outside Smithers Cloud.
       */
      const refusal = yield* readBoundedResponseText(response)
      if (refusalCode(refusal) === "not_found") {
        return { status: "workspace_gone", detail: WORKSPACE_GONE_REFUSAL } as const
      }
      return {
        status: "no_cloud_repo",
        detail: `${repo} isn't on Smithers Cloud yet, so there is no workspace to provision for it.`
      } as const
    }
    if (!response.ok) {
      const detail = yield* readBoundedResponseText(response)
      /*
       * The body's own `code` decides, and the status line is consulted only
       * when there is none. Smithers Cloud is moving the full-pool refusal
       * from `500 {"error":"no_capacity"}` to the honest
       * `503 {"code":"no_capacity","fault":"infra"}`; both are live at once,
       * so a classifier keyed on the status is wrong about one of them
       * whichever status it picks. Reading the code is right for both.
       */
      const code = refusalCode(detail)
      if (code === "plan_limit_exceeded") {
        return { status: "plan_limit_exceeded", detail: upstreamProse(detail) ?? "Your plan is at its sandbox limit.", refusal: machineReadableRefusal(detail) } as const
      }
      if (code === "quota_exceeded") {
        /*
         * The account's own cap, in Cloud's words: only Cloud knows what the
         * limit is and how much of it this user holds. Never NO_CAPACITY_DETAIL
         * — that sentence blames the fleet for a boundary the user set.
         */
        return { status: "quota_exceeded", detail: upstreamProse(detail) ?? QUOTA_EXCEEDED_DETAIL } as const
      }
      /*
       * `429 quota_exceeded / concurrent sandboxes limit reached` was caught
       * live on canary and is handled above. A 429 that names NO code is the
       * shape this seam has always read as the pool saying no, and stays it:
       * moving it under a user-fault sentence on no evidence would blame the
       * user for the fleet.
       */
      if (
        code === "no_capacity" ||
        (code === undefined && (response.status === 429 || (response.status === 500 && detail.includes("no_capacity"))))
      ) {
        return { status: "no_capacity", detail: NO_CAPACITY_DETAIL } as const
      }
      return {
        status: "unavailable",
        ...(response.status >= 500 ? { retryable: true } : {}),
        detail: upstreamRefusalMessage("The workspace gateway", response.status, detail)
      } as const
    }
    const body = (yield* readJsonOrUndefined(response)) as
      | {
        base_url?: unknown
        token?: unknown
        expires_at?: unknown
        gateway_id?: unknown
        vm_id?: unknown
        workspace_id?: unknown
      }
      | null
      | undefined
    if (
      body === undefined || body === null ||
      typeof body.base_url !== "string" ||
      typeof body.token !== "string" ||
      typeof body.gateway_id !== "string" ||
      typeof body.expires_at !== "string" ||
      body.workspace_id !== workspaceId
    ) {
      return { status: "unavailable", detail: "Provisioning answered in a shape the gateway seam did not understand." } as const
    }
    const expiresAt = Date.parse(body.expires_at)
    const now = yield* Clock.currentTimeMillis
    const row: GatewayRecordRow = {
      gatewayId: body.gateway_id,
      workspaceId,
      baseUrl: body.base_url,
      token: body.token,
      vmId: typeof body.vm_id === "string" ? body.vm_id : null,
      // §5: expires_at is a re-resolve cadence, not a credential lifetime.
      // Re-call at the midpoint of the issued window (half-life), with a sane
      // floor so a bogus upstream timestamp cannot spin the provision loop.
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + 60 * 60 * 1000,
      renewAfter: Number.isFinite(expiresAt) ? now + Math.max((expiresAt - now) / 2, 60 * 1000) : now + 30 * 60 * 1000,
      provisionedAt: now,
      ...(requiredCapability === undefined ? {} : { verifiedCapabilities: [requiredCapability] })
    }
    const record = gatewayRecordFrom(config.cloudApiBaseUrl, row)
    if (record === undefined) {
      const address = URL.canParse(body.base_url) ? new URL(body.base_url) : undefined
      logSeamFailure("gateway provision", `gateway ${JSON.stringify(body.gateway_id)} answered base_url ${
        address === undefined ? "that is not a URL" : JSON.stringify(address.origin + address.pathname)
      }, outside ${new URL(config.cloudApiBaseUrl).origin}/api/gateways/<gateway_id>`)
      return { status: "unavailable", detail: "Smithers Cloud answered with a gateway address outside its own origin." } as const
    }
    return { status: "ready", record } as const
  })

/**
 * Resolve the caller's gateway for a repo through the owning Durable Object:
 * a cached record inside its half-life window answers directly; anything else
 * re-provisions (the §5 renew contract) and adopts whatever comes back.
 * Concurrent cold or expired misses join ONE resolution inside the registry
 * instead of each stampeding the token door and the provision route.
 */
export const ensureGateway = (
  login: string,
  repo: string,
  force: GatewayRefresh,
  workspaceId: string,
  requiredCapability?: GatewayCapability
): Effect.Effect<ProvisionOutcome, never, GatewaySessions> =>
  Effect.gen(function* () {
    // The routes refuse a malformed repo before reaching here; the seam refuses
    // it again so no caller can spend the Cloud token on an unintended path.
    if (!isRelayRepoName(repo) || !isGatewayWorkspaceId(workspaceId)) {
      return { status: "unavailable", detail: `${repo} is not a repository this seam can address.` } as const
    }
    const sessions = yield* GatewaySessions
    return yield* sessions.resolve(login, repo, workspaceId, force, requiredCapability)
  })

/** The token door, the provision POST, and exactly one re-mint on a 401 (the registry's leader runs this). */
const provisionWithRemint = (
  login: string,
  repo: string,
  workspaceId: string,
  requiredCapability?: GatewayCapability
): Effect.Effect<ProvisionOutcome, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const cloudToken = yield* fetchCloudToken(login)
    if (cloudToken.status !== "ok") {
      if (cloudToken.status === "not_found" || cloudToken.status === "not_eligible") {
        return { status: "no_cloud_token", detail: cloudToken.detail } as const
      }
      return { status: "unavailable", detail: cloudToken.detail } as const
    }
    const first = yield* provisionGateway(repo, cloudToken.token, workspaceId, requiredCapability)
    if (first.status !== "cloud_token_rejected") return first
    // The vaulted Cloud token was rejected (plue-side expiry/revocation): the
    // door re-exchanges from the vaulted GitHub token, so one fresh mint may
    // legitimately succeed. More than one retry would be a loop.
    const reminted = yield* fetchCloudToken(login)
    if (reminted.status !== "ok") {
      return reminted.status === "not_found" || reminted.status === "not_eligible"
        ? { status: "no_cloud_token", detail: reminted.detail } as const
        : { status: "unavailable", detail: reminted.detail } as const
    }
    const second = yield* provisionGateway(repo, reminted.token, workspaceId, requiredCapability)
    if (second.status === "cloud_token_rejected") {
      return { status: "unavailable", detail: "Smithers Cloud rejected a freshly minted identity token." } as const
    }
    return second
  })

/*
 * A relay answer that is the TUNNEL failing, not the engine answering. §5: a
 * workspace VM idle-suspends after 30 minutes and the gateway row stays
 * `running`, so the relay keeps accepting the call and then cannot reach
 * anything behind it — proven live on canary, where every call to a resumed-
 * hours-ago gateway came back as a Cloudflare 502 and the run card sat in
 * "reconnecting" until the record aged out. Re-POSTing the provision route is
 * what resumes the VM, so this is stale state, not a dead end.
 */
const isTunnelFailure = (status: number): boolean => status === 502 || status === 503 || status === 504

// The authenticated API rejects a sleeping workspace before forwarding the
// call. Its two exact conflicts invalidate a cached gateway; an application
// conflict must remain untouched and must never cause a command replay.
const isSleepingGateway = (response: Response): Effect.Effect<boolean> =>
  response.status !== 409 ? Effect.succeed(false) : readJsonOrUndefined(response.clone()).pipe(
    Effect.map((body) => typeof body === "object" && body !== null &&
      "code" in body && body.code === "conflict" && "message" in body &&
      (body.message === "repo gateway is not running" || body.message === "bound workspace is not running at the recorded VM"))
  )

// The same API rejects a call bound to a workspace it no longer has before the
// workspace's own host sees the frame. Only Cloud says `not_found`; a host
// behind the relay calls its own missing address `route_not_found`, so the
// code alone tells a dead binding from an answer the engine gave.
const isWorkspaceGone = (response: Response): Effect.Effect<boolean> =>
  response.status !== 404 ? Effect.succeed(false) : readJsonOrUndefined(response.clone()).pipe(
    Effect.map((body) => typeof body === "object" && body !== null && "code" in body && body.code === "not_found")
  )

/**
 * How long a freshly minted record is trusted before another tunnel failure may
 * force a second re-provision. Without it an EventSource that reconnects every
 * few seconds would stampede the provision route — exactly what §5 forbids.
 */
const FORCED_REPROVISION_FLOOR_MS = 30_000

/**
 * The gateway mounts the relay may address. Nothing else is reachable, so a
 * path assembled from anything the browser sent can never aim the user's
 * server-held credential somewhere this seam never allowlisted.
 */
export const GATEWAY_RELAY_PATHS: ReadonlyArray<string> = ["/rpc", "/projections", "/health"]

export type GatewayCallOutcome =
  | { readonly status: "ok"; readonly response: Response }
  | { readonly status: "unknown_outcome"; readonly detail: string }
  | { readonly status: "provisioning"; readonly detail: string }
  | { readonly status: "no_capacity"; readonly detail: string }
  | { readonly status: "quota_exceeded"; readonly detail: string }
  | { readonly status: "plan_limit_exceeded"; readonly detail: string; readonly refusal: ReturnType<typeof machineReadableRefusal> }
  | { readonly status: "no_cloud_token"; readonly detail: string }
  | { readonly status: "no_cloud_repo"; readonly detail: string }
  | { readonly status: "workspace_gone"; readonly detail: string }
  | { readonly status: "workspace_starting"; readonly detail: string }
  | { readonly status: "unavailable"; readonly detail: string }

export interface GatewayCallInit {
  readonly method: string
  readonly body?: unknown
  /** A body forwarded byte for byte, for the RPC mounts. */
  readonly text?: string
  readonly headers?: Record<string, string>
  /** Whether this call may be replayed after an ambiguous transport or tunnel failure. */
  readonly replayable?: boolean
  readonly workspaceId: string
  readonly requiredCapability?: GatewayCapability
}

/** One relay attempt; a failure is the sentence stating why, never swallowed. */
const relayAttempt = (
  record: GatewayRecord,
  path: string,
  init: GatewayCallInit
): Effect.Effect<Result.Result<Response, string>, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    // The address is a path base: URL-joining an absolute path would drop it.
    return yield* fetchWithDeadline(
      "The workspace gateway",
      `${record.baseUrl}${path}`,
      {
        method: init.method,
        headers: {
          authorization: `Bearer ${record.token}`,
          ...(init.body === undefined && init.text === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers
        },
        ...(init.text === undefined
          ? init.body === undefined ? {} : { body: JSON.stringify(init.body) }
          : { body: init.text })
      },
      config.upstreamTimeoutMs
    )
  }).pipe(
    Effect.map((response) => Result.succeed(response)),
    Effect.catch((failure) => Effect.succeed(Result.fail(failureMessage(failure))))
  )

const unreachable = (reason: string | undefined): GatewayCallOutcome => ({
  status: "unavailable",
  detail: `The workspace gateway is unreachable${reason === undefined ? "." : `: ${reason}`}`
})

/**
 * Call the per-user gateway through the relay: the Worker holds the token and
 * sets the Authorization header (a browser never can). A 401 from the relay
 * forces a re-provision and retries exactly once (§5: the VM can be
 * reprovisioned under a live token; the fresh record is always adopted).
 */
export const callGateway = (
  login: string,
  repo: string,
  path: string,
  init: GatewayCallInit
): Effect.Effect<GatewayCallOutcome, never, Transport | ServerConfig | GatewaySessions> =>
  Effect.gen(function* () {
    // The relay addresses the gateway's own mounts and nothing else. Without
    // this, a path assembled from anything the browser sent would aim the
    // user's server-held credential wherever that string pointed.
    if (!GATEWAY_RELAY_PATHS.includes(path)) {
      return { status: "unavailable", detail: `${path} is not a gateway path this seam relays.` } as const
    }
    const gateway = yield* ensureGateway(login, repo, false, init.workspaceId, init.requiredCapability)
    if (gateway.status !== "ready") return gateway
    const first = yield* relayAttempt(gateway.record, path, init)
    // A binding Cloud has disowned is not stale caching: re-POSTing the
    // provision route cannot conjure the workspace back, so the call ends here.
    if (Result.isSuccess(first) && (yield* isWorkspaceGone(first.success))) {
      yield* discardBody(first.success)
      return { status: "workspace_gone", detail: WORKSPACE_GONE_REFUSAL } as const
    }
    /*
     * Three things force exactly ONE re-provision, all from §5: a 401 (the VM
     * was reprovisioned under a live token), an unreachable base_url, and a
     * relay tunnel failure (the VM idle-suspended or was recycled behind a row
     * that still reads `running`). Either way the cached record is stale and
     * the fresh one is adopted — "never cache the token past a gateway_id
     * change". One retry, never a loop.
     */
    const lost = Result.isFailure(first)
    const tunnelFailed = Result.isSuccess(first) && isTunnelFailure(first.success.status)
    const sleeping = Result.isSuccess(first) && (yield* isSleepingGateway(first.success))
    if (!lost && first.success.status !== 401 && !tunnelFailed && !sleeping) return { status: "ok", response: first.success } as const
    // A record minted moments ago has already had its chance: re-POSTing
    // again cannot resume anything and would only stampede the route.
    const now = yield* Clock.currentTimeMillis
    if ((tunnelFailed && now - gateway.record.provisionedAt < FORCED_REPROVISION_FLOOR_MS) ||
      (sleeping && resumeCoolingDown(gateway.record, now))) {
      return { status: "ok", response: first.success } as const
    }
    if (Result.isSuccess(first)) yield* discardBody(first.success)
    const renewed = yield* ensureGateway(login, repo, sleeping ? "sleeping" : true, init.workspaceId, init.requiredCapability)
    // Losing the headers does not establish whether the command was accepted.
    // Renew for subsequent callers, but preserve that uncertainty even if
    // renewal fails: its outcome says nothing about the original command.
    if (Result.isFailure(first) && init.replayable === false) {
      return {
        status: "unknown_outcome",
        detail: `The workspace command may have been accepted, but its response was lost. It was not replayed: ${first.failure}`
      } as const
    }
    if (renewed.status !== "ready") return renewed
    /*
     * A tunnel failure can also mean the engine took the write and only the
     * answer was lost, so a call that a repeat could duplicate is NOT
     * replayed: the gateway is resumed for the next one and this attempt is
     * reported as what it was.
     */
    if ((tunnelFailed || sleeping) && init.replayable === false) {
      /*
       * Not `unavailable`: under that status the person reads "Something
       * Smithers depends on refused that", and nothing refused anything — the
       * box was asleep and is on its way back.
       */
      return {
        status: "workspace_starting",
        detail: "Your workspace had gone to sleep. It is starting back up; ask me once more in a moment."
      } as const
    }
    const second = yield* relayAttempt(renewed.record, path, init)
    if (Result.isFailure(second)) return unreachable(second.failure)
    return { status: "ok", response: second.success } as const
  })

/**
 * How long the seam waits for a gateway to say it is serving.
 *
 * Its own budget, not `upstreamTimeoutMs`: a live gateway answers `/health`
 * immediately, and this question is asked on the path a person is waiting on.
 * A box that needs longer than this to answer is not "ready" for the purpose
 * of the question, whatever it turns out to be doing.
 */
const GATEWAY_LIVENESS_DEADLINE_MS = 5_000

/** What the gateway said about itself: serving, not serving yet, or disowned by Cloud. */
type GatewayLiveness = "live" | "starting" | "gone"

/*
 * The sentence for a workspace that is coming up. It names the wait and
 * nothing else — the refusal copy for `workspace_starting` supplies how long.
 */
const WORKSPACE_STARTING_DETAIL = "Your workspace isn't answering yet."

/**
 * Ask the gateway whether it is serving.
 *
 * `/health` through the relay, with the record's own credential, bounded. The
 * three signals that mean "not this box, not yet" are the same three
 * `callGateway` re-provisions on — a 401, a tunnel failure, and the
 * authenticated API's sleeping conflict — plus a transport failure, because a
 * suspended VM's port refuses rather than answering.
 */
const gatewayIsServing = (record: GatewayRecord): Effect.Effect<GatewayLiveness, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const answered = yield* Effect.result(fetchWithDeadline(
      "The workspace gateway",
      `${record.baseUrl}/health`,
      { method: "GET", headers: { authorization: `Bearer ${record.token}` } },
      Math.min(config.upstreamTimeoutMs, GATEWAY_LIVENESS_DEADLINE_MS)
    ))
    if (Result.isFailure(answered)) return "starting"
    const response = answered.success
    if (yield* isWorkspaceGone(response)) {
      yield* discardBody(response)
      return "gone"
    }
    const sleeping = yield* isSleepingGateway(response)
    yield* discardBody(response)
    return response.ok && !sleeping ? "live" : "starting"
  })

/**
 * The readiness question, answered by the gateway instead of by the record.
 *
 * `ensureGateway` answers a cached record inside its half-life without asking
 * anyone, which is right for a relay call (the call itself finds out) and
 * wrong for the one route whose entire answer is the word "ready": a suspend
 * writes nothing to that record, so for the rest of the half-life the seam
 * reported the PRE-SUSPEND state — measured on canary as `ready` in 0s while
 * the gateway was down for ~3 minutes, followed by rpc timeouts.
 *
 * So `ready` here means the gateway answered. Anything else is
 * `workspace_starting` (or whatever Cloud said instead), and the caller waits
 * — which is what it already does with `provisioning`, and cannot do with a
 * `ready` that is not true.
 */
export const ensureGatewayReady = (
  login: string,
  repo: string,
  workspaceId: string
): Effect.Effect<ProvisionOutcome, never, GatewaySessions | Transport | ServerConfig> =>
  Effect.gen(function* () {
    const held = yield* ensureGateway(login, repo, false, workspaceId)
    if (held.status !== "ready") return held
    const serving = yield* gatewayIsServing(held.record)
    if (serving === "live") return held
    if (serving === "gone") return { status: "workspace_gone", detail: WORKSPACE_GONE_REFUSAL } as const
    const now = yield* Clock.currentTimeMillis
    // §5 again: a record minted moments ago has already had its provision, so
    // a second POST cannot wake anything sooner and would stampede the route.
    // The honest answer is the wait, and the next poll is the one that asks.
    if (now - held.record.provisionedAt < FORCED_REPROVISION_FLOOR_MS) {
      return { status: "workspace_starting", detail: WORKSPACE_STARTING_DETAIL } as const
    }
    const woken = yield* ensureGateway(login, repo, "sleeping", workspaceId)
    if (woken.status !== "ready") return woken
    // Smithers Cloud probes the gateway's own /health before it hands back a
    // record (plue internal/services/repo_gateway.go), so this second ask is
    // usually a formality. It is asked anyway, because the rule is that
    // `ready` means this seam heard the gateway, with no exception for a
    // record that looks fresh — that exception is the bug.
    return (yield* gatewayIsServing(woken.record)) === "live"
      ? woken
      : { status: "workspace_starting", detail: WORKSPACE_STARTING_DETAIL } as const
  })
