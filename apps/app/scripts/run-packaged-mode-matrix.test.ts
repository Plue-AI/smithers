import { afterEach, expect, mock, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const revision = "a".repeat(40)
const originalArgs = process.argv
const originalExitCode = process.exitCode
const originalUrl = process.env.SMITHERS_MODE_MATRIX_PLUE_URL
const originalToken = process.env.SMITHERS_MODE_MATRIX_PLUE_TOKEN
const originalError = console.error
const dirs: string[] = []
const acquisitions: string[] = []
const closes: string[] = []
let failClose = false
const modeConfig = (mode: string) => ({
  mode, origin: "http://127.0.0.1:3000", endpoint: "http://127.0.0.1:3000",
  auth: { kind: "owner-session", environment: "MATRIX_TEST_AUTH" }, executionReceipt: "receipt.json"
})

mock.module("../e2e/real/coverage/matrix", () => ({
  selectMatrixModes: (selection?: string) => ({ modes: selection?.split(",") ?? [] }),
  parseMatrixConfig: (value: { revision: string; modes: unknown[] }) => value
}))
mock.module("./mode-matrix/source-revision", () => ({ sourceRevision: async () => revision }))
mock.module("./mode-matrix/docker-web-selfhost", () => ({
  startPackagedWebSelfhost: async () => {
    acquisitions.push("docker")
    return { modeConfig: modeConfig("web-selfhost"), runtimeEnvironment: {}, close: async () => {
      closes.push("docker")
      if (failClose) throw new Error("docker close failed")
    } }
  }
}))
mock.module("./mode-matrix/local-own", () => ({
  startLocalOwn: async () => {
    acquisitions.push("local")
    return { modeConfig: modeConfig("local-own"), runtimeEnvironment: {}, close: async () => { closes.push("local") } }
  }
}))
mock.module("./mode-matrix/native-own", () => ({
  startNativeOwn: async () => { throw new Error("unexpected native launch") }
}))
mock.module("./mode-matrix/plue-target", () => ({
  startWebPlue: async () => { throw new Error("unexpected Plue launch") },
  startLocalPlue: async () => { throw new Error("unexpected Plue launch") }
}))

afterEach(() => {
  process.argv = originalArgs
  process.exitCode = originalExitCode ?? 0
  console.error = originalError
  if (originalUrl === undefined) delete process.env.SMITHERS_MODE_MATRIX_PLUE_URL
  else process.env.SMITHERS_MODE_MATRIX_PLUE_URL = originalUrl
  if (originalToken === undefined) delete process.env.SMITHERS_MODE_MATRIX_PLUE_TOKEN
  else process.env.SMITHERS_MODE_MATRIX_PLUE_TOKEN = originalToken
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  acquisitions.length = 0
  closes.length = 0
  failClose = false
})

test("duplicate external Plue target is rejected before acquiring owned resources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-conflict-"))
  dirs.push(dir)
  const external = join(dir, "external.json")
  writeFileSync(external, JSON.stringify({ revision, modes: [modeConfig("web-plue")] }))
  process.argv = ["bun", "run-packaged-mode-matrix.ts", "audit", "--modes", "web-selfhost,web-plue",
    "--external-config", external, "--output-dir", join(dir, "output")]
  process.env.SMITHERS_MODE_MATRIX_PLUE_URL = "https://plue.example"
  process.env.SMITHERS_MODE_MATRIX_PLUE_TOKEN = "test-token"
  const cli = "./run-packaged-mode-matrix?conflict"
  await expect(import(cli)).rejects.toThrow(
    "external configuration must not duplicate the configured Plue web or local target")
  expect(acquisitions).toEqual([])
  expect(closes).toEqual([])
})

test("config write failure closes all acquired sessions once and retains the original error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-write-"))
  dirs.push(dir)
  const output = join(dir, "output")
  mkdirSync(join(output, "config.json"), { recursive: true })
  const errors: string[] = []
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")) }
  failClose = true
  process.argv = ["bun", "run-packaged-mode-matrix.ts", "audit", "--modes", "web-selfhost,local-own",
    "--output-dir", output]
  const cli = "./run-packaged-mode-matrix?write-failure"
  await import(cli)
  expect(acquisitions).toEqual(["docker", "local"])
  expect(closes).toEqual(["docker", "local"])
  expect(errors.some((message) => message.includes("EISDIR"))).toBe(true)
  expect(errors.some((message) => message.includes("mode launcher teardown failed"))).toBe(true)
  expect(process.exitCode).toBe(1)
})
