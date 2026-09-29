import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const runFixture = () =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn("bun", [fileURLToPath(new URL("./fixtures/bun-gateway.ts", import.meta.url))], {
        timeout: 60_000
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => (stdout += chunk))
      child.stderr.on("data", (chunk) => (stderr += chunk))
      child.on("error", reject)
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }))
    }
  )

it("serves the shared authenticated gateway protocol on Bun and shuts down cleanly", async () => {
  const { code, signal, stdout, stderr } = await runFixture()
  // The success JSON alone does not qualify the gateway: scope shutdown after the
  // bind-conflict probe must also finish, so the process exit status is asserted.
  expect({ code, signal, stderr }).toMatchObject({ code: 0, signal: null })
  expect(JSON.parse(stdout)).toMatchObject({ runtime: "bun", passed: true })
  // The only stderr output is the operator log for the intentional EADDRINUSE probe.
  expect(stderr).toContain("EADDRINUSE")
  expect(stderr).not.toMatch(/interrupted/i)
}, 65_000)
