import { describe, expect, test } from "bun:test"
import { type Feature, featureSchema } from "./schema.ts"
import { type IssueKind, validateFeatures } from "./validate.ts"
import { fixtureMock, fixtureRepo } from "./fixtures.ts"

/** Deterministic PRNG (mulberry32) so a failing seed reproduces. */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const SEEDS = 300
const word = (rand: () => number) => Array.from({ length: 1 + Math.floor(rand() * 8) }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rand() * 36)]).join("")
const pick = <T,>(rand: () => number, values: ReadonlyArray<T>): T => values[Math.floor(rand() * values.length)]!

/** A registry of valid entries plus the tree they point into. */
function generate(seed: number): { features: Feature[]; files: Record<string, string> } {
  const rand = prng(seed)
  const files: Record<string, string> = { ".specs/product/mvp.md": "# MVP\n" }
  const features: Feature[] = []
  const count = Math.floor(rand() * 12)
  for (let i = 0; i < count; i++) {
    const id = `${word(rand)}-${i}`
    const lineTotal = 1 + Math.floor(rand() * 500)
    const codePath = `src/${word(rand)}/${word(rand)}.ts`
    files[codePath] = "x\n".repeat(lineTotal)
    const start = 1 + Math.floor(rand() * lineTotal)
    const end = start + Math.floor(rand() * (lineTotal - start + 1))
    const docsPath = `docs/${word(rand)}.md`
    files[docsPath] = "# doc\n"
    const implemented = rand() < 0.5
    const proofFile = `apps/app/e2e/proof/${word(rand)}.spec.ts`
    files[proofFile] = `${files[proofFile] ?? ""}proofStep("${id}")\n`
    features.push({
      id,
      title: `Feature ${i}`,
      journey: pick(rand, ["J1", "J2", "J10", "run", "agent"]),
      spec: rand() < 0.5 ? ".specs/product/mvp.md" : `.specs/product/mvp.md#${word(rand)}`,
      mockSteps: Array.from({ length: Math.floor(rand() * 4) }, () => `j1#${1 + Math.floor(rand() * 30)}`),
      status: implemented ? "implemented" : "not-implemented",
      proof: implemented || rand() < 0.5 ? [{ file: proofFile, step: id }] : [],
      docs: rand() < 0.5 ? [docsPath] : [`${docsPath}#${word(rand)}`],
      code: rand() < 0.3 ? [codePath] : [`${codePath}#L${start}-L${end}`],
      gap: implemented ? "" : `Gap ${word(rand)}`
    })
  }
  return { features, files }
}

type Mutation = { readonly kind: IssueKind; readonly apply: (feature: Feature, files: Record<string, string>) => Feature }

const MUTATIONS: ReadonlyArray<Mutation> = [
  { kind: "mock-step-missing", apply: feature => ({ ...feature, mockSteps: [...feature.mockSteps, "j1#31"] }) },
  { kind: "proof-file-missing", apply: feature => ({ ...feature, proof: [{ file: "apps/app/e2e/proof/missing.spec.ts", step: feature.id }] }) },
  { kind: "proof-step-missing", apply: (feature, files) => {
    files["apps/app/e2e/proof/other.spec.ts"] = "proofStep()\n"
    return { ...feature, proof: [{ file: "apps/app/e2e/proof/other.spec.ts", step: feature.id }] }
  } },
  { kind: "code-path-missing", apply: feature => ({ ...feature, code: ["src/missing.ts#L1-L1"] }) },
  { kind: "code-range-out-of-bounds", apply: (feature, files) => {
    files["src/short.ts"] = "x\n"
    return { ...feature, code: ["src/short.ts#L1-L2"] }
  } },
  { kind: "docs-path-missing", apply: feature => ({ ...feature, docs: ["docs/missing.md"] }) },
  { kind: "spec-path-missing", apply: feature => ({ ...feature, spec: ".specs/product/missing.md" }) },
  { kind: "gap-missing", apply: feature => ({ ...feature, status: "not-implemented", gap: "" }) },
  { kind: "gap-on-implemented", apply: feature => ({ ...feature, status: "implemented", proof: [{ file: "apps/app/e2e/proof/self.spec.ts", step: feature.id }], gap: "gap" }) }
]

describe("validateFeatures over generated registries", () => {
  test("every generated entry parses and a valid registry has no issues", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { features, files } = generate(seed)
      for (const feature of features) expect(featureSchema.safeParse(feature).success).toBe(true)
      expect({ seed, issues: validateFeatures(features, fixtureRepo(files), fixtureMock) }).toEqual({ seed, issues: [] })
    }
  })

  test("validation does not depend on entry order", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { features, files } = generate(seed)
      const forward = validateFeatures(features, fixtureRepo(files), fixtureMock).map(issue => issue.message).sort()
      const backward = validateFeatures([...features].reverse(), fixtureRepo(files), fixtureMock).map(issue => issue.message).sort()
      expect(backward).toEqual(forward)
    }
  })

  test("one broken link in one entry gives exactly that issue, on that entry", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { features, files } = generate(seed)
      if (features.length === 0) continue
      const rand = prng(seed * 7919)
      const index = Math.floor(rand() * features.length)
      const mutation = pick(rand, MUTATIONS)
      const target = features[index]!
      files["apps/app/e2e/proof/self.spec.ts"] = `${files["apps/app/e2e/proof/self.spec.ts"] ?? ""}${target.id}\n`
      const broken = features.map((feature, i) => (i === index ? mutation.apply(feature, files) : feature))
      const issues = validateFeatures(broken, fixtureRepo(files), fixtureMock)
      expect({ seed, kinds: issues.map(issue => issue.kind), ids: issues.map(issue => issue.id) }).toEqual({ seed, kinds: [mutation.kind], ids: [target.id] })
    }
  })

  test("duplicating any entry reports exactly one duplicate-id", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { features, files } = generate(seed)
      if (features.length === 0) continue
      const copy = features[seed % features.length]!
      const issues = validateFeatures([...features, copy], fixtureRepo(files), fixtureMock)
      expect(issues.map(issue => [issue.kind, issue.id])).toEqual([["duplicate-id", copy.id]])
    }
  })

  test("arbitrary JSON never throws: it validates or reports a schema issue", () => {
    const rand = prng(42)
    const value = (depth: number): unknown => {
      const r = rand()
      if (depth > 3 || r < 0.2) return pick(rand, [null, true, 0, -1, 1.5, "", "j1#1", "x"])
      if (r < 0.6) return Array.from({ length: Math.floor(rand() * 4) }, () => value(depth + 1))
      return Object.fromEntries(Array.from({ length: Math.floor(rand() * 5) }, () => [pick(rand, ["id", "status", "proof", "code", "gap", word(rand)]), value(depth + 1)]))
    }
    for (let i = 0; i < 1000; i++) {
      const issues = validateFeatures(value(0), fixtureRepo({}), fixtureMock)
      expect(issues.every(issue => typeof issue.message === "string")).toBe(true)
    }
  })
})
