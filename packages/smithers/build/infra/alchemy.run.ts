/**
 * Cloudflare resource declarations for the hosted build cache.
 *
 * @since 0.1.0
 */

import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Stack } from "alchemy/Stack"
import {
  cacheBucketOptions,
  cacheDatabaseOptions,
  cacheStackOutputs,
  cacheWorkerOptions,
  type RateLimitDeclaration,
  stackName
} from "./deployment.ts"

// Every option object and the stack program come from `deployment.ts`, where
// the suite executes them. This file only names the resources, which cannot
// be applied without a Cloudflare account.
const cacheDatabase = Cloudflare.D1.Database("CacheDatabase", cacheDatabaseOptions)
const cacheBucket = Cloudflare.R2.Bucket("CacheBucket", cacheBucketOptions)
// Annotated so the budget type is the binding a call returns, not the
// Effect-shaped service tag `Cloudflare.RateLimit` also is.
const rateLimit: RateLimitDeclaration<Cloudflare.RateLimitBinding> = Cloudflare.RateLimit
const cacheWorker = Cloudflare.Worker(
  "CacheWorker",
  Stack.useSync(
    cacheWorkerOptions({
      database: cacheDatabase,
      bucket: cacheBucket,
      // Rate Limiting bindings have no backing resource: they live on the
      // Worker alone, in namespaces `cacheWorkerOptions` derives per stage.
      rateLimit,
      // Analytics Engine datasets are created on first write; the binding is
      // the whole declaration.
      metrics: Cloudflare.AnalyticsEngine.Dataset
    })
  )
)

/**
 * Stage-isolated Cloudflare infrastructure for the hosted smithers build cache.
 *
 * Production owns `build.smithers.sh`; developer stages use isolated
 * `workers.dev` URLs and independently named D1 and R2 resources.
 *
 * @category infrastructure
 * @since 0.1.0
 */
export default Alchemy.Stack(
  stackName,
  {
    providers: Cloudflare.providers(),
    // A working copy only: `scripts/deploy.ts` pulls the durable snapshot from
    // the R2 state bucket into it before Alchemy runs and publishes it back
    // afterwards, and the stack program refuses to run without that wrapper.
    state: Alchemy.localState()
  },
  cacheStackOutputs({ stack: Alchemy.Stack, database: cacheDatabase, bucket: cacheBucket, worker: cacheWorker })
)
