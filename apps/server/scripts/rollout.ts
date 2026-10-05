import { cloudflareApiBase } from "./cloudflareApi"
/** Worker ports for the shared deterministic rollout. All commands and reads are bounded. */
import { join } from "node:path"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { parseDeployedVersions } from "./canary/rollback-verdict"
import type { RecoveryEvidence } from "./deployGuard"
import type { CheckResult, Release, RolloutHost, RolloutReceipt } from "../../../flows/rollout/runtime.ts"

export interface WorkerRolloutOptions {
  previous: Release | (() => Promise<Release>)
  identity?: Omit<RecoveryEvidence, "newestVersion">
  serverDir: string
  accountId: string
  worker: string
  token: string
  beforePublish?(): Promise<void>
  publish(): Promise<Release>
  record(receipt: WorkerRolloutReceipt): Promise<void>
  run(cmd: readonly string[], options: { cwd: string; capture?: boolean; env?: Record<string, string>; timeout?: number }): Promise<{ exitCode: number; output: string }>
  get?: (path: string) => Promise<unknown>
  sleep?: (ms: number) => Promise<void>
}

export type WorkerRolloutReceipt = RolloutReceipt & { recovery?: RecoveryEvidence }

export const workerRolloutHost = (options: WorkerRolloutOptions): RolloutHost => {
  const origin = "https://canary.smithers.sh"
  const base = `/accounts/${options.accountId}/workers/scripts/${options.worker}`
  const get = options.get ?? (async (path: string) => {
    const response = await fetch(`${cloudflareApiBase}${path}`, {
      headers: { authorization: `Bearer ${options.token}` }, signal: AbortSignal.timeout(30_000), redirect: "error"
    })
    if (!response.ok) throw new Error("Cloudflare read failed")
    return response.json()
  })
  const sleep = options.sleep ?? (ms => Bun.sleep(ms))
  const command = (args: readonly string[], timeout = 30_000) => options.run(args, { cwd: options.serverDir, timeout,
    env: { CLOUDFLARE_ACCOUNT_ID: options.accountId } })
  let previous: Release
  let recovery: RecoveryEvidence | undefined = options.identity ? { ...options.identity, newestVersion: options.identity.target.versionId } : undefined
  return {
    lastReceipt: async () => readRolloutReceipt(join(options.serverDir, "deploy-receipts", "rollout", "latest.json")),
    checks: ["CN-1", "site", "CN-18", "CN-24"],
    rollbackChecks: ["CN-1", "site", "CN-24"],
    capture: async () => {
      previous = typeof options.previous === "function" ? await options.previous() : options.previous
      return previous
    },
    ...(options.beforePublish ? { beforePublish: options.beforePublish } : {}),
    publish: options.publish,
    record: receipt => options.record({ ...receipt, ...(recovery ? { recovery } : {}) }),
    restore: async previous => {
      try {
        const result = await command(["node", join(options.serverDir, "node_modules/wrangler/bin/wrangler.js"),
          "rollback", previous.version, "--yes", "--message", "Automatic rollback: required rollout check failed"], 120_000)
        if (result.exitCode !== 0) throw new Error("Rollback command failed")
      } finally {
        // A failed command can still have restored traffic. CN-24 verifies that separately.
        if (options.identity) {
          const versions = await get(`${base}/versions?per_page=1`) as { success?: boolean; result?: { items?: Array<{ id: string }> } }
          const newestVersion = versions.result?.items?.[0]?.id
          if (!versions.success || !newestVersion) throw new Error("Rollback evidence unavailable")
          recovery = { ...options.identity, newestVersion }
        }
      }
    },
    check: async (name, release) => {
      let passed = false
      if (name === "CN-24") {
        // Query the recorded target by ID. Newer uploads and list ordering cannot change it.
        const target = await get(`${base}/versions/${(previous ?? release).version}`) as { success?: boolean; result?: { id?: string } }
        const live = parseDeployedVersions(await get(`${base}/deployments`))
        passed = target.success === true && target.result?.id === (previous ?? release).version && live.ok &&
          live.value.length === 1 && live.value[0]?.id === release.version && live.value[0]?.percentage === 100
      } else {
        const args = name === "CN-1" ? ["scripts/canary/build-probe.ts", origin, "--sha", release.revision]
          : name === "site" ? ["scripts/canary/site-probe.ts", "canary.smithers.sh"]
          : name === "CN-18" ? ["scripts/canary/workers-health.ts"] : null
        if (!args) throw new Error("Unknown required check")
        for (let attempt = 0; attempt < (name === "CN-1" ? 3 : 1); attempt++) {
          if ((await command(["bun", ...args], name === "site" ? siteProbeTimeout : undefined)).exitCode === 0) {
            passed = true
            break
          }
          if (name === "CN-1" && attempt < 2) await sleep(20_000)
        }
      }
      return { status: passed ? "passed" : "failed" }
    }
  }
}

/** Missing history permits a first deploy; unreadable or malformed history must refuse it. */
const readRolloutReceipt = (path: string): RolloutReceipt | null => {
  let content: string
  try { content = readFileSync(path, "utf8") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  const receipt: unknown = JSON.parse(content)
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
  const release = (value: unknown) => value === null || (object(value) && text(value.version) && text(value.revision))
  const checks = (value: unknown) => Array.isArray(value) && value.every(check => object(check) && text(check.name) && ["passed", "failed"].includes(check.status as string))
  const strings = (value: unknown) => Array.isArray(value) && value.every(text)
  if (!object(receipt) || !text(receipt.startedAt) || !Number.isFinite(Date.parse(receipt.startedAt)) ||
    !text(receipt.updatedAt) || !Number.isFinite(Date.parse(receipt.updatedAt)) ||
    !["captured", "prepared", "publishing", "checking", "restoring", "passed", "failed", "refused", "rolled-back", "rollback-failed"].includes(receipt.status as string) ||
    !release(receipt.previous) || !release(receipt.candidate) || !checks(receipt.baseline) || !checks(receipt.checks) ||
    !checks(receipt.reverification) || !strings(receipt.failedChecks) || !strings(receipt.skippedChecks) ||
    !["not-needed", "succeeded", "failed"].includes(receipt.rollback as string)) throw new Error("Invalid rollout receipt")
  return receipt as unknown as RolloutReceipt
}

/**
 * The site probe reads its few hundred legacy aliases one at a time (see
 * site-checks.ts); against canary.smithers.sh that took 43 s on 2026-09-28, so
 * the 30 s default killed a passing probe and rolled back every release.
 */
export const siteProbeTimeout = 300_000

/** Atomic replacement prevents a partially written recovery target. */
export const writeRolloutReceipt = (directory: string, receipt: WorkerRolloutReceipt): void => {
  mkdirSync(directory, { recursive: true })
  const content = `${JSON.stringify(receipt, null, 2)}\n`
  const names = [`${receipt.startedAt.replace(/[:.]/g, "-")}.json`, "latest.json"]
  if (receipt.recovery && receipt.rollback !== "not-needed" && ["rolled-back", "rollback-failed"].includes(receipt.status))
    names.push("last-rollback.json")
  for (const name of names) {
    const path = join(directory, name)
    writeFileSync(`${path}.tmp`, content, { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }
}

/** Read-only checks still run during a rehearsal; they cannot publish or restore. */
export const dryRunChecks = async (options: Pick<WorkerRolloutOptions, "run" | "serverDir" | "accountId">): Promise<{ checks: CheckResult[] }> => {
  const host = workerRolloutHost({ ...options, previous: { version: "dry-run", revision: "dry-run" }, worker: "", token: "",
    publish: async () => { throw new Error("Dry run cannot publish") }, record: async () => {} })
  const name = "CN-18"
  try { return { checks: [{ name, ...(await host.check(name, { version: "dry-run", revision: "dry-run" }, "candidate")) }] } }
  catch { return { checks: [{ name, status: "failed" }] } }
}

/** Called inside capture so HTTP/JSON/timeout failures produce a refused receipt. */
export const readPreviousRevision = async (read: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<string> => {
  const response = await read("https://canary.smithers.sh/__build.json", { signal: AbortSignal.timeout(30_000), redirect: "error" })
  const stamp = await response.json() as { gitSha?: string }
  if (!response.ok || !/^[a-f0-9]{40}$/.test(stamp.gitSha ?? "")) throw new Error("Previous build identity unavailable")
  return stamp.gitSha!
}
