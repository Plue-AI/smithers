import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

// Collection only: no browser, HTTP request, installed host or check receipt.
// The actual runner must discover the scenario before its real-install fixtures
// can enforce the release prerequisites. Suite-level metadata arrives too late.
const list = (spec: string, host: "local" | "production") => {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (name.startsWith("SMITHERS_J1_") || ["SMITHERS_REAL_E2E_MODE", "SMITHERS_REAL_TEST_GREP", "SMITHERS_J1_ACTIVATION"].includes(name)) delete env[name]
  }
  return spawnSync("pnpm", ["exec", "playwright", "test", "--config", "playwright.real.config.ts",
    `e2e/real/${spec}.spec.ts`, "--list", "--reporter", "list"], {
    cwd: new URL("../../..", import.meta.url), encoding: "utf8", timeout: 30_000,
    env: { ...env, SMITHERS_JOURNEY: `${spec}.spec.ts`, SMITHERS_REAL_E2E_HOST: host,
      SMITHERS_REAL_BASE_URL: "http://127.0.0.1:49999", SMITHERS_REAL_E2E_BUILD_SHA: "a".repeat(40), SMITHERS_REAL_HEADED: "1" }
  })
}

for (const spec of ["todo-from-issue", "todo-needs-you", "todo-evidence", "todo-merge"]) {
  for (const host of ["local", "production"] as const) test(`${spec} is discoverable on ${host} through the public runner`, () => {
    const result = list(spec, host)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Total: 1 test in 1 file")
    expect(result.stdout).toContain(`${spec}.spec.ts`)
    expect(result.stderr).not.toContain("No tests found")
  }, 35_000)
}

for (const spec of ["fresh-repository", "wiki-coedit", "wiki-generated-refresh"]) {
  test(`${spec} retains Mac admission before collection`, () => {
    const result = list(spec, "local")
    expect(result.error).toBeUndefined()
    if (process.platform === "darwin") {
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("Total: 1 test in 1 file")
    } else {
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("Install config qualification requires a built Mac reference install")
      expect(result.stderr).not.toContain("No tests found")
    }
  }, 35_000)
}
