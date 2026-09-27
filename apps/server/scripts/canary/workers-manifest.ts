/* Active dependencies of the shared application edge. Retired authority hosts
 * stay reserved below; the cutover gate verifies their fences separately. */

/** @see BACKING_WORKERS for which Worker carries which contract. */
/**
 * status-ok-json is Plue's /healthz (packages/backend/internal/routes/healthz.go):
 * HTTP 200, `status: "ok"`, and every entry of `checks` "ok". application-bootstrap
 * is the shared backend's canonical `/api/bootstrap` contract.
 */
export type HealthContract = "ok-json" | "status-ok-json" | "responds" | "application-bootstrap"

export interface BackingWorker {
  readonly name: string
  /**
   * undefined means this deployment declares the Worker unset. That is a
   * state, not a failure — the same honesty canary-seam-probe.ts applies to
   * the deliberately-unset gateway seam, where a 501 is the PASS shape.
   */
  readonly origin: string | undefined
  /**
   * The other routes this product configures for the same seam. identity
   * answers on both a custom domain and a workers.dev subdomain, and
   * apps/server/wrangler.jsonc points at the workers.dev one; the canary's
   * chat upstream is a separate deployment of the chat Worker entirely. Probing
   * only the custom domain would report a green CN-18 while the route the
   * product actually calls was dead. Each alternate carries its Worker's
   * contract.
   */
  readonly alternateOrigins: ReadonlyArray<string>
  /** Health path, joined onto the origin. "/" for a Worker with no health route. */
  readonly path: string
  readonly contract: HealthContract
  /** Why this Worker carries this contract. Printed with its result. */
  readonly note: string
}

const DEPLOYED_SERVICES: ReadonlyArray<BackingWorker> = [
  {
    name: "application",
    origin: "https://api.jjhub.tech",
    alternateOrigins: [],
    path: "/api/bootstrap",
    contract: "application-bootstrap",
    note: "canonical shared application backend; SMITHERS_BACKEND_ORIGIN"
  },
  {
    name: "identity",
    origin: "https://identity.smithers.sh",
    alternateOrigins: ["https://smithers-cloud-identity.willcory10.workers.dev"],
    path: "/healthz",
    contract: "ok-json",
    note: "GitHub OAuth, sessions, the allowlist; IDENTITY_UPSTREAM_URL"
  },
  {
    name: "billing",
    origin: "https://billing.smithers.sh",
    alternateOrigins: [],
    path: "/healthz",
    contract: "ok-json",
    note: "balances, grants, the admin grant surface; BILLING_UPSTREAM_URL"
  },
  {
    name: "chat",
    origin: "https://chat.smithers.sh",
    alternateOrigins: ["https://smithers-cloud-chat-canary.willcory10.workers.dev"],
    path: "/",
    contract: "responds",
    note:
      "the metered turn upstream (SMITHERS_CHAT_URL); no health route — / answers 404 with the Worker's own \"Not found\", and /chat is origin-gated, so a Worker-authored body is the whole assertion"
  },
  {
    name: "connectors-catalog",
    origin: "https://connectors.smithers.sh",
    alternateOrigins: [],
    path: "/healthz",
    contract: "ok-json",
    note: "the connector catalog; not called by apps/server today"
  },
  {
    name: "cron",
    origin: "https://cron-schedules.smithers.sh",
    alternateOrigins: [],
    path: "/",
    contract: "responds",
    note:
      "scheduled triggers; no health route and every path is origin-gated (403 without an allowed Origin), so routability is the whole assertion"
  },
  {
    name: "status",
    origin: "https://status.smithers.sh",
    alternateOrigins: [],
    path: "/healthz",
    contract: "ok-json",
    note: "the public status page, Worker smithers-cloud-status"
  },
  {
    name: "sync",
    origin: "https://sync.smithers.sh",
    alternateOrigins: [],
    path: "/health",
    contract: "ok-json",
    note: "durable-object backed sync; note /health, not /healthz — /healthz is a 404 here"
  },
  {
    name: "webhooks",
    origin: "https://webhooks.smithers.sh",
    alternateOrigins: [],
    path: "/",
    contract: "responds",
    note:
      "inbound webhooks; no health route and every path is origin-gated (403 without an allowed Origin), so routability is the whole assertion"
  }
]

const activeNames = new Set(["application", "connectors-catalog", "status"])
export const BACKING_WORKERS = DEPLOYED_SERVICES.filter(service => activeNames.has(service.name))
/** Reserved host ownership only. These services must remain fenced after cutover. */
export const RETIRED_WORKERS = DEPLOYED_SERVICES.filter(service => !activeNames.has(service.name))

export const ORIGIN_OVERRIDE_ENV = "CANARY_WORKER_ORIGINS"

/**
 * Apply $CANARY_WORKER_ORIGINS: a JSON object of { name: origin } naming any
 * subset of the manifest. An empty string or null declares the Worker unset on
 * this deployment, which the probe reports as not-configured rather than as a
 * failure.
 *
 * Every malformed value throws. A silent fallback to the defaults would probe
 * the canary deployment while the operator believed they were probing theirs,
 * and report PASS for a stack nobody looked at.
 */
export const withOriginOverrides = (
  workers: ReadonlyArray<BackingWorker>,
  raw: string | undefined
): ReadonlyArray<BackingWorker> => {
  const text = raw?.trim()
  if (text === undefined || text === "") return workers

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `$${ORIGIN_OVERRIDE_ENV} is not a JSON object of { name: origin }: ${
        error instanceof Error ? error.message : "unparseable"
      }`
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`$${ORIGIN_OVERRIDE_ENV} is not a JSON object of { name: origin }: got ${JSON.stringify(parsed)}`)
  }

  const known = new Set(workers.map((worker) => worker.name))
  const overrides = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!known.has(name)) {
      throw new Error(
        `$${ORIGIN_OVERRIDE_ENV} names an unknown Worker "${name}". Known Workers: ${[...known].join(", ")}`
      )
    }
    if (value === null || value === "") {
      overrides.set(name, undefined)
      continue
    }
    if (typeof value !== "string") {
      throw new Error(
        `$${ORIGIN_OVERRIDE_ENV}.${name} must be an origin string, "" or null (unset), not ${JSON.stringify(value)}`
      )
    }
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error(`$${ORIGIN_OVERRIDE_ENV}.${name} is not an absolute URL: ${JSON.stringify(value)}`)
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`$${ORIGIN_OVERRIDE_ENV}.${name} must be http or https, not ${JSON.stringify(value)}`)
    }
    overrides.set(name, value)
  }

  // An override names the ONE origin that deployment uses, so it also drops the
  // canary's alternate routes: probing another deployment's identity Worker
  // plus this one's workers.dev twin would report on two stacks at once.
  return workers.map((worker) =>
    overrides.has(worker.name) ? { ...worker, origin: overrides.get(worker.name), alternateOrigins: [] } : worker
  )
}

/** The URL this probe will request, or undefined when the Worker is unset. */
export const healthUrl = (worker: BackingWorker): string | undefined =>
  worker.origin === undefined ? undefined : new URL(worker.path, worker.origin).toString()

/**
 * One probe target per route: each Worker, then each alternate route to it.
 * An unset Worker expands to itself alone — there is nothing to probe, and
 * saying so once is the honest report.
 */
export const expandTargets = (workers: ReadonlyArray<BackingWorker>): ReadonlyArray<BackingWorker> =>
  workers.flatMap((worker) =>
    worker.origin === undefined
      ? [worker]
      : [
        worker,
        ...worker.alternateOrigins.map((origin) => ({
          ...worker,
          name: `${worker.name} via ${new URL(origin).hostname}`,
          origin,
          alternateOrigins: []
        }))
      ]
  )
