/**
 * Scripted deploy: build the smithers.sh Astro site (apps/site), which carries
 * the product app as a prerendered React island, then deploy this package's
 * Worker with `wrangler deploy` over wrangler.jsonc, recording a receipt (git
 * sha + timestamp + Cloudflare version id) either way.
 *
 *   bun scripts/deploy.ts --dry-run
 *     Runs the real site build, then `wrangler deploy --dry-run`, which
 *     bundles src/index.ts, reads the assets directory and prints the
 *     bindings it would upload without touching the account. Nothing is
 *     published. Receipt lands in deploy-receipts/dry-run/.
 *
 *   bun scripts/deploy.ts
 *     Real deploy. Requires CLOUDFLARE_API_TOKEN and a clean commit already
 *     on origin/main; CLOUDFLARE_ACCOUNT_ID defaults to the frozen account.
 *     Runs scripts/adopt-durable-objects.ts first and stops on a red report,
 *     then `wrangler deploy --tag <sha12> --message "<sha> <subject>"`.
 *     Receipt lands in deploy-receipts/. The Deploy apps workflow runs this
 *     on every push to main; see DEPLOY.md.
 *
 * The Worker identity (name `smithers-mvp-web`, the canary.smithers.sh domain,
 * the apex route, the five Durable Objects) is frozen in src/workerIdentity.ts
 * and held to wrangler.jsonc by src/workerIdentity.test.ts; see
 * apps/server/DEPLOY.md. This script never changes it; it only builds and
 * deploys what's there.
 *
 * SECRETS ARE NOT AN INPUT. wrangler uploads with `keep_bindings:
 * ["secret_text"]`, so every secret set once with `wrangler secret put` stays
 * on the script across deploys, and this shell never has to carry a value.
 * The deploy path before this one (Alchemy, 2026-09-10 to 2026-09-12) replaced
 * the bindings wholesale and so could not run without all eleven values in
 * the shell, which nobody had; it never deployed.
 *
 * CN-1: the receipt records the sha the site build was stamped with, not a sha
 * read afterwards, so `scripts/canary/build-probe.ts` can hold the deployment
 * to the claim.
 */
import { rollout, type RolloutReceipt } from "../../../flows/rollout/runtime.ts"
import { workerRolloutHost, writeRolloutReceipt } from "./rollout"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { WORKER_IDENTITY } from "../src/workerIdentity"
import { judgeRevision, readRevisionFacts, wranglerDeployArgs } from "./deployRevision"
import { readWranglerConfig } from "../src/wranglerConfig"
import { artifactDigest, authorizeActivation, classifyLocal, DeployGuardRefusal, liveFactsFromCloudflare, preflightDeploy, sha256, verifyActivated, type ActivationAuthorization, type GuardDecision } from "./deployGuard"

const dryRun = process.argv.includes("--dry-run")

/*
 * Cutover interlock (scripts/deployGuard.ts). The first act of a real deploy,
 * before any revision read, build or wrangler spawn: this checkout's entry
 * against the live version's entry and annotations. Normal CI cannot undo a
 * live cutover-installer version, cannot bring the legacy writer back over the
 * shared edge, and cannot activate the edge except over the final fence with
 * the release gate's authorization. Anything unrecognized refuses.
 */
const guardRefused = (error: unknown): never => {
  console.error(`[deploy] cutover interlock refused: ${error instanceof DeployGuardRefusal ? error.message : "DEPLOY_GUARD_UNCLASSIFIED"}`)
  process.exit(1)
}
let guard: GuardDecision | null = null
try {
  const local = classifyLocal(readWranglerConfig().main, WORKER_IDENTITY.entry)
  if (dryRun) console.log(`[deploy] cutover interlock: dry run of the ${local} entry; the live version is not read.`)
  else {
    guard = await preflightDeploy(WORKER_IDENTITY.name, readWranglerConfig().main, WORKER_IDENTITY.entry)
    console.log(`[deploy] cutover interlock: ${guard.mode} (local ${guard.local}, live ${guard.live} ${guard.liveVersion})`)
  }
} catch (error) { guardRefused(error) }

const serverDir = fileURLToPath(new URL("..", import.meta.url))
const uiDir = fileURLToPath(new URL("../../app", import.meta.url))
const siteDir = fileURLToPath(new URL("../../site", import.meta.url))
/**
 * This package's own wrangler (a devDependency, so the version is the
 * lockfile's), on its JavaScript entry: no shell shim, no PATH lookup, and
 * the same binary under pnpm, bun and CI.
 */
const wrangler = (...args: ReadonlyArray<string>): ReadonlyArray<string> => [
  "node",
  `${serverDir}node_modules/wrangler/bin/wrangler.js`,
  ...args
]

const run = async (
  cmd: ReadonlyArray<string>,
  options: { cwd: string; capture?: boolean; env?: Record<string, string>; timeout?: number }
): Promise<{ exitCode: number; output: string }> => {
  const proc = Bun.spawn([...cmd], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdout: options.capture === true ? "pipe" : "inherit",
    stderr: "inherit"
  })
  const timer = setTimeout(() => proc.kill("SIGKILL"), options.timeout ?? 600_000)
  const output = options.capture === true ? await new Response(proc.stdout).text() : ""
  if (options.capture === true) process.stdout.write(output)
  const exitCode = await proc.exited
  clearTimeout(timer)
  return { exitCode, output }
}

/*
 * The sha is read BEFORE the build, not after, because the build consumes it:
 * the site's build-stamp integration (apps/site/scripts/build-stamp-integration.ts,
 * over apps/app/scripts/build-stamp.ts) writes SMITHERS_BUILD_SHA into the
 * build as /__build.json and as a meta tag on the app document. The receipt
 * below records the sha read back from that file, so the deployment and the
 * receipt can be compared byte for byte; that comparison is CN-1, and
 * scripts/canary/build-probe.ts runs it.
 *
 * A real deploy ships only a clean commit already on origin/main
 * (scripts/deployRevision.ts); a dry run may be dirty or unpushed and records
 * the dirty tree rather than hiding it.
 */
const facts = await readRevisionFacts({ cwd: serverDir, vcs: existsSync(join(serverDir, "../..", ".jj")) ? "jj" : "git" })
const verdict = judgeRevision(facts, dryRun ? "dry-run" : "real")
if (!verdict.ok) {
  console.error(`[deploy] refusing to deploy: ${verdict.detail}`)
  process.exit(1)
}
const gitSha = verdict.sha
const gitDirty = facts.dirty.length > 0
const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env
const runUrl =
  GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : null

/*
 * The island's sources are transformed under apps/app/tsconfig.json, which
 * extends the projected Electrobun devkit (gitignored), so a fresh checkout
 * cannot build the site until that projection exists. apps/app's own build ran
 * this step first; the site build does not, so it runs here.
 */
console.log(`[deploy] ensuring the Electrobun devkit projection in ${uiDir}...`)
const devkit = await run(["node", "scripts/ensure-devkit.mjs"], { cwd: uiDir })
if (devkit.exitCode !== 0) {
  console.error("[deploy] the devkit projection could not be prepared.")
  process.exit(devkit.exitCode)
}

console.log(`[deploy] building the smithers.sh site in ${siteDir}, stamped ${gitSha}${gitDirty ? " (dirty tree)" : ""}...`)
const build = await run(["pnpm", "run", "build"], { cwd: siteDir, env: { SMITHERS_BUILD_SHA: gitSha } })
if (build.exitCode !== 0) {
  console.error("[deploy] site build failed.")
  process.exit(build.exitCode)
}

/*
 * The stamp the build actually wrote is what the deployment will serve, so
 * the receipt reads it back instead of trusting the value it passed in. A
 * build that stamped something else (a stale dist, an integration that
 * stopped running) is caught here, before it is published as this commit.
 */
const stamp = JSON.parse(readFileSync(join(serverDir, WORKER_IDENTITY.assets.directory, "__build.json"), "utf8")) as {
  gitSha?: string
}
if (stamp.gitSha !== gitSha) {
  console.error(`[deploy] the site build is stamped ${stamp.gitSha ?? "<none>"}, not ${gitSha}; not deploying a build that names another commit.`)
  process.exit(1)
}

const apiToken = process.env.CLOUDFLARE_API_TOKEN
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? WORKER_IDENTITY.accountId
const wranglerEnv = { CLOUDFLARE_ACCOUNT_ID: accountId }

let versionId: string | null = null
let rolloutReceipt: RolloutReceipt | null = null
let activation: (ActivationAuthorization & { readonly artifactSHA256: string }) | null = null
let dryRunArtifactSHA256: string | null = null

if (dryRun) {
  const outdir = mkdtempSync(join(tmpdir(), "smithers-mvp-web-dry-run-"))
  console.log(`[deploy] dry-run: wrangler deploy --dry-run --outdir ${outdir} (bundles the Worker, reads the assets, publishes nothing)...`)
  const plan = await run(wrangler("deploy", "--dry-run", "--outdir", outdir), { cwd: serverDir, env: wranglerEnv })
  if (plan.exitCode !== 0) {
    console.error("[deploy] wrangler deploy --dry-run failed.")
    process.exit(plan.exitCode)
  }
  console.log("[deploy] the dry run reads no live script; run `bun scripts/adopt-durable-objects.ts` for the identity verdict.")
  // The digest an edge activation must match: the release gate records it from this rehearsal.
  dryRunArtifactSHA256 = artifactDigest(Object.fromEntries(readdirSync(outdir).filter(name => name.endsWith(".js")).map(name => [name, sha256(readFileSync(join(outdir, name)))])))
  console.log(`[deploy] artifact ${dryRunArtifactSHA256}`)
} else {
  if (apiToken === undefined || apiToken === "") {
    console.error("[deploy] CLOUDFLARE_API_TOKEN is unset; a real deploy needs it (see DEPLOY.md).")
    process.exit(1)
  }
  /*
   * Edge activation replaces the final fence with the exact artifact the
   * release gate rehearsed: bundle it, digest its code modules, and ask the
   * gate, which holds the production lease and the verified cutover and
   * import receipts. No authorization, no deploy.
   */
  if (guard?.mode === "activation") {
    const outdir = mkdtempSync(join(tmpdir(), "smithers-mvp-web-activation-"))
    const bundle = await run(wrangler("deploy", "--dry-run", "--outdir", outdir), { cwd: serverDir, env: wranglerEnv })
    if (bundle.exitCode !== 0) {
      console.error("[deploy] the activation artifact could not be bundled.")
      process.exit(bundle.exitCode)
    }
    const artifactSHA256 = artifactDigest(Object.fromEntries(readdirSync(outdir).filter(name => name.endsWith(".js")).map(name => [name, sha256(readFileSync(join(outdir, name)))])))
    try {
      activation = { ...authorizeActivation({ schema: "smithers-edge-activation-request/v1", worker: WORKER_IDENTITY.name, smithersRevision: gitSha, artifactSHA256,
        liveVersion: guard.liveVersion, cutoverExecutionID: guard.executionID }), artifactSHA256 }
    } catch (error) { guardRefused(error) }
    console.log(`[deploy] edge activation authorized by lease ${activation!.lockTag} for artifact ${artifactSHA256}`)
  }
  console.log("[deploy] identity preflight (scripts/adopt-durable-objects.ts)...")
  const preflight = await run(["bun", "scripts/adopt-durable-objects.ts"], { cwd: serverDir, env: wranglerEnv })
  if (preflight.exitCode !== 0) {
    console.error("[deploy] the preflight is red; not deploying. A Durable Object mismatch is data loss.")
    process.exit(preflight.exitCode)
  }
  // The live version the interlock judged must still be the one being replaced.
  try {
    if ((await liveFactsFromCloudflare(WORKER_IDENTITY.name)).versionId !== guard!.liveVersion) throw new DeployGuardRefusal("DEPLOY_GUARD_LIVE_CHANGED", "the live version changed after the interlock judged it")
  } catch (error) { guardRefused(error) }
  // Bind the rollback SHA to the captured live version before any mutation.
  let previousRevision = guard!.mode === "activation" ? guard!.executionID : ""
  if (!previousRevision) {
    const response = await fetch("https://canary.smithers.sh/__build.json", { signal: AbortSignal.timeout(30_000), redirect: "error" })
    const previousStamp = await response.json() as { gitSha?: string }
    if (!response.ok || !/^[a-f0-9]{40}$/.test(previousStamp.gitSha ?? "")) throw new Error("Previous build identity unavailable")
    previousRevision = previousStamp.gitSha!
  }
  rolloutReceipt = await rollout(workerRolloutHost({
    previous: { version: guard!.liveVersion, revision: previousRevision },
    serverDir, accountId, worker: WORKER_IDENTITY.name, token: apiToken,
    inviteConfigured: Boolean(process.env.IDENTITY_SERVICE_TOKEN || process.env.CANARY_ALLOWLIST_LOGINS),
    ...(guard!.mode === "activation" ? { fenceExecution: guard!.executionID } : {}),
    run,
    record: async receipt => {
      writeRolloutReceipt(join(serverDir, "deploy-receipts", "rollout"), receipt)
      console.log(`[deploy] rollout ${receipt.status}`)
    },
    beforePublish: async () => {
      // Baseline verification can take time; reject a moved target before publication.
      if ((await liveFactsFromCloudflare(WORKER_IDENTITY.name)).versionId !== guard!.liveVersion)
        throw new Error("Live deployment changed")
    },
    publish: async () => {
      const deploy = await run(wrangler(...wranglerDeployArgs(verdict)), { cwd: serverDir, env: wranglerEnv, capture: true })
      if (deploy.exitCode !== 0) throw new Error("Publish failed")
      versionId = deploy.output.match(/Current Version ID:\s*([0-9a-f-]{36})/)?.[1] ?? null
      if (versionId === null) throw new Error("Published version identity unavailable")
      if (activation) verifyActivated(await liveFactsFromCloudflare(WORKER_IDENTITY.name), activation.artifactSHA256)
      return { version: versionId, revision: gitSha }
    }
  }))
}

/*
 * `wranglerVersionId` is the key scripts/canary/rollback-verdict.ts reads.
 * `dryRunMode` names what a dry run proved (a bundle, never a live read).
 */
const receipt = {
  worker: WORKER_IDENTITY.name,
  dryRun,
  dryRunMode: dryRun ? "bundle" : null,
  deployTool: "wrangler",
  gitSha: rolloutReceipt?.status === "rolled-back" ? rolloutReceipt.previous.revision : gitSha,
  attemptedGitSha: gitSha,
  gitDirty,
  timestamp: new Date().toISOString(),
  wranglerVersionId: rolloutReceipt?.status === "rolled-back" ? rolloutReceipt.previous.version :
    rolloutReceipt?.status === "rollback-failed" ? null : versionId,
  rollout: rolloutReceipt,
  versionTag: verdict.tag,
  versionMessage: verdict.message,
  runUrl,
  artifactSHA256: dryRun ? dryRunArtifactSHA256 : activation?.artifactSHA256 ?? null,
  cutoverInterlock: guard === null ? null : { ...guard, activation }
}

const receiptDir = dryRun ? `${serverDir}deploy-receipts/dry-run` : `${serverDir}deploy-receipts`
mkdirSync(receiptDir, { recursive: true })
const receiptPath = `${receiptDir}/${receipt.timestamp.replace(/[:.]/g, "-")}.json`
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, "\t")}\n`)
writeFileSync(`${receiptDir}/latest.json`, `${JSON.stringify(receipt, null, "\t")}\n`)

console.log(`[deploy] receipt written to ${receiptPath}`)
if (rolloutReceipt && rolloutReceipt.status !== "passed") process.exitCode = 1
