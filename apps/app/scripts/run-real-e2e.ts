import { appendFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { extractRequestedGrep, selectsEveryScenario } from "../e2e/real/coverage/selection"
import { admitSourceRevision } from "../e2e/real/coverage/revision"
import { MODEL_CREDENTIAL_ENV_PREFIX, MODEL_CREDENTIAL_ORIGIN_SUFFIX, MODEL_TEST_DEADLINE_MS } from "@smthrs/rpc/ConfiguredModel"
import { sourceRevision } from "./mode-matrix/source-revision"
import { productionBuild } from "./production-preflight"

const appDir = fileURLToPath(new URL("../", import.meta.url))
const args = process.argv.slice(2)

const run = async (command: string, commandArgs: readonly string[]): Promise<number> => {
  const child = Bun.spawn([command, ...commandArgs], { cwd: appDir, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  return child.exited
}

const serve = async (): Promise<never> => {
  if (process.env.SMITHERS_CHAT_STUB !== "0") throw new Error("The real E2E host requires SMITHERS_CHAT_STUB=0.")
  if (process.env.SMITHERS_SKIP_SPA_BUILD !== "1") {
    const build = await run("pnpm", ["exec", "vite", "build", "--configLoader", "runner"])
    if (build !== 0) process.exit(build)
  }
  const { startLocalServer } = await import("../src/bun/server")
  const { darwinKeychain } = await import("../src/bun/CloudAuth")
  const { MODEL_KEYCHAIN_SERVICE, modelKeychainAccount } = await import("../src/bun/ModelCredentials")

  const port = Number(process.env.SMITHERS_REAL_PORT ?? "47321")
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid SMITHERS_REAL_PORT: ${process.env.SMITHERS_REAL_PORT}`)
  const root = await mkdtemp(join(tmpdir(), "smithers-real-e2e-host-"))
  const home = join(root, "home")
  await mkdir(home)
  const logPath = join(appDir, "test-results", ["real-host", "log"].join("."))
  await mkdir(join(appDir, "test-results"), { recursive: true })
  await writeFile(logPath, "")
  let server: Awaited<ReturnType<typeof startLocalServer>> | undefined
  try {
    server = await startLocalServer({
      port,
      distDir: join(appDir, "dist"),
      home,
      stateDir: join(root, "state"),
      cloudMode: "hybrid",
      log: line => { appendFileSync(logPath, `${line}\n`); console.log(line) }
    })
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }

  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= server!.stop().then(async () => {
    await darwinKeychain().remove(MODEL_KEYCHAIN_SERVICE, modelKeychainAccount(join(root, "state")))
    await rm(root, { recursive: true, force: true })
  })
  process.on("SIGINT", () => { void stop().then(() => process.exit(0), () => process.exit(1)) })
  process.on("SIGTERM", () => { void stop().then(() => process.exit(0), () => process.exit(1)) })
  console.log(`[real-e2e] isolated real host listening at http://127.0.0.1:${port}`)
  return await new Promise<never>(() => {})
}

/*
 * The named model credentials of e2e/real/models.spec.ts, and the loopback
 * provider they are pinned to. The runner declares two environment credentials
 * for the model scenarios. The provider's port must
 * be known before the host boots. E2E_LOOPBACK is accepted; E2E_REVOKED gets 401.
 */
const launchModelProvider = async (): Promise<() => Promise<void>> => {
  const loopback = `${MODEL_CREDENTIAL_ENV_PREFIX}E2E_LOOPBACK`
  const revoked = `${MODEL_CREDENTIAL_ENV_PREFIX}E2E_REVOKED`
  process.env[loopback] ??= `sk-loopback-${randomBytes(24).toString("hex")}`
  process.env[revoked] ??= `sk-revoked-${randomBytes(24).toString("hex")}`
  const provider = Bun.spawn(["bun", "e2e/real/support/model-provider.ts"], {
    cwd: appDir,
    env: {
      ...process.env,
      SMITHERS_MODEL_PROVIDER_KEY: process.env[loopback],
      // An ephemeral port unless the operator fixed one; either way it is known before the host boots.
      SMITHERS_MODEL_PROVIDER_PORT: process.env.SMITHERS_MODEL_PROVIDER_PORT ?? "0",
      // Its slow model must outlast the one deadline a test runs under.
      SMITHERS_MODEL_PROVIDER_SLOW_MS: String(MODEL_TEST_DEADLINE_MS * 2)
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit"
  })
  const stop = async (): Promise<void> => {
    provider.kill("SIGTERM")
    await provider.exited
  }
  const reader = provider.stdout.getReader()
  const decoder = new TextDecoder()
  let line = ""
  while (!line.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`The model provider exited ${await provider.exited} before it was ready.`)
    line += decoder.decode(chunk.value, { stream: true })
  }
  reader.releaseLock()
  const ready = JSON.parse(line.slice(0, line.indexOf("\n"))) as { readonly event?: string; readonly origin?: string }
  if (ready.event !== "ready" || ready.origin === undefined) {
    await stop()
    throw new Error("The model provider did not report ready.")
  }
  process.env[`${loopback}${MODEL_CREDENTIAL_ORIGIN_SUFFIX}`] = ready.origin
  process.env[`${revoked}${MODEL_CREDENTIAL_ORIGIN_SUFFIX}`] = ready.origin
  return stop
}

if (args[0] === "serve") {
  await serve()
} else {
  const selection = extractRequestedGrep(args)
  if (selection.grep !== undefined) process.env.SMITHERS_REAL_TEST_GREP = selection.grep
  if (process.env.SMITHERS_CHAT_STUB === "1") throw new Error("The real E2E runner refuses SMITHERS_CHAT_STUB=1.")
  process.env.SMITHERS_REAL_E2E_REVISION = admitSourceRevision(
    await sourceRevision(join(appDir, "../..")), process.env.SMITHERS_REAL_E2E_REVISION)
  const external = process.env.SMITHERS_REAL_BASE_URL
  process.env.SMITHERS_REAL_E2E_HOST ??= external ? "production" : "local"
  if (external && process.env.SMITHERS_REAL_E2E_HOST === "production") {
    process.env.SMITHERS_REAL_E2E_BUILD_SHA = await productionBuild(external, process.env.SMITHERS_REAL_E2E_BUILD_SHA?.trim() || undefined)
  }
  const evidence = process.env.SMITHERS_REAL_E2E_RESULTS ?? join(appDir, "test-results/real-e2e-evidence.json")
  process.env.SMITHERS_REAL_E2E_RESULTS = evidence
  await rm(evidence, { force: true })
  // Only the host this runner boots can reach a loopback provider; a deployed canary never sees one.
  const stopModelProvider = external || args.includes("--list") ? undefined : await launchModelProvider()
  let code: number
  try {
    code = await run("pnpm", ["exec", "playwright", "test", "--config", "playwright.real.config.ts", ...selection.args])
  } finally {
    await stopModelProvider?.()
  }
  if (args.includes("--list")) process.exit(code)
  const gate = await run(process.execPath, [
    "scripts/check-real-e2e.ts", "--results", evidence, "--expected-host", process.env.SMITHERS_REAL_E2E_HOST!, "--expected-revision", process.env.SMITHERS_REAL_E2E_REVISION!,
    ...(selectsEveryScenario(selection, process.env.SMITHERS_REAL_E2E_MODE) ? ["--require-complete"] : [])
  ])
  process.exit(code || gate)
}
