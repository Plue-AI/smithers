import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { checkRealE2E, declaredFlowNames, executableImportClosure, formatGateReport } from "./gate"
import { RELEASE_CRITICAL_ACTIONS, UNSCENARIOED_ACTIONS } from "./deferrals"

const roots: string[] = []
const fixture = (): { root: string; real: string; flows: string } => {
  const root = mkdtempSync(join(tmpdir(), "real-e2e-gate-"))
  roots.push(root)
  const real = join(root, "real")
  mkdirSync(real, { recursive: true })
  const flows = join(root, "FlowName.ts")
  writeFileSync(flows, `export const FLOW_NAMES = ["repo.open", "chat.send"] as const\n`)
  return { root, real, flows }
}

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

/** The fixture's reviewed deferral: chat.send has no scenario in most fixtures. */
const deferred = { owed: ["chat.send"] } as const

const valid = `
import { test } from "./support"
import { scenario } from "./coverage/types"
test("opens", scenario("repo.open.success", { capabilities: ["filesystem:read"],
  coverage: ["action:repo.open", "host:local", "path:success", "door:button", "dimension:desktop", "evidence:filesystem-readback"]
}), async ({ page }) => { await page.getByRole("button").click(); expect(await readDisk()).toBe("bytes") })
`

describe("real E2E coverage gate", () => {
  test("reads the canonical static action declaration rather than test names", () => {
    const { flows } = fixture()
    expect(declaredFlowNames(flows)).toEqual(["chat.send", "repo.open"])
  })

  test("inventories literal search factory actions returned by the actual registry", () => {
    const { root, real, flows } = fixture()
    const entries = join(root, "entries")
    mkdirSync(entries)
    writeFileSync(join(entries, "search.ts"), `
const unrelated = search(actions, "search.unregistered", "not returned")
export const searchFlows = (actions) => [
  flow({ name: "search" }),
  search(actions, "search.files", "path"),
  search(actions, "search.wiki", "wiki")
]
`)
    expect(declaredFlowNames(flows)).toEqual(["chat.send", "repo.open", "search.files", "search.wiki"])
    writeFileSync(join(real, "search.spec.ts"), valid.replace("repo.open.success", "search.files.success").replace("action:repo.open", "action:search.files"))
    const report = checkRealE2E({ realDir: real, flowNameFile: flows, deferred: { owed: ["chat.send", "repo.open"], browser: ["search.wiki"] } })
    expect(report.ok).toBe(true)
    expect(report.deferred).toContainEqual({ action: "search.wiki", reason: "browser" })
    expect(report.declaredActions).not.toContain("search.unregistered")
  })

  test("inventories a feature-filtered literal registry without claiming every action is enabled", () => {
    const { root, flows } = fixture()
    const entries = join(root, "entries")
    mkdirSync(entries)
    writeFileSync(join(entries, "search.ts"), `export const searchFlows = actions => [
      search(actions, "search.files", "path"), search(actions, "search.wiki", "wiki")
    ].filter(entry => enabled(entry))`)
    expect(declaredFlowNames(flows)).toEqual(["chat.send", "repo.open", "search.files", "search.wiki"])
  })

  test("fails closed when a search factory no longer exposes literal action names", () => {
    const { root, flows } = fixture()
    const entries = join(root, "entries")
    mkdirSync(entries)
    const file = join(entries, "search.ts")
    writeFileSync(file, `export const searchFlows = (actions) => [search(actions, dynamicName, "path")]`)
    expect(() => declaredFlowNames(flows)).toThrow("requires an explicit built-in name")
    writeFileSync(file, `export const searchFlows = (actions) => registerSomeOtherWay(actions)`)
    expect(() => declaredFlowNames(flows)).toThrow("Cannot inventory generated search actions")
  })

  test("accepts structured metadata but keeps unexecuted and uncovered cells visible", () => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid)
    const report = checkRealE2E({ realDir: real, flowNameFile: flows, deferred, now: "2026-09-14T00:00:00.000Z" })
    expect(report.ok).toBe(true)
    expect(report.deferred).toEqual([{ action: "chat.send", reason: "owed" }])
    expect(report.gaps.filter((gap) => gap.kind === "action")).toEqual([])
    expect(report.gaps).toContainEqual({ kind: "execution", value: "local", scenarioId: "repo.open.success" })
  })

  test("permits explicit browser-only dependencies while rejecting an omitted dependency declaration", () => {
    const { real, flows } = fixture()
    const file = join(real, "browser.spec.ts")
    writeFileSync(file, valid.replace('capabilities: ["filesystem:read"]', 'capabilities: []'))
    expect(checkRealE2E({ realDir: real, flowNameFile: flows, deferred }).ok).toBe(true)
    writeFileSync(file, valid.replace('capabilities: ["filesystem:read"],', ''))
    expect(checkRealE2E({ realDir: real, flowNameFile: flows }).findings.map((finding) => finding.code)).toContain("invalid-scenario")
  })

  test("joins an actual passed verdict without converting other gaps to coverage", () => {
    const { root, real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid)
    const results = join(root, "results.json")
    writeFileSync(results, JSON.stringify({ suiteStatus: "passed", reporterErrors: [], runs: [{ scenarioId: "repo.open.success", host: "local", status: "passed", revision: "a".repeat(40), startedAt: "2026-09-14T00:00:00Z", finishedAt: "2026-09-14T00:00:01Z" }] }))
    const report = checkRealE2E({ realDir: real, flowNameFile: flows, resultsFile: results })
    expect(report.gaps.some((gap) => gap.kind === "execution")).toBe(false)
    expect(report.gaps).toContainEqual({ kind: "action", value: "chat.send" })
    expect(report.ok).toBe(false)
  })

  test.each([
    ["malformed start", { startedAt: "not-a-date" }],
    ["malformed finish", { finishedAt: "still-not-a-date" }],
    ["non-string start", { startedAt: 123 }],
    ["non-string finish", { finishedAt: {} }],
    ["impossible date", { startedAt: "2026-02-30T12:00:00Z" }],
    ["inverted window", { startedAt: "2026-09-27T12:00:00Z", finishedAt: "2026-09-26T12:00:00Z" }]
  ])("rejects %s in executed receipt timestamps", (_name, timestamps) => {
    const { root, real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid)
    const results = join(root, "results.json")
    const run = { scenarioId: "repo.open.success", host: "local", status: "passed", revision: "a".repeat(40),
      startedAt: "2026-09-27T12:00:00Z", finishedAt: "2026-09-27T12:00:01Z", ...timestamps }
    writeFileSync(results, JSON.stringify({ suiteStatus: "passed", reporterErrors: [], runs: [run] }))
    const report = checkRealE2E({ realDir: real, flowNameFile: flows, resultsFile: results,
      deferred, requireComplete: true, expectedRevision: run.revision, expectedHost: "local" })
    expect(report.ok).toBe(false)
    expect(report.findings.map((finding) => finding.code)).toContain("malformed-run")
  })

  test.each(["failed", "timedOut", "interrupted", "skipped"])("a passed retry cannot erase an earlier %s attempt", (status) => {
    const { root, real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid)
    const results = join(root, "results.json")
    const attempt = { scenarioId: "repo.open.success", host: "local", revision: "a".repeat(40), startedAt: "2026-09-14T00:00:00Z", finishedAt: "2026-09-14T00:00:01Z" }
    writeFileSync(results, JSON.stringify({ suiteStatus: "passed", reporterErrors: [], runs: [
      { ...attempt, status },
      { ...attempt, status: "passed", startedAt: "2026-09-14T00:00:02Z", finishedAt: "2026-09-14T00:00:03Z" }
    ] }))
    const report = checkRealE2E({ realDir: real, flowNameFile: flows, resultsFile: results, expectedRevision: attempt.revision, expectedHost: "local" })
    expect(report.ok).toBe(false)
    expect(report.findings.map((finding) => finding.code)).toContain("unsuccessful-attempt")
    expect(report.gaps).toContainEqual({ kind: "execution", value: "local", scenarioId: "repo.open.success" })
    expect(formatGateReport(report, root)).toContain("1 passed attempts; 1 unsuccessful attempts")
  })

  test("fails malformed or incomplete reporter evidence instead of treating it as no runs", () => {
    const { root, real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid)
    const results = join(root, "results.json")
    writeFileSync(results, JSON.stringify({ suiteStatus: "failed", reporterErrors: ["host unverified"], runs: [] }))
    const codes = checkRealE2E({ realDir: real, flowNameFile: flows, resultsFile: results }).findings.map((item) => item.code)
    expect(codes).toContain("suite-did-not-pass")
    expect(codes).toContain("reporter-evidence-error")
  })

  test("strict completeness pins evidence and fails remaining gaps", () => {
    const { root, real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid)
    const results = join(root, "results.json")
    writeFileSync(results, JSON.stringify({ suiteStatus: "passed", reporterErrors: [], runs: [{ scenarioId: "repo.open.success", host: "local", status: "passed", revision: "b".repeat(40), startedAt: "2026-09-14T00:00:00Z", finishedAt: "2026-09-14T00:00:01Z" }] }))
    const report = checkRealE2E({ realDir: real, flowNameFile: flows, resultsFile: results, requireComplete: true, expectedRevision: "a".repeat(40), expectedHost: "production" })
    const codes = report.findings.map((finding) => finding.code)
    expect(codes).toContain("unexpected-revision")
    expect(codes).toContain("unexpected-host")
    expect(codes).toContain("incomplete-coverage")
  })

  test("scopes host receipts without erasing aggregate execution gaps", () => {
    const { root, real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid.replace('"host:local"', '"host:local", "host:production"'))
    const results = join(root, "results.json")
    writeFileSync(results, JSON.stringify({ suiteStatus: "passed", reporterErrors: [], runs: [{ scenarioId: "repo.open.success", host: "production", status: "passed", revision: "a".repeat(40), buildSha: "b".repeat(40), startedAt: "2026-09-14T00:00:00Z", finishedAt: "2026-09-14T00:00:01Z" }] }))
    const options = { realDir: real, flowNameFile: flows, resultsFile: results, expectedRevision: "a".repeat(40), deferred }
    const hostReport = checkRealE2E({ ...options, expectedHost: "production" })
    expect(hostReport.ok).toBe(true)
    expect(hostReport.gaps.filter((gap) => gap.kind === "execution" || gap.kind === "host")).toEqual([])
    expect(hostReport.deferred).toEqual([{ action: "chat.send", reason: "owed" }])
    const aggregate = checkRealE2E(options)
    expect(aggregate.gaps).toContainEqual({ kind: "execution", value: "local", scenarioId: "repo.open.success" })
    // Both remaining real hosts are declared (the native host retired with the desktop app, #3387): declaring is not executing.
    expect(aggregate.gaps.filter((gap) => gap.kind === "host")).toEqual([])
  })

  test("does not let a host-specific receipt hide an unexecuted applicable case", () => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid.replace('"host:local"', '"host:local", "host:production"'))
    const report = checkRealE2E({ realDir: real, flowNameFile: flows, expectedHost: "production", requireComplete: true })
    expect(report.gaps.filter((gap) => gap.kind === "execution")).toEqual([{ kind: "execution", value: "production", scenarioId: "repo.open.success" }])
    expect(report.ok).toBe(false)
  })

  test("rejects receipts for an unknown scenario or undeclared host", () => {
    const { root, real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid)
    const results = join(root, "results.json")
    const run = { scenarioId: "repo.open.success", host: "production", status: "passed", revision: "a".repeat(40), buildSha: "b".repeat(40), startedAt: "2026-09-14T00:00:00Z", finishedAt: "2026-09-14T00:00:01Z" }
    writeFileSync(results, JSON.stringify({ suiteStatus: "passed", reporterErrors: [], runs: [run, { ...run, scenarioId: "invented.success", host: "local" }] }))
    const report = checkRealE2E({ realDir: real, flowNameFile: flows, resultsFile: results })
    expect(report.findings.map((finding) => finding.code)).toContain("undeclared-run-host")
    expect(report.findings.map((finding) => finding.code)).toContain("undeclared-run")
    expect(report.gaps).toContainEqual({ kind: "execution", value: "local", scenarioId: "repo.open.success" })
  })

  test("rejects interception and skip constructs in imported executable helpers", () => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid.replace('import { test } from "./support"', 'import { test } from "./support"\nimport "./bad-helper"'))
    writeFileSync(join(real, "bad-helper.ts"), `page.route("**/api/**", route => route.fulfill({ json: {} })); test.skip(true)\n`)
    const report = checkRealE2E({ realDir: real, flowNameFile: flows })
    expect(report.ok).toBe(false)
    expect(report.findings.filter((item) => item.code === "forbidden-double")).toHaveLength(2)
    expect(executableImportClosure([join(real, "repo.spec.ts")], real)).toContain(join(real, "bad-helper.ts"))
  })

  test("follows re-exports and dynamic imports and catches renamed receivers", () => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid.replace('import { test } from "./support"', 'import { test } from "./support"\nexport { helper } from "./barrel"'))
    writeFileSync(join(real, "barrel.ts"), `export const helper = () => import("./renamed")\n`)
    writeFileSync(join(real, "renamed.ts"), `renamedBrowserContext.route("**/*", handler)\n`)
    expect(checkRealE2E({ realDir: real, flowNameFile: flows }).findings.map((finding) => finding.code)).toContain("forbidden-double")
  })

  test("does not scan type-only imports as executable suite code", () => {
    const { real, flows } = fixture()
    mkdirSync(join(real, "coverage"))
    writeFileSync(join(real, "repo.spec.ts"), valid.replace('import { test } from "./support"', 'import { test } from "./support"\nimport type { Fake } from "./coverage/type-only"'))
    writeFileSync(join(real, "coverage/type-only.ts"), `page.route("**/*", handler)\nexport type Fake = string\n`)
    expect(checkRealE2E({ realDir: real, flowNameFile: flows, deferred }).ok).toBe(true)
  })

  test("scans a subprocess entry even when its launcher does not import it", () => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid)
    writeFileSync(join(real, "process-host.ts"), `page.route("**/api/**", handler)`)
    expect(checkRealE2E({ realDir: real, flowNameFile: flows }).findings.map((finding) => finding.code)).toContain("forbidden-double")
  })

  test.each([
    'cloudMode: "hybrid", chatStub: true',
    'cloudMode: "hybrid", identityUpstream: null',
    'cloudMode: "hybrid", cloudApi: null',
    'cloudMode: "offline", chatStub: false',
    'chatStub: false',
  ])("rejects built-in host doubles: %s", (options) => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid)
    writeFileSync(join(real, "process-host.ts"), `import { startLocalServer as launch } from "./server"; launch({ ${options} })`)
    expect(checkRealE2E({ realDir: real, flowNameFile: flows }).findings.map((finding) => finding.code)).toContain("forbidden-double")
  })

  test("requires reviewable real host configuration and accepts real defaults in hybrid mode", () => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid)
    const host = join(real, "process-host.ts")
    writeFileSync(host, `startLocalServer({ ...options, cloudMode: "hybrid" })`)
    expect(checkRealE2E({ realDir: real, flowNameFile: flows }).findings.map((finding) => finding.code)).toContain("unverified-real-host")
    writeFileSync(host, `startLocalServer({ chatStub: false, cloudMode: "hybrid" })`)
    expect(checkRealE2E({ realDir: real, flowNameFile: flows, deferred }).ok).toBe(true)
  })

  test("rejects unknown actions, invalid dimensions, and success without completion evidence", () => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "bad.spec.ts"), valid.replace("action:repo.open", "action:repo.typo").replace(', "evidence:filesystem-readback"', "").replace('"dimension:desktop"', '"dimension:keyboard"').replace('"path:success"', '"path:success", "path:keyboard"'))
    const codes = checkRealE2E({ realDir: real, flowNameFile: flows }).findings.map((item) => item.code)
    expect(codes).toContain("unknown-action")
    expect(codes).toContain("missing-completion-evidence")
  })

  test("allows only the explicit runtime repository-flow family marker", () => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "dynamic.spec.ts"), valid.replace("action:repo.open", "action:repository-flow:*"))
    expect(checkRealE2E({ realDir: real, flowNameFile: flows, deferred: { owed: ["chat.send", "repo.open"] } }).ok).toBe(true)
  })

  test("supports suite defaults but rejects duplicate ids across per-test and default declarations", () => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid + `\ntest.use({ realScenario: { id: "repo.open.success", capabilities: ["filesystem:read"], coverage: ["action:repo.open", "host:local", "path:error", "door:slash", "dimension:error"] } })\n`)
    const report = checkRealE2E({ realDir: real, flowNameFile: flows })
    expect(report.findings.map((finding) => finding.code)).toContain("duplicate-scenario")
  })

  test("rejects a test whose suite defaults hide missing per-test identity", () => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "default.spec.ts"), `import { test } from "./support"\ntest.use({ realScenario: { id: "suite.default", capabilities: ["filesystem:read"], coverage: ["action:repo.open", "host:local", "path:error", "door:button", "dimension:error"] } })\ntest("anonymous case", async () => {})\n`)
    const report = checkRealE2E({ realDir: real, flowNameFile: flows })
    expect(report.findings.map((finding) => finding.code)).toContain("missing-per-test-scenario")
  })

  test("rejects refusal text and nonempty text as success evidence", () => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "weak.spec.ts"), valid.replace('expect(await readDisk()).toBe("bytes")', 'await expect(page.locator("output")).toContainText(/\\s+/); await expect(page.locator("output")).toContainText("permission denied")'))
    const codes = checkRealE2E({ realDir: real, flowNameFile: flows }).findings.map((item) => item.code)
    expect(codes).toContain("nonempty-is-not-success")
    expect(codes).toContain("refusal-is-not-success")
  })

  test.each([
    ["no boundary proof", "", "review"],
    ["an empty side-effect list", "expect(writes).toEqual([])", undefined],
    ["an empty filtered list", "expect(writes.filter((w) => w.method !== \"GET\")).toHaveLength(0)", undefined],
    ["a 4xx service status", "expect((await api(\"GET\", \"/api/user\")).status()).toBe(401)", undefined],
    ["a 2xx service status", "expect((await api(\"GET\", \"/api/user\")).status()).toBe(200)", "review"],
    ["a nonempty side-effect list", "expect(writes).toEqual([\"POST /x\"])", "review"],
    ["a locator count", "await expect(page.locator(\"card\")).toHaveCount(0)", "review"]
  ] as const)("reviews an error-path refusal followed by %s accordingly", (_label, after, severity) => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "refusal.spec.ts"), valid.replace("repo.open.success", "repo.open.denied").replace("path:success", "path:permission")
      .replace('expect(await readDisk()).toBe("bytes")', `const writes = []; await expect(page.locator("output")).toContainText(/sign in to open/i); ${after}`))
    const findings = checkRealE2E({ realDir: real, flowNameFile: flows, deferred }).findings.filter((item) => item.code === "refusal-is-not-success")
    expect(findings.map((item) => item.severity)).toEqual(severity ? [severity] : [])
  })

  test("requires the boundary proof after the refusal, inside the same test", () => {
    const { real, flows } = fixture()
    const denied = valid.replace("repo.open.success", "repo.open.denied").replace("path:success", "path:error")
    writeFileSync(join(real, "before.spec.ts"), denied.replace('expect(await readDisk()).toBe("bytes")', 'expect(writes).toEqual([]); await expect(page.locator("output")).toContainText("permission denied")'))
    writeFileSync(join(real, "other.spec.ts"), denied.replace("repo.open.denied", "repo.open.other").replace('expect(await readDisk()).toBe("bytes")', 'await expect(page.locator("output")).toContainText("permission denied")')
      + 'test("second", scenario("repo.open.second", { capabilities: [], coverage: ["action:repo.open", "host:local", "path:error", "door:button", "dimension:x"] }), async () => { expect(writes).toEqual([]) })\n')
    const findings = checkRealE2E({ realDir: real, flowNameFile: flows, deferred }).findings.filter((item) => item.code === "refusal-is-not-success")
    writeFileSync(join(real, "helper.spec.ts"), denied.replace("repo.open.denied", "repo.open.helper").replace('expect(await readDisk()).toBe("bytes")', 'await expect(page.locator("output")).toContainText("permission denied"); const never = () => expect(writes).toEqual([]); if (false) { expect(writes).toEqual([]) }'))
    writeFileSync(join(real, "persistence.spec.ts"), valid.replace("repo.open.success", "repo.open.persisted").replace("path:success", "path:persistence").replace('expect(await readDisk()).toBe("bytes")', 'await expect(page.locator("output")).toContainText("permission denied"); expect(writes).toEqual([])'))
    expect(findings.length).toBe(2)
    const all = checkRealE2E({ realDir: real, flowNameFile: flows, deferred }).findings.filter((item) => item.code === "refusal-is-not-success")
    expect(all.map((item) => [item.file.split("/").pop(), item.severity]).sort()).toEqual([
      ["before.spec.ts", "review"], ["helper.spec.ts", "review"], ["other.spec.ts", "review"], ["persistence.spec.ts", "review"]
    ])
  })

  test("reads refusal copy from literal text, not from identifiers that hold a message", () => {
    const { real, flows } = fixture()
    const denied = valid.replace("repo.open.success", "repo.open.denied").replace("path:success", "path:error")
    writeFileSync(join(real, "identifier.spec.ts"), denied.replace('expect(await readDisk()).toBe("bytes")', 'await expect(page.locator("output")).toContainText(String(refused.error.message))'))
    writeFileSync(join(real, "template.spec.ts"), denied.replace("repo.open.denied", "repo.open.template").replace('expect(await readDisk()).toBe("bytes")', 'await expect(page.locator("output")).toContainText(`${repo} cannot be opened`)'))
    const findings = checkRealE2E({ realDir: real, flowNameFile: flows, deferred }).findings.filter((item) => item.code === "refusal-is-not-success")
    expect(findings.map((item) => item.file.split("/").pop())).toEqual(["template.spec.ts"])
  })

  test("requires per-test metadata for imported authenticated test aliases", () => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "auth.spec.ts"), valid + '\nimport { authenticatedTest as signedIn } from "./profile"\nsignedIn("missing identity", async () => {})\n')
    expect(checkRealE2E({ realDir: real, flowNameFile: flows }).findings.map((item) => item.code)).toContain("missing-per-test-scenario")
  })

  test.each(["skip", "fixme", "fail", "only", "describe.skip", "describe.only", "describe.parallel.only", "describe.serial.skip"])("rejects %s on derived real test variants", (method) => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "auth.spec.ts"), valid + `\nimport { authenticatedTest as signedIn } from "./profile"\nconst ordinary = signedIn.extend({})\nordinary.${method}(true)\n`)
    expect(checkRealE2E({ realDir: real, flowNameFile: flows }).findings.map((item) => item.code)).toContain("forbidden-double")
  })

  test("keeps successful-path refusal checks active through imported and derived fixtures", () => {
    const { real, flows } = fixture()
    const source = valid.replace('import { test } from "./support"', 'import { authenticatedTest as signedIn } from "./profile"\nconst ordinary = signedIn.extend({})')
      .replace('test("opens"', 'ordinary("opens"')
      .replace('expect(await readDisk()).toBe("bytes")', 'await expect(page.locator("output")).toContainText("permission denied")')
    writeFileSync(join(real, "auth.spec.ts"), source)
    expect(checkRealE2E({ realDir: real, flowNameFile: flows }).findings).toContainEqual(expect.objectContaining({ code: "refusal-is-not-success", severity: "error" }))
  })

  test("accepts direct metadata on a derived fixture but rejects hidden metadata wrappers", () => {
    const { real, flows } = fixture()
    const file = join(real, "auth.spec.ts")
    const source = valid.replace('import { test } from "./support"', 'import { authenticatedTest as signedIn } from "./profile"\nconst ordinary = signedIn.extend({})')
      .replace('test("opens"', 'ordinary("opens"')
    writeFileSync(file, source)
    expect(checkRealE2E({ realDir: real, flowNameFile: flows, deferred }).ok).toBe(true)
    writeFileSync(file, source.replace('scenario("repo.open.success",', 'wrap(scenario("repo.open.success",').replace('}), async', '})), async'))
    expect(checkRealE2E({ realDir: real, flowNameFile: flows }).findings.map((item) => item.code)).toContain("missing-per-test-scenario")
  })

  test("fails a built-in action with neither a real scenario nor a reviewed deferral", () => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid)
    const report = checkRealE2E({ realDir: real, flowNameFile: flows })
    expect(report.ok).toBe(false)
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "unscenarioed-action", severity: "error", message: expect.stringContaining("chat.send") }))
    expect(report.gaps).toContainEqual({ kind: "action", value: "chat.send" })
  })

  test("rejects deferrals for covered, removed, duplicated, or release-critical actions", () => {
    const { real, flows } = fixture()
    writeFileSync(join(real, "repo.spec.ts"), valid)
    const report = checkRealE2E({
      realDir: real, flowNameFile: flows, releaseCritical: ["chat.send"],
      deferred: { owed: ["chat.send", "repo.open", "retired.action"], browser: ["chat.send"] }
    })
    expect(report.ok).toBe(false)
    const messages = (code: string) => report.findings.filter((finding) => finding.code === code).map((finding) => finding.message)
    expect(messages("stale-deferral")).toEqual([expect.stringContaining("repo.open"), expect.stringContaining("retired.action")])
    expect(messages("duplicate-deferral")).toEqual([expect.stringContaining("chat.send")])
    expect(messages("critical-action-deferred")).toEqual([expect.stringContaining("chat.send")])
  })

  test("the repository's deferrals are current and leave only release-critical actions unscenarioed", () => {
    const app = join(import.meta.dir, "../../..")
    const report = checkRealE2E({
      realDir: join(app, "e2e/real"), flowNameFile: join(app, "src/mainview/flows/FlowName.ts"),
      deferred: UNSCENARIOED_ACTIONS, releaseCritical: RELEASE_CRITICAL_ACTIONS
    })
    const codes = new Set(report.findings.filter((finding) => finding.severity === "error").map((finding) => finding.code))
    expect([...codes].filter((code) => code !== "unscenarioed-action")).toEqual([])
    const unscenarioed = report.gaps.filter((gap) => gap.kind === "action").map((gap) => gap.value)
    expect(unscenarioed.filter((action) => !RELEASE_CRITICAL_ACTIONS.includes(action))).toEqual([])
  }, 60_000)
})

test("exclusive journey specs belong only to their explicitly selected gate", () => {
  const { real, flows } = fixture()
  const ordinary = join(real, "ordinary.spec.ts")
  const exclusive = join(real, "j1-activation.spec.ts")
  writeFileSync(ordinary, valid)
  writeFileSync(exclusive, valid.replaceAll("repo.open.success", "journey.j1-activation"))
  const defaultGate = checkRealE2E({ realDir: real, flowNameFile: flows, deferred, excludedSpecs: [exclusive] })
  expect(defaultGate.ok).toBe(true)
  expect(defaultGate.scenarios.map(value => value.id)).toEqual(["repo.open.success"])
  const journeyGate = checkRealE2E({ realDir: real, flowNameFile: flows, deferred })
  expect(journeyGate.ok).toBe(true)
  expect(journeyGate.scenarios.map(value => value.id).sort()).toEqual(["journey.j1-activation", "repo.open.success"])
})
