import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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

for (const spec of ["home", "todo-from-issue", "todo-needs-you", "todo-evidence", "todo-merge", "todo-merge-order", "todo-placement", "fork-add-to-stack", "flow-activation", "duplicate-launch", "github-j10/merge-on-github", "github-j10/merge-on-github-continuation", "github-j10/pr-shape", "github-j10/sync-health", "members", "install-origins"]) {
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

// Test collection only: never creates a session or contacts the supplied origin.
test("keyboard continuation is admitted and listed beside fresh activation", () => {
  const dir = mkdtempSync(join(process.cwd(), ".keyboard-collection-"))
  try {
    const recording = join(dir, "screen.mp4"), evidence = join(dir, "preconditions.json")
    writeFileSync(recording, "collection fixture, never release evidence")
    writeFileSync(evidence, JSON.stringify({
      stage: "R", operator: { name: "independent operator", didNotBuildTickets: true, instructions: "quickstart" },
      host: { referenceMini: true, freshMacOSUser: true, erased: true, macOSMajor: 15, homebrew: true, profile: { architecture: "arm64" } },
      fresh: { install: true, repository: true, modelCache: true, noSmithersFiles: true, canaryTemplate: true, detectedTestCommand: "node --test" },
      owner: "canary-owner", repository: "smithers-mvp-canary/2026-10-07", t0: new Date().toISOString(), clockOffsetStartMs: 0,
      recording, setupURL: "http://127.0.0.1:49999/setup?token=collection", install: { version: "collection", commit: "a".repeat(40) }
    }))
    const result = spawnSync("pnpm", ["exec", "playwright", "test", "--config", "playwright.real.config.ts",
      "e2e/real/keyboard-journeys.spec.ts", "--list", "--reporter", "list"], {
      cwd: new URL("../../..", import.meta.url), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, SMITHERS_JOURNEY: "keyboard-journeys.spec.ts", SMITHERS_REAL_E2E_HOST: "local", SMITHERS_REAL_E2E_MODE: undefined,
        SMITHERS_REAL_TEST_GREP: undefined, SMITHERS_REAL_BASE_URL: "http://127.0.0.1:49999", SMITHERS_REAL_E2E_BUILD_SHA: "a".repeat(40),
        SMITHERS_REAL_HEADED: "1", SMITHERS_J1_PRECONDITIONS: evidence, SMITHERS_J1_REVIEW: join(dir, "review.json"),
        SMITHERS_J1_FINAL_EVIDENCE: join(dir, "final.json"), SMITHERS_J1_RECORDING_REVIEW: join(dir, "recording-review.json") }
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Total: 4 tests in 1 file")
    expect(result.stdout).toContain("prepared install branch, stack, flow and monitor keyboard doors")
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 35_000)

for (const host of ["local", "production"] as const) {
  test(`file-coedit's six production-bound cases are discoverable on ${host}`, () => {
    const result = list("file-coedit", host)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Total: 6 tests in 1 file")
    expect(result.stdout).toContain("file-coedit.spec.ts")
    expect(result.stderr).not.toContain("No tests found")
  }, 35_000)
}
