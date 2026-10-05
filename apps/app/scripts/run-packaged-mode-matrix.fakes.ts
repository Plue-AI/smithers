/*
 * Launcher fakes for run-packaged-mode-matrix.test.ts, loaded with
 * `bun --preload` into the child process that runs the CLI.
 *
 * `mock.module` replaces a module for the whole Bun process and cannot be
 * undone, so installing these in the test process leaked the fake
 * `sourceRevision` and `matrix` into every later test file in the same
 * `bun test` run. A child process keeps them to one CLI invocation.
 *
 * The child reports which sessions it acquired and closed as JSON written to
 * MATRIX_FAKES_LOG when it exits; MATRIX_FAKES_FAIL_CLOSE=1 makes the
 * docker session's close throw.
 */
import { mock } from "bun:test"
import { writeFileSync } from "node:fs"

const revision = "a".repeat(40)
const acquisitions: string[] = []
const closes: string[] = []
let matrixEnvironment: Record<string, string> | undefined
const failClose = process.env.MATRIX_FAKES_FAIL_CLOSE === "1"
const modeConfig = (mode: string) => ({
  mode, origin: "http://127.0.0.1:3000", endpoint: "http://127.0.0.1:3000",
  auth: { kind: "owner-session", environment: "MATRIX_TEST_AUTH" }, executionReceipt: "receipt.json"
})

process.on("exit", () => {
  const log = process.env.MATRIX_FAKES_LOG
  if (log !== undefined) writeFileSync(log, JSON.stringify({ acquisitions, closes, matrixEnvironment }))
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
    return { modeConfig: modeConfig("local-own"), runtimeEnvironment: { MATRIX_TEST_AUTH: JSON.stringify({ username: "owner", password: "unused-fixture-password", bootstrapToken: "unused-fixture-bootstrap", sessionCookie: "b".repeat(64) }), SMITHERS_LOCAL_GIT_ORIGIN: "http://127.0.0.1:3001" }, close: async () => { closes.push("local") } }
  }
}))
mock.module("./mode-matrix/plue-target", () => ({
  startWebPlue: async () => { throw new Error("unexpected Plue launch") },
  startLocalPlue: async () => { throw new Error("unexpected Plue launch") }
}))

// Capture only the downstream runner boundary; launcher resource handling stays real.
const spawn = Bun.spawn
Bun.spawn = ((argv: string[], options: { env?: Record<string, string> }) => {
  if (argv[0] === "bun" && argv[1] === "scripts/run-mode-matrix.ts") {
    matrixEnvironment = { MATRIX_TEST_AUTH: options.env?.MATRIX_TEST_AUTH ?? "", SMITHERS_LOCAL_GIT_ORIGIN: options.env?.SMITHERS_LOCAL_GIT_ORIGIN ?? "" }
    return { exited: Promise.resolve(0) }
  }
  return spawn(argv, options)
}) as typeof Bun.spawn
