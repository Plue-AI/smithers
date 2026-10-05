import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/*
 * The CLI runs in a child Bun process with its launchers faked by a preload
 * (run-packaged-mode-matrix.fakes.ts). The fakes are `mock.module` calls,
 * which Bun applies to its whole process for good, so they must never load
 * into the `bun test` process other suites share.
 */
const revision = "a".repeat(40)
const cli = join(import.meta.dir, "run-packaged-mode-matrix.ts")
const fakes = join(import.meta.dir, "run-packaged-mode-matrix.fakes.ts")
const dirs: string[] = []
const modeConfig = (mode: string) => ({
  mode, origin: "http://127.0.0.1:3000", endpoint: "http://127.0.0.1:3000",
  auth: { kind: "owner-session", environment: "MATRIX_TEST_AUTH" }, executionReceipt: "receipt.json"
})

const runCli = (dir: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) => {
  const log = join(dir, "fakes.json")
  const result = spawnSync(process.execPath, ["--preload", fakes, cli, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", MATRIX_FAKES_LOG: log, ...env
    },
    // spawnSync blocks the event loop, so the test's own timeout cannot fire.
    timeout: 50_000
  })
  if (result.error !== undefined || !existsSync(log)) {
    throw new Error(`matrix CLI child did not finish: ${result.error?.message ?? "no fakes log"}\n${result.stderr}`)
  }
  const { acquisitions, closes, matrixEnvironment } = JSON.parse(readFileSync(log, "utf8")) as { acquisitions: string[]; closes: string[]; matrixEnvironment?: Record<string, string> }
  return { status: result.status, stderr: result.stderr, acquisitions, closes, matrixEnvironment }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test("duplicate external Plue target is rejected before acquiring owned resources", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-conflict-"))
  dirs.push(dir)
  const external = join(dir, "external.json")
  writeFileSync(external, JSON.stringify({ revision, modes: [modeConfig("web-plue")] }))
  const run = runCli(dir, ["audit", "--modes", "web-selfhost,web-plue", "--external-config", external, "--output-dir", join(dir, "output")], {
    SMITHERS_MODE_MATRIX_PLUE_URL: "https://plue.example",
    SMITHERS_MODE_MATRIX_PLUE_TOKEN: "test-token"
  })
  expect(run.status).not.toBe(0)
  expect(run.stderr).toContain("external configuration must not duplicate the configured Plue web or local target")
  expect(run.acquisitions).toEqual([])
  expect(run.closes).toEqual([])
}, 60_000)

test("config write failure closes all acquired sessions once and retains the original error", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-write-"))
  dirs.push(dir)
  const output = join(dir, "output")
  mkdirSync(join(output, "config.json"), { recursive: true })
  const run = runCli(dir, ["audit", "--modes", "web-selfhost,local-own", "--output-dir", output], { MATRIX_FAKES_FAIL_CLOSE: "1" })
  expect(run.acquisitions).toEqual(["docker", "local"])
  expect(run.closes).toEqual(["docker", "local"])
  expect(run.stderr).toContain("EISDIR")
  expect(run.stderr).toContain("mode launcher teardown failed")
  expect(run.status).toBe(1)
}, 60_000)

test("local-own forwards its seeded owner session and Git origin to the matrix runner", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-seeded-owner-"))
  dirs.push(dir)
  const run = runCli(dir, ["audit", "--modes", "local-own", "--output-dir", join(dir, "output")])
  expect(run.status).toBe(0)
  expect(run.acquisitions).toEqual(["local"])
  expect(run.closes).toEqual(["local"])
  expect(JSON.parse(run.matrixEnvironment!.MATRIX_TEST_AUTH!)).toEqual({
    username: "owner", password: "unused-fixture-password", bootstrapToken: "unused-fixture-bootstrap", sessionCookie: "b".repeat(64)
  })
  expect(run.matrixEnvironment!.SMITHERS_LOCAL_GIT_ORIGIN).toBe("http://127.0.0.1:3001")
  expect(readFileSync(join(dir, "output", "config.json"), "utf8")).not.toContain("sessionCookie")
}, 60_000)
