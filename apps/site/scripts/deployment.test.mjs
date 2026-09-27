/** Validate real Alchemy entry points offline; never evaluate or deploy a stack. */
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import ts from "typescript"
import { sites } from "../../docs/shared/manifest.mjs"

const root = resolve(import.meta.dirname, "../../..")
const appEntries = ["review", "bug-worker"].map((name) => join(root, "apps", name, "alchemy.run.ts"))

/** The smithers.sh zone on account dd3525a4132493566aeb38de533c8827. */
const SMITHERS_ZONE_ID = "8ebd98d2f0dc7d8db2e61f31ebc19c14"

test("all deployment entry points import as Alchemy 2 stack effects", async () => {
  const entryPoints = [
    ...appEntries,
    ...sites.map((site) => join(site.siteDir, "alchemy.run.ts"))
  ]
  for (const path of entryPoints) {
    const module = await import(pathToFileURL(path).href)
    assert.ok(Effect.isEffect(module.default), `${path}: the CLI needs a default-exported stack effect`)
  }
})

test("stack properties and shared implementation typecheck against the declared Alchemy API", () => {
  const program = ts.createProgram({
    rootNames: [
      ...appEntries,
      join(root, "apps/docs/shared/alchemy-site.mjs"),
      ...sites.map((site) => join(site.siteDir, "alchemy.run.ts"))
    ],
    options: {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      allowJs: true,
      checkJs: true,
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ESNext
    }
  })
  const errors = ts.getPreEmitDiagnostics(program).filter((diagnostic) =>
    diagnostic.category === ts.DiagnosticCategory.Error
  )
  assert.equal(
    errors.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n"
    })
  )
})

test("app stacks retain their Worker routing and defer required redacted credentials", async () => {
  const [review, bugs] = await Promise.all(appEntries.map((path) => import(pathToFileURL(path).href)))
  // The live Worker, bucket, database and hostname observed on Cloudflare
  // 2026-09-23: Alchemy 1 names. Another name creates a second Worker and
  // empty storage beside the live ones.
  assert.equal(review.workerProps.name, "smithers-review-smithers-review-williamcory")
  assert.equal(review.walkthroughsProps.name, "smithers-review-walkthroughs-williamcory")
  assert.equal(review.reviewDbProps.name, "smithers-review-review-db-williamcory")
  assert.equal(review.workerProps.main, "src/server/worker.ts")
  assert.deepEqual(review.workerProps.domain, { name: "review.jjhub.tech", zoneId: "72854846f57d9e46794e7e6aae7e3328" })
  assert.deepEqual(review.workerProps.routes, [])
  assert.equal(review.workerProps.workersDev, true)
  assert.equal(review.workerProps.observability.enabled, true)
  assert.equal(review.workerProps.env.PUBLIC_BASE_URL, "https://review.jjhub.tech")
  assert.ok(Effect.isEffect(review.workerProps.env.WALKTHROUGHS))
  assert.ok(Effect.isEffect(review.workerProps.env.DB))

  // The live Worker, KV namespace and hostnames observed on Cloudflare 2026-09-23.
  // Another name creates a second Worker and an empty namespace; a declared
  // domain detaches every live hostname it does not list.
  assert.equal(bugs.workerProps.name, "smithers-bug-worker-smithers-bug-worker-williamcory")
  assert.equal(bugs.bugReportsProps.title, "smithers-bug-worker-bug-reports-williamcory")
  assert.equal(bugs.workerProps.main, "src/worker.ts")
  assert.deepEqual(bugs.workerProps.domain, { name: "bug.smithers.sh", aliases: ["bugs.smithers.sh"], zoneId: SMITHERS_ZONE_ID })
  // A workers.dev origin would serve the same routes outside the smithers.sh zone's rules.
  assert.equal(bugs.workerProps.workersDev, false)
  assert.deepEqual(bugs.workerProps.crons, ["*/10 * * * *"])
  assert.equal(bugs.workerProps.env.PUBLIC_BASE_URL, "https://bug.smithers.sh")
  assert.ok(Effect.isEffect(bugs.workerProps.env.BUGS))

  // A deploy from a shell without a binding's variable must fail, not delete the binding.
  const sender = bugs.workerProps.env.NOTIFICATION_FROM
  assert.ok(Config.isConfig(sender), "NOTIFICATION_FROM: resolve only while evaluating the stack")
  assert.equal(Effect.runSyncExit(sender.parse(ConfigProvider.fromUnknown({})))._tag, "Failure")
  assert.equal(Effect.runSyncExit(sender.parse(ConfigProvider.fromUnknown({ NOTIFICATION_FROM: "  " })))._tag, "Failure")
  assert.equal(
    Effect.runSync(sender.parse(ConfigProvider.fromUnknown({ NOTIFICATION_FROM: " Smithers <reports@example.test> " }))),
    "Smithers <reports@example.test>"
  )

  const credentials = [
    [review.workerProps.env.REVIEW_PUBLISH_TOKEN, "REVIEW_PUBLISH_TOKEN"],
    [review.workerProps.env.ADMIN_TOKEN, "REVIEW_ADMIN_TOKEN"],
    [review.workerProps.env.METRICS_TOKEN, "REVIEW_METRICS_TOKEN"],
    [review.workerProps.env.ANTHROPIC_API_KEY, "REVIEW_ANTHROPIC_API_KEY"],
    [bugs.workerProps.env.BUG_ADMIN_TOKEN, "BUG_ADMIN_TOKEN"],
    [bugs.workerProps.env.RESEND_API_KEY, "RESEND_API_KEY"],
    [bugs.workerProps.env.GITHUB_FORK_TOKEN, "GITHUB_FORK_TOKEN"]
  ]
  for (const [config, name] of credentials) {
    assert.ok(Config.isConfig(config), `${name}: resolve credentials only while evaluating the stack`)
    assert.equal(Effect.runSyncExit(config.parse(ConfigProvider.fromUnknown({})))._tag, "Failure")
    assert.equal(Effect.runSyncExit(config.parse(ConfigProvider.fromUnknown({ [name]: "  " })))._tag, "Failure")
    const value = Effect.runSync(
      config.parse(ConfigProvider.fromUnknown({ [name]: "  deployment-test-placeholder  " }))
    )
    assert.ok(Redacted.isRedacted(value))
    assert.equal(Redacted.value(value), "deployment-test-placeholder")
  }
})

test("every hostname has one owning Worker, in this repository or in the canary manifest", async () => {
  // A zone route wins over a custom domain on the same hostname, so a second
  // claim is never a fallback: it is a Worker nobody can reach, deployed and
  // tested as if it were live.
  const owners = new Map()
  const claim = (host, worker) => owners.set(host, new Set([...(owners.get(host) ?? []), worker]))
  const apps = join(root, "apps")
  for (const app of readdirSync(apps)) {
    const wranglerPath = join(apps, app, "wrangler.jsonc")
    if (existsSync(wranglerPath)) {
      const { config, error } = ts.parseConfigFileTextToJson(wranglerPath, readFileSync(wranglerPath, "utf8"))
      assert.equal(error, undefined, wranglerPath)
      for (const route of config.routes ?? []) claim(route.pattern.split("/")[0], config.name)
    }
    const stackPath = join(apps, app, "alchemy.run.ts")
    if (existsSync(stackPath)) {
      const stack = await import(pathToFileURL(stackPath).href)
      for (const props of Object.values(stack)) {
        if (typeof props !== "object" || props === null || !("domain" in props)) continue
        for (const host of [props.domain.name, ...(props.domain.aliases ?? [])]) claim(host, props.name)
      }
    }
  }
  const { docsSiteProps } = await import("../../docs/shared/alchemy-site.mjs")
  for (const site of sites) claim(site.domain, docsSiteProps(site.slug).name)
  // Deployed from another repository and probed by the canary.
  const { BACKING_WORKERS, RETIRED_WORKERS } = await import("../../server/scripts/canary/workers-manifest.ts")
  for (const worker of [...BACKING_WORKERS, ...RETIRED_WORKERS]) {
    for (const origin of [worker.origin, ...worker.alternateOrigins]) {
      if (origin !== undefined) claim(new URL(origin).hostname, `${worker.name} (canary manifest)`)
    }
  }
  const contested = [...owners].filter(([, workers]) => workers.size > 1).map(([host, workers]) => `${host}: ${[...workers].join(", ")}`)
  assert.deepEqual(contested, [])
})

test("docs sites derive the live Alchemy 1 Worker name and hostname from the slug alone", async (t) => {
  const { docsSiteProps } = await import("../../docs/shared/alchemy-site.mjs")
  // A leftover override from an operator shell must not rename a live Worker.
  const previous = new Map(["CORE_WORKER_NAME", "CORE_SITE_DOMAIN", "CLOUDFLARE_SMITHERS_ZONE_ID"].map((name) => [name, process.env[name]]))
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  Object.assign(process.env, { CORE_WORKER_NAME: "other", CORE_SITE_DOMAIN: "other.example", CLOUDFLARE_SMITHERS_ZONE_ID: "other-zone" })
  // Two Workers observed on Cloudflare 2026-09-23, verbatim.
  assert.equal(docsSiteProps("core").name, "smithers-docs-core-smithers-docs-core-williamcory")
  assert.equal(docsSiteProps("platform-node").name, "smithers-docs-platform-node-smithers-docs-platform-node-williamcory")
  for (const site of sites) {
    const props = docsSiteProps(site.slug)
    assert.equal(props.name, `smithers-docs-${site.slug}-smithers-docs-${site.slug}-williamcory`)
    assert.deepEqual(props.domain, { name: site.domain, zoneId: SMITHERS_ZONE_ID })
    assert.equal(props.workersDev, false)
    assert.equal(props.command, "pnpm run build")
    assert.equal(props.outdir, "dist")
  }
})

test("every shared-state stack plans against one record under stage prod", () => {
  const read = (path) => readFileSync(join(root, path), "utf8")
  // Local state lives in a gitignored .alchemy/ on whichever machine deployed
  // last, and the CLI's default stage is dev_$USER, so either one gives each
  // machine its own view of production.
  const stacks = [
    { stack: "apps/review/alchemy.run.ts", pkg: "apps/review/package.json" },
    { stack: "apps/bug-worker/alchemy.run.ts", pkg: "apps/bug-worker/package.json" },
    ...sites.map((site) => ({ stack: "apps/docs/shared/alchemy-site.mjs", pkg: `apps/docs/${site.slug}/package.json` }))
  ]
  for (const { stack, pkg } of stacks) {
    const source = read(stack)
    assert.ok(source.includes("state: Cloudflare.state()"), `${stack}: state must live in the account's alchemy-state-store`)
    assert.ok(!source.includes("localState"), `${stack}: local state is one machine's view`)
    const scripts = Object.values(JSON.parse(read(pkg)).scripts).filter((script) => script.startsWith("alchemy "))
    assert.deepEqual(scripts.sort(), [
      "alchemy deploy --dry-run --stage prod",
      "alchemy deploy --stage prod",
      "alchemy destroy --stage prod"
    ], pkg)
  }
  for (const site of sites) {
    assert.match(read(`apps/docs/${site.slug}/alchemy.run.ts`), new RegExp(`makeDocsSiteStack\\(\\{ slug: "${site.slug}" \\}\\)`))
  }
})

test("documented deploy commands hand Alchemy its flags directly", () => {
  // pnpm 11 forwards a literal `--` to the script, and Alchemy's CLI reads
  // every argument after `--` as the main file: `run deploy -- --adopt`
  // looks for a file named --adopt and never adopts.
  const docs = [
    "apps/bug-worker/README.md",
    "apps/bug-worker/alchemy.run.ts",
    "apps/review/CONTRIBUTING.md",
    "apps/review/alchemy.run.ts",
    "apps/docs/README.md",
    ...sites.map((site) => `apps/docs/${site.slug}/alchemy.run.ts`)
  ]
  for (const path of docs) {
    assert.doesNotMatch(readFileSync(join(root, path), "utf8"), /(run (plan|deploy|destroy)|docs:deploy) -- /, path)
  }
})
