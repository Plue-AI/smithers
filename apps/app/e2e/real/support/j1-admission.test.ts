import { expect, test } from "bun:test"
import { spawnSync } from "../../../scripts/test-child"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

for (const door of ["environment", "argv"] as const) test(`TODO journey ${door} selection refuses development-host fallback`, () => {
  const env = { ...process.env }
  for (const name of ["SMITHERS_REAL_BASE_URL", "SMITHERS_JOURNEY", "SMITHERS_J1_ACTIVATION"]) delete (env as NodeJS.ProcessEnv)[name]
  if (door === "environment") env.SMITHERS_JOURNEY = "todo-from-issue.spec.ts"
  const result = spawnSync("pnpm", ["exec", "playwright", "test", "--config", "playwright.real.config.ts",
    ...(door === "argv" ? ["e2e/real/todo-from-issue.spec.ts"] : []), "--list", "--reporter", "list"], {
    cwd: new URL("../../..", import.meta.url), env, encoding: "utf8", timeout: 30_000
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("Release journey qualification requires a reference install origin")
  expect(result.stderr).not.toContain("webServer")
  expect(result.stderr).not.toContain("SMITHERS_REAL_E2E_REVISION is required")
}, 35_000)

// Exercise the public test-runner door: selecting the spec directly must refuse
// before Playwright's reporter or webServer can start a development install.
for (const spec of ["j1-activation.spec.ts", "j1.spec.ts", "keyboard-journeys.spec.ts"]) test(`direct ${spec} selection refuses a missing reference install during config admission`, () => {
  const env = { ...process.env, SMITHERS_JOURNEY: spec }
  for (const name of ["SMITHERS_REAL_BASE_URL", "SMITHERS_E2E_BASE_URL", "SMITHERS_J1_PRECONDITIONS"]) delete (env as NodeJS.ProcessEnv)[name]
  const result = spawnSync("pnpm", ["exec", "playwright", "test", "--config", "playwright.real.config.ts", `e2e/real/${spec}`, "--list", "--reporter", "list"], {
    cwd: new URL("../../..", import.meta.url), env, encoding: "utf8", timeout: 30_000
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("precondition/install_missing")
  expect(result.stderr).not.toContain("webServer")
  expect(result.stderr).not.toContain("SMITHERS_REAL_E2E_REVISION is required")
}, 35_000)

for (const refusal of ["candidate", "recording-review"] as const) test(`direct release activation refuses ${refusal} before a browser or host starts`, () => {
  const dir = mkdtempSync(join(process.cwd(), ".j1-admission-test-"))
  try {
    const recording = join(dir, "screen.mp4")
    const evidence = join(dir, "preconditions.json")
    // Admission fixtures only; this command lists tests and never qualifies a journey.
    writeFileSync(recording, "operator recording fixture")
    writeFileSync(evidence, JSON.stringify({
      stage: "R", operator: { name: "outside operator", didNotBuildTickets: true, instructions: "quickstart" },
      host: { referenceMini: true, freshMacOSUser: true, erased: true, macOSMajor: 15, homebrew: true, profile: { architecture: "arm64" } },
      fresh: { install: true, repository: true, modelCache: true, noSmithersFiles: true, canaryTemplate: true, detectedTestCommand: "node --test" },
      owner: "canary-owner", repository: "smithers-mvp-canary/2026-10-05", t0: new Date().toISOString(),
      clockOffsetStartMs: 0, recording, setupURL: "http://localhost:4000/setup?token=fixture",
      install: { version: "fixture", commit: "a".repeat(40) }
    }))
    const result = spawnSync("pnpm", ["exec", "playwright", "test", "--config", "playwright.real.config.ts", "e2e/real/j1-activation.spec.ts", "--list", "--reporter", "list"], {
      cwd: new URL("../../..", import.meta.url), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, SMITHERS_JOURNEY: "j1-activation.spec.ts", SMITHERS_REAL_BASE_URL: "http://localhost:4000",
        SMITHERS_J1_PRECONDITIONS: evidence, SMITHERS_J1_REVIEW: join(dir, "review.json"),
        SMITHERS_J1_FINAL_EVIDENCE: join(dir, "final.json"), SMITHERS_J1_RECORDING_REVIEW: refusal === "recording-review" ? "" : join(dir, "recording-review.json"),
        SMITHERS_REAL_HEADED: "1", SMITHERS_REAL_E2E_BUILD_SHA: "b".repeat(40) }
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(refusal === "candidate"
      ? "declared build SHA must match the operator's installed candidate"
      : "SMITHERS_J1_RECORDING_REVIEW must name the sanitized full-run recording review")
    expect(result.stderr).not.toContain("webServer")
    expect(result.stderr).not.toContain("SMITHERS_REAL_E2E_REVISION is required")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 35_000)
