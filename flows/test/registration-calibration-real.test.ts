import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { BANDS, DETERMINISTIC, fit, type Fit, LANGUAGES } from "../register-repository/calibration/fit.ts"
import { type ManifestEntry, type RealCase, recordRepository } from "../register-repository/calibration/record.ts"

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../register-repository/calibration/${name}`, import.meta.url), "utf8")) as T
const manifest = read<{
  quota: Record<"human" | "agent" | "hybrid", number>
  unfilled: Record<string, number>
  entries: ReadonlyArray<ManifestEntry>
}>("manifest.json")
const corpus = read<{ synthetic: boolean; cases: ReadonlyArray<RealCase> }>("real-corpus.json")
const artifact = read<Fit>("real-fit.json")
const TOLERANCE = 1e-3
const LABELS = ["human", "agent", "hybrid"] as const

const close = (left: unknown, right: unknown, path = ""): void => {
  if (typeof left === "number" && typeof right === "number") {
    assert.ok(Math.abs(left - right) <= TOLERANCE, `${path}: ${left} vs ${right}`)
  } else if (left !== null && typeof left === "object") {
    for (const key of Object.keys(left)) close((left as any)[key], (right as any)[key], `${path}.${key}`)
  } else assert.equal(left, right, path)
}

test("manifest: every sampled repository is pinned, unique and in a documented cell", () => {
  const { entries } = manifest
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length)
  assert.equal(new Set(entries.map((entry) => entry.repo)).size, entries.length)
  for (const entry of entries) {
    assert.match(entry.sha, /^[0-9a-f]{40}$/, entry.id)
    assert.match(entry.repo, /^[\w.-]+\/[\w.-]+$/, entry.id)
    assert.ok(entry.evidence.length > 0, entry.id)
    assert.ok((LANGUAGES as ReadonlyArray<string>).includes(entry.language))
    assert.ok((BANDS as ReadonlyArray<string>).includes(entry.band))
    assert.ok(LABELS.includes(entry.label))
    assert.ok(entry.id.startsWith(`${entry.language}-${entry.band}-${entry.label}-`), entry.id)
  }
  // Every cell holds its quota unless the manifest names the shortfall.
  for (const language of LANGUAGES) {
    for (const band of BANDS) {
      for (const label of LABELS) {
        const cell = `${language}/${band}/${label}`
        const count = entries.filter((e) => e.language === language && e.band === band && e.label === label).length
        assert.equal(count, manifest.quota[label] - (manifest.unfilled[cell] ?? 0), cell)
      }
    }
  }
})

test("real corpus: one recorded case per manifest entry, never synthetic", () => {
  assert.equal(corpus.synthetic, false)
  assert.equal(corpus.cases.length, manifest.entries.length)
  manifest.entries.forEach((entry, index) => {
    const recorded = corpus.cases[index]!
    for (const key of ["id", "repo", "sha", "language", "band", "label"] as const) assert.equal(recorded[key], entry[key])
    assert.ok(recorded.coverage >= 0.6 && recorded.lines > 0, entry.id)
    for (const id of DETERMINISTIC) {
      const value = recorded.values[id]
      assert.ok(value === null || (Number.isFinite(value) && value >= 0), `${entry.id} ${id}`)
    }
    assert.notEqual(recorded.values.duplicates, null, entry.id)
  })
})

test("real fit is what the fitter computes from the real corpus", () => {
  close(fit(corpus.cases, "calibrated-real-v1"), artifact)
  assert.equal(artifact.method, "calibrated-real-v1")
})

const reachable = () => {
  try {
    execFileSync("git", ["ls-remote", "--exit-code", "https://github.com/octocat/Hello-World.git", "HEAD"], {
      stdio: "ignore",
      timeout: 20_000
    })
    return true
  } catch {
    return false
  }
}

/** The five smallest recorded repositories, at least one per label when available: cheap to fetch. */
const sample = () => {
  const smallest = [...corpus.cases].sort((a, b) => a.lines - b.lines)
  const chosen = LABELS.flatMap((label) => smallest.filter((entry) => entry.label === label).slice(0, 1))
  return [...chosen, ...smallest.filter((entry) => !chosen.includes(entry))].slice(0, 5)
}

test("recorded corpus reproduces from the manifest for a five-repository sample", {
  skip: reachable() ? false : "GitHub is not reachable from this host",
  timeout: 600_000
}, async () => {
  const work = mkdtempSync(join(tmpdir(), "calibration-test-"))
  try {
    const picked = sample()
    assert.equal(picked.length, 5)
    const results = await Promise.all(picked.map((entry) => recordRepository(manifest.entries.find((m) => m.id === entry.id)!, work)))
    results.forEach((result, index) => {
      assert.ok(result.ok, picked[index]!.id)
      if (result.ok) assert.deepEqual(result.recorded, picked[index])
    })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
