import * as Fs from "node:fs/promises"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import {
  classifyOutcome,
  compareLabelSets,
  defaults,
  type Expectations,
  expectedOutcome,
  loadExpectations,
  parseCliJson,
  resetCommands,
  runSweep,
  selectRows,
  summarize,
  validateExpectations,
  verdictFor
} from "../scripts/package-api-sweep.mjs"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

const expectationsPath = NodePath.resolve(import.meta.dirname, "fixtures/sweep-expectations.json")
const forceSpec = NodePath.resolve(import.meta.dirname, "fixtures/force-spec")

const observed = (
  exitCode: number,
  stdout: string,
  stderr = "",
  extra: { timedOut?: boolean; sawReadiness?: boolean } = {}
) => {
  const observation = { exitCode, stdout, stderr, ...extra }
  return { ...observation, classified: classifyOutcome(observation) }
}

describe("sweep expectations file", () => {
  it("is structurally valid", async () => {
    const expectations = await loadExpectations(expectationsPath)
    expect(validateExpectations(expectations)).toEqual([])
  })

  it("covers exactly the 81 force labels the frozen fixture graph exports", async () => {
    const expectations = await loadExpectations(expectationsPath)
    const discovery = await PackageDiscovery.discover(forceSpec)
    const loaded = await PackageLoader.load(discovery)
    const index = PackageIndex.make(loaded)
    const fixtureLabels = index.targets().map((row) => row.label)
    expect(fixtureLabels).toHaveLength(81)
    const comparison = compareLabelSets(Object.keys(expectations.labels), fixtureLabels)
    expect(comparison.missing).toEqual([])
    expect(comparison.extra).toEqual([])
    expect(comparison.equal).toBe(true)
  })

  it("carries the honest class distribution", async () => {
    const expectations = await loadExpectations(expectationsPath)
    const count = (kind: string): number =>
      Object.values(expectations.labels).filter((row) => row.class === kind).length
    expect(count("executes-green")).toBe(37)
    expect(count("typed-refusal")).toBe(18)
    expect(count("heavy")).toBe(21)
    expect(count("service")).toBe(5)
  })

  it("pins every checklist correct-refusal target to a typed refusal expectation", async () => {
    const expectations = await loadExpectations(expectationsPath)
    const refusalOf = (label: string) => {
      const row = expectations.labels[label]
      expect(row, label).toBeDefined()
      const refusal = row!.refusal
      expect(refusal, label).toBeDefined()
      return refusal!
    }
    // W4 correct-refusal set from PACKAGE-API-CHECKLIST.md.
    expect(refusalOf("//:syncEnv")).toEqual({ code: "missing-secret", substring: "AWS_ACCESS_KEY_ID" })
    expect(refusalOf("//src:publishAssets").code).toBe("missing-secret")
    expect(refusalOf("//.github:danger")).toEqual({
      code: "missing-secret",
      substring: "DANGER_GITHUB_API_TOKEN"
    })
    expect(refusalOf("//:deleteReviewApp").code).toBe("approval-required")
    expect(refusalOf("//:hokusai")).toEqual({ code: "host-bin-absent", substring: "hokusai" })
    expect(refusalOf("//:detectSecrets").substring).toBe("detect-secrets-hook")
    expect(refusalOf("//:localPaletteDev").substring).toBe("yalc")
    expect(refusalOf("//workflows/fix-sentry-issue:fixSentryIssue").code).toBe("needs-input")
    expect(refusalOf("//workflows/adding-a-new-app-route:addAppRoute").code).toBe("needs-input")
  })

  it("rejects malformed rows loudly", () => {
    expect(validateExpectations({ labels: { "not-a-label": { class: "executes-green" } } })).toEqual([
      "not-a-label: not an exact //package:target label"
    ])
    expect(
      validateExpectations({ labels: { "//a:b": { class: "sometimes-green" } } })[0]
    ).toContain("unknown class")
    expect(
      validateExpectations({ labels: { "//a:b": { class: "typed-refusal" } } })[0]
    ).toContain("expects refusal without a refusal object")
    expect(
      validateExpectations({
        labels: { "//a:b": { class: "typed-refusal", refusal: { code: "bogus", substring: "x" } } }
      })[0]
    ).toContain("unknown refusal code")
    expect(
      validateExpectations({
        labels: { "//a:b": { class: "executes-green", refusal: { code: "missing-secret", substring: "X" } } }
      })[0]
    ).toContain("carries a refusal object but does not expect refusal")
  })
})

describe("outcome classifier", () => {
  it("classifies exit 0 as green", () => {
    const { classified } = observed(0, "{\"ok\":true}")
    expect(classified.outcome).toBe("green")
  })

  it("classifies a NotImplemented refusal as its own outcome, never green", () => {
    const { classified } = observed(
      1,
      "",
      "NotImplemented: run does not execute PACKAGE.ts targets yet; query and graph are the build-system surface"
    )
    expect(classified.outcome).toBe("not-implemented")
  })

  it("tags recognizer hits for the typed refusal shapes", () => {
    expect(
      observed(1, "", "host bin `hokusai` is declared but not found on PATH").classified.detectedCodes
    ).toContain("host-bin-absent")
    expect(
      observed(1, "", "missing secret AWS_ACCESS_KEY_ID at spawn").classified.detectedCodes
    ).toContain("missing-secret")
    expect(observed(1, "", "approval required for //:deleteReviewApp").classified.detectedCodes).toContain(
      "approval-required"
    )
    expect(observed(1, "", "payload field `name` is required headless").classified.detectedCodes).toContain(
      "needs-input"
    )
    expect(
      observed(1, "", "smithers cloud memory bank unreachable").classified.detectedCodes
    ).toContain("memory-unavailable")
  })

  it("classifies a timeout and a readiness signal", () => {
    expect(observed(1, "", "", { timedOut: true }).classified.outcome).toBe("timeout")
    expect(observed(0, "dev server listening on :4000", "", { sawReadiness: true }).classified.outcome).toBe(
      "ready"
    )
  })
})

describe("service shutdown observation", () => {
  it("requires a clean SIGTERM shutdown after readiness", async () => {
    const workspace = await Fs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "sweep-service-"))
    try {
      const cli = NodePath.join(workspace, "service.mjs")
      const expectationsPath = NodePath.join(workspace, "expectations.json")
      const receipt = NodePath.join(workspace, "exit.txt")
      await Fs.writeFile(
        expectationsPath,
        JSON.stringify({ version: 1, labels: { "//:serve": { class: "service", expect: "ready" } } })
      )
      for (const exit of [17, 0, null]) {
        await Fs.rm(receipt, { force: true })
        const shutdown = exit === null
          ? "return;"
          : `writeFileSync(${JSON.stringify(receipt)}, ${JSON.stringify(String(exit))}); process.exit(${exit});`
        await Fs.writeFile(cli, `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { ${shutdown} });
console.log("listening on 4000");
setInterval(() => {}, 1000);
`)
        const report = await runSweep({
          workspace, cli, expectationsPath, invoke: "run {label}",
          heavy: false, services: true, only: [], timeoutSeconds: 5, reset: false
        })
        const result = report.results[0]!
        if (exit !== null) expect(await Fs.readFile(receipt, "utf8")).toBe(String(exit))
        expect(result.observed.exitCode).toBe(exit)
        expect(result.observed.signal).toBe(exit === null ? "SIGKILL" : null)
        expect(result.observed.outcome).toBe(exit === 0 ? "ready" : "failed")
        expect(result.verdict).toBe(exit === 0 ? "pass" : "mismatch")
        expect(report.ok).toBe(exit === 0)
      }
    } finally {
      await Fs.rm(workspace, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("verdicts against stubbed CLI outputs", () => {
  it("passes an executes-green row on exit 0 and fails it on nonzero", () => {
    const row = { class: "executes-green" } as const
    expect(verdictFor(row, observed(0, "done")).verdict).toBe("pass")
    const failed = verdictFor(row, observed(1, "", "3 lint errors"))
    expect(failed.verdict).toBe("mismatch")
    expect(failed.reason).toContain("expected green")
  })

  it("passes a typed-refusal row only when the discriminating substring appears", () => {
    const row = {
      class: "typed-refusal",
      refusal: { code: "host-bin-absent", substring: "detect-secrets-hook" }
    } as const
    expect(
      verdictFor(row, observed(1, "", "host bin detect-secrets-hook not found on PATH")).verdict
    ).toBe("pass")
    expect(verdictFor(row, observed(1, "", "some unrelated crash")).verdict).toBe("mismatch")
    expect(verdictFor(row, observed(0, "ok")).verdict).toBe("mismatch")
  })

  it("treats NotImplemented as a mismatch even where a refusal is expected", () => {
    const row = {
      class: "typed-refusal",
      refusal: { code: "approval-required", substring: "approval" }
    } as const
    const judged = verdictFor(
      row,
      observed(1, "", "NotImplemented: run does not execute PACKAGE.ts targets yet (approval)")
    )
    expect(judged.verdict).toBe("mismatch")
    expect(judged.reason).toContain("NotImplemented")
  })

  it("accepts a declared alternate and reports which one fired", () => {
    const row = {
      class: "typed-refusal",
      refusal: { code: "memory-unavailable", substring: "memory" },
      alternates: [{ expect: "green", notes: "graceful no-op without smithers cloud" }]
    } as const
    const judged = verdictFor(row, observed(0, "retain skipped: no memory backend"))
    expect(judged.verdict).toBe("alternate")
    expect(judged.alternateIndex).toBe(0)
  })

  it("accepts a red alternate for generator drift", () => {
    const row = {
      class: "executes-green",
      alternates: [{ expect: "red", notes: "drift red" }]
    } as const
    expect(verdictFor(row, observed(1, "", "gen.ci.yml is out of date")).verdict).toBe("alternate")
  })

  it("judges a service row by readiness, not by exit code alone", () => {
    const row = { class: "service" } as const
    expect(expectedOutcome(row)).toBe("ready")
    expect(verdictFor(row, observed(0, "listening on 4000", "", { sawReadiness: true })).verdict).toBe(
      "pass"
    )
    expect(verdictFor(row, observed(1, "", "", { timedOut: true })).verdict).toBe("mismatch")
  })

  it("judges a heavy refusal row (secret check after heavy deps) by its refusal substring", () => {
    const row = {
      class: "heavy",
      expect: "refusal",
      refusal: { code: "missing-secret", substring: "AWS_ACCESS_KEY_ID" }
    } as const
    expect(
      verdictFor(row, observed(1, "built dist in 184s", "missing secret AWS_ACCESS_KEY_ID")).verdict
    ).toBe("pass")
    expect(verdictFor(row, observed(0, "uploaded to s3")).verdict).toBe("mismatch")
  })
})

describe("row selection and reset plumbing", () => {
  const expectationsOf = (labels: Expectations["labels"]): Expectations => ({ version: 1, labels })

  it("defaults to the cheap classes and orders refusals first", () => {
    const rows = selectRows(
      expectationsOf({
        "//a:green": { class: "executes-green" },
        "//a:heavy": { class: "heavy" },
        "//a:serve": { class: "service" },
        "//a:refuse": { class: "typed-refusal", refusal: { code: "missing-secret", substring: "X" } }
      })
    )
    expect(rows.map((row) => row.label)).toEqual(["//a:refuse", "//a:green"])
  })

  it("adds heavy and service classes only behind their flags, and honors --only", () => {
    const expectations = expectationsOf({
      "//a:green": { class: "executes-green" },
      "//a:heavy": { class: "heavy" },
      "//a:serve": { class: "service" }
    })
    expect(selectRows(expectations, { heavy: true }).map((row) => row.label)).toEqual([
      "//a:green",
      "//a:heavy"
    ])
    expect(selectRows(expectations, { services: true }).map((row) => row.label)).toEqual([
      "//a:green",
      "//a:serve"
    ])
    expect(selectRows(expectations, { only: ["//a:serve"] }).map((row) => row.label)).toEqual(["//a:serve"])
  })

  it("resets with checkout+clean while preserving node_modules, .flows, .env.shared, .yalc", () => {
    const commands = resetCommands("/tmp/ws")
    expect(commands[0]).toEqual(["git", ["-C", "/tmp/ws", "checkout", "--", "."]])
    const clean = commands[1]![1]
    expect(clean).toContain("clean")
    for (const preserved of ["node_modules", ".flows", ".env.shared", ".yalc"]) {
      expect(clean).toContain(preserved)
    }
  })
})

describe("graph output parsing", () => {
  it("parses the --format json body and diffs label sets", () => {
    const parsed = parseCliJson(
      `${JSON.stringify({ pattern: "//...", roots: ["//a:x", "//a:y"], edges: [], warnings: [] }, null, 2)}\n`
    )
    expect(parsed.roots).toEqual(["//a:x", "//a:y"])
    const comparison = compareLabelSets(["//a:x", "//a:z"], parsed.roots)
    expect(comparison.missing).toEqual(["//a:z"])
    expect(comparison.extra).toEqual(["//a:y"])
    expect(comparison.equal).toBe(false)
  })

  it("refuses non-JSON output loudly", () => {
    expect(() => parseCliJson("plain text, no json here")).toThrow(/no JSON object/)
  })

  it("summarizes mismatches for humans", () => {
    const text = summarize({
      kind: "sweep",
      workspace: "/tmp/ws",
      counts: { pass: 1, alternate: 1, mismatch: 1 },
      ok: false,
      results: [
        { label: "//a:x", class: "executes-green", verdict: "pass" },
        { label: "//a:y", class: "typed-refusal", verdict: "alternate", reason: "graceful no-op" },
        {
          label: "//a:z",
          class: "executes-green",
          verdict: "mismatch",
          reason: "expected green, observed failed (exit 1)"
        }
      ],
      skipped: [{ label: "//a:h", class: "heavy" }]
    })
    expect(text).toContain("FAIL")
    expect(text).toContain("MISMATCH //a:z")
    expect(text).toContain("alternate //a:y")
    expect(text).toContain("skipped 1 heavy")
  })

  it("keeps the documented defaults pointing at the frozen artifacts", () => {
    expect(defaults.expectations.endsWith("packages/smithers/build/build-cli/test/fixtures/sweep-expectations.json"))
      .toBe(
        true
      )
    expect(defaults.cli.endsWith("packages/smithers/build/build-cli/src/main.js")).toBe(true)
    expect(defaults.invoke).toBe("run {label}")
  })
})
