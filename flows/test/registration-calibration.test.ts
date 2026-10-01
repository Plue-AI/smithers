import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import {
  auroc,
  BANDS,
  type CorpusCase,
  DETERMINISTIC,
  DETERMINISTIC_TOTAL,
  type Fit,
  fit,
  LANGUAGES,
  projectSimplex,
  split
} from "../register-repository/calibration/fit.ts"
import { generate, PER_STRATUM } from "../register-repository/calibration/generate.ts"

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../register-repository/calibration/${name}`, import.meta.url), "utf8")) as T
const corpus = read<{ synthetic: boolean; cases: ReadonlyArray<CorpusCase> }>("corpus.json")
const artifact = read<Fit>("fit.json")

/** Stated tolerance: a rerun reproduces the checked-in artifacts within this absolute difference. */
const TOLERANCE = 1e-3
/** Held-out AUROC the fitted anchors must reach on the synthetic corpus. */
const MIN_AUROC = 0.95

const close = (left: unknown, right: unknown, path = ""): void => {
  if (typeof left === "number" && typeof right === "number") {
    assert.ok(Math.abs(left - right) <= TOLERANCE, `${path}: ${left} vs ${right}`)
  } else if (left !== null && typeof left === "object") {
    for (const key of Object.keys(left)) close((left as any)[key], (right as any)[key], `${path}.${key}`)
  } else assert.equal(left, right, path)
}

test("corpus is the documented synthetic set: every stratum and label present", () => {
  assert.equal(corpus.synthetic, true)
  const per = PER_STRATUM.human + PER_STRATUM.agent + PER_STRATUM.hybrid
  assert.equal(corpus.cases.length, per * LANGUAGES.length * BANDS.length)
  assert.equal(new Set(corpus.cases.map((entry) => entry.id)).size, corpus.cases.length)
  for (const language of LANGUAGES) {
    for (const band of BANDS) {
      for (const label of ["human", "agent", "hybrid"] as const) {
        const count = corpus.cases.filter((c) => c.language === language && c.band === band && c.label === label).length
        assert.equal(count, PER_STRATUM[label])
      }
    }
  }
})

test("checked-in corpus and fit are what the scripts regenerate", () => {
  close(generate(), corpus.cases)
  close(fit(corpus.cases), artifact)
})

test("fitted weights are non-negative and sum to the deterministic share", () => {
  const weights = DETERMINISTIC.map((id) => artifact.weights[id])
  assert.ok(weights.every((weight) => weight >= 0))
  assert.ok(Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - DETERMINISTIC_TOTAL) <= TOLERANCE)
})

test("fitted anchors reproduce the labels on held-out cases", () => {
  assert.ok(artifact.auroc.heldOut >= MIN_AUROC, `held-out AUROC ${artifact.auroc.heldOut}`)
  assert.ok(artifact.auroc.train >= MIN_AUROC)
  // Hybrid sits between human and agent.
  assert.ok(artifact.auroc.hybridVsHuman > 0.5 && artifact.auroc.hybridVsHuman < artifact.auroc.heldOut)
  const { heldOut } = split(corpus.cases)
  assert.equal(heldOut.length, artifact.heldOutCases)
  const score = (entry: CorpusCase) =>
    DETERMINISTIC.reduce((sum, id) => {
      const anchor = (artifact.strata[`${entry.language}/${entry.band}`] ?? artifact.pooled)[id]
      const value = entry.values[id]
      assert.ok(value !== null, `synthetic case ${entry.id} must measure ${id}`)
      return sum + artifact.weights[id] * Math.min(1, value / anchor)
    }, 0)
  const recomputed = auroc(
    heldOut.filter((entry) => entry.label !== "hybrid").map((entry) => ({
      score: score(entry),
      positive: entry.label === "agent"
    }))
  )
  assert.ok(Math.abs(recomputed - artifact.auroc.heldOut) <= TOLERANCE)
})

test("every anchor is positive and strata cover all languages and bands", () => {
  assert.equal(Object.keys(artifact.strata).length, LANGUAGES.length * BANDS.length)
  for (const anchors of [artifact.pooled, ...Object.values(artifact.strata)]) {
    for (const id of DETERMINISTIC) assert.ok(anchors[id] > 0)
  }
})

test("helpers: simplex projection, AUROC ties and split", () => {
  const projected = projectSimplex([2, 0, -1])
  assert.deepEqual(projected, [1, 0, 0])
  assert.ok(Math.abs(projectSimplex([0.2, 0.2]).reduce((a, b) => a + b, 0) - 1) < 1e-9)
  assert.equal(auroc([{ score: 1, positive: true }, { score: 1, positive: false }]), 0.5)
  assert.equal(auroc([{ score: 2, positive: true }, { score: 1, positive: false }]), 1)
  const { train, heldOut } = split(corpus.cases)
  assert.equal(train.length + heldOut.length, corpus.cases.length)
  assert.ok(heldOut.every((entry) => !train.includes(entry)))
})
