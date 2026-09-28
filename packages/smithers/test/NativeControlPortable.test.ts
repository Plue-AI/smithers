/** Both native boundaries exercise the same persisted control/execution graph. */
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const execute = promisify(execFile)
const fixture = fileURLToPath(new URL("./fixtures/native-control-portable.ts", import.meta.url))

for (const runtime of ["node", "bun"]) {
  for (const recovery of [false, true]) {
    it(
      `${runtime} ${
        recovery
          ? "refuses ordinary adoption and resumes with the configured catalog"
          : "executes an approved native module"
      }`,
      async () => {
        const args = [
          ...(runtime === "node" ? ["--experimental-strip-types"] : []),
          fixture,
          runtime,
          ...(recovery ? ["recovery"] : [])
        ]
        // Recovery starts three complete host scopes. Give slow loaded builders
        // room to initialize; every execution/observation still has its own bound.
        const { stdout } = await execute(runtime, args, { timeout: 1_200_000, maxBuffer: 1024 * 1024 })
        const result = stdout.trim().split("\n").findLast((line) => line.startsWith("{\"runtime\""))
        expect(result).toBeDefined()
        expect(JSON.parse(result!)).toMatchObject({ runtime, recovery, passed: true })
      },
      1_205_000
    )
  }
}

it("regression: Flaky: NativeControlPortable 'bun refuses ordinary adoption' after #1807 drift rescans", async () => {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const { stdout, stderr } = await execute("bun", [fixture, "bun", "drift-rescan"], {
      timeout: 1_200_000,
      maxBuffer: 1024 * 1024
    })
    const result = stdout.trim().split("\n").findLast((line) => line.startsWith("{\"runtime\""))
    expect(result, `attempt ${attempt}: ${stderr}`).toBeDefined()
    expect(JSON.parse(result!), `attempt ${attempt}: ${stderr}`).toMatchObject({
      runtime: "bun",
      recovery: true,
      driftRescan: true,
      passed: true
    })
    expect(`${stdout}\n${stderr}`, `attempt ${attempt}`).not.toContain("coordinated drain failed")
  }
}, 1_205_000)

it("fails a drifted approved module explicitly instead of parking it on an ordinary host", async () => {
  const { stdout } = await execute("node", ["--experimental-strip-types", fixture, "node", "drift"], {
    timeout: 1_200_000,
    maxBuffer: 1024 * 1024
  })
  const result = stdout.trim().split("\n").findLast((line) => line.startsWith("{\"runtime\""))
  expect(result).toBeDefined()
  expect(JSON.parse(result!)).toMatchObject({ runtime: "node", drift: true, passed: true })
}, 1_205_000)

for (const runtime of ["node", "bun"]) {
  it(
    `${runtime} commits direct native cancellation intent before publishing it through the control bridge`,
    async () => {
      const { stdout } = await execute(runtime, [
        ...(runtime === "node" ? ["--experimental-strip-types"] : []),
        fixture,
        runtime,
        "cancel"
      ], { timeout: 1_200_000, maxBuffer: 1024 * 1024 })
      const result = stdout.trim().split("\n").findLast((line) => line.startsWith("{\"runtime\""))
      expect(result).toBeDefined()
      expect(JSON.parse(result!)).toMatchObject({ runtime, cancel: true, passed: true })
    },
    1_205_000
  )
}
