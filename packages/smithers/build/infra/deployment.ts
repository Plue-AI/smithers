/**
 * Deployment policy for the hosted remote cache, separated from the Alchemy
 * resource graph so every rule it encodes can be exercised directly.
 *
 * @since 0.1.0
 */

import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import { createHash } from "node:crypto"

/**
 * The Alchemy stack name, which is also the state directory redaction walks.
 *
 * @category constants
 * @since 0.1.0
 */
export const stackName = "SmithersBuildRemoteCache"

const configError = (message: string): Config.ConfigError =>
  new Config.ConfigError(new Schema.SchemaError(new SchemaIssue.InvalidValue({ message })))

/**
 * The variable the deploy wrapper sets for the Alchemy process it drives.
 *
 * The wrapper pulls the stack's state from R2 before Alchemy runs and
 * publishes it back afterwards. The stack program refuses to run without this
 * variable, so a direct `alchemy deploy` or `alchemy plan` cannot act on a
 * local state directory that was never synced and create a second production.
 *
 * @category constants
 * @since 0.1.0
 */
export const stateSyncVariable = "SMITHERS_BUILD_INFRA_STATE_SYNCED"

/**
 * Refuses a stack run the deploy wrapper did not start.
 *
 * @category constructors
 * @since 0.1.0
 */
export const stateSyncGuard: Config.Config<void> = Config.String(stateSyncVariable).pipe(
  Config.withDefault(""),
  Config.mapEffect((value) =>
    value === "1"
      ? Effect.void
      : Effect.fail(
        configError(
          `${stateSyncVariable} is not set: run this stack through scripts/deploy.ts (pnpm run deploy or ` +
            `pnpm run plan), which syncs its state with R2. Alchemy alone plans against local state and can ` +
            `create a second production`
        )
      )
  )
)

/**
 * The shortest cache credential a deployment accepts.
 *
 * The Worker's verifier is an unsalted SHA-256 of the credential, held in
 * Alchemy state and as a Cloudflare secret, so anyone who reads either can run
 * an offline guess against it. Thirty-two bytes is the floor at which a random
 * credential puts that guess out of reach; `openssl rand -hex 32` yields 64.
 *
 * @category constants
 * @since 0.1.0
 */
export const minCacheTokenBytes = 32

/**
 * The longest cache credential a deployment accepts.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxCacheTokenBytes = 4096

/**
 * When the Worker's scheduled retention sweep runs.
 *
 * @category constants
 * @since 0.1.0
 */
export const retentionCron = "17 3 * * *"

/**
 * How long a published artifact survives in R2.
 *
 * R2 lifecycle rules measure an object's age from its upload, not from its
 * last read, so this cannot be the same window the D1 sweep applies to entries
 * (that one is last-access based). It is deliberately three times longer, so
 * an entry that is still being read normally outlives its artifacts' upload
 * age only in the tail. When it does not, the reference dangles and `GET
 * /cas/{digest}` answers 404, which `@smthrs/artifacts` raises as
 * `ArtifactMissing` and the engine's step boundary turns into a real
 * execution: a cache miss, never a corrupt restore.
 *
 * @category constants
 * @since 0.1.0
 */
export const artifactRetentionDays = 90

/**
 * How long an incomplete multipart upload survives in R2.
 *
 * An abandoned upload is billed storage that no request can ever read, so it
 * is discarded well inside the artifact window.
 *
 * @category constants
 * @since 0.1.0
 */
export const abandonedUploadRetentionDays = 1

const secondsPerDay = 24 * 60 * 60

/**
 * The bucket lifecycle the deployment applies to published artifacts.
 *
 * Declared here rather than inline in the resource graph so the retention
 * policy is exercised by the same suite that covers the rest of deployment
 * policy.
 *
 * @category constructors
 * @since 0.1.0
 */
export const artifactLifecycleRules = [
  {
    id: "expire-cache-artifacts",
    enabled: true,
    deleteObjectsTransition: {
      condition: { type: "Age", maxAge: artifactRetentionDays * secondsPerDay }
    }
  },
  {
    id: "abort-abandoned-uploads",
    enabled: true,
    abortMultipartUploadsTransition: {
      condition: { type: "Age", maxAge: abandonedUploadRetentionDays * secondsPerDay }
    }
  }
] as const satisfies ReadonlyArray<{
  readonly id: string
  readonly enabled: boolean
  readonly deleteObjectsTransition?: { readonly condition: { readonly type: "Age"; readonly maxAge: number } }
  readonly abortMultipartUploadsTransition?: {
    readonly condition: { readonly type: "Age"; readonly maxAge: number }
  }
}>

const printableAscii = /^[!-~]+$/

/**
 * The character classes a credential draws from. One class alone (`xxxx…`,
 * `1234…`, `----…`) is the shape of a memorable value, which an offline
 * dictionary recovers from the verifier however long it is.
 */
const characterClasses: ReadonlyArray<RegExp> = [/[0-9]/, /[a-z]/, /[A-Z]/, /[!-/:-@[-`{-~]/]

const characterClassCount = (value: string): number =>
  characterClasses.filter((characterClass) => characterClass.test(value)).length

/**
 * The name of one cache credential.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheTokenName = "SMITHERS_CACHE_READ_TOKEN" | "SMITHERS_CACHE_WRITE_TOKEN"

/**
 * Names the rule one cache credential breaks, or `null` when it holds.
 *
 * A credential is {@link minCacheTokenBytes} to {@link maxCacheTokenBytes}
 * printable ASCII bytes with no spaces, drawn from at least two of digits,
 * lowercase, uppercase, and punctuation. The one rule serves both the throwing
 * digest and the deploy-time `Config`, so the two cannot drift apart.
 *
 * @category utilities
 * @since 0.1.0
 */
export const cacheTokenFault = (name: CacheTokenName, value: string): string | null => {
  if (value.length < minCacheTokenBytes || value.length > maxCacheTokenBytes || !printableAscii.test(value)) {
    return `${name} must be ${minCacheTokenBytes}-${maxCacheTokenBytes} printable ASCII bytes with no spaces`
  }
  if (characterClassCount(value) < 2) {
    return `${name} must mix at least two of digits, lowercase, uppercase, and punctuation`
  }
  return null
}

const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")

/**
 * Turns one cache credential into the verifier the Worker receives.
 *
 * The Worker never holds a bearer value: it compares the SHA-256 of the token
 * a request presents against this digest, so Alchemy state and the Cloudflare
 * secret carry a one-way verifier rather than a usable credential.
 *
 * @throws A `TypeError` naming the offending variable when
 * {@link cacheTokenFault} reports a fault.
 * @category constructors
 * @since 0.1.0
 */
export const cacheTokenDigest = (name: CacheTokenName, value: string): string => {
  const fault = cacheTokenFault(name, value)
  if (fault !== null) throw new TypeError(fault)
  return sha256Hex(value)
}

/**
 * Reads one cache credential and hands the Worker its digest.
 *
 * Both credentials are required at deploy time. A Worker that received only
 * one of them would answer every request from whichever half was configured,
 * which is the single-credential posture this split exists to end, so a
 * missing secret fails the deployment instead.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cacheTokenVerifier = (name: CacheTokenName): Config.Config<Redacted.Redacted<string>> =>
  Config.Redacted(name).pipe(
    Config.mapEffect((token) => {
      const value = Redacted.value(token)
      const fault = cacheTokenFault(name, value)
      return fault === null ? Effect.succeed(Redacted.make(sha256Hex(value))) : Effect.fail(configError(fault))
    })
  )

/**
 * Both cache verifiers, read together so the pair can be refused as a pair.
 *
 * @category models
 * @since 0.1.0
 */
export interface CacheCredentialVerifiers {
  readonly read: Redacted.Redacted<string>
  readonly write: Redacted.Redacted<string>
}

/**
 * Reads both cache credentials and refuses them when they are equal.
 *
 * The Worker classifies a presented token as `write` before `read`, so one
 * value configured for both directions lets every reader publish. The Worker
 * refuses that pair too, but only when it builds its handler on the first
 * request: a deployment that validated each credential alone would replace a
 * healthy Worker with one that answers every request `503`. Reading the pair
 * here fails the deployment before any resource is applied.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cacheCredentialVerifiers: Config.Config<CacheCredentialVerifiers> = Config.all({
  read: cacheTokenVerifier("SMITHERS_CACHE_READ_TOKEN"),
  write: cacheTokenVerifier("SMITHERS_CACHE_WRITE_TOKEN")
}).pipe(
  Config.mapEffect((verifiers) =>
    Redacted.value(verifiers.read) === Redacted.value(verifiers.write)
      ? Effect.fail(
        configError(
          "SMITHERS_CACHE_READ_TOKEN and SMITHERS_CACHE_WRITE_TOKEN must differ, or the read credential can publish"
        )
      )
      : Effect.succeed(verifiers)
  )
)

/**
 * The Worker's two credential bindings, each derived from the validated pair.
 *
 * Both derive from {@link cacheCredentialVerifiers} rather than reading their
 * own variable, so an equal pair fails whichever binding Alchemy resolves
 * first.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cacheCredentialBindings = {
  CACHE_READ_TOKEN: Config.map(cacheCredentialVerifiers, (verifiers) => verifiers.read),
  CACHE_WRITE_TOKEN: Config.map(cacheCredentialVerifiers, (verifiers) => verifiers.write)
} as const

/**
 * How many cache requests one credential may make per minute.
 *
 * The read credential is public within the organization, and the Worker's
 * per-isolate concurrency ceilings bound memory, not aggregate rate:
 * Cloudflare scales isolates per location. This is the Rate Limiting binding
 * the Worker charges every admitted request to, keyed by the SHA-256 of the
 * credential that presented it, so a leaked read token can drive at most this
 * many metered operations a minute at one Cloudflare location. The binding
 * counts per location; only an account-level rate rule is a global ceiling.
 *
 * @category constants
 * @since 0.1.0
 */
export const credentialRequestBudget = {
  simple: { limit: 12_000, period: 60 }
} as const

/**
 * How many `findMissing` probes one credential may make per minute.
 *
 * One `findMissing` fans out to up to a thousand R2 `HEAD` calls, so it has a
 * budget of its own, well under the request budget. The default pull policy
 * never probes and a publication probes at most twice per target, so the
 * ceiling sits above any job's legitimate rate.
 *
 * @category constants
 * @since 0.1.0
 */
export const findMissingBudget = {
  simple: { limit: 600, period: 60 }
} as const

/**
 * The two Rate Limiting namespaces one stage's budgets count in.
 *
 * A namespace is account-wide, so a stage that reused production's would
 * spend production's per-credential budget from its own traffic, and the
 * reverse. Production keeps the namespaces it was deployed with; every other
 * stage derives a pair from its name, above production's and never equal to
 * it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const budgetNamespaces = (
  stage: string
): { readonly request: number; readonly findMissing: number } => {
  if (stage === "prod") return { request: 1001, findMissing: 1002 }
  // FNV-1a over the stage's UTF-8 bytes: stable across deploys and machines.
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(stage)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  }
  const request = 1_000_000 + (hash % 100_000_000) * 2
  return { request, findMissing: request + 1 }
}

/**
 * The Analytics Engine dataset one stage's Worker writes its request metrics to.
 *
 * One datapoint per request (route class, method, status, duration) and one
 * per retention run (outcome, duration, rows removed). A stage name may hold
 * characters a dataset name may not, so they become underscores.
 *
 * @category constructors
 * @since 0.1.0
 */
export const metricsDataset = (stage: string): string =>
  `smithers_build_cache_requests_${stage.replace(/[^A-Za-z0-9_]/g, "_")}`

/**
 * Workers Logs and Traces for the cache Worker.
 *
 * The Worker logs only failures and the retention record, so every
 * invocation log is kept. Traces sample one request in ten: enough to see
 * where a slow D1 or R2 call spends its time without paying for every hit.
 *
 * @category constants
 * @since 0.1.0
 */
export const workerObservability = {
  enabled: true,
  headSamplingRate: 1,
  logs: { enabled: true, invocationLogs: true, headSamplingRate: 1 },
  traces: { enabled: true, headSamplingRate: 0.1 }
} as const

/**
 * Declares one Rate Limiting binding. `alchemy.run.ts` passes
 * `Cloudflare.RateLimit`; the suite passes a recorder.
 *
 * @category models
 * @since 0.1.0
 */
export type RateLimitDeclaration<Budget> = (
  name: string,
  props: { readonly namespaceId: number; readonly simple: { readonly limit: number; readonly period: 60 } }
) => Budget

/**
 * The stage-dependent half of the Worker's configuration.
 *
 * Production claims the custom domain and refuses a `workers.dev` URL, so the
 * service has exactly one public address. Every other stage is the reverse:
 * an isolated `workers.dev` URL and no claim on the production domain.
 *
 * @category constructors
 * @since 0.1.0
 */
export const workerStageOptions = (
  stage: string
): { readonly domain: string; readonly workersDev: false } | { readonly workersDev: true } =>
  stage === "prod" ? { domain: "build.smithers.sh", workersDev: false } : { workersDev: true }

/**
 * The D1 resource configuration: where the Worker's schema migrations live.
 *
 * @category constants
 * @since 0.1.0
 */
export const cacheDatabaseOptions = { migrations: "./worker/migrations" } as const

/**
 * The R2 resource configuration: the artifact lifecycle.
 *
 * The Worker's scheduled sweep prunes D1 entries; R2 has no scheduled reader,
 * so artifact retention is the bucket's own lifecycle. Without it the store
 * keeps every artifact ever published, forever.
 *
 * @category constants
 * @since 0.1.0
 */
export const cacheBucketOptions = { lifecycleRules: [...artifactLifecycleRules] }

/**
 * The Worker's entry module, relative to this directory.
 *
 * @category constants
 * @since 0.1.0
 */
export const workerEntry = "./worker/CacheWorker.ts"

/**
 * The Workers runtime compatibility date the cache runs under.
 *
 * @category constants
 * @since 0.1.0
 */
export const workerCompatibilityDate = "2026-08-14"

/**
 * The D1 and R2 resources, and the declarations for the Rate Limiting and
 * Analytics Engine bindings the Worker binds.
 *
 * @category models
 * @since 0.1.0
 */
export interface CacheWorkerResources<Database, Bucket, Budget, Metrics> {
  readonly database: Database
  readonly bucket: Bucket
  /** Declares the two budget bindings in the stage's own namespaces. */
  readonly rateLimit: RateLimitDeclaration<Budget>
  /** Declares the Analytics Engine binding; `alchemy.run.ts` passes `Cloudflare.AnalyticsEngine.Dataset`. */
  readonly metrics: (name: string, props: { readonly dataset: string }) => Metrics
}

/**
 * Builds the Worker's configuration for the stage a stack is deploying.
 *
 * Every rule the resource graph used to encode inline lives here: the entry
 * module, the compatibility date, the retention trigger, the eight bindings,
 * and the stage's public address. `alchemy.run.ts` hands the result to
 * `Cloudflare.Worker` unchanged, so the suite executes what the deployment
 * applies.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cacheWorkerOptions =
  <Database, Bucket, Budget, Metrics>(resources: CacheWorkerResources<Database, Bucket, Budget, Metrics>) =>
  (stack: { readonly stage: string }) => {
    const namespaces = budgetNamespaces(stack.stage)
    return {
      main: workerEntry,
      compatibility: { date: workerCompatibilityDate },
      // The Worker's `scheduled` handler prunes entries past the retention
      // window; without this trigger the store grows until D1 refuses writes.
      crons: [retentionCron],
      env: {
        CACHE_DATABASE: resources.database,
        CACHE_BUCKET: resources.bucket,
        CACHE_REQUEST_BUDGET: resources.rateLimit("CACHE_REQUEST_BUDGET", {
          namespaceId: namespaces.request,
          ...credentialRequestBudget
        }),
        CACHE_FIND_MISSING_BUDGET: resources.rateLimit("CACHE_FIND_MISSING_BUDGET", {
          namespaceId: namespaces.findMissing,
          ...findMissingBudget
        }),
        CACHE_REQUEST_METRICS: resources.metrics("CacheRequestMetrics", { dataset: metricsDataset(stack.stage) }),
        CACHE_READ_NAMESPACE_PREFIX: Config.String("SMITHERS_CACHE_READ_NAMESPACE_PREFIX").pipe(
          Config.withDefault(""),
          Config.mapEffect((prefix) =>
            prefix === "" || /^[A-Za-z0-9_-]+\/$/.test(prefix)
              ? Effect.succeed(prefix)
              : Effect.fail(configError("SMITHERS_CACHE_READ_NAMESPACE_PREFIX must be one namespace ending in /"))
          )
        ),
        ...cacheCredentialBindings
      },
      observability: workerObservability,
      ...workerStageOptions(stack.stage)
    }
  }

/**
 * The resources one deployment's outputs come from.
 *
 * Each is the Effect Alchemy resolves it with, so the stack program runs
 * against the real resource graph, whose fields are Alchemy outputs, and
 * against plain values alike.
 *
 * @category models
 * @since 0.1.0
 */
export interface CacheStackResources<Stage, DatabaseName, BucketName, Url, E, R> {
  readonly stack: Effect.Effect<{ readonly stage: Stage }, E, R>
  readonly database: Effect.Effect<{ readonly databaseName: DatabaseName }, E, R>
  readonly bucket: Effect.Effect<{ readonly bucketName: BucketName }, E, R>
  readonly worker: Effect.Effect<{ readonly url: Url }, E, R>
}

/**
 * What one deployment reports.
 *
 * @category models
 * @since 0.1.0
 */
export interface CacheStackOutputs<Stage, DatabaseName, BucketName, Url> {
  readonly stage: Stage
  readonly url: Url
  readonly databaseName: DatabaseName
  readonly bucketName: BucketName
}

/**
 * The stack program: checks that the deploy wrapper synced state, reads the
 * credential pair, then reports the resources.
 *
 * Both checks run before any resource is touched, so an equal pair fails the
 * deployment with nothing created or replaced, and a plan that reaches the
 * resources has already proven its credentials.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cacheStackOutputs = <Stage, DatabaseName, BucketName, Url, E, R>(
  resources: CacheStackResources<Stage, DatabaseName, BucketName, Url, E, R>
): Effect.Effect<CacheStackOutputs<Stage, DatabaseName, BucketName, Url>, E | Config.ConfigError, R> =>
  Effect.gen(function*() {
    yield* stateSyncGuard
    yield* cacheCredentialVerifiers
    const { stage } = yield* resources.stack
    const database = yield* resources.database
    const bucket = yield* resources.bucket
    const worker = yield* resources.worker
    return { stage, url: worker.url, databaseName: database.databaseName, bucketName: bucket.bucketName }
  })
