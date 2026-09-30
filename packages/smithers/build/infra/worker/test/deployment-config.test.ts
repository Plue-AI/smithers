import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { createHash, randomBytes } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import cacheStack from "../../alchemy.run.ts"
import {
  artifactLifecycleRules,
  budgetNamespaces,
  cacheBucketOptions,
  cacheCredentialBindings,
  cacheCredentialVerifiers,
  cacheDatabaseOptions,
  cacheStackOutputs,
  cacheTokenDigest,
  cacheTokenVerifier,
  cacheWorkerOptions,
  credentialRequestBudget,
  findMissingBudget,
  maxCacheTokenBytes,
  metricsDataset,
  minCacheTokenBytes,
  retentionCron,
  stackName,
  stateSyncVariable,
  workerCompatibilityDate,
  workerEntry,
  workerObservability,
  workerStageOptions
} from "../../deployment.ts"
import { readTouchDays } from "../D1ActionCache.ts"
import { makeCredentialBudget } from "../RateLimitCredentialBudget.ts"
import { retentionDays } from "../RetentionSweep.ts"

const readToken = "SMITHERS_CACHE_READ_TOKEN"
const writeToken = "SMITHERS_CACHE_WRITE_TOKEN"
const infraRoot = fileURLToPath(new URL("../../", import.meta.url).href)
const digestOf = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")

const configured = (value: string): Promise<string> =>
  Effect.runPromise(
    Effect.provide(
      Effect.map(cacheTokenVerifier(readToken), Redacted.value),
      ConfigProvider.layer(ConfigProvider.fromUnknown({ [readToken]: value }))
    )
  )

/**
 * Runs `effect` against a deploying shell that exported the two credentials,
 * under the deploy wrapper unless `synced` is false.
 */
const deployed = <A, E>(effect: Effect.Effect<A, E>, read: string, write: string, synced = true): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      effect,
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          [readToken]: read,
          [writeToken]: write,
          ...(synced ? { [stateSyncVariable]: "1" } : {})
        })
      )
    )
  )

const distinct = {
  read: "read-credential-with-entropy-2026",
  write: "write-credential-with-entropy-2026"
} as const
/** The shortest credential the deployment accepts: two classes at the floor. */
const shortest = "0123456789abcdef".repeat(minCacheTokenBytes / 16)
/** What the README's `openssl rand -hex` command mints: hex, two classes. */
const mintedHex = (bytes: number): string =>
  Array.from(randomBytes(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")

describe("cache credential verification", () => {
  it("hands the Worker a digest rather than the credential", async () => {
    const token = shortest

    expect(token).toHaveLength(minCacheTokenBytes)
    expect(cacheTokenDigest(readToken, token)).toBe(createHash("sha256").update(token, "utf8").digest("hex"))
    await expect(configured(token)).resolves.toBe(createHash("sha256").update(token, "utf8").digest("hex"))
  })

  it("refuses a credential that is too short, too long, or not printable ASCII", () => {
    const longest = `${shortest}${"0a".repeat((maxCacheTokenBytes - minCacheTokenBytes) / 2)}`
    const cases = [
      shortest.slice(1),
      `${longest}a`,
      `${shortest} withspace`,
      `${shortest}\u0000`,
      `${shortest}é`,
      ""
    ]

    for (const value of cases) {
      expect(() => cacheTokenDigest(readToken, value)).toThrow(`${readToken} must be`)
    }
    expect(longest).toHaveLength(maxCacheTokenBytes)
    expect(() => cacheTokenDigest(readToken, longest)).not.toThrow()
  })

  /**
   * The verifier is an unsalted SHA-256 held in Alchemy state and as a
   * Cloudflare secret, so the floor has to put an offline guess out of reach:
   * the 32 random bytes the README asks for, never the 16 a memorable value
   * fits in.
   */
  it("enforces the floor the README asks for", async () => {
    const guide = (await Fs.readFile(NodePath.join(infraRoot, "README.md"), "utf8")).replace(/\s+/g, " ")

    expect(minCacheTokenBytes).toBe(32)
    expect(guide).toContain(`at least ${minCacheTokenBytes} random bytes`)
    expect(guide).toContain(`shorter than ${minCacheTokenBytes} or longer than ${maxCacheTokenBytes}`)
    expect(guide).toContain(`openssl rand -hex ${minCacheTokenBytes}`)
    const minted = mintedHex(minCacheTokenBytes)
    expect(minted).toHaveLength(minCacheTokenBytes * 2)
    expect(() => cacheTokenDigest(readToken, minted)).not.toThrow()
    await expect(configured(minted)).resolves.toBe(digestOf(minted))
  })

  it("refuses a credential drawn from a single character class however long it is", async () => {
    const singleClass = [
      "x".repeat(minCacheTokenBytes),
      "X".repeat(minCacheTokenBytes * 2),
      "7".repeat(maxCacheTokenBytes),
      "-".repeat(minCacheTokenBytes)
    ]

    for (const value of singleClass) {
      expect(() => cacheTokenDigest(readToken, value)).toThrow(`${readToken} must mix at least two of`)
    }
    await expect(configured("x".repeat(minCacheTokenBytes))).rejects.toThrow("must mix at least two of")
    // Any second class is enough: the rule refuses the shape of a memorable
    // value, it does not grade entropy.
    const twoClasses = [
      `${"x".repeat(minCacheTokenBytes - 1)}1`,
      `${"7".repeat(minCacheTokenBytes - 1)}-`,
      `${"X".repeat(minCacheTokenBytes - 1)}x`
    ]
    for (const value of twoClasses) {
      expect(cacheTokenDigest(readToken, value)).toBe(digestOf(value))
    }
  })

  it("fails the deployment rather than deploying with one credential", async () => {
    // A Worker that received only one secret would answer every request from
    // whichever half was configured, which is the posture the split ends.
    await expect(
      Effect.runPromise(
        Effect.provide(
          cacheTokenVerifier("SMITHERS_CACHE_WRITE_TOKEN"),
          ConfigProvider.layer(ConfigProvider.fromUnknown({ [readToken]: shortest }))
        )
      )
    ).rejects.toThrow()
    await expect(
      Effect.runPromise(
        Effect.provide(
          cacheTokenVerifier(readToken),
          ConfigProvider.layer(ConfigProvider.fromUnknown({ [readToken]: "short" }))
        )
      )
    ).rejects.toThrow(readToken)
  })

  it("gives production the custom domain and every other stage a workers.dev URL", () => {
    expect(workerStageOptions("prod")).toEqual({ domain: "build.smithers.sh", workersDev: false })
    expect(workerStageOptions("dev_alice")).toEqual({ workersDev: true })
    expect(workerStageOptions("production")).toEqual({ workersDev: true })
  })

  it("exposes the credential as a Config so a deployment reads it from the environment", () => {
    expect(Config.isConfig(cacheTokenVerifier(readToken))).toBe(true)
  })

  it("keeps retention policy internally bounded and ordered", () => {
    const ids = artifactLifecycleRules.map((rule) => rule.id)
    const maxAges = artifactLifecycleRules.map((rule) =>
      "deleteObjectsTransition" in rule
        ? rule.deleteObjectsTransition.condition.maxAge
        : rule.abortMultipartUploadsTransition.condition.maxAge
    )
    const artifactRule = artifactLifecycleRules.find((rule) => rule.id === "expire-cache-artifacts")
    const artifactMaxAge = artifactRule !== undefined && "deleteObjectsTransition" in artifactRule
      ? artifactRule.deleteObjectsTransition.condition.maxAge
      : 0

    expect(new Set(ids).size).toBe(ids.length)
    expect(maxAges.every((maxAge) => Number.isInteger(maxAge) && maxAge > 0)).toBe(true)
    expect(artifactMaxAge).toBeGreaterThan(retentionDays * 24 * 60 * 60)
    expect(retentionCron.trim().split(/\s+/)).toHaveLength(5)
    // A reader keeps an entry alive by touching it, so the touch interval has
    // to fit inside the window the sweep measures.
    expect(readTouchDays).toBeLessThan(retentionDays)
  })

  it("budgets each credential's requests and its findMissing probes separately", () => {
    // The Rate Limiting binding counts over ten or sixty seconds only.
    expect(credentialRequestBudget.simple.period).toBe(60)
    expect(findMissingBudget.simple.period).toBe(60)
    expect(Number.isInteger(credentialRequestBudget.simple.limit)).toBe(true)
    expect(Number.isInteger(findMissingBudget.simple.limit)).toBe(true)
    // One findMissing fans out to up to a thousand metered probes, so its
    // budget is the tighter one, counted in its own namespace.
    expect(findMissingBudget.simple.limit).toBeLessThan(credentialRequestBudget.simple.limit)
  })

  /**
   * A Rate Limiting namespace is account-wide. Had every stage bound the same
   * two, a developer stage deployed with the production credentials would
   * spend production's budget and the reverse.
   */
  it("keeps request metrics, invocation logs, and traces on for every stage", () => {
    expect(metricsDataset("prod")).toBe("smithers_build_cache_requests_prod")
    expect(metricsDataset("pr-1347.alice")).toBe("smithers_build_cache_requests_pr_1347_alice")
    expect(workerObservability.enabled).toBe(true)
    expect(workerObservability.logs).toMatchObject({ enabled: true, invocationLogs: true, headSamplingRate: 1 })
    expect(workerObservability.traces.enabled).toBe(true)
    expect(workerObservability.traces.headSamplingRate).toBeGreaterThan(0)
  })

  it("gives every stage its own pair of budget namespaces", () => {
    const production = budgetNamespaces("prod")
    expect(production).toEqual({ request: 1001, findMissing: 1002 })
    const stages = ["dev_alice", "dev_bob", "production", "pr-1347", "staging", ""]
    const seen = new Set([production.request, production.findMissing])
    for (const stage of stages) {
      const ids = budgetNamespaces(stage)
      expect(budgetNamespaces(stage)).toEqual(ids)
      expect(Number.isSafeInteger(ids.request) && ids.request > 0).toBe(true)
      expect(ids.findMissing).toBe(ids.request + 1)
      expect(seen.has(ids.request) || seen.has(ids.findMissing)).toBe(false)
      seen.add(ids.request)
      seen.add(ids.findMissing)
    }
  })

  /**
   * Cloudflare shares a counter between every binding in one account that
   * names the same namespace and key. The namespace pair is a finite hash of
   * the stage name, so this simulates that sharing and proves the stage in the
   * key keeps colliding stages apart while one stage keeps its own counter.
   */
  it("keeps colliding development stages on separate counters under one credential", async () => {
    const counters = new Map<string, number>()
    const resources = {
      database: "the-database",
      bucket: "the-bucket",
      rateLimit: (_name: string, props: { readonly namespaceId: number; readonly simple: { readonly limit: number } }) =>
        ({
          limit: async ({ key }: { readonly key: string }) => {
            const counter = `${props.namespaceId}:${key}`
            const used = (counters.get(counter) ?? 0) + 1
            counters.set(counter, used)
            return { success: used <= props.simple.limit }
          }
        }) as RateLimit,
      metrics: (name: string) => ({ name })
    }
    const budgetFor = (stage: string) => {
      const { env } = cacheWorkerOptions(resources)({ stage })
      return {
        env,
        budget: makeCredentialBudget(env.CACHE_REQUEST_BUDGET, env.CACHE_FIND_MISSING_BUDGET, env.CACHE_BUDGET_SCOPE)
      }
    }
    const spend = async (budget: ReturnType<typeof budgetFor>["budget"], count: number) => {
      for (let index = 0; index < count; index += 1) await budget.charge(digestOf("shared-credential"), "findMissing")
    }

    // The exact collision from #2670: two stage names, one namespace pair.
    expect(budgetNamespaces("dev_review_6219")).toEqual({ request: 86827832, findMissing: 86827833 })
    expect(budgetNamespaces("dev_review_61384")).toEqual(budgetNamespaces("dev_review_6219"))
    const first = budgetFor("dev_review_6219")
    const second = budgetFor("dev_review_61384")
    expect(first.env.CACHE_FIND_MISSING_BUDGET).not.toBe(second.env.CACHE_FIND_MISSING_BUDGET)

    await spend(first.budget, findMissingBudget.simple.limit)
    expect(await first.budget.charge(digestOf("shared-credential"), "findMissing")).toBe(false)
    expect(await second.budget.charge(digestOf("shared-credential"), "findMissing")).toBe(true)
    expect(await second.budget.charge(digestOf("shared-credential"), "request")).toBe(true)

    // The same stage redeployed keys the same counter, so its spent budget stays spent.
    expect(await budgetFor("dev_review_6219").budget.charge(digestOf("shared-credential"), "findMissing")).toBe(false)

    // Production keeps its reserved pair and its own counters.
    const production = budgetFor("prod")
    expect(budgetNamespaces("prod")).toEqual({ request: 1001, findMissing: 1002 })
    expect(await production.budget.charge(digestOf("shared-credential"), "findMissing")).toBe(true)
    expect([...counters.keys()].every((key) => key.includes(`/${digestOf("shared-credential")}`))).toBe(true)
  })

  it("documents what a leaked read credential can cost with the deployed budgets", async () => {
    const guide = await Fs.readFile(NodePath.join(infraRoot, "CACHE-TRUST.md"), "utf8")

    expect(guide).toContain(`${credentialRequestBudget.simple.limit} requests`)
    expect(guide).toContain(`${findMissingBudget.simple.limit} findMissing`)
    expect(guide).toContain(`${readTouchDays} day`)
    expect(guide).toContain("account-level")
    expect(guide).not.toContain("\u2014")
  })

  /**
   * The Worker refuses an equal pair when it builds its handler, but that
   * happens on the first request, after a deployment has already replaced a
   * healthy Worker. The pair has to fail while the deployment resolves its
   * configuration, before any Worker request exists.
   */
  it("refuses equal credentials while the deployment resolves its configuration", async () => {
    const equal = "one-credential-wearing-two-names"

    await expect(deployed(cacheCredentialVerifiers, equal, equal)).rejects.toThrow(
      "SMITHERS_CACHE_READ_TOKEN and SMITHERS_CACHE_WRITE_TOKEN must differ"
    )
    // Both Worker bindings derive from the pair, so whichever one Alchemy
    // resolves first is the one that fails the deployment.
    await expect(deployed(cacheCredentialBindings.CACHE_READ_TOKEN, equal, equal)).rejects.toThrow("must differ")
    await expect(deployed(cacheCredentialBindings.CACHE_WRITE_TOKEN, equal, equal)).rejects.toThrow("must differ")
    // A single invalid credential still names itself rather than the pair.
    await expect(deployed(cacheCredentialVerifiers, "short", distinct.write)).rejects.toThrow(readToken)
  })

  it("hands the Worker one digest per direction for a distinct pair", async () => {
    const pair = await deployed(cacheCredentialVerifiers, distinct.read, distinct.write)
    const read = await deployed(cacheCredentialBindings.CACHE_READ_TOKEN, distinct.read, distinct.write)
    const write = await deployed(cacheCredentialBindings.CACHE_WRITE_TOKEN, distinct.read, distinct.write)

    expect(Redacted.value(pair.read)).toBe(digestOf(distinct.read))
    expect(Redacted.value(pair.write)).toBe(digestOf(distinct.write))
    expect(Redacted.value(read)).toBe(digestOf(distinct.read))
    expect(Redacted.value(write)).toBe(digestOf(distinct.write))
  })

  it("configures the Worker from the seams the resource graph applies", async () => {
    const resources = {
      database: "the-database",
      bucket: "the-bucket",
      rateLimit: (name: string, props: { readonly namespaceId: number; readonly simple: unknown }) => ({
        name,
        ...props
      }),
      metrics: (name: string, props: { readonly dataset: string }) => ({ name, ...props })
    }
    const production = cacheWorkerOptions(resources)({ stage: "prod" })
    const development = cacheWorkerOptions(resources)({ stage: "dev_alice" })
    const developmentNamespaces = budgetNamespaces("dev_alice")

    expect(production).toEqual({
      main: workerEntry,
      compatibility: { date: workerCompatibilityDate },
      crons: [retentionCron],
      env: {
        CACHE_DATABASE: "the-database",
        CACHE_BUCKET: "the-bucket",
        CACHE_REQUEST_BUDGET: { name: "CACHE_REQUEST_BUDGET", namespaceId: 1001, ...credentialRequestBudget },
        CACHE_FIND_MISSING_BUDGET: { name: "CACHE_FIND_MISSING_BUDGET", namespaceId: 1002, ...findMissingBudget },
        CACHE_BUDGET_SCOPE: "prod",
        CACHE_REQUEST_METRICS: { name: "CacheRequestMetrics", dataset: "smithers_build_cache_requests_prod" },
        CACHE_READ_NAMESPACE_PREFIX: expect.any(Object),
        CACHE_READ_TOKEN: cacheCredentialBindings.CACHE_READ_TOKEN,
        CACHE_WRITE_TOKEN: cacheCredentialBindings.CACHE_WRITE_TOKEN
      },
      observability: workerObservability,
      domain: "build.smithers.sh",
      workersDev: false
    })
    const prefixBinding = production.env.CACHE_READ_NAMESPACE_PREFIX
    const resolvePrefix = (values: Record<string, string>): Promise<string> =>
      Effect.runPromise(Effect.provide(prefixBinding, ConfigProvider.layer(ConfigProvider.fromUnknown(values))))
    await expect(resolvePrefix({})).resolves.toBe("")
    await expect(resolvePrefix({ SMITHERS_CACHE_READ_NAMESPACE_PREFIX: "pr-1/" })).resolves.toBe("pr-1/")
    await expect(resolvePrefix({ SMITHERS_CACHE_READ_NAMESPACE_PREFIX: "pr-1" })).rejects.toThrow("must be one namespace")
    expect(development.env).toEqual({
      ...production.env,
      CACHE_READ_NAMESPACE_PREFIX: expect.any(Object),
      CACHE_REQUEST_BUDGET: {
        name: "CACHE_REQUEST_BUDGET",
        namespaceId: developmentNamespaces.request,
        ...credentialRequestBudget
      },
      CACHE_FIND_MISSING_BUDGET: {
        name: "CACHE_FIND_MISSING_BUDGET",
        namespaceId: developmentNamespaces.findMissing,
        ...findMissingBudget
      },
      CACHE_BUDGET_SCOPE: "dev_alice",
      CACHE_REQUEST_METRICS: { name: "CacheRequestMetrics", dataset: "smithers_build_cache_requests_dev_alice" }
    })
    expect(development.main).toBe(production.main)
    expect(development.workersDev).toBe(true)
    expect(development).not.toHaveProperty("domain")
    // The entry and the migrations the seams name exist where the graph
    // resolves them, relative to this directory.
    await expect(Fs.access(NodePath.join(infraRoot, workerEntry))).resolves.toBeUndefined()
    await expect(Fs.readdir(NodePath.join(infraRoot, cacheDatabaseOptions.migrations))).resolves.toEqual([
      "0001_initial.sql",
      "0002_bound_cache_rows.sql"
    ])
    expect(cacheBucketOptions.lifecycleRules).toEqual([...artifactLifecycleRules])
    expect(/^\d{4}-\d{2}-\d{2}$/.test(workerCompatibilityDate)).toBe(true)
  })

  it("reads the credential pair before it touches any resource", async () => {
    const touched: Array<string> = []
    const resource = <A>(name: string, value: A): Effect.Effect<A> =>
      Effect.sync(() => {
        touched.push(name)
        return value
      })
    const program = cacheStackOutputs({
      stack: resource("stack", { stage: "prod" }),
      database: resource("database", { databaseName: "cache-db" }),
      bucket: resource("bucket", { bucketName: "cache-bucket" }),
      worker: resource("worker", { url: "https://build.smithers.sh" })
    })
    const equal = "one-credential-wearing-two-names"

    await expect(deployed(program, equal, equal)).rejects.toThrow("must differ")
    expect(touched).toEqual([])

    // Alchemy run directly, without the wrapper's R2 state sync, would plan
    // against whatever local state this machine has and fork production.
    await expect(deployed(program, distinct.read, distinct.write, false)).rejects.toThrow(
      `${stateSyncVariable} is not set`
    )
    expect(touched).toEqual([])

    await expect(deployed(program, distinct.read, distinct.write)).resolves.toEqual({
      stage: "prod",
      url: "https://build.smithers.sh",
      databaseName: "cache-db",
      bucketName: "cache-bucket"
    })
    expect(touched).toEqual(["stack", "database", "bucket", "worker"])
  })

  it("declares the Cloudflare resource graph from those seams", () => {
    // Suite setup imports the real graph without applying its resources.
    // Keep dependency loading out of this assertion's runtime budget, just
    // like the deployment helpers imported above; import errors fail the suite.
    const stack = cacheStack as unknown as Record<string, unknown>

    expect(stack["stackName"]).toBe(stackName)
    expect(stack["state"]).toBeDefined()
    expect(stack["providers"]).toBeDefined()
  })
})
