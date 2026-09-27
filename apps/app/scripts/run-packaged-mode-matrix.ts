#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseMatrixConfig, selectMatrixModes } from "../e2e/real/coverage/matrix"
import type { MatrixConfig } from "../e2e/real/coverage/matrix"
import { startPackagedWebSelfhost } from "./mode-matrix/docker-web-selfhost"
import type { WebSelfhostSession } from "./mode-matrix/docker-web-selfhost"
import { startLocalOwn } from "./mode-matrix/local-own"
import type { LocalOwnSession } from "./mode-matrix/local-own"
import { startLocalPlue, startWebPlue } from "./mode-matrix/plue-target"
import type { PlueSession } from "./mode-matrix/plue-target"
import { startNativeOwn } from "./mode-matrix/native-own"
import type { NativeOwnSession } from "./mode-matrix/native-own"
import { sourceRevision } from "./mode-matrix/source-revision"

const appDir = fileURLToPath(new URL("../", import.meta.url))
const rootDir = resolve(appDir, "../..")
const args = process.argv.slice(2)
const matrixCommand = args[0] ?? "run"
if (matrixCommand !== "audit" && matrixCommand !== "run") {
  throw new Error("usage: run-packaged-mode-matrix.ts audit|run [--output-dir path] [--external-config path] [--auth-environment NAME] [--modes comma-separated]")
}

const option = (name: string): string | undefined => {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

const revision = await sourceRevision(rootDir)

const outputDir = resolve(option("--output-dir") ?? process.env.SMITHERS_MODE_MATRIX_OUTPUT_DIR ?? resolve(appDir, "test-results/mode-matrix"))
const modeSelection = option("--modes")
const selectedModes = selectMatrixModes(modeSelection).modes
const wants = (mode: string): boolean => selectedModes.some((selected) => selected === mode)
const configPath = resolve(outputDir, "config.json")
const reportPath = resolve(outputDir, "report.json")
mkdirSync(outputDir, { recursive: true })

const externalPath = option("--external-config") ?? process.env.SMITHERS_MODE_MATRIX_EXTERNAL_CONFIG
let external: MatrixConfig = { revision, modes: [] }
if (externalPath !== undefined) {
  if (!existsSync(externalPath)) throw new Error(`external mode configuration does not exist: ${externalPath}`)
  external = parseMatrixConfig(JSON.parse(readFileSync(resolve(externalPath), "utf8")) as unknown)
  if (external.revision !== revision) throw new Error(`external mode revision ${external.revision} does not match checkout ${revision}`)
  if (external.modes.some(({ mode }) => mode === "web-selfhost" || mode === "local-own")) {
    throw new Error("external mode configuration must not replace an in-repo owned launch")
  }
}

const plueTarget = process.env.SMITHERS_MODE_MATRIX_PLUE_URL?.trim()
const plueWebTarget = process.env.SMITHERS_MODE_MATRIX_PLUE_WEB_URL?.trim()
const plueTokenEnvironment = "SMITHERS_MODE_MATRIX_PLUE_TOKEN"
if (plueTarget && process.env[plueTokenEnvironment]?.trim() && (wants("web-plue") || wants("local-plue")) &&
  external.modes.some(({ mode }) => mode === "web-plue" || mode === "local-plue")) {
  throw new Error("external configuration must not duplicate the configured Plue web or local target")
}

let session: WebSelfhostSession | undefined
let localSession: LocalOwnSession | undefined
let nativeSession: NativeOwnSession | undefined
let plueSessions: PlueSession[] = []
let launchFailure: unknown
let matrixCode = 1
let teardownFailure: unknown
const stop = async (): Promise<void> => {
  const docker = session
  const local = localSession
  const native = nativeSession
  const remote = plueSessions
  session = undefined
  localSession = undefined
  nativeSession = undefined
  plueSessions = []
  const failures: unknown[] = []
  for (const close of [docker?.close, local?.close, native?.close, ...remote.map((target) => target.close)]) {
    if (close === undefined) continue
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, "mode launcher teardown failed")
}
const interrupt = (signal: NodeJS.Signals): void => {
  void stop().finally(() => {
    process.kill(process.pid, signal)
  })
}
process.once("SIGINT", interrupt)
process.once("SIGTERM", interrupt)
try {
  if (wants("web-selfhost")) try {
    session = await startPackagedWebSelfhost({
      rootDir,
      revision,
      outputDir,
      ...(process.env.SMITHERS_MODE_MATRIX_IMAGE ? { image: process.env.SMITHERS_MODE_MATRIX_IMAGE } : {}),
      ...(option("--auth-environment") === undefined ? {} : { authEnvironment: option("--auth-environment") })
    })
  } catch (error) {
    launchFailure = error
    console.error(`web-selfhost launch failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (plueTarget && process.env[plueTokenEnvironment]?.trim() && (wants("web-plue") || wants("local-plue"))) {
    if (wants("web-plue")) try {
      if (!plueWebTarget) throw new Error("web-plue requires SMITHERS_MODE_MATRIX_PLUE_WEB_URL and SMITHERS_MODE_MATRIX_PLUE_URL")
      plueSessions.push(await startWebPlue(outputDir, plueWebTarget, plueTokenEnvironment, plueTarget))
    }
    catch (error) {
      launchFailure = error
      console.error(`web-plue launch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (wants("local-plue")) try { plueSessions.push(await startLocalPlue(appDir, revision, outputDir, plueTarget, plueTokenEnvironment)) }
    catch (error) {
      launchFailure = error
      console.error(`local-plue launch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (wants("local-own")) try {
    localSession = await startLocalOwn(rootDir, revision, outputDir)
  } catch (error) {
    launchFailure = error
    console.error(`local-own launch failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const nativeExecutable = process.env.SMITHERS_MODE_MATRIX_NATIVE_EXECUTABLE?.trim()
  const nativeCDP = process.env.SMITHERS_MODE_MATRIX_NATIVE_CDP_ENDPOINT?.trim()
  if (wants("native-own") && Boolean(nativeExecutable) !== Boolean(nativeCDP)) {
    const error = new Error("native-own requires both SMITHERS_MODE_MATRIX_NATIVE_EXECUTABLE and SMITHERS_MODE_MATRIX_NATIVE_CDP_ENDPOINT")
    launchFailure = error
    console.error(error.message)
  }
  if (nativeExecutable && nativeCDP && wants("native-own")) {
    try { nativeSession = await startNativeOwn(revision, outputDir, nativeExecutable, nativeCDP) }
    catch (error) {
      launchFailure = error
      console.error(`native-own launch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const config: MatrixConfig = {
    revision,
    modes: [...(session === undefined ? [] : [session.modeConfig]), ...(localSession === undefined ? [] : [localSession.modeConfig]),
      ...(nativeSession === undefined ? [] : [nativeSession.modeConfig]), ...plueSessions.map(({ modeConfig }) => modeConfig), ...external.modes]
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })

  const matrix = Bun.spawn([
    "bun", "scripts/run-mode-matrix.ts", matrixCommand,
    "--config", configPath,
    "--report", reportPath,
    ...(modeSelection === undefined ? [] : ["--modes", modeSelection])
  ], {
    cwd: appDir,
    env: { ...process.env, ...session?.runtimeEnvironment, ...localSession?.runtimeEnvironment, ...nativeSession?.runtimeEnvironment },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })
  matrixCode = await matrix.exited
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  process.off("SIGINT", interrupt)
  process.off("SIGTERM", interrupt)
  try { await stop() } catch (error) {
    teardownFailure = error
    console.error(`mode launcher teardown failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (launchFailure !== undefined || teardownFailure !== undefined || matrixCode !== 0) process.exitCode = 1
