import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readLiveFacts, decideDeploy } from "./deployGuard"
import { WORKER_IDENTITY } from "../src/workerIdentity"
import { dryRunChecks, readPreviousRevision, workerRolloutHost, writeRolloutReceipt } from "./rollout"
import { rollout } from "../../../flows/rollout/runtime.ts"

const previous = { version: "11111111-1111-1111-1111-111111111111", revision: "a".repeat(40) }
const next = { version: "22222222-2222-2222-2222-222222222222", revision: "b".repeat(40) }
test("Worker failing site probe invokes pinned rollback and checks restored SHA", async () => {
  let live = previous.version
  const commands: string[][] = []
  const host = workerRolloutHost({
    previous, serverDir: "/server/", accountId: "account", worker: "worker", token: "fake",
    inviteConfigured: false,
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
  expect(result.skippedChecks).toEqual(["CN-23"])
})
test("CN-24 refuses a split deployment or missing captured target", async () => {
  for (const result of [{ success: true, result: { id: "other" } }, { success: false }]) {
    const host = workerRolloutHost({ previous, serverDir: "/server/", accountId: "account", worker: "worker", token: "fake", inviteConfigured: false,
      publish: async () => next, record: async () => {}, run: async () => ({ exitCode: 0, output: "" }), get: async () => result })
    await expect(host.check("CN-24", previous, "baseline")).resolves.toEqual({ status: "failed" })
  }
})

test("CN-18 and CN-23 fail a rollout without restoring its Worker", async () => {
  for (const failed of ["scripts/canary/workers-health.ts", "scripts/canary/invite-probe.ts"]) {
    let live = previous.version
    const commands: string[][] = []
    const host = workerRolloutHost({ previous, serverDir: "/server/", accountId: "account", worker: "worker", token: "fake", inviteConfigured: true,
      publish: async () => { live = next.version; return next }, record: async () => {},
      get: async path => path.endsWith("/deployments")
        ? { success: true, result: { deployments: [{ versions: [{ version_id: live, percentage: 100 }] }] } }
        : { success: true, result: { id: previous.version } },
      run: async cmd => { commands.push([...cmd]); return { exitCode: cmd.includes(failed) ? 1 : 0, output: "" } } })
    expect((await rollout(host)).status).toBe("failed")
    expect(commands.some(cmd => cmd.includes("rollback"))).toBe(false)
    expect(live).toBe(next.version)
  }
})


test("dry runs execute upstream checks, fail on errors, and explicitly skip unconfigured invites", async () => {
  for (const inviteConfigured of [true, false]) {
    const commands: string[][] = []
    const result = await dryRunChecks({ serverDir: "/server", accountId: "account", inviteConfigured,
      run: async (cmd, options) => {
        commands.push([...cmd])
        expect(options.timeout).toBe(30_000)
        if (cmd.includes("scripts/canary/workers-health.ts")) throw Error("timeout secret")
        return { exitCode: 1, output: "" }
      } })
    expect(commands.map(c => c[1])).toEqual(["scripts/canary/workers-health.ts", ...(inviteConfigured ? ["scripts/canary/invite-probe.ts"] : [])])
    expect(result.checks.every(c => c.status === "failed")).toBe(true)
    expect(result.skippedChecks).toEqual(inviteConfigured ? [] : ["CN-23"])
    expect(JSON.stringify(result)).not.toContain("secret")
  }
})

test("unreadable previous build stamps write refusal evidence and never publish", async () => {
  for (const read of [async () => { throw Error("secret timeout") }, async () => new Response("invalid json"),
    async () => Response.json({ gitSha: "bad" }), async () => Response.json({ gitSha: previous.revision }, { status: 503 })]) {
    const receipts: unknown[] = []
    let published = false
    const host = workerRolloutHost({ previous: async () => ({ version: previous.version, revision: await readPreviousRevision(read) }),
      serverDir: "/server", accountId: "account", worker: "worker", token: "fake", inviteConfigured: false,
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
    const identity = { versionId: previous.version, entry: "index.js", modules: ["index.js"], annotations: {}, digests: { "index.js": "a".repeat(64) } }
    let attempt = 1
    let restores = 0
    const get = async (path: string) => path.endsWith("/deployments")
      ? { success: true, result: { deployments: [{ versions: [{ version_id: live, percentage: 100 }] }] } }
      : path.endsWith("/versions?per_page=1") ? { success: true, result: { items: [{ id: newest }] } }
      : { success: true, result: { id: previous.version, annotations: {} } }
    try {
      const options = {
        previous, serverDir: "/server", accountId: WORKER_IDENTITY.accountId, worker: WORKER_IDENTITY.name, token: "fake", inviteConfigured: false,
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
      expect(decideDeploy("legacy", guarded).mode).toBe("normal")
      attempt = 2
      expect((await rollout(workerRolloutHost({ ...options, identity: { ...options.identity, target: guarded } }))).status).toBe("passed")
      expect(live).toBe(next.version)
      expect(restores).toBe(1)
      // A successful deploy retains the last rollback receipt, but it cannot admit another target.
      expect(JSON.parse(readFileSync(join(directory, "last-rollback.json"), "utf8"))).toEqual(evidence)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})
