/** Worker ports for the shared deterministic rollout. All commands and reads are bounded. */
import { join } from "node:path"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { parseDeployedVersions } from "./canary/rollback-verdict"
import type { Release, RolloutHost, RolloutReceipt } from "../../../flows/rollout/runtime.ts"

export interface WorkerRolloutOptions {
  previous: Release
  serverDir: string
  accountId: string
  worker: string
  token: string
  inviteConfigured: boolean
  fenceExecution?: string
  beforePublish?(): Promise<void>
  publish(): Promise<Release>
  record(receipt: RolloutReceipt): Promise<void>
  run(cmd: readonly string[], options: { cwd: string; capture?: boolean; env?: Record<string, string>; timeout?: number }): Promise<{ exitCode: number; output: string }>
  get?: (path: string) => Promise<unknown>
  sleep?: (ms: number) => Promise<void>
}

export const workerRolloutHost = (options: WorkerRolloutOptions): RolloutHost => {
  const origin = "https://canary.smithers.sh"
  const base = `/accounts/${options.accountId}/workers/scripts/${options.worker}`
  const get = options.get ?? (async (path: string) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { authorization: `Bearer ${options.token}` }, signal: AbortSignal.timeout(30_000), redirect: "error"
    })
    if (!response.ok) throw new Error("Cloudflare read failed")
    return response.json()
  })
  const sleep = options.sleep ?? (ms => Bun.sleep(ms))
  const command = (args: readonly string[], timeout = 30_000) => options.run(args, { cwd: options.serverDir, timeout,
    env: { CLOUDFLARE_ACCOUNT_ID: options.accountId } })
  const checks = ["CN-1", "site", "CN-18", ...(options.inviteConfigured ? ["CN-23"] : []), "CN-24"]
  return {
    checks,
    ...(options.fenceExecution ? { previousChecks: ["CN-24", "cutover-fence"] } : {}),
    skippedChecks: options.inviteConfigured ? [] : ["CN-23"],
    capture: async () => options.previous,
    ...(options.beforePublish ? { beforePublish: options.beforePublish } : {}),
    publish: options.publish,
    record: options.record,
    restore: async previous => {
      const result = await command(["node", join(options.serverDir, "node_modules/wrangler/bin/wrangler.js"),
        "rollback", previous.version, "--yes", "--message", "Automatic rollback: required rollout check failed"], 120_000)
      if (result.exitCode !== 0) throw new Error("Rollback command failed")
    },
    check: async (name, release) => {
      let passed = false
      if (name === "CN-24") {
        // Query the recorded target by ID. Newer uploads and list ordering cannot change it.
        const target = await get(`${base}/versions/${options.previous.version}`) as { success?: boolean; result?: { id?: string } }
        const live = parseDeployedVersions(await get(`${base}/deployments`))
        passed = target.success === true && target.result?.id === options.previous.version && live.ok &&
          live.value.length === 1 && live.value[0]?.id === release.version && live.value[0]?.percentage === 100
      } else if (name === "cutover-fence") {
        const response = await fetch(`${origin}/api/user`, { signal: AbortSignal.timeout(30_000), redirect: "error" })
        const body = await response.json() as { code?: string; executionID?: string }
        passed = response.status === 503 && response.headers.get("cache-control") === "no-store" &&
          body.code === "cutover_maintenance" && body.executionID === options.fenceExecution
      } else {
        const args = name === "CN-1" ? ["scripts/canary/build-probe.ts", origin, "--sha", release.revision]
          : name === "site" ? ["scripts/canary/site-probe.ts", "canary.smithers.sh"]
          : name === "CN-18" ? ["scripts/canary/workers-health.ts"]
          : name === "CN-23" ? ["scripts/canary/invite-probe.ts"] : null
        if (!args) throw new Error("Unknown required check")
        for (let attempt = 0; attempt < (name === "CN-1" ? 3 : 1); attempt++) {
          if ((await command(["bun", ...args])).exitCode === 0) { passed = true; break }
          if (name === "CN-1" && attempt < 2) await sleep(20_000)
        }
      }
      return { status: passed ? "passed" : "failed" }
    }
  }
}

/** Atomic replacement prevents a partially written recovery target. */
export const writeRolloutReceipt = (directory: string, receipt: RolloutReceipt): void => {
  mkdirSync(directory, { recursive: true })
  const content = `${JSON.stringify(receipt, null, 2)}\n`
  for (const name of [`${receipt.startedAt.replace(/[:.]/g, "-")}.json`, "latest.json"]) {
    const path = join(directory, name)
    writeFileSync(`${path}.tmp`, content, { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }
}
