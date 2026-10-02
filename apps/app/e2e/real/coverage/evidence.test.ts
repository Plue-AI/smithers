import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveEvidence, rawEvidence, readEvidenceReference, validateRawMatrixEvidence, type ExpectedMatrixEvidence } from "./evidence"
import { owedScenarioIds } from "./matrix"
import type { RealE2EEvidenceFile } from "./types"
import Reporter from "./reporter"
import type { FullResult } from "@playwright/test/reporter"

const roots: string[] = []
const root = () => { const value = mkdtempSync(join(tmpdir(), "smithers-matrix-evidence-")); roots.push(value); return value }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const expected: ExpectedMatrixEvidence = {
  executionID: "01234567-89ab-4def-8123-456789abcdef", mode: "local-plue", origin: "http://127.0.0.1:5173", endpoint: "https://backend.example.test",
  revision: "a".repeat(40), buildSha: "b".repeat(40), startedAt: "2026-09-24T00:00:00.000Z", finishedAt: "2026-09-24T00:01:00.000Z"
}
const evidence = (): RealE2EEvidenceFile => ({ suiteStatus: "passed", reporterErrors: [],
  execution: { ...expected, surfaceOrigin: expected.origin },
  runs: owedScenarioIds(expected.mode).map(scenarioId => ({ scenarioId, host: "production", mode: expected.mode, status: "passed",
    revision: expected.revision, buildSha: expected.buildSha, startedAt: expected.startedAt, finishedAt: expected.finishedAt })) })

test("raw receipts require exactly the owed scenarios and their actual invocation identity", () => {
  expect(validateRawMatrixEvidence(evidence(), expected)).toEqual([])
  const changed = [
    { ...evidence(), execution: { ...evidence().execution!, executionID: "stale" } },
    { ...evidence(), execution: { ...evidence().execution!, endpoint: "https://another.example.test" } },
    { ...evidence(), execution: { ...evidence().execution!, surfaceOrigin: "http://127.0.0.1:5174" } },
    { ...evidence(), runs: evidence().runs.slice(1) },
    { ...evidence(), runs: [...evidence().runs, evidence().runs[0]!] },
    { ...evidence(), runs: evidence().runs.map(run => ({ ...run, mode: "web-plue" })) },
    { ...evidence(), runs: evidence().runs.map(run => ({ ...run, startedAt: "2026-09-23T00:00:00Z" })) },
    { ...evidence(), reporterErrors: ["cleanup failed"] },
    { ...evidence(), suiteStatus: "failed" }
  ]
  for (const value of changed) expect(validateRawMatrixEvidence(value, expected).length).toBeGreaterThan(0)
})

test("evidence hashes retain exact child bytes, refuse tampering and never overwrite prior runs", () => {
  const directory = root(), bytes = new TextEncoder().encode(JSON.stringify(evidence()))
  const ref = archiveEvidence(directory, "local-plue/raw.json", bytes)
  expect(rawEvidence(directory, ref)).toEqual(evidence())
  expect(() => archiveEvidence(directory, "local-plue/raw.json", bytes)).toThrow()
  expect(() => readEvidenceReference(directory, { ...ref, path: "../raw.json" })).toThrow()
  writeFileSync(join(directory, ref.path), "{}")
  expect(() => readEvidenceReference(directory, ref)).toThrow("hash mismatch")
  const other = root(), foreign = archiveEvidence(other, "foreign.json", bytes)
  symlinkSync(join(other, foreign.path), join(directory, "outside.json"))
  expect(() => readEvidenceReference(directory, { ...foreign, path: "outside.json" })).toThrow()
})

test("reporter persists runtime invocation metadata even when the child suite fails", () => {
  const directory = root(), output = join(directory, "raw.json")
  const values: Record<string, string> = {
    SMITHERS_REAL_E2E_HOST: "production", SMITHERS_REAL_E2E_MODE: expected.mode, SMITHERS_REAL_E2E_REVISION: expected.revision,
    SMITHERS_REAL_E2E_BUILD_SHA: expected.buildSha!, SMITHERS_REAL_E2E_RESULTS: output, SMITHERS_REAL_BASE_URL: expected.origin,
    SMITHERS_REAL_MATRIX_EXECUTION_ID: expected.executionID, SMITHERS_REAL_MATRIX_ORIGIN: expected.origin, SMITHERS_REAL_MATRIX_ENDPOINT: expected.endpoint
  }
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  try {
    Object.assign(process.env, values)
    new Reporter().onEnd({ status: "failed" } as FullResult)
    const raw = JSON.parse(readFileSync(output, "utf8"))
    expect(raw.suiteStatus).toBe("failed")
    expect(raw.execution).toMatchObject({ executionID: expected.executionID, mode: expected.mode, origin: expected.origin, endpoint: expected.endpoint, surfaceOrigin: expected.origin })
    expect(validateRawMatrixEvidence(raw, { ...expected, finishedAt: new Date().toISOString() }).length).toBeGreaterThan(0)
  } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
})
