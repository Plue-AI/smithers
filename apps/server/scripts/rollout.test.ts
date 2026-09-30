import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { artifactDigest, decideDeploy, preflightDeploy, readLiveFacts, verifyActivated } from "./deployGuard"
import { WORKER_IDENTITY } from "../src/workerIdentity"
import { dryRunChecks, readPreviousRevision, siteProbeTimeout, workerRolloutHost, writeRolloutReceipt } from "./rollout"
import { rollout } from "../../../flows/rollout/runtime.ts"

const previous = { version: "11111111-1111-1111-1111-111111111111", revision: "a".repeat(40) }
const next = { version: "22222222-2222-2222-2222-222222222222", revision: "b".repeat(40) }
test("Worker failing site probe invokes pinned rollback and checks restored SHA", async () => {
  let live = previous.version
  const commands: string[][] = []
  const host = workerRolloutHost({
    previous, serverDir: "/server/", accountId: "account", worker: "worker", token: "fake",
    publish: async () => { live = next.version; return next },
    record: async () => {},
    get: async path => path.endsWith("/deployments")
      ? { success: true, result: { deployments: [{ versions: [{ version_id: live, percentage: 100 }] }] } }
      : { success: true, result: { id: previous.version } },
    run: async cmd => {
      commands.push([...cmd])
      if (cmd.includes("rollback")) live = previous.version
      // Deliberately red executable probe; no deployment or credential required.
      const probe = Bun.spawnSync(["bun", "-e", `process.exit(${cmd.includes("scripts/canary/site-probe.ts") && live === next.version ? 1 : 0})`])
      return { exitCode: probe.exitCode, output: "" }
    },
    sleep: async () => {}
  })
  const result = await rollout(host)
  expect(result.status).toBe("rolled-back")
  expect(result.failedChecks).toEqual(["site"])
  const restore = commands.find(c => c.includes("rollback"))!
  expect(restore).toEqual(["node", "/server/node_modules/wrangler/bin/wrangler.js", "rollback", previous.version, "--yes", "--message", "Automatic rollback: required rollout check failed"])
  expect(commands.at(-3)).toContain(previous.revision)
  expect(result.skippedChecks).toEqual([])
})
test("CN-24 refuses a split deployment or missing captured target", async () => {
  for (const result of [{ success: true, result: { id: "other" } }, { success: false }]) {
    const host = workerRolloutHost({ previous, serverDir: "/server/", accountId: "account", worker: "worker", token: "fake",
      publish: async () => next, record: async () => {}, run: async () => ({ exitCode: 0, output: "" }), get: async () => result })
    await expect(host.check("CN-24", previous, "baseline")).resolves.toEqual({ status: "failed" })
  }
})

test("CN-18 fails a rollout without restoring its Worker", async () => {
  let live = previous.version
  const commands: string[][] = []
  const host = workerRolloutHost({ previous, serverDir: "/server/", accountId: "account", worker: "worker", token: "fake",
    publish: async () => { live = next.version; return next }, record: async () => {},
    get: async path => path.endsWith("/deployments")
      ? { success: true, result: { deployments: [{ versions: [{ version_id: live, percentage: 100 }] }] } }
      : { success: true, result: { id: previous.version } },
    run: async cmd => { commands.push([...cmd]); return { exitCode: cmd.includes("scripts/canary/workers-health.ts") ? 1 : 0, output: "" } } })
  const result = await rollout(host)
  expect(result.status).toBe("failed")
  expect(result.failedChecks).toEqual(["CN-18"])
  expect(commands.some(cmd => cmd.includes("rollback"))).toBe(false)
  expect(live).toBe(next.version)
})

test("the rollout requires exactly CN-1, site, CN-18 and CN-24, and refuses an unknown check", async () => {
  const host = workerRolloutHost({ previous, serverDir: "/server/", accountId: "account", worker: "worker", token: "fake",
    publish: async () => next, record: async () => {}, run: async () => ({ exitCode: 0, output: "" }) })
  expect(host.checks).toEqual(["CN-1", "site", "CN-18", "CN-24"])
  expect(host.skippedChecks).toBeUndefined()
  await expect(host.check("CN-23", next, "candidate")).rejects.toThrow("Unknown required check")
})


test("dry runs execute CN-18 alone and fail on a red exit or an error", async () => {
  for (const outcome of ["red", "throws"] as const) {
    const commands: string[][] = []
    const result = await dryRunChecks({ serverDir: "/server", accountId: "account",
      run: async (cmd, options) => {
        commands.push([...cmd])
        expect(options.timeout).toBe(30_000)
        if (outcome === "throws") throw Error("timeout secret")
        return { exitCode: 1, output: "" }
      } })
    expect(commands.map(c => c[1])).toEqual(["scripts/canary/workers-health.ts"])
    expect(result).toEqual({ checks: [{ name: "CN-18", status: "failed" }] })
    expect(JSON.stringify(result)).not.toContain("secret")
  }
  const green = await dryRunChecks({ serverDir: "/server", accountId: "account", run: async () => ({ exitCode: 0, output: "" }) })
  expect(green).toEqual({ checks: [{ name: "CN-18", status: "passed" }] })
})

test("unreadable previous build stamps write refusal evidence and never publish", async () => {
  for (const read of [async () => { throw Error("secret timeout") }, async () => new Response("invalid json"),
    async () => Response.json({ gitSha: "bad" }), async () => Response.json({ gitSha: previous.revision }, { status: 503 })]) {
    const receipts: unknown[] = []
    let published = false
    const host = workerRolloutHost({ previous: async () => ({ version: previous.version, revision: await readPreviousRevision(read) }),
      serverDir: "/server", accountId: "account", worker: "worker", token: "fake",
      publish: async () => { published = true; return next }, record: async r => { receipts.push(r) },
      run: async () => { throw Error("must not probe without identity") } })
    expect((await rollout(host)).status).toBe("refused")
    expect(receipts).toMatchObject([{ status: "refused", failedChecks: ["capture"], previous: null }])
    expect(published).toBe(false)
  }
})


test("a failed fix-forward writes verified rollback evidence and the next deploy succeeds", async () => {
  for (const restoreExitCode of [0, 1]) {
    const directory = mkdtempSync(join(tmpdir(), "worker-rollback-next-"))
    let live = previous.version
    let newest = previous.version
    const identity = { versionId: previous.version, entry: "edge.js", modules: ["edge.js"], annotations: {}, digests: { "edge.js": "a".repeat(64) } }
    let attempt = 1
    let restores = 0
    const get = async (path: string) => path.endsWith("/deployments")
      ? { success: true, result: { deployments: [{ versions: [{ version_id: live, percentage: 100 }] }] } }
      : path.endsWith("/versions?per_page=1") ? { success: true, result: { items: [{ id: newest }] } }
      : { success: true, result: { id: previous.version, annotations: {} } }
    try {
      const options = {
        previous, serverDir: "/server", accountId: WORKER_IDENTITY.accountId, worker: WORKER_IDENTITY.name, token: "fake",
        identity: { accountId: WORKER_IDENTITY.accountId, worker: WORKER_IDENTITY.name, target: identity }, get,
        publish: async () => { live = next.version; newest = next.version; return next },
        record: async (receipt: Parameters<typeof writeRolloutReceipt>[1]) => { writeRolloutReceipt(directory, receipt) },
        run: async (cmd: readonly string[]) => {
          if (cmd.includes("rollback")) { live = previous.version; restores++; return { exitCode: restoreExitCode, output: "" } }
          return { exitCode: cmd.includes("scripts/canary/site-probe.ts") && (attempt === 1 || live === previous.version) ? 1 : 0, output: "" }
        }
      }
      const first = await rollout(workerRolloutHost(options))
      expect(first.status).toBe(restoreExitCode === 0 ? "rolled-back" : "rollback-failed")
      expect(first.baseline.find(c => c.name === "site")?.status).toBe("failed")
      expect(first.reverification.find(c => c.name === "site")?.status).toBe("failed")
      const evidence = JSON.parse(readFileSync(join(directory, "last-rollback.json"), "utf8"))
      const guarded = await readLiveFacts(WORKER_IDENTITY.name, get as never, async () => { throw Error("newest content is not baseline") }, evidence)
      expect(decideDeploy(guarded).mode).toBe("normal")
      attempt = 2
      expect((await rollout(workerRolloutHost({ ...options, identity: { ...options.identity, target: guarded } }))).status).toBe("passed")
      expect(live).toBe(next.version)
      expect(restores).toBe(1)
      // A successful deploy retains the last rollback receipt, but it cannot admit another target.
      expect(JSON.parse(readFileSync(join(directory, "last-rollback.json"), "utf8"))).toEqual(evidence)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})

test("an activation whose published edge drifts restores the captured legacy version, and the next preflight is the activation again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "worker-activation-drift-"))
  const annotations = { "workers/message": `${previous.revision} legacy`, "workers/tag": previous.revision.slice(0, 12) }
  // The legacy version the interlock captured before publication (deploy.ts `capturedIdentity`).
  const legacy = { versionId: previous.version, entry: "index.js", modules: ["index.js"], annotations, digests: { "index.js": "a".repeat(64) } }
  const authorized = artifactDigest({ "edge.js": "b".repeat(64) })
  let live = previous.version, newest = previous.version
  const get = async (path: string) => path.endsWith("/deployments")
    ? { success: true, result: { deployments: [{ versions: [{ version_id: live, percentage: 100 }] }] } }
    : path.endsWith("/versions?per_page=1") ? { success: true, result: { items: [{ id: newest }] } }
    : { success: true, result: { id: path.split("/").at(-1), annotations: path.endsWith(previous.version) ? annotations : {} } }
  // content/v2 describes the newest upload: the published edge, whose code is not the bundled artifact.
  const content = async () => ({ entry: "edge.js", modules: ["edge.js"], digests: { "edge.js": "c".repeat(64) } })
  const commands: string[][] = []
  try {
    const receipt = await rollout(workerRolloutHost({
      previous, serverDir: "/server", accountId: WORKER_IDENTITY.accountId, worker: WORKER_IDENTITY.name, token: "fake",
      identity: { accountId: WORKER_IDENTITY.accountId, worker: WORKER_IDENTITY.name, target: legacy }, get,
      publish: async () => {
        live = next.version; newest = next.version
        verifyActivated(await readLiveFacts(WORKER_IDENTITY.name, get as never, content), authorized)
        return next
      },
      record: async r => { writeRolloutReceipt(directory, r) },
      run: async cmd => {
        commands.push([...cmd])
        if (cmd.includes("rollback")) live = previous.version
        return { exitCode: 0, output: "" }
      }
    }))
    expect(receipt).toMatchObject({ status: "rolled-back", rollback: "succeeded", failedChecks: ["publish"], candidate: null })
    expect(commands.find(c => c.includes("rollback"))).toContain(previous.version)
    expect(live).toBe(previous.version)
    const evidence = JSON.parse(readFileSync(join(directory, "last-rollback.json"), "utf8"))
    expect(evidence.recovery).toMatchObject({ newestVersion: next.version, target: legacy })
    // The newest upload is the rejected edge; only the receipt lets the guard read the restored legacy version.
    await expect(preflightDeploy(WORKER_IDENTITY.name, "src/edge.ts", "src/edge.ts", worker => readLiveFacts(worker, get as never, content))).rejects.toThrow("DEPLOY_GUARD_LIVE_NOT_NEWEST")
    const decision = await preflightDeploy(WORKER_IDENTITY.name, "src/edge.ts", "src/edge.ts", worker => readLiveFacts(worker, get as never, content, evidence))
    expect(decision).toMatchObject({ mode: "activation", local: "edge", live: "legacy", liveVersion: previous.version, record: { decision: "direct-switch" } })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("the sequential site probe gets its own timeout; other checks keep 30 s", async () => {
  const timeouts = new Map<string, number | undefined>()
  const host = workerRolloutHost({
    previous, serverDir: "/server/", accountId: "account", worker: "worker", token: "fake",
    publish: async () => next, record: async () => {},
    run: async (cmd, options) => { timeouts.set(cmd[1]!, options.timeout); return { exitCode: 0, output: "" } },
    sleep: async () => {}
  })
  for (const name of ["CN-1", "site", "CN-18"]) await host.check(name, next, "candidate")
  // The probe measured 43 s against canary.smithers.sh; a 30 s kill rolled back every release.
  expect(timeouts.get("scripts/canary/site-probe.ts")).toBe(siteProbeTimeout)
  expect(siteProbeTimeout).toBeGreaterThan(43_000 * 3)
  for (const probe of ["scripts/canary/build-probe.ts", "scripts/canary/workers-health.ts"])
    expect(timeouts.get(probe)).toBe(30_000)
})
