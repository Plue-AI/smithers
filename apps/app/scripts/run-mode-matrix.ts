#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  MANDATORY_DETERMINISTIC_BROWSER_SPECS,
  MANDATORY_DETERMINISTIC_BUN_TESTS,
  MODE_DESCRIPTORS,
  applicableScenarioIds,
  missingModeReadiness,
  matrixVerdict,
  parseMatrixConfig,
  probeMode,
  scenarioReceipts,
  selectMatrixModes,
  readExecutionReceipt,
  validateExecutionReceipt
} from "../e2e/real/coverage/matrix"
import type { MatrixConfig, MatrixScenarioReceipt, ModeReadiness } from "../e2e/real/coverage/matrix"
import type { RealScenarioRunEvidence } from "../e2e/real/coverage/types"
import { sourceRevision } from "./mode-matrix/source-revision"
import { archiveEvidence, rawEvidence, readEvidenceReference, validateRawMatrixEvidence, type EvidenceReference } from "../e2e/real/coverage/evidence"

const appDir = fileURLToPath(new URL("../", import.meta.url))
const args = process.argv.slice(2)
const command = args[0] ?? "audit"
if (command !== "audit" && command !== "run") throw new Error("usage: run-mode-matrix.ts audit|run [--config path] [--report path] [--modes comma-separated]")

const option = (name: string): string | undefined => {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}
const selection = selectMatrixModes(option("--modes"))
const selectedModes = selection.modes
const executionID = randomUUID()
const reportPath = resolve(option("--report") ?? process.env.SMITHERS_MODE_MATRIX_REPORT ?? `${appDir}/test-results/mode-matrix/report.json`)
const evidenceDirectory = `${basename(reportPath)}.evidence/${executionID}`
const outputDirectory = resolve(dirname(reportPath), evidenceDirectory)
mkdirSync(outputDirectory, { recursive: true })

const detectedRevision = await sourceRevision(resolve(appDir, "../.."))
const configPath = option("--config") ?? process.env.SMITHERS_MODE_MATRIX_CONFIG
let config: MatrixConfig = { revision: detectedRevision, modes: [] }
let configFailure: string | undefined
if (configPath) {
  try { config = parseMatrixConfig(JSON.parse(readFileSync(resolve(configPath), "utf8")) as unknown) }
  catch (error) { configFailure = error instanceof Error ? error.message : String(error) }
}
if (config.revision !== detectedRevision) configFailure = `matrix revision ${config.revision} does not match checkout ${detectedRevision}`

const commands: Array<{ readonly tier: string; readonly command: readonly string[]; readonly status: "passed" | "failed" | "unavailable"; readonly exitCode?: number }> = []
let deterministicPassed = command === "audit"
if (command === "run") {
  const unit = ["bun", "test", "e2e/real/coverage", "e2e/real/support", ...MANDATORY_DETERMINISTIC_BUN_TESTS]
  const unitRun = Bun.spawn(unit, { cwd: appDir, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const unitCode = await unitRun.exited
  commands.push({ tier: "deterministic", command: unit, status: unitCode === 0 ? "passed" : "failed", exitCode: unitCode })

  const browser = ["pnpm", "exec", "playwright", "test", "--config", "playwright.config.ts", "--output", resolve(outputDirectory, "deterministic-browser"), ...MANDATORY_DETERMINISTIC_BROWSER_SPECS]
  const browserRun = Bun.spawn(browser, { cwd: appDir, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const browserCode = await browserRun.exited
  commands.push({ tier: "deterministic", command: browser, status: browserCode === 0 ? "passed" : "failed", exitCode: browserCode })
  deterministicPassed = unitCode === 0 && browserCode === 0
}

const readiness: ModeReadiness[] = []
const runs: RealScenarioRunEvidence[] = []
const evidence: Array<{ mode: string; origin: string; endpoint: string; startedAt?: string; finishedAt?: string; raw?: EvidenceReference; launcher?: EvidenceReference; errors: string[] }> = []
for (const mode of selectedModes) {
  const modeConfig = config.modes.find((entry) => entry.mode === mode)
  const state = configFailure ? missingModeReadiness(mode, configFailure)
    : modeConfig === undefined ? missingModeReadiness(mode, `configuration for ${mode} is unavailable`)
      : await probeMode(modeConfig, config.revision)
  readiness.push(state)
  const record = modeConfig ? { mode, origin: modeConfig.origin, endpoint: modeConfig.endpoint, errors: [] as string[] } as typeof evidence[number] : undefined
  if (record && modeConfig) {
    evidence.push(record)
    try {
      record.launcher = archiveEvidence(outputDirectory, `${mode}/launcher.json`, readFileSync(modeConfig.executionReceipt))
      readEvidenceReference(outputDirectory, record.launcher)
      const launcherRevision = mode === "web-plue" ? state.buildSha : config.revision
      if (!launcherRevision) record.errors.push("launcher deployment revision is unavailable")
      else record.errors.push(...validateExecutionReceipt(modeConfig, launcherRevision, readExecutionReceipt(resolve(outputDirectory, record.launcher.path))))
    } catch (error) { record.errors.push(error instanceof Error ? error.message : String(error)) }
  }
  if (command !== "run" || state.status !== "passed" || modeConfig === undefined || !deterministicPassed) continue

  const childEvidence = resolve(outputDirectory, mode, "child.real-e2e.json")
  const ownerProfile = resolve(outputDirectory, mode, "owner-profile")
  const selectedScenarios = applicableScenarioIds(state.capabilities)
  if (selectedScenarios.length === 0) continue
  const nativeDriver = modeConfig.surfaceDriver
  const prelaunchedNative = nativeDriver !== undefined && process.env.SMITHERS_NATIVE_MATRIX_PRELAUNCHED === mode
  const invocation = nativeDriver === undefined || prelaunchedNative
    ? ["bun", "scripts/run-real-e2e.ts"]
    : ["bun", "scripts/run-native-mode-matrix.ts"]
  const childEnvironment = { ...process.env }
  delete childEnvironment.SMITHERS_REAL_GIT_ORIGIN
  delete childEnvironment.SMITHERS_REAL_E2E_BUILD_SHA
  if (nativeDriver === undefined) {
    delete childEnvironment.SMITHERS_REAL_NATIVE_CDP_ENDPOINT
    delete childEnvironment.SMITHERS_REAL_NATIVE_WINDOW_URL
    delete childEnvironment.SMITHERS_REAL_NATIVE_TARGET_ID
    delete childEnvironment.SMITHERS_NATIVE_MATRIX_PRELAUNCHED
  }
  record!.startedAt = new Date().toISOString()
  const child = Bun.spawn(invocation, {
    cwd: appDir,
    env: {
      ...childEnvironment,
      ...(nativeDriver === undefined
        ? { SMITHERS_REAL_BASE_URL: modeConfig.origin }
        : {
          SMITHERS_REAL_API_ORIGIN: modeConfig.origin,
          SMITHERS_NATIVE_MATRIX_DRIVER_ENVIRONMENT: nativeDriver.environment,
          ...(prelaunchedNative ? { SMITHERS_REAL_BASE_URL: new URL(process.env.SMITHERS_REAL_NATIVE_WINDOW_URL!).origin } : {})
        }),
      SMITHERS_REAL_E2E_MODE: mode,
      ...(mode === "local-own" && process.env.SMITHERS_LOCAL_GIT_ORIGIN ? { SMITHERS_REAL_GIT_ORIGIN: process.env.SMITHERS_LOCAL_GIT_ORIGIN } : {}),
      ...(MODE_DESCRIPTORS[mode].provider === "plue" ? { SMITHERS_REAL_GIT_ORIGIN: modeConfig.endpoint } : {}),
      SMITHERS_REAL_E2E_HOST: MODE_DESCRIPTORS[mode].legacyHost,
      // Every Plue scenario must run against the deployment readiness certified.
      ...(MODE_DESCRIPTORS[mode].provider === "plue" && state.buildSha ? { SMITHERS_REAL_E2E_BUILD_SHA: state.buildSha } : {}),
      SMITHERS_REAL_E2E_REVISION: config.revision,
      SMITHERS_REAL_E2E_RESULTS: childEvidence,
      SMITHERS_REAL_E2E_REPORT: resolve(outputDirectory, mode, "playwright-report.json"),
      SMITHERS_REAL_E2E_ARTIFACTS: resolve(outputDirectory, mode, "playwright"),
      SMITHERS_REAL_NATIVE_ARTIFACTS: resolve(outputDirectory, mode, "native"),
      SMITHERS_REAL_MATRIX_EXECUTION_ID: executionID,
      SMITHERS_REAL_MATRIX_ORIGIN: modeConfig.origin,
      SMITHERS_REAL_MATRIX_ENDPOINT: modeConfig.endpoint,
      SMITHERS_REAL_MATRIX_SCENARIOS: JSON.stringify(selectedScenarios),
      SMITHERS_REAL_AUTH_KIND: modeConfig.auth.kind,
      SMITHERS_REAL_AUTH_ENVIRONMENT: modeConfig.auth.environment,
      ...(modeConfig.auth.kind === "owner-session" ? { SMITHERS_REAL_OWNER_PROFILE_DIR: ownerProfile } : {}),
      ...(modeConfig.auth.kind === "browser-profile" ? { SMITHERS_E2E_PROFILE: process.env[modeConfig.auth.environment] } : {})
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })
  const code = await child.exited
  record!.finishedAt = new Date().toISOString()
  commands.push({ tier: state.tier, command: invocation, status: code === 0 ? "passed" : "failed", exitCode: code })
  try {
    if (!existsSync(childEvidence)) throw new Error("raw child evidence is missing")
    record!.raw = archiveEvidence(outputDirectory, `${mode}/raw.json`, readFileSync(childEvidence))
    const value = rawEvidence(outputDirectory, record!.raw)
    record!.errors.push(...validateRawMatrixEvidence(value, { executionID, mode, origin: modeConfig.origin, endpoint: modeConfig.endpoint,
      revision: config.revision, buildSha: state.buildSha, startedAt: record!.startedAt!, finishedAt: record!.finishedAt! }))
    if (record!.errors.length === 0) runs.push(...value.runs)
  } catch (error) { record!.errors.push(error instanceof Error ? error.message : String(error)) }
}

const scenarios: MatrixScenarioReceipt[] = readiness.flatMap((state) => scenarioReceipts(state, config.revision, runs))
const report = {
  ...matrixVerdict(selection, readiness, scenarios, deterministicPassed, commands),
  generatedAt: new Date().toISOString(),
  revision: config.revision,
  command,
  executionID,
  evidenceDirectory,
  evidence,
  commands,
  readiness,
  scenarios
}
mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(resolve(outputDirectory, "report.json"), JSON.stringify({ ...report, evidenceDirectory: "." }, null, 2) + "\n", { mode: 0o600, flag: "wx" })
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n")

for (const state of readiness) console.log(`${state.status.toUpperCase()} ${state.mode}${state.reasons.length ? `: ${state.reasons.join("; ")}` : ""}`)
const counts = scenarios.reduce((result, row) => ({ ...result, [row.status]: result[row.status] + 1 }), { passed: 0, failed: 0, unavailable: 0, "not-configured": 0 })
console.log(`matrix scenarios: ${counts.passed} passed, ${counts.failed} failed, ${counts.unavailable} unavailable, ${counts["not-configured"]} not configured`)
console.log(`matrix report: ${reportPath}`)
if (!report.ok) process.exitCode = 1
