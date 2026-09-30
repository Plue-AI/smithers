import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import {
  ADMIN_ERRORS_PATH,
  ADMIN_GRANT_PATH,
  ADMIN_HEALTH_PATH,
  ADMIN_RECOMMEND_LOG_PATH
} from "@smthrs/rpc/AgentApiRoutes"
import { ClientErrors } from "./clientErrorLog"
import { ServerConfig } from "./Config"
import type { ServerConfigShape } from "./Config"
import { DeploymentBindings } from "./Environment"
import type { UpstreamFailure } from "./Failures"
import { discardBody, fetchWithDeadline, readJsonOrUndefined, readText } from "./Http"
import type { Transport } from "./Http"
import { validateSession } from "./identity"
import { readRecommendLog } from "./recommend"
import type { RecommendLogStore } from "./recommend"
import { causeMessage, ISOLATION_HEADERS, json, notConfigured, notFound, readBody, refuse, upstreamUnreachable } from "./Responses"

/*
 * The admin plugin's server half (Launch Checklist §E). Every /api/admin/*
 * route FIRST validates the session through identity and requires
 * admin:true; anything else gets the canonical 404,
 * byte-identical to an unknown route. Admin writes carry their audit
 * attribution at write time: requester is the admin's own validated login and
 * the timestamp is fresh — the siblings refuse unattributed writes by contract.
 */

/** Maximum credit issued by one confirmed grant. */
export const ADMIN_GRANT_MAX_USD = 100

/** Forward an admin upstream call, passing the upstream status and body through verbatim. */
const forwardAdminCall = (
  upstream: string,
  path: string,
  adminToken: string,
  init: { readonly method: string; readonly body?: unknown },
  timeoutMs: number
): Effect.Effect<Response, never, Transport> =>
  Effect.gen(function* () {
    const headers: Record<string, string> = { "x-smithers-admin-token": adminToken }
    if (init.body !== undefined) headers["content-type"] = "application/json"
    const fetched = yield* Effect.result(
      fetchWithDeadline(
        "The admin upstream",
        new URL(path, upstream).toString(),
        {
          method: init.method,
          headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
        },
        timeoutMs
      )
    )
    if (Result.isFailure(fetched)) return upstreamUnreachable("The admin upstream", fetched.failure)
    const response = fetched.success
    const text = yield* readText(response).pipe(Effect.catch(() => Effect.succeed("")))
    return new Response(text, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json", ...ISOLATION_HEADERS }
    })
  })

const adminTokenNotConfigured = (name: string, envName: string): Response =>
  notConfigured(name, `${envName} is unset. The admin surface is unavailable on this deployment`)

interface AdminServiceHealth {
  readonly name: string
  readonly status: "ok" | "failed" | "unconfigured"
  readonly detail: string
}

/** One honest per-service line for admin.health — a real healthz read or the truth about why not. */
const readServiceHealth = (
  name: string,
  upstream: string | undefined,
  envName: string,
  summarize: (body: Record<string, unknown>) => string,
  timeoutMs: number
): Effect.Effect<AdminServiceHealth, never, Transport> =>
  Effect.gen(function* () {
    if (upstream === undefined) {
      return { name, status: "unconfigured", detail: `${envName} is unset on this deployment.` } as const
    }
    const fetched = yield* Effect.result(
      fetchWithDeadline(name, new URL("/healthz", upstream).toString(), undefined, timeoutMs)
    )
    if (Result.isFailure(fetched)) {
      const failure: UpstreamFailure = fetched.failure
      return {
        name,
        status: "failed",
        detail: failure._tag === "UpstreamTimeout" ? failure.message : `unreachable: ${causeMessage(failure.cause)}`
      } as const
    }
    const response = fetched.success
    if (!response.ok) {
      yield* discardBody(response)
      return { name, status: "failed", detail: `healthz answered HTTP ${response.status}.` } as const
    }
    const body = (yield* readJsonOrUndefined(response)) as Record<string, unknown> | undefined
    if (body === undefined || typeof body !== "object" || body === null) {
      return { name, status: "failed", detail: "healthz did not return JSON." } as const
    }
    if (body.ok !== true) return { name, status: "failed", detail: "healthz reported not ok." } as const
    return { name, status: "ok", detail: summarize(body) } as const
  })

interface ChargeSummary {
  readonly chargeCount: number
  readonly lifetimeChargedUsd: string
  readonly scope: string
  readonly scopeDetail: string
}

/*
 * Recent charges: the billing ledger's own totals, read with the account
 * bearer — which authenticates the DEPLOYMENT's billing account, not the
 * fleet. Since wave 13 a signed-in user's turn is metered onto that user's
 * own account, so this figure stopped moving and is smaller than a single
 * active user's (repro apps/app/canary-repros/admin/25.7). Billing keeps one
 * Durable Object per login with no enumeration, so no fleet total can be
 * read from here at all; the answer therefore STATES its scope instead of
 * presenting a deployment figure as a fleet one.
 */
const readCharges = (config: ServerConfigShape, proxyOrigin: string): Effect.Effect<ChargeSummary | null, never, Transport> =>
  Effect.gen(function* () {
    if (config.billingUpstreamUrl === undefined || config.billingAuthToken === undefined) return null
    // Billing refuses a request that carries no Origin, so the read states
    // this Worker's own — the same seam discipline as the billing proxy.
    const balance = yield* fetchWithDeadline(
      "billing",
      new URL("/api/billing/balance", config.billingUpstreamUrl).toString(),
      { headers: { authorization: `Bearer ${Redacted.value(config.billingAuthToken)}`, origin: proxyOrigin } },
      config.upstreamTimeoutMs
    )
    if (!balance.ok) {
      yield* discardBody(balance)
      return null
    }
    const body = (yield* readJsonOrUndefined(balance)) as {
      balance?: { chargeCount?: unknown; lifetimeChargedUsd?: unknown }
    } | undefined
    if (typeof body?.balance?.chargeCount !== "number" || typeof body.balance.lifetimeChargedUsd !== "string") return null
    return {
      chargeCount: body.balance.chargeCount,
      lifetimeChargedUsd: body.balance.lifetimeChargedUsd,
      scope: "deployment-account",
      scopeDetail:
        "charge rows on the deployment's own billing account. Signed-in users' turns meter onto their own accounts, so this is not a fleet total and it is not a turn count."
    }
  }).pipe(
    // charges stays null — the card says "no charge read" rather than inventing one.
    Effect.catch(() => Effect.succeed(null))
  )

/**
 * "What failed overnight?" v1: compose the health card's facts from real
 * reads — each sibling's /healthz and the billing ledger's charge totals.
 * A service that cannot be read says so; nothing is invented. The three
 * reads run together.
 */
const handleAdminHealth = (proxyOrigin: string): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const summarize = (...fields: ReadonlyArray<string>) => (body: Record<string, unknown>): string => {
      const parts = fields
        .filter((field) => body[field] !== undefined)
        .map((field) => `${field}: ${JSON.stringify(body[field])}`)
      return parts.length === 0 ? "healthz ok." : `healthz ok — ${parts.join(" · ")}`
    }
    const { billing, identity, charges } = yield* Effect.all(
      {
        billing: readServiceHealth(
          "billing",
          config.billingUpstreamUrl,
          "BILLING_UPSTREAM_URL",
          summarize("rateCardVersion", "resources", "unpricedActiveResources"),
          config.upstreamTimeoutMs
        ),
        identity: readServiceHealth(
          "identity",
          config.identityUpstreamUrl,
          "IDENTITY_UPSTREAM_URL",
          summarize("requestedScopes", "admin", "serviceToken"),
          config.upstreamTimeoutMs
        ),
        charges: readCharges(config, proxyOrigin)
      },
      { concurrency: "unbounded" }
    )
    return json(200, {
      services: [billing, identity],
      charges,
      checkedAt: new Date().toISOString()
    })
  })

/** The caller-owned idempotency key of one confirmed grant: the UI sends its confirmation card id. */
const GRANT_OPERATION_KEY = /^[A-Za-z0-9_-]{8,64}$/
const GRANT_OPERATION_KEY_GRAMMAR = "of 8 to 64 letters, digits, '_' or '-'"
const grantIdOf = (operationKey: string): string => `admin:product-${operationKey}`

/**
 * Read one grant from the recipient's ledger, keyed by the grant id billing
 * dedups on. This is the trusted-caller balance read (service token +
 * x-user-login, see proxyToBilling), so it needs BILLING_PRODUCT_SERVICE_TOKEN.
 * Returns the credit row, undefined when absent, or the refusal to send.
 */
const readAdminGrant = (
  config: ServerConfigShape,
  upstream: string,
  proxyOrigin: string,
  login: string,
  grantId: string
): Effect.Effect<Record<string, unknown> | undefined | Response, never, Transport> =>
  Effect.gen(function* () {
    if (config.billingProductServiceToken === undefined) {
      return notConfigured(
        "Credit grants",
        "BILLING_PRODUCT_SERVICE_TOKEN is unset. A grant is checked against the recipient's ledger before it posts, and that read needs the trusted-caller token"
      )
    }
    const fetched = yield* Effect.result(
      fetchWithDeadline(
        "The billing service",
        new URL("/api/billing/balance", upstream).toString(),
        {
          headers: {
            "x-smithers-service-token": Redacted.value(config.billingProductServiceToken),
            "x-user-login": login,
            "x-user-id": login,
            "x-user-role": "member",
            origin: proxyOrigin
          }
        },
        config.upstreamTimeoutMs
      )
    )
    if (Result.isFailure(fetched)) return upstreamUnreachable("The billing service", fetched.failure)
    const response = fetched.success
    if (!response.ok) {
      yield* discardBody(response)
      return refuse(
        "upstream_refused",
        `The billing service refused the ledger read for ${login} (HTTP ${response.status}), so the grant was not posted.`
      )
    }
    const ledger = (yield* readJsonOrUndefined(response)) as { credits?: unknown } | undefined
    const credits = Array.isArray(ledger?.credits) ? ledger.credits : []
    return credits.find((credit): credit is Record<string, unknown> =>
      typeof credit === "object" && credit !== null && (credit as { id?: unknown }).id === grantId)
  })

const parseAdminBody = (request: Request): Effect.Effect<Record<string, unknown> | Response> =>
  Effect.map(readBody(request), (body) => {
    if (body instanceof Response) return body
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return refuse("request_invalid", "Body must be a JSON object.")
    }
    return body as Record<string, unknown>
  })

const readLimit = (url: URL): number | undefined => {
  const asked = Number(url.searchParams.get("limit") ?? "")
  return Number.isInteger(asked) && asked > 0 ? asked : undefined
}

/** The admin claim alone decides the admin surface; a signed-in non-admin gets the canonical 404. */
export const handleAdmin = (
  request: Request,
  url: URL
): Effect.Effect<Response, never, Transport | ServerConfig | ClientErrors | RecommendLogStore | DeploymentBindings> =>
  Effect.gen(function* () {
    const validation = yield* validateSession(request)
    if (validation.status === "unavailable") return validation.response
    if (validation.status === "invalid") return notFound()
    const session = validation.identity
    if (!session.admin) return notFound()
    const config = yield* ServerConfig

    if (url.pathname === ADMIN_GRANT_PATH && request.method === "GET") {
      if (config.billingUpstreamUrl === undefined) {
        return notConfigured("Credit grants", "BILLING_UPSTREAM_URL is unset. Grants are unavailable")
      }
      const login = url.searchParams.get("login")?.trim() ?? ""
      const operationKey = url.searchParams.get("operationKey") ?? ""
      if (login === "" || !GRANT_OPERATION_KEY.test(operationKey)) {
        return refuse("request_invalid", `Query must carry login and operationKey ${GRANT_OPERATION_KEY_GRAMMAR}.`)
      }
      const grantId = grantIdOf(operationKey)
      const existing = yield* readAdminGrant(config, config.billingUpstreamUrl, url.origin, login, grantId)
      if (existing instanceof Response) return existing
      return json(200, existing === undefined
        ? { found: false, grantId, userId: login }
        : { found: true, grantId, userId: login, grant: existing })
    }

    if (url.pathname === ADMIN_GRANT_PATH && request.method === "POST") {
      if (config.billingUpstreamUrl === undefined) {
        return notConfigured("Credit grants", "BILLING_UPSTREAM_URL is unset. Grants are unavailable")
      }
      if (config.billingAdminToken === undefined) {
        return adminTokenNotConfigured("The billing admin page", "BILLING_ADMIN_TOKEN")
      }
      const body = yield* parseAdminBody(request)
      if (body instanceof Response) return body
      const login = typeof body.login === "string" ? body.login.trim() : ""
      const amountUsd = typeof body.amountUsd === "number" ? body.amountUsd : Number.NaN
      const operationKey = typeof body.operationKey === "string" ? body.operationKey : ""
      if (login === "" || !Number.isFinite(amountUsd) || amountUsd <= 0 || !GRANT_OPERATION_KEY.test(operationKey)) {
        return refuse(
          "request_invalid",
          `Body must be { login, amountUsd, operationKey } with a positive dollar amount and an operationKey ${GRANT_OPERATION_KEY_GRAMMAR}.`
        )
      }
      if (amountUsd > ADMIN_GRANT_MAX_USD) return refuse("request_invalid", `One grant credits at most $${ADMIN_GRANT_MAX_USD}.`)
      /*
       * The grant id is derived from the caller's operation key, never minted
       * here: a confirmation retried after a lost billing response carries the
       * same key, so billing deduplicates it by grantId instead of crediting a
       * second time (review app-server/api-design/1). The recipient's ledger is
       * read first so a key reused for a different amount, or by a different
       * admin, is refused instead of silently answering with the old credit.
       * Without the trusted-caller token that read cannot happen; the stable
       * grant id alone still keeps a retry from crediting twice, so the grant
       * posts and only the conflict check is skipped.
       */
      const grantId = grantIdOf(operationKey)
      const existing = config.billingProductServiceToken === undefined
        ? undefined
        : yield* readAdminGrant(config, config.billingUpstreamUrl, url.origin, login, grantId)
      if (existing instanceof Response) return existing
      if (existing !== undefined) {
        const grantedUsd = typeof existing.grantedUsd === "string" ? Number(existing.grantedUsd) : Number.NaN
        const sameAmount = Number.isFinite(grantedUsd) && Math.abs(grantedUsd - amountUsd) < 0.005
        const sameRequester = existing.requestedBy === session.login
        if (!sameAmount || !sameRequester) {
          return refuse(
            "request_conflict",
            `Operation ${operationKey} already granted $${Number.isFinite(grantedUsd) ? grantedUsd.toFixed(2) : "?"} to ${login}` +
              ` (requested by ${typeof existing.requestedBy === "string" ? existing.requestedBy : "unknown"}).` +
              " Start a new grant for a different amount instead of reusing this confirmation."
          )
        }
        return json(200, { granted: true, duplicate: true, grantId, userId: login, grant: existing })
      }
      const response = yield* forwardAdminCall(
        config.billingUpstreamUrl,
        "/api/billing/admin/grants",
        Redacted.value(config.billingAdminToken),
        {
          method: "POST",
          body: {
            userId: login,
            grantId,
            amountUsd,
            kind: "promotional",
            requester: session.login,
            timestamp: new Date().toISOString()
          }
        },
        config.upstreamTimeoutMs
      )
      console.log(JSON.stringify({ event: "admin_grant", requester: session.login, userId: login, amountUsd, grantId, status: response.status }))
      return response
    }

    if (url.pathname === ADMIN_HEALTH_PATH && request.method === "GET") {
      return yield* handleAdminHealth(url.origin)
    }

    // The client-error log, newest first. No upstream and no admin token: the
    // reports are this Worker's own state, so this is a local read, and it
    // answers an empty log honestly rather than 404ing when nothing has broken.
    if (url.pathname === ADMIN_ERRORS_PATH && request.method === "GET") {
      const bindings = yield* DeploymentBindings
      const errors = yield* ClientErrors
      const log = yield* errors.page(readLimit(url))
      return json(200, {
        status: "ok",
        total: log.total,
        reports: log.reports,
        ...(log.note === undefined ? {} : { note: log.note }),
        ...(bindings.clientErrors
          ? {}
          : { note: "No CLIENT_ERRORS binding on this deployment: nothing is stored, so this log is always empty." })
      })
    }

    // The recommendation log, newest first: what the recommender said and what
    // the user ran next. The scorer reads it; nothing here holds chat text.
    if (url.pathname === ADMIN_RECOMMEND_LOG_PATH && request.method === "GET") {
      const bindings = yield* DeploymentBindings
      const rows = yield* readRecommendLog(readLimit(url))
      return json(200, {
        status: "ok",
        rows,
        ...(bindings.recommendLog
          ? {}
          : { note: "No RECOMMEND_LOG binding on this deployment: nothing is stored, so this log is always empty." })
      })
    }

    // An admin-only path this Worker does not implement is still just not found.
    return notFound()
  })
