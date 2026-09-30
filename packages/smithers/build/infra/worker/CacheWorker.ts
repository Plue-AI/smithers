/**
 * Cloudflare Worker entry point for the hosted build cache.
 *
 * @since 0.1.0
 */

import { CacheFailure } from "./cache-failure.ts"
import { makeActionCache } from "./D1ActionCache.ts"
import { createHandler, describeFailure, makeAdmissionState } from "./protocol.ts"
import { makeContentStore } from "./R2ContentStore.ts"
import { makeCredentialBudget } from "./RateLimitCredentialBudget.ts"
import { pruneStaleEntries, retentionDays } from "./RetentionSweep.ts"

interface CacheWorkerEnv {
  readonly CACHE_DATABASE: D1Database
  readonly CACHE_BUCKET: R2Bucket
  /** Counts every admitted request per credential digest at this location. */
  readonly CACHE_REQUEST_BUDGET: RateLimit
  /** Counts `findMissing` probes per credential digest at this location. */
  readonly CACHE_FIND_MISSING_BUDGET: RateLimit
  /** The stage name both budgets key under, so stages sharing a namespace never share a counter. */
  readonly CACHE_BUDGET_SCOPE: string
  /** SHA-256 of the pull credential every job may hold, trusted or not. */
  readonly CACHE_READ_TOKEN: string
  readonly CACHE_READ_NAMESPACE_PREFIX?: string
  /** SHA-256 of the publish credential only post-merge jobs may hold. */
  readonly CACHE_WRITE_TOKEN: string
  /**
   * One header datapoint per request, a terminal datapoint per streamed hit,
   * and one per retention run. The deployment always
   * binds it; an environment without it records nothing.
   */
  readonly CACHE_REQUEST_METRICS?: AnalyticsEngineDataset
}

interface HealthRow {
  readonly ok: number
}

const healthObjectKey = "__smithers_build_healthcheck__"
const millisecondsPerDay = 24 * 60 * 60 * 1000

const makeHealth = (database: D1Database, bucket: R2Bucket) => async (): Promise<void> => {
  const [row] = await Promise.all([
    database.prepare("SELECT 1 AS ok").first<HealthRow>(),
    bucket.head(healthObjectKey)
  ])
  if (row?.ok !== 1) {
    throw new CacheFailure("D1_READINESS_INVALID", "health", "D1 readiness check did not return its sentinel")
  }
}

/**
 * The route class a request is counted under.
 *
 * A class, never the path: a key or digest in a datapoint would make every
 * row unique and the dataset useless for aggregation.
 */
const routeOf = (request: Request): string => {
  // The handler answers an unparseable URL with 400; its datapoint is "other".
  if (!URL.canParse(request.url)) return "other"
  const path = new URL(request.url).pathname
  if (path === "/healthz") return "healthz"
  if (path === "/cas/findMissing") return "findMissing"
  if (path.startsWith("/ac/")) return "ac"
  if (path.startsWith("/cas/")) return "cas"
  return "other"
}

/**
 * Writes one datapoint without letting the metrics path fail the request.
 *
 * Blobs are the route class, the method, and the outcome; doubles start with
 * the duration in milliseconds.
 */
const record = (
  metrics: AnalyticsEngineDataset | undefined,
  route: string,
  method: string,
  outcome: string,
  doubles: ReadonlyArray<number>
): void => {
  try {
    metrics?.writeDataPoint({ indexes: [route], blobs: [route, method, outcome], doubles: [...doubles] })
  } catch {
    // Analytics Engine is best effort; a lost datapoint must not cost a request.
  }
}

type CacheHandler = ReturnType<typeof createHandler>

const admission = makeAdmissionState()
let isolateHandler: CacheHandler | null = null
let capturedBindings: ReadonlyArray<unknown> = []

const handlerFor = (env: CacheWorkerEnv): CacheHandler => {
  const bindings = [
    env.CACHE_DATABASE,
    env.CACHE_BUCKET,
    env.CACHE_READ_TOKEN,
    env.CACHE_READ_NAMESPACE_PREFIX,
    env.CACHE_WRITE_TOKEN,
    env.CACHE_REQUEST_BUDGET,
    env.CACHE_FIND_MISSING_BUDGET,
    env.CACHE_BUDGET_SCOPE
  ]
  if (isolateHandler !== null && bindings.every((value, index) => value === capturedBindings[index])) {
    return isolateHandler
  }
  isolateHandler = createHandler({
    actionCache: makeActionCache(env.CACHE_DATABASE),
    contentStore: makeContentStore(env.CACHE_BUCKET),
    readTokenHash: env.CACHE_READ_TOKEN,
    readNamespacePrefix: env.CACHE_READ_NAMESPACE_PREFIX ?? "",
    writeTokenHash: env.CACHE_WRITE_TOKEN,
    credentialBudget: makeCredentialBudget(
      env.CACHE_REQUEST_BUDGET,
      env.CACHE_FIND_MISSING_BUDGET,
      env.CACHE_BUDGET_SCOPE
    ),
    health: makeHealth(env.CACHE_DATABASE, env.CACHE_BUCKET)
  }, admission)
  capturedBindings = bindings
  return isolateHandler
}

/**
 * Cloudflare Worker entry point for the hosted remote cache.
 *
 * @category runtime
 * @since 0.1.0
 */
const worker = {
  async fetch(request: Request, env: CacheWorkerEnv): Promise<Response> {
    const started = Date.now()
    const route = routeOf(request)
    let response: Response
    try {
      response = await handlerFor(env)(request, (outcome) => {
        record(env.CACHE_REQUEST_METRICS, route, request.method, `stream_${outcome}`, [Date.now() - started])
      })
    } catch (cause) {
      console.error(describeFailure(cause))
      response = new Response(JSON.stringify({ error: "the cache tier failed to initialize" }), {
        status: 503,
        headers: { "content-type": "application/json", "Smithers-Cache-Contract": "result-only-v1" }
      })
    }
    record(env.CACHE_REQUEST_METRICS, route, request.method, String(response.status), [
      Date.now() - started
    ])
    return response
  },
  async scheduled(_controller: ScheduledController, env: CacheWorkerEnv): Promise<void> {
    const started = Date.now()
    const cutoff = new Date(started - retentionDays * millisecondsPerDay).toISOString()
    try {
      const { backlog, removed } = await pruneStaleEntries(env.CACHE_DATABASE, cutoff)
      console.log(JSON.stringify({ event: "smithers.build.retention", removed, backlog, cutoff }))
      record(env.CACHE_REQUEST_METRICS, "retention", "SCHEDULED", "ok", [
        Date.now() - started,
        removed,
        backlog ? 1 : 0
      ])
    } catch (cause) {
      record(env.CACHE_REQUEST_METRICS, "retention", "SCHEDULED", "failed", [Date.now() - started, 0])
      // The allowlisted diagnostic is the record; the rethrown failure is what
      // makes Cloudflare retry the invocation without repeating the cause.
      console.error(
        describeFailure(new CacheFailure("RETENTION_FAILED", "retention", "scheduled retention failed", { cause }))
      )
      throw new Error("scheduled retention failed")
    }
  }
} satisfies ExportedHandler<CacheWorkerEnv>

export default worker
