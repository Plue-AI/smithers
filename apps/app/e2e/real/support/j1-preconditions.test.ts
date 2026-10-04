import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { J1PreconditionError, requireJ1Preconditions } from "./j1-preconditions"

// Stay in the worktree: the QA lane cannot write fixtures elsewhere.
const names = ["SMITHERS_REAL_BASE_URL", "SMITHERS_E2E_BASE_URL", "SMITHERS_J1_PRECONDITIONS", "SMITHERS_J1_FINAL_EVIDENCE", "SMITHERS_J1_REVIEW", "SMITHERS_REAL_HEADED", "SMITHERS_REAL_E2E_ARTIFACTS", "SMITHERS_REAL_E2E_HOST", "SMITHERS_J1_ACTIVATION"]
const run = (body: (dir: string, value: ReturnType<typeof fixture>) => void) => {
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  const dir = mkdtempSync(join(process.cwd(), ".j1-precondition-test-"))
  try {
    for (const name of names) delete process.env[name]
    const value = fixture(dir)
    writeFileSync(value.recording, "operator recording fixture")
    process.env.SMITHERS_REAL_BASE_URL = "http://localhost:4000"
    process.env.SMITHERS_J1_PRECONDITIONS = join(dir, "preconditions.json")
    process.env.SMITHERS_J1_REVIEW = join(dir, "review.json")
    process.env.SMITHERS_J1_FINAL_EVIDENCE = join(dir, "final.json")
    process.env.SMITHERS_REAL_HEADED = "1"
    writeFileSync(process.env.SMITHERS_J1_PRECONDITIONS, JSON.stringify(value))
    body(dir, value)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  }
}
const fixture = (dir: string) => ({
  stage: "S1", operator: { name: "outside operator", didNotBuildTickets: true, instructions: "bundle README" },
  host: { referenceMini: true, freshMacOSUser: true, erased: true, macOSMajor: 15, homebrew: true, profile: { architecture: "arm64" } },
  fresh: { install: true, repository: true, modelCache: true, noSmithersFiles: true, canaryTemplate: true, detectedTestCommand: "npm test" },
  owner: "canary-owner", repository: "smithers-mvp-canary/2026-10-03", t0: new Date().toISOString(),
  clockOffsetStartMs: 0, recording: join(dir, "screen.mp4"), setupURL: "http://localhost:4000/setup?token=fixture",
  install: { version: "fixture", commit: "a".repeat(40) }
})

test("missing install fails with its typed refusal before evidence or a server is read", () => run(() => {
  delete process.env.SMITHERS_REAL_BASE_URL
  try { requireJ1Preconditions(); throw new Error("accepted missing install") }
  catch (error) {
    expect(error).toBeInstanceOf(J1PreconditionError)
    expect((error as J1PreconditionError).code).toBe("install_missing")
    expect(process.env.SMITHERS_J1_ACTIVATION).toBeUndefined()
  }
}))
test("missing human evidence cannot enable activation", () => run(() => {
  delete process.env.SMITHERS_J1_PRECONDITIONS
  expect(requireJ1Preconditions).toThrow("precondition/human_evidence_missing")
  expect(process.env.SMITHERS_J1_ACTIVATION).toBeUndefined()
}))
for (const invalid of ["operator", "clock", "origin", "recording", "stage", "headless", "review"] as const) {
  test(`refuses invalid ${invalid} evidence`, () => run((_dir, value) => {
    if (invalid === "operator") value.operator.didNotBuildTickets = false
    if (invalid === "clock") value.t0 = new Date(Date.now() - 3_600_001).toISOString()
    if (invalid === "origin") value.setupURL = "http://elsewhere.invalid/setup"
    if (invalid === "recording") writeFileSync(value.recording, "")
    if (invalid === "stage") value.operator.instructions = "quickstart"
    if (invalid === "headless") delete process.env.SMITHERS_REAL_HEADED
    if (invalid === "review") delete process.env.SMITHERS_J1_REVIEW
    writeFileSync(process.env.SMITHERS_J1_PRECONDITIONS!, JSON.stringify(value))
    expect(requireJ1Preconditions).toThrow("precondition/human_evidence_invalid")
    expect(process.env.SMITHERS_J1_ACTIVATION).toBeUndefined()
  }))
}
test("valid evidence uses the external install and the check's artifact tree", () => run((_dir, value) => {
  expect(requireJ1Preconditions()).toEqual(value as ReturnType<typeof requireJ1Preconditions>)
  expect(process.env.SMITHERS_REAL_BASE_URL).toBe("http://localhost:4000")
  expect(process.env.SMITHERS_REAL_E2E_HOST).toBe("local")
  expect(process.env.SMITHERS_J1_ACTIVATION).toBe("1")
  expect(process.env.SMITHERS_REAL_E2E_ARTIFACTS).toContain(".artifacts/checks/C-J1-04/")
}))
