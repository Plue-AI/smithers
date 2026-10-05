import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildModel, disagreements, findStep, generate, lineOf, parseMock, permalink, recordedTests, renderHtml, sameFile, titleNames, verdictOf,
  type Feature, type MockReel, type PwReport, type PwStep, type Verdict
} from "./proof-page.ts"

const fixtures = join(import.meta.dir, "test/fixtures")
const root = join(import.meta.dir, "../../..")
const fixtureReport = JSON.parse(readFileSync(join(fixtures, "results.json"), "utf8")) as PwReport
const fixtureFeatures = JSON.parse(readFileSync(join(fixtures, "features.json"), "utf8")) as ReadonlyArray<Feature>
const fixtureMock = parseMock(JSON.parse(readFileSync(join(fixtures, "mock-steps.json"), "utf8")))

const feature = (overrides: Partial<Feature> & { id: string }): Feature => ({
  title: overrides.id, journey: "J1", mockSteps: [], status: "not-implemented", proof: [], docs: [], code: [], gap: "", ...overrides
})

/** A report with one test in `file` whose steps are given as [title, error?, children?]. */
type StepSpec = readonly [string, string?, ReadonlyArray<StepSpec>?]
const report = (file: string, steps: ReadonlyArray<StepSpec>, annotations: ReadonlyArray<{ type: string; description?: string }> = []): PwReport => {
  const toStep = ([title, error, children]: StepSpec): PwStep =>
    ({ title, duration: 1, ...(error === undefined ? {} : { error: { message: error } }), ...(children === undefined ? {} : { steps: children.map(toStep) }) })
  return { suites: [{ title: file, specs: [{ title: "journey", file, line: 3, tests: [{ annotations, results: [{ status: "passed", steps: steps.map(toStep), attachments: [] }] }] }] }] }
}

const proof = (step: string, file = "apps/app/e2e/proof/j1.spec.ts") => ({ file, step })

describe("verdict rules", () => {
  test("Works when every proof step passed", () => {
    const tests = recordedTests(report("j1.spec.ts", [["a"], ["b"]]))
    expect(verdictOf(feature({ id: "a", proof: [proof("a"), proof("b")] }), tests)).toEqual({ kind: "works" })
  })

  test("Broken with the first error when a proof step failed", () => {
    const tests = recordedTests(report("j1.spec.ts", [["a"], ["b", "expected Merge to be visible"]]))
    expect(verdictOf(feature({ id: "a", proof: [proof("a"), proof("b")] }), tests)).toEqual({ kind: "broken", detail: "expected Merge to be visible" })
  })

  test("a soft assertion's error on a child step breaks the feature", () => {
    const tests = recordedTests(report("j1.spec.ts", [["a", undefined, [["expect.soft toBeVisible", "\u001b[31mnot visible\u001b[39m"]]]]))
    expect(verdictOf(feature({ id: "a", proof: [proof("a")] }), tests)).toEqual({ kind: "broken", detail: "not visible" })
  })

  test("Blocked by the feature named in the step's error", () => {
    const tests = recordedTests(report("j1.spec.ts", [["a", "boom"], ["b", "Error: blocked by a"]]))
    expect(verdictOf(feature({ id: "b", proof: [proof("b")] }), tests)).toEqual({ kind: "blocked", blockedBy: "a" })
  })

  test("Blocked by the feature named in a test annotation", () => {
    const tests = recordedTests(report("j1.spec.ts", [["b"]], [{ type: "blocked", description: "b: blocked by j1-machine-ready" }]))
    expect(verdictOf(feature({ id: "b", proof: [proof("b")] }), tests)).toEqual({ kind: "blocked", blockedBy: "j1-machine-ready" })
  })

  test("Broken outranks Blocked across a feature's proof steps", () => {
    const tests = recordedTests(report("j1.spec.ts", [["a", "blocked by z"], ["b", "boom"]]))
    expect(verdictOf(feature({ id: "a", proof: [proof("a"), proof("b")] }), tests).kind).toBe("broken")
  })

  test("Not built with the registry's gap when there is no proof", () => {
    expect(verdictOf(feature({ id: "a", gap: "No Merge button yet." }), [])).toEqual({ kind: "not-built", detail: "No Merge button yet." })
    expect(verdictOf(feature({ id: "a", gap: "" }), [])).toEqual({ kind: "not-built", detail: "No proof step yet." })
  })

  test("Not built when the run never recorded a named step, even if the others passed", () => {
    const tests = recordedTests(report("j1.spec.ts", [["a"]]))
    const verdict = verdictOf(feature({ id: "a", proof: [proof("a"), proof("b")] }), tests)
    expect(verdict.kind).toBe("not-built")
    expect(verdict.detail).toContain("step b")
  })

  test("a step in another spec file does not count", () => {
    const tests = recordedTests(report("j2.spec.ts", [["a"]]))
    expect(verdictOf(feature({ id: "a", proof: [proof("a")] }), tests).kind).toBe("not-built")
  })

  test("the last retry decides", () => {
    const base = report("j1.spec.ts", [["a", "flaky"]])
    const spec = base.suites![0]!.specs![0]!
    const retried: PwReport = { suites: [{ specs: [{ ...spec, tests: [{ results: [spec.tests![0]!.results![0]!, { status: "passed", steps: [{ title: "a", duration: 1 }] }] }] }] }] }
    expect(verdictOf(feature({ id: "a", proof: [proof("a")] }), recordedTests(retried)).kind).toBe("works")
  })

  test("a step title names a feature alone or before a space or colon, never as a prefix of another id", () => {
    expect(titleNames("j1-merge", "j1-merge")).toBe(true)
    expect(titleNames("j1-merge: press Merge", "j1-merge")).toBe(true)
    expect(titleNames("j1-merge in the app", "j1-merge")).toBe(true)
    expect(titleNames("j1-merge-in-app", "j1-merge")).toBe(false)
  })

  test("spec files match by repository path suffix", () => {
    expect(sameFile("j1.spec.ts", "apps/app/e2e/proof/j1.spec.ts")).toBe(true)
    expect(sameFile("proof/j1.spec.ts", "apps/app/e2e/proof/j1.spec.ts")).toBe(true)
    expect(sameFile("xj1.spec.ts", "apps/app/e2e/proof/j1.spec.ts")).toBe(false)
  })

  test("findStep is undefined for a step the run did not reach", () => {
    expect(findStep(recordedTests(report("j1.spec.ts", [["a"]])), proof("b"))).toBeUndefined()
  })
})

describe("disagreements", () => {
  const verdicts = (entries: ReadonlyArray<readonly [string, Verdict["kind"]]>) => new Map(entries.map(([id, kind]) => [id, { kind }] as const))
  test("implemented must be Works and Works must be implemented", () => {
    const features = [
      feature({ id: "ok-yes", status: "implemented" }), feature({ id: "ok-no", status: "not-implemented" }),
      feature({ id: "claims", status: "implemented" }), feature({ id: "modest", status: "not-implemented" }),
      feature({ id: "blocked", status: "implemented" })
    ]
    expect(disagreements(features, verdicts([["ok-yes", "works"], ["ok-no", "broken"], ["claims", "not-built"], ["modest", "works"], ["blocked", "blocked"]]))).toEqual([
      { id: "claims", status: "implemented", verdict: "not-built" },
      { id: "modest", status: "not-implemented", verdict: "works" },
      { id: "blocked", status: "implemented", verdict: "blocked" }
    ])
  })
})

describe("links", () => {
  test("permalinks pin the recorded commit and keep line anchors", () => {
    expect(permalink("https://github.com/o/r", "abc1234", "packages/x.go#L10-L20")).toBe("https://github.com/o/r/blob/abc1234/packages/x.go#L10-L20")
    expect(permalink("https://github.com/o/r", "abc1234", "/docs/a.md")).toBe("https://github.com/o/r/blob/abc1234/docs/a.md")
  })
  test("a proof step's line is the first line quoting its id", () => {
    expect(lineOf('a\n  await proofStep("j1-a-b", async () => {\n  await proofStep("j1-a", x)', "j1-a")).toBe(3)
    expect(lineOf("nothing", "j1-a")).toBeUndefined()
  })
})

describe("mock steps", () => {
  test("accepts captions as strings or {caption, spec}", () => {
    expect(fixtureMock[0]!.steps[1]).toEqual({ caption: "She writes a draft.", spec: "FX.2" })
    expect(fixtureMock[0]!.steps[0]).toEqual({ caption: "She continues past setup." })
  })
  test("refuses a journey without a file", () => {
    expect(() => parseMock([{ steps: [] }])).toThrow("no file")
    expect(() => parseMock({})).toThrow("array of journeys")
  })
})

describe("the fixture run (a real Playwright run of test/fx.pw.ts)", () => {
  const model = buildModel({ features: fixtureFeatures, mock: fixtureMock, report: fixtureReport, sha: "0123456789abcdef0123456789abcdef01234567", time: "t" })
  test("each feature gets the verdict its recorded step earned", () => {
    expect(Object.fromEntries(Object.values(model.features).map(each => [each.id, each.verdict.kind]))).toEqual({
      "fx-pass": "works", "fx-fail": "broken", "fx-blocked": "blocked", "fx-disagree": "works",
      "fy-unrecorded": "not-built", "fy-none": "not-built", "fz-orphan": "not-built"
    })
    expect(model.features["fx-blocked"]!.verdict.blockedBy).toBe("fx-fail")
    expect(model.features["fx-fail"]!.verdict.detail).toContain("Commit")
  })
  test("a step shows its worst feature; a step no feature covers is Not built", () => {
    expect(model.reels[0]!.steps.map(step => step.verdict)).toEqual(["works", "broken", "broken", "works"])
    expect(model.reels[1]!.steps.map(step => step.verdict)).toEqual(["not-built", "not-built"])
  })
  test("counts only features that work, per journey", () => {
    expect(model.counts).toEqual({ works: 2, total: 7, byJourney: [{ journey: "FX", works: 2, total: 4 }, { journey: "FY", works: 0, total: 2 }, { journey: "FZ", works: 0, total: 1 }] })
  })
  test("reports the disagreeing status and the unknown mock step", () => {
    expect(model.disagreements).toEqual([{ id: "fx-disagree", status: "not-implemented", verdict: "works" }])
    expect(model.unknownSteps).toEqual([{ id: "fz-orphan", ref: "fz#9" }])
  })
  test("features without a mock step open their reel; a journey without a reel gets its own", () => {
    expect(model.reels[1]!.unmapped).toEqual(["fy-none"])
    expect(model.reels.at(-1)).toMatchObject({ file: "other", unmapped: ["fz-orphan"] })
  })
  test("generate embeds screenshots, copies the video and makes no external request", async () => {
    const out = mkdtempSync(join(tmpdir(), "proof-page-"))
    try {
      const generated = await generate({ root, features: join(fixtures, "features.json"), results: join(fixtures, "results.json"), mock: join(fixtures, "mock-steps.json"), out })
      const html = readFileSync(join(out, "index.html"), "utf8")
      expect(generated.sha).toBe("0123456789abcdef0123456789abcdef01234567")
      expect(html).toContain("data:image/png;base64,")
      expect(generated.reels[0]!.video).toBe("videos/fx.webm")
      expect(existsSync(join(out, "videos/fx.webm"))).toBe(true)
      const external = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map(match => match[1]!)
      expect(external.every(url => url.startsWith("https://github.com/smithersai/smithers/"))).toBe(true)
      expect(html).not.toMatch(/<(?:link|script)[^>]+(?:href|src)=/)
      expect(html).toContain("https://github.com/smithersai/smithers/blob/0123456789abcdef0123456789abcdef01234567/apps/app/proof/test/fx.pw.ts#L")
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})

/* ── Property: every feature and every mock step appears exactly once ── */

const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const randomWorld = (seed: number) => {
  const random = prng(seed)
  const pick = <T,>(list: ReadonlyArray<T>): T => list[Math.floor(random() * list.length)]!
  const files = ["j1", "j2", "j10", "run", "agent"].slice(0, 1 + Math.floor(random() * 5))
  const mock: Array<MockReel> = files.map(file => ({ file, title: file, intro: `<intro ${file}>`, steps: Array.from({ length: Math.floor(random() * 6) }, (_, i) => ({ caption: `${file} step ${i + 1} </script>` })) }))
  const refs = mock.flatMap(reel => reel.steps.map((_, i) => `${reel.file}#${i + 1}`))
  const ids = Array.from({ length: Math.floor(random() * 12) }, (_, i) => `f-${seed}-${i}`)
  const steps: Array<[string, string?]> = []
  const features: Array<Feature> = ids.map(id => {
    const mockSteps = Array.from({ length: Math.floor(random() * 4) }, () => random() < 0.85 && refs.length > 0 ? pick(refs) : `zz#${Math.floor(random() * 9)}`)
    const outcome = random()
    if (outcome < 0.3) steps.push([id])
    else if (outcome < 0.5) steps.push([id, "boom & <b>"])
    else if (outcome < 0.6) steps.push([id, `blocked by ${pick(ids)}`])
    return feature({ id, title: `<${id}>`, journey: pick([...files, "J9"]), mockSteps, status: random() < 0.5 ? "implemented" : "not-implemented", proof: random() < 0.8 ? [proof(id)] : [] })
  })
  return { features, mock, report: report("j1.spec.ts", steps) }
}

const count = (text: string, needle: string) => text.split(needle).length - 1

describe("property: coverage", () => {
  test("for 300 random registries, every feature has exactly one home and every mock step exactly one frame", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const world = randomWorld(seed)
      const model = buildModel({ ...world, sha: "abcdef0", time: "t" })
      const homes = model.reels.flatMap(reel => [...reel.unmapped, ...reel.steps.flatMap(step => step.home)])
      expect([...homes].sort()).toEqual(world.features.map(each => each.id).sort())
      const frames = model.reels.flatMap(reel => reel.steps.map(step => step.ref))
      expect(frames).toEqual(world.mock.flatMap(reel => reel.steps.map((_, i) => `${reel.file}#${i + 1}`)))
      for (const reel of model.reels) for (const step of reel.steps) {
        for (const id of step.features) expect(world.features.find(each => each.id === id)!.mockSteps).toContain(step.ref)
      }
      const html = renderHtml(model)
      for (const each of world.features) expect(count(html, `data-feature-home="${each.id}"`)).toBe(1)
      for (const ref of frames) expect(count(html, `data-mock-step="${ref}"`)).toBe(1)
      expect(count(html, "</script>")).toBe(3)
      expect(model.counts.works).toBe(Object.values(model.features).filter(each => each.verdict.kind === "works").length)
    }
  })
})
