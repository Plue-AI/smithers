/** Implementations behind the burndown monitor. */
import { Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { Diagnose, Inspect, Report } from "./loop.ts"

const run = promisify(execFile)
const timeout = 15_000

const localEnvironment = () => {
  const env = { ...process.env }
  for (const key of ["SMITHERS_REMOTE", "SMITHERS_TOKEN", "SMITHERS_BACKEND", "DATABASE_URL"]) delete env[key]
  return env
}

const clean = (value: string) => value.replace(/[\s\p{Cc}]+/gu, " ").trim()

/** Inspect only the requested run in the watched host's database. */
export const inspectRun = async (runId: string, hostRoot: string, timeoutMs = timeout): Promise<{
  state: "live" | "terminal" | "unknown"
  evidence: string
  healthy: boolean
}> => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return { state: "unknown", healthy: false, evidence: "## run (unknown)\nInvalid inspection timeout." }
  }
  try {
    const { stdout } = await run("smthrs", ["runs", "show", runId, "--json", "--root", hostRoot], {
      env: localEnvironment(),
      cwd: hostRoot,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 8 << 20
    })
    const value = JSON.parse(stdout)
    const row = value?._tag === "runs"
      ? value.items?.find((item: { runId?: string }) => item.runId === runId)
      : value
    const status = row?.runId === runId ? row.status : undefined
    const state = ["completed", "failed", "cancelled"].includes(status)
      ? "terminal"
      : ["accepted", "running", "parked", "waiting-approval"].includes(status)
      ? "live"
      : "unknown"
    return {
      state,
      healthy: state !== "unknown" && status !== "failed" && status !== "cancelled",
      evidence: `## run (${state})\n${stdout.slice(-6000)}`
    }
  } catch {
    // CLI diagnostics can contain credentials; retain the failure without echoing them.
    return { state: "unknown", healthy: false, evidence: "## run (unknown)\nInspection failed or timed out." }
  }
}

export const captureEvidence = (label: string, file: string, args: Array<string>, hostRoot: string) =>
  run(file, args, { env: localEnvironment(), cwd: hostRoot, timeout, killSignal: "SIGKILL", maxBuffer: 8 << 20 }).then(
    ({ stdout }) => ({ failed: false, evidence: `## ${label}\n${stdout.slice(-6000)}` }),
    (error: { code?: number }) =>
      file === "pgrep" && error.code === 1
        ? { failed: false, evidence: `## ${label}\n(none)` }
        : { failed: true, evidence: `## ${label} (failed)\nInspection failed or timed out.` }
  )

const text = (label: string, path: string) =>
  readFile(path, "utf8").then((body) => `## ${label}\n${body.slice(-6000)}`, () => `## ${label}\n(absent)`)

/** Retain the health receipt before deciding whether another round is needed. */
export const reportRun = async ({ runId, hostRoot, reportRoot, verdict, inspectedHealthy }: {
  runId: string
  hostRoot: string
  reportRoot: string
  verdict: { healthy: boolean; findings: ReadonlyArray<string>; actions: ReadonlyArray<string> }
  inspectedHealthy: boolean
}): Promise<boolean> => {
  const inspection = await inspectRun(runId, hostRoot)
  const healthy = inspection.healthy && inspectedHealthy && verdict.healthy
  const findings = inspection.state === "unknown"
    ? ["Run inspection unknown", ...verdict.findings]
    : verdict.findings
  const line = `${new Date().toISOString()} ${clean(runId)} ${healthy ? "HEALTHY" : "UNHEALTHY"} ${
    findings.map(clean).join(" | ")
  }${verdict.actions.length === 0 ? "" : ` => ${verdict.actions.map(clean).join(" | ")}`}\n`
  await mkdir(reportRoot, { recursive: true })
  await appendFile(join(reportRoot, "monitor.log"), line)
  if (!healthy) {
    await run("osascript", [
      "-e",
      `display notification ${JSON.stringify(clean(findings[0] ?? "unhealthy"))} with title "Burndown unhealthy"`
    ], { timeout, killSignal: "SIGKILL" }).catch(() => undefined)
  }
  // Unknown evidence retries; it never claims that the run settled.
  return inspection.state !== "terminal"
}

export const layer = Layer.mergeAll(
  Inspect.toLayer(({ runId, hostRoot, reportRoot }) =>
    Effect.tryPromise({
      try: async () => {
        const inspection = await inspectRun(runId, hostRoot)
        const [runs, dispatchers] = await Promise.all([
          captureEvidence("runs", "smthrs", ["runs", "list", "--limit", "40", "--json", "--root", hostRoot], hostRoot),
          captureEvidence("other dispatchers", "pgrep", ["-fl", "dispatch.py"], hostRoot)
        ])
        const evidence = (await Promise.all([
          Promise.resolve(inspection.evidence),
          Promise.resolve(runs.evidence),
          text("status line", join(reportRoot, "status.txt")),
          text("needs you", join(reportRoot, "NEEDS-YOU.md")),
          Promise.resolve(dispatchers.evidence)
        ])).join("\n\n")
        return { healthy: inspection.healthy && !runs.failed && !dispatchers.failed, now: Date.now(), evidence }
      },
      catch: () => "Monitor inspection failed"
    }), { implementationVersion: "burndown/monitor/inspect/v3" }),
  Diagnose.layer,
  Report.toLayer(
    (payload) =>
      Effect.tryPromise({ try: () => reportRun(payload), catch: () => "Monitor report could not be retained" }),
    {
      implementationVersion: "burndown/monitor/report/v3"
    }
  )
)
