/**
 * The install tier (//apps/app:installE2e): every Playwright test tagged
 * @install. Each starts a real install through the Go backend harness, so the
 * tier declares what T1 does not have and refuses before Playwright starts
 * when any is missing:
 *
 * - Go at the root go.mod's version (go test ./packages/backend/internal/compose)
 * - PostgreSQL 18 binaries (startLocalOwn; SMITHERS_POSTGRES_TEST_BIN)
 * - SMITHERS_TEST_DATABASE_URL, a PostgreSQL server the harness may write to
 * - the native smithers-ffi library (SMITHERS_FFI_LIBRARY_PATH); when unset,
 *   built here once in release mode instead of once per install
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { postgres18Bin } from "./mode-matrix/local-own"

const appDir = fileURLToPath(new URL("../", import.meta.url))
const rootDir = join(appDir, "../..")

const run = (argv: readonly string[], cwd = appDir, env: Record<string, string | undefined> = process.env) => {
  const result = Bun.spawnSync([...argv], { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  return result.exitCode ?? 1
}
const refuse = (reason: string): never => {
  console.error(`installE2e refused: ${reason}`)
  process.exit(2)
}

if (!process.env.SMITHERS_TEST_DATABASE_URL?.trim()) refuse("SMITHERS_TEST_DATABASE_URL is unset; the install tier needs a PostgreSQL test server")

const required = /^go (\d+(?:\.\d+)*)$/m.exec(readFileSync(new URL("../../../go.mod", import.meta.url), "utf8"))?.[1] ?? refuse("go.mod has no go directive")
const go = Bun.spawnSync(["go", "env", "GOVERSION"], { cwd: rootDir, stdout: "pipe", stderr: "pipe" })
if (go.exitCode !== 0) refuse(`go is unavailable for go.mod's go ${required}: ${go.stderr.toString().trim()}`)
const have = /go(\d+(?:\.\d+)*)/.exec(go.stdout.toString())?.[1] ?? refuse(`go reported no version: ${go.stdout.toString().trim()}`)
const compare = (left: string, right: string): number => {
  const [a, b] = [left.split(".").map(Number), right.split(".").map(Number)]
  for (let index = 0; index < Math.max(a.length, b.length); index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0)
  return 0
}
if (compare(have, required) < 0) refuse(`go ${have} is older than go.mod's go ${required}`)

try { postgres18Bin() } catch (error) { refuse(error instanceof Error ? error.message : "PostgreSQL 18 is unavailable") }

const env: Record<string, string | undefined> = { ...process.env, SMITHERS_CHAT_STUB: "1" }
if (!env.SMITHERS_FFI_LIBRARY_PATH?.trim()) {
  if (run(["cargo", "build", "--locked", "--release", "--package", "smithers-ffi"], rootDir) !== 0) refuse("cargo could not build smithers-ffi")
  env.SMITHERS_FFI_LIBRARY_PATH = join(rootDir, "target", "release", process.platform === "darwin" ? "libsmithers_ffi.dylib" : "libsmithers_ffi.so")
}
if (!existsSync(env.SMITHERS_FFI_LIBRARY_PATH!)) refuse(`SMITHERS_FFI_LIBRARY_PATH does not exist: ${env.SMITHERS_FFI_LIBRARY_PATH}`)

if (run(["pnpm", "exec", "playwright", "install", "chromium"]) !== 0) refuse("Playwright could not install Chromium")
process.exit(run(["pnpm", "exec", "playwright", "test", "--config", "playwright.install.config.ts", ...process.argv.slice(2)], appDir, env))
