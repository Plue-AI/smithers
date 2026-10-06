import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

// Exercise the public test-runner door: selecting the spec directly must refuse
// before Playwright's reporter or webServer can start a development install.
test("direct activation selection refuses a missing reference install during config admission", () => {
  const env = { ...process.env, SMITHERS_JOURNEY: "j1-activation.spec.ts" }
  for (const name of ["SMITHERS_REAL_BASE_URL", "SMITHERS_E2E_BASE_URL", "SMITHERS_J1_PRECONDITIONS"]) delete (env as NodeJS.ProcessEnv)[name]
  const result = spawnSync("pnpm", ["exec", "playwright", "test", "--config", "playwright.real.config.ts", "e2e/real/j1-activation.spec.ts", "--list", "--reporter", "list"], {
    cwd: new URL("../../..", import.meta.url), env, encoding: "utf8", timeout: 30_000
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("precondition/install_missing")
  expect(result.stderr).not.toContain("webServer")
  expect(result.stderr).not.toContain("SMITHERS_REAL_E2E_REVISION is required")
}, 35_000)
