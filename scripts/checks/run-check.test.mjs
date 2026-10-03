import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { commandTable } from "./commands.mjs"
import { gateVerdict, main as qualifyMain, qualify } from "./qualify.mjs"
import { allocate, artifactHashes, classifyRun, digest, execute, hostProfile, main as checkMain, parseAutomation, parseCli, parsePopulation, prepareCommand, probePrerequisite, REASONS, resourceGuard, ROOT, runCheck, worst } from "./run-check.mjs"
import { thinObligations, thinSourcePaths } from "./thin.mjs"

const sha = "a".repeat(40)
const check = "C-TST-01"
const spec = "# Literal fixture specification\n"
const nodeTests = {
  pass: 'import { test } from "node:test"; import assert from "node:assert/strict"; test("boundary", () => assert.equal(2 + 3, 5));\n',
  fail: 'import { test } from "node:test"; import assert from "node:assert/strict"; test("oracle", () => assert.equal(2 + 3, 6));\n',
  skipped: 'import { test } from "node:test"; test("unavailable", { skip: "intentional fixture" }, () => {});\n',
  quarantine: 'import { test } from "node:test"; test.todo("quarantined fixture");\n',
  empty: "// Deliberately no test population.\n",
  receipt: 'console.log(JSON.stringify({ expectedCases: 1, executedCases: 1 }));\n'
}

async function writable(directory) {
  await chmod(directory, 0o755)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await writable(join(directory, entry.name))
  }
}
async function fixture(t, kind = "pass", automation) {
  const parent = join(ROOT, ".artifacts/checks")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, "runner-test-"))
  t.after(async () => { await writable(root); await rm(root, { recursive: true }) })
  await mkdir(join(root, ".specs/engineering/checks"), { recursive: true })
  await writeFile(join(root, ".specs/engineering/spec.md"), spec)
  await writeFile(join(root, "fixture.mjs"), nodeTests[kind])
  const text = `# ${check} Literal fixture\nAutomation: ${automation ?? "`node --test fixture.mjs`"}\n`
  await writeFile(join(root, `.specs/engineering/checks/${check}.md`), text)
  return { root, check, sha, evidenceRoot: join(root, "evidence"), env: process.env, guard: async () => null }
}
const goEvent = (Action, Test, Package = "fixture") => JSON.stringify({ Action, Test, Package })
const goodRun = { code: 0, stdout: "", stderr: "" }

test("literal Automation argv preserves quotes and order without shell evaluation", () => {
  const parsed = parseAutomation('Automation: `node --test "a file.test.mjs"` && `node tools/check.mjs` · Runs in: CI')
  assert.deepEqual(parsed.commands.map((c) => c.argv), [["node", "--test", "a file.test.mjs"], ["node", "tools/check.mjs"]])
  for (const line of ["node $SECRET", "node a | tee log", "node a > log", "node a; node b", "node `id`", "node \\\"a\\\""]) {
    assert.equal(parseAutomation(`Automation: \`${line}\``).commands.length, 0)
  }
  assert.equal(parseAutomation("# empty").problem, "Automation line absent")
  assert.deepEqual(parseAutomation("Automation: `a.test.mjs` (new)").files, ["a.test.mjs"])
  assert.equal(parseAutomation('Automation: `node "unterminated`').commands.length, 0)
})

test("CLI rejects ambiguity and accepts explicit subcase bindings", () => {
  assert.deepEqual(parseCli([check, "--sha", sha, "--evidence-root", "out", "--upload", "--subcase", "claim"]), {
    check, sha, evidenceRoot: "out", upload: true, subcases: ["claim"]
  })
  for (const args of [[check, "--sha"], [check, "--wat"], [check, "C-TST-02"], [check, "--sha", "--upload"]]) assert.throws(() => parseCli(args))
})

test("real node runner produces PASS, digests, pinned SHA, counts and artifact hashes", async (t) => {
  const options = await fixture(t)
  const receipt = await runCheck(options)
  assert.equal(receipt.result.status, "PASS")
  assert.equal(receipt.result.reasonCode, "complete")
  assert.equal(receipt.result.candidateSha, sha)
  assert.equal(receipt.result.specDigest, digest(spec))
  assert.equal(receipt.result.checkDigest, digest(await readFile(join(options.root, `.specs/engineering/checks/${check}.md`))))
  assert.equal(receipt.result.expectedCases, 1)
  assert.equal(receipt.result.executedCases, 1)
  assert.equal(receipt.result.firstFailure, null)
  assert.deepEqual(receipt.result.command, [["node", "--test", "--test-reporter=tap", "fixture.mjs"]])
  assert.equal(receipt.result.commands[0].launchArgv[0], "nice")
  assert.ok(receipt.result.hostProfile.memory > 0)
  assert.ok(receipt.result.hostProfile.cores > 0)
  assert.ok(receipt.result.startedAt.endsWith("Z"))
  assert.ok(receipt.result.finishedAt.endsWith("Z"))
  const hashes = JSON.parse(await readFile(join(receipt.directory, "sha256s.json")))
  assert.ok(hashes["result.json"])
  for (const [path, hash] of Object.entries(hashes)) assert.equal(hash, digest(await readFile(join(receipt.directory, path))))
  const detached = await readFile(join(receipt.directory, "sha256s.sha256"), "utf8")
  assert.equal(detached, `${digest(await readFile(join(receipt.directory, "sha256s.json")))}  sha256s.json\n`)
  assert.equal(receipt.upload.status, "BLOCKED")
  assert.equal(receipt.upload.reasonCode, "artifact_missing")
})

test("same UTC and concurrent attempts never overwrite; source digests remain stable", async (t) => {
  const options = await fixture(t)
  const now = () => new Date("2026-10-02T00:00:00.000Z")
  const [first, second] = await Promise.all([runCheck({ ...options, now }), runCheck({ ...options, now })])
  assert.notEqual(first.directory, second.directory)
  assert.deepEqual([first.utc, second.utc].sort(), ["2026-10-02T00:00:00.000Z", "2026-10-02T00:00:00.001Z"])
  assert.equal(first.result.specDigest, second.result.specDigest)
  assert.equal(first.result.checkDigest, second.result.checkDigest)
  const before = await readFile(join(first.directory, "result.json"))
  await writeFile(join(options.root, `.specs/engineering/checks/${check}.md`), `# edited\nAutomation: \`node --test fixture.mjs\`\n`)
  const third = await runCheck({ ...options, now })
  assert.notEqual(third.result.checkDigest, first.result.checkDigest)
  assert.equal(third.result.specDigest, first.result.specDigest)
  assert.deepEqual(await readFile(join(first.directory, "result.json")), before)
})

for (const [kind, status, reasonCode] of [["fail", "FAIL", "oracle_violation"], ["skipped", "SKIPPED", "intentional_skip"], ["quarantine", "SKIPPED", "quarantine"], ["empty", "FAIL", "oracle_violation"]]) {
  test(`real fixture ${kind}: ${status}(${reasonCode})`, async (t) => {
    const options = await fixture(t, kind)
    const { result } = await runCheck(options)
    assert.equal(result.status, status)
    assert.equal(result.reasonCode, reasonCode)
    assert.ok(result.firstFailure)
    if (kind === "empty") {
      assert.equal(result.expectedCases, 0)
      assert.equal(result.executedCases, 0)
      assert.match(result.reason, /Empty test population/)
    }
  })
}

test("missing check, missing automation and unbound prose are NOT IMPLEMENTED; never launched", async (t) => {
  const options = await fixture(t, "pass", "`missing.test.mjs` (new)")
  const missingFile = await runCheck(options)
  assert.equal(missingFile.result.status, "NOT IMPLEMENTED")
  assert.match(missingFile.result.reason, /missing.test.mjs/)
  assert.equal(missingFile.result.commands.length, 0)
  assert.equal(missingFile.result.reasonCode, "runner_absent")
  await writeFile(join(options.root, `.specs/engineering/checks/${check}.md`), `Automation: \`fixture.mjs\` (planned)\n`)
  assert.equal((await runCheck(options)).result.status, "NOT IMPLEMENTED")
  await rm(join(options.root, `.specs/engineering/checks/${check}.md`))
  assert.match((await runCheck(options)).result.reason, /Missing check file/)
})

test("missing literal command file is runner_absent, not a command FAIL", async (t) => {
  const options = await fixture(t, "pass", "`node --test absent.test.mjs`")
  const { result } = await runCheck(options)
  assert.equal(result.status, "NOT IMPLEMENTED")
  assert.match(result.reason, /absent.test.mjs/)
})

test("absent behavior, missing spec, bad candidate and unsupported report have distinct reason codes", async (t) => {
  const options = await fixture(t)
  const behavior = await runCheck({ ...options, bindings: { [check]: { commands: [{ argv: ["node", "fixture.mjs"] }], behaviorAbsent: "T-TST-01 required behavior absent" } } })
  assert.equal(behavior.result.status, "NOT IMPLEMENTED")
  assert.equal(behavior.result.reasonCode, "behavior_absent")
  const badSha = await runCheck({ ...options, sha: "not-a-sha" })
  assert.equal(badSha.result.reasonCode, "source_drift")
  await rm(join(options.root, ".specs/engineering/spec.md"))
  assert.equal((await runCheck(options)).result.reasonCode, "artifact_missing")
  await writeFile(join(options.root, ".specs/engineering/spec.md"), spec)
  await writeFile(join(options.root, "fixture.mjs"), "console.log('no population');\n")
  await writeFile(join(options.root, `.specs/engineering/checks/${check}.md`), "Automation: `node fixture.mjs`\n")
  const unsupported = await runCheck(options)
  assert.equal(unsupported.result.status, "BLOCKED")
  assert.equal(unsupported.result.reasonCode, "incompatible_result")
})

test("candidate is resolved once from the read-only jj parent command", async (t) => {
  const options = await fixture(t)
  let called = 0
  const exec = async (argv, config) => {
    if (argv[0] === "jj") { called++; assert.deepEqual(argv, ["jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id"]); return { ...goodRun, stdout: sha } }
    return execute(argv, config)
  }
  assert.equal((await runCheck({ ...options, sha: undefined, exec })).result.candidateSha, sha)
  assert.equal(called, 1)
})

test("missing prerequisites remain named BLOCKED evidence, never skipped", async (t) => {
  const options = await fixture(t)
  for (const [name, reason] of [["PG18", "environment"], ["msb", "environment"], ["reference-host", "dependency"], ["built-bundle", "dependency"], ["jj-helper", "environment"], ["QA-HOST-ACTIVATION", "oracle_conflict"]]) {
    const { result } = await runCheck({ ...options, requiredEnvironment: [name], env: {} })
    assert.equal(result.status, "BLOCKED", name)
    assert.equal(result.reasonCode, reason, name)
    assert.match(result.reason, new RegExp(name))
    assert.equal(result.commands.length, 0)
  }
  const absent = await runCheck({ ...options, bindings: { [check]: { files: ["missing.mjs"], commands: [] } }, requiredEnvironment: ["PG18"] })
  assert.equal(absent.result.status, "NOT IMPLEMENTED", "absence wins over unavailable environment")
})

test("PG version and msb version probes cannot qualify incompatible dependencies", async () => {
  const env = { SMITHERS_TEST_DATABASE_URL: "postgres://fixture", SMITHERS_MICROSANDBOX_BIN: process.execPath }
  const probe = async (stdout, name) => probePrerequisite(name, { root: ROOT, env, exec: async () => ({ ...goodRun, stdout }) })
  assert.equal(await probe("180004\n", "PG18"), null)
  assert.equal((await probe("170001\n", "PG18")).reasonCode, "environment")
  assert.equal(await probe("microsandbox 0.6.16\n", "msb"), null)
  assert.equal((await probe("microsandbox 0.6.15\n", "msb")).reasonCode, "environment")
})

test("Go JSON records expected, executed, failed, skipped and incomplete named cases", () => {
  const output = [goEvent("run", "TestOne"), goEvent("run", "TestOne/boundary"), goEvent("pass", "TestOne/boundary"), goEvent("pass", "TestOne"), goEvent("pass")].join("\n")
  const population = parsePopulation("go", output)
  assert.equal(population.expectedCases, 2)
  assert.equal(population.executedCases, 2)
  assert.equal(classifyRun(goodRun, population, { expectedCaseIds: ["TestOne"], argv: ["go"] }).status, "PASS")
  assert.equal(classifyRun(goodRun, population, { expectedCaseIds: ["TestAbsent"], argv: ["go"] }).reasonCode, "incompatible_result")
  assert.equal(classifyRun(goodRun, parsePopulation("go", goEvent("pass")), {}).status, "FAIL")
  assert.equal(classifyRun(goodRun, parsePopulation("go", [goEvent("run", "TestOne"), goEvent("skip", "TestOne")].join("\n")), {}).status, "SKIPPED")
  assert.equal(classifyRun(goodRun, parsePopulation("go", [goEvent("run", "TestOne"), goEvent("fail", "TestOne")].join("\n")), {}).status, "FAIL")
  assert.equal(classifyRun(goodRun, parsePopulation("go", goEvent("run", "TestOne")), {}).status, "FAIL")
  assert.equal(parsePopulation("go", "unstructured"), null)
})

test("Vitest JSON and Bun population parsing reject empty or partial green runs", () => {
  const report = { numTotalTestSuites: 1, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, success: true,
    testResults: [{ assertionResults: [{ fullName: "edge a", status: "passed" }, { fullName: "edge b", status: "passed" }] }] }
  const parsed = parsePopulation("vitest", `banner\n${JSON.stringify(report)}`)
  assert.equal(parsed.expectedCases, 2)
  assert.equal(classifyRun(goodRun, parsed, {}).status, "PASS")
  assert.equal(classifyRun(goodRun, { ...parsed, executedCases: 1 }, {}).reasonCode, "incompatible_result")
  assert.equal(classifyRun(goodRun, { ...parsed, executedCases: 3 }, {}).reasonCode, "incompatible_result")
  assert.equal(classifyRun(goodRun, { ...parsed, reportedSkipped: 1 }, {}).status, "SKIPPED")
  assert.equal(parsePopulation("vitest", "bad json"), null)
  assert.equal(parsePopulation("vitest", "{}"), null)
  assert.equal(classifyRun(goodRun, parsePopulation("bun", "", " 2 pass\n 0 fail\n"), {}).status, "PASS")
  assert.equal(classifyRun(goodRun, parsePopulation("bun", "", " 0 pass\n 0 fail\n"), {}).status, "FAIL")
  assert.equal(classifyRun(goodRun, parsePopulation("bun", "", " 1 pass\n 0 fail\n 1 skip\n"), {}).status, "SKIPPED")
  assert.equal(classifyRun(goodRun, parsePopulation("bun", "", " 0 pass\n 1 fail\n(fail) oracle\n"), {}).status, "FAIL")
})

test("resource refusal, cancellation, process timeout and missing executable preserve failures", async (t) => {
  const options = await fixture(t)
  const resource = await runCheck({ ...options, bindings: { [check]: { commands: [{ argv: ["go", "test", "-json", "./fixture"], reporter: "go" }] } },
    guard: async () => ({ status: "BLOCKED", reasonCode: "environment", reason: "Machine load 60; retry after 2 minutes" }) })
  assert.equal(resource.result.status, "BLOCKED")
  assert.equal(resource.result.commands.length, 0)
  const controller = new AbortController(); controller.abort()
  assert.equal(classifyRun(await execute(["node", "fixture.mjs"], { signal: controller.signal }), null, {}).reasonCode, "pending")
  const timeout = await execute([process.execPath, "-e", "setInterval(() => {}, 1000)"], { cwd: options.root, timeoutMs: 40 })
  assert.equal(timeout.timedOut, true)
  assert.equal(classifyRun(timeout, null, {}).status, "FAIL")
  const missing = await execute([join(options.root, "missing-binary")], { cwd: options.root })
  assert.equal(classifyRun(missing, null, { argv: ["missing-binary"] }).reasonCode, "environment")
})

test("upload authentication failure never changes the local execution result", async (t) => {
  const options = await fixture(t)
  const exec = async (argv, config) => argv[0] === "gcloud" ? { code: 1, stdout: "", stderr: "not logged in" } : execute(argv, config)
  const receipt = await runCheck({ ...options, upload: true, exec })
  assert.equal(receipt.result.status, "PASS")
  assert.equal(receipt.upload.status, "BLOCKED")
  assert.equal(receipt.upload.reasonCode, "environment")
  const stored = JSON.parse(await readFile(`${receipt.directory}.upload.json`))
  assert.equal(stored.resultDigest, digest(await readFile(join(receipt.directory, "result.json"))))
})

test("upload copies sealed timestamp directory and retains an independent transfer receipt", async (t) => {
  const options = await fixture(t)
  const calls = []
  const exec = async (argv, config) => {
    if (argv[0] !== "gcloud") return execute(argv, config)
    calls.push(argv)
    if (argv[1] === "auth") return { ...goodRun, stdout: "fixture-account\n" }
    assert.equal(argv[1], "storage")
    assert.equal(JSON.parse(await readFile(join(argv[4], "result.json"))).status, "PASS")
    return goodRun
  }
  const receipt = await runCheck({ ...options, upload: true, exec })
  assert.equal(receipt.result.status, "PASS")
  assert.equal(receipt.upload.status, "PASS")
  assert.deepEqual(calls[1], ["gcloud", "auth", "print-access-token"])
  assert.deepEqual(calls[2], ["gcloud", "storage", "cp", "-r", receipt.directory, `gs://plue-prod-1771780303-check-evidence/checks/${check}/`])
  const stored = JSON.parse(await readFile(`${receipt.directory}.upload.json`))
  assert.equal(stored.status, "PASS")
  assert.equal(JSON.parse(await readFile(join(receipt.directory, "result.json"))).upload.reasonCode, "pending", "sealed bytes never rewritten")
})

test("logs redact inherited secrets and token URLs, retaining the failure oracle", async (t) => {
  const options = await fixture(t, "receipt", "`node fixture.mjs`")
  await writeFile(join(options.root, "fixture.mjs"), 'console.log(process.env.QA_SECRET); console.log("http://fixture/setup?token=raw-setup-value"); console.log(JSON.stringify({expectedCases: 1, executedCases: 1}));\n')
  const receipt = await runCheck({ ...options, env: { ...process.env, QA_SECRET: "private-fixture-secret" } })
  const log = await readFile(join(receipt.directory, "command-1.stdout.log"), "utf8")
  assert.doesNotMatch(log, /private-fixture-secret|raw-setup-value/)
  assert.match(log, /\[REDACTED\]/)
  assert.match(log, /expectedCases/)
})

test("only explicitly bound subcases may run; no partial check accidentally passes", async (t) => {
  const options = await fixture(t)
  const binding = { files: ["not-landed.mjs"], commands: [], subcases: { owner: { commands: [{ argv: ["node", "--test", "fixture.mjs"] }] } } }
  assert.equal((await runCheck({ ...options, bindings: { [check]: binding } })).result.status, "NOT IMPLEMENTED")
  const owner = await runCheck({ ...options, bindings: { [check]: binding }, subcases: ["owner"] })
  assert.equal(owner.result.status, "PASS")
  assert.deepEqual(owner.result.subcases, ["owner"])
  assert.equal((await runCheck({ ...options, bindings: { [check]: binding }, subcases: ["roster"] })).result.status, "NOT IMPLEMENTED")
})

test("command preparation retains Go budget flags and constrains Vitest workers", () => {
  const go = prepareCommand({ argv: ["go", "test", "./pkg"] }, { GOFLAGS: "-p=100", GOMAXPROCS: "99", GOCACHE: "/caller/cache" }, "evidence")
  assert.deepEqual(go.argv, ["go", "test", "-json", "./pkg"])
  assert.equal(go.environment.GOFLAGS, "-p=4")
  assert.equal(go.environment.GOMAXPROCS, "4")
  assert.equal(go.environment.GOCACHE, "/caller/cache")
  const vitest = prepareCommand({ argv: ["pnpm", "exec", "vitest", "run", "file.test.ts"] }, {}, "evidence")
  assert.ok(vitest.argv.includes("--maxWorkers=2"))
  assert.ok(vitest.argv.includes("--reporter=json"))
  for (const id of ["C-STK-01", "C-SEC-04", "C-ACC-04", "C-INS-05"]) assert.ok(commandTable[id].commands.length, id)
})

test("every result vocabulary reason is exercised and precedence never treats non-PASS as passing", () => {
  const all = Object.entries(REASONS).flatMap(([status, reasons]) => reasons.map((reasonCode) => ({ status, reasonCode, reason: reasonCode })))
  assert.equal(worst(all).status, "FAIL")
  assert.equal(worst(all.filter((v) => v.status !== "FAIL")).status, "NOT IMPLEMENTED")
  assert.equal(worst(all.filter((v) => !["FAIL", "NOT IMPLEMENTED"].includes(v.status))).status, "SKIPPED")
  for (const row of all) {
    const gate = gateVerdict([{ id: "thin.fixture", result: { check, ...row }, upload: { status: "PASS" }, directory: "fixture" }])
    assert.equal(gate.status, row.status)
    assert.equal(gate.rejected.length, row.status === "PASS" ? 0 : 1)
  }
  assert.equal(gateVerdict([]).status, "FAIL")
  assert.equal(gateVerdict([{ id: "fixture", result: { status: "PASS" }, upload: { status: "BLOCKED", reasonCode: "artifact_missing" } }]).status, "BLOCKED")
})

test("thin list is finite, unique, source-pinned and joins the real owner ticket issues", async () => {
  assert.equal(new Set(thinObligations.map((o) => o.id)).size, thinObligations.length)
  for (const ticket of ["T-INS-01", "T-INS-02", "T-INS-08", "T-ACC-01", "T-ACC-03", "T-STK-01", "T-STK-12", "T-STK-04"]) assert.ok(thinObligations.some((o) => o.ownerTicket === ticket), ticket)
  for (const row of thinObligations) {
    assert.ok(Array.isArray(row.subcases))
    assert.ok(Array.isArray(row.requiredEnvironment))
    const ticket = await readFile(join(ROOT, `.specs/engineering/tickets/${row.ownerTicket}.md`), "utf8")
    assert.ok(ticket.includes(`issues/${row.ownerIssue})`), row.id)
    assert.ok(thinSourcePaths.includes(`.specs/engineering/checks/${row.check}.md`))
  }
  assert.ok(thinObligations.some((o) => o.requiredEnvironment.includes("QA-HOST-ACTIVATION")))
})

test("qualification runs every obligation sequentially with one SHA and retains the manifest and verdict", async (t) => {
  const options = await fixture(t)
  await mkdir(join(options.root, ".specs/engineering/tickets"), { recursive: true })
  await writeFile(join(options.root, ".specs/engineering/tickets/T-TST-01.md"), "Issue: [#42](https://github.com/smithersai/smithers/issues/42)\n")
  const obligations = [1, 2].map((n) => ({ id: `thin.fixture-${n}`, check, subcases: [], ownerTicket: "T-TST-01", ownerIssue: 42, requiredEnvironment: [] }))
  const seen = []
  const run = async (config) => {
    seen.push(config)
    return { directory: "fixture", result: { check, candidateSha: config.sha, status: seen.length === 1 ? "PASS" : "NOT IMPLEMENTED", reasonCode: seen.length === 1 ? "complete" : "runner_absent", reason: "fixture" }, upload: { status: "PASS" } }
  }
  const receipt = await qualify({ ...options, gate: "G-THIN", obligations, sourcePaths: [".specs/engineering/spec.md"], run })
  assert.equal(receipt.result.status, "NOT IMPLEMENTED")
  assert.equal(receipt.result.executedObligations, 2)
  assert.equal(receipt.result.expectedObligations, 2)
  assert.ok(seen.every((config) => config.sha === sha))
  assert.equal(receipt.result.rejected[0].id, "thin.fixture-2")
  assert.match(receipt.output, /thin.fixture-2/)
  assert.equal(JSON.parse(await readFile(join(receipt.directory, "manifest.json"))).obligations.length, 2)
  await assert.rejects(qualify({ ...options, gate: "G-UNKNOWN" }), /Unknown gate/)
})

test("machine admission covers load and disk boundaries and refuses unknown health", async (t) => {
  const options = await fixture(t)
  const healthPath = join(options.root, "health.txt")
  const config = { env: {}, healthPath, exec: async () => ({ ...goodRun, stdout: `Filesystem 1K-blocks Used Available Capacity Mounted\nfixture 999999999 0 ${31 * 1024 ** 2} 1% /\n` }) }
  assert.equal((await resourceGuard(options.root, false, config)).reasonCode, "environment")
  for (const [text, builds, passes] of [
    ["mac: load 59.99 · disk 20 GiB", false, true], ["mac: load 60 · disk 30 GiB", false, false],
    ["mac: load 1 · disk 19 GiB", false, false], ["mac: load 1 · disk 29 GiB", true, false],
    ["mac: load 1 · disk 30 GiB", true, true], ["unparseable", false, false]
  ]) {
    await writeFile(healthPath, text)
    const result = await resourceGuard(options.root, builds, config)
    assert.equal(result === null, passes, text)
  }
  for (const disk of [{ ...goodRun, stdout: "unparseable" }, { code: 1, stdout: "", stderr: "unavailable" }, { ...goodRun, stdout: "header\nfixture 999 0 10 99% /" }]) {
    await writeFile(healthPath, "mac: load 1 · disk 30 GiB")
    for (const builds of [false, true]) {
      const refusal = await resourceGuard(options.root, builds, { ...config, exec: async () => disk })
      assert.equal(refusal.reasonCode, "environment")
      assert.match(refusal.reason, /Disk guard/)
    }
  }
})

test("machine budget is opt-in and reads only the configured host's segment", async (t) => {
  const options = await fixture(t)
  const healthPath = join(options.root, "health.txt")
  const disk = (gib) => async () => ({ ...goodRun, stdout: `Filesystem 1K-blocks Used Available Capacity Mounted\nfixture 999999999 0 ${gib * 1024 ** 2} 1% /\n` })
  // No configured budget file: CI and unconfigured hosts admit on the disk guard alone.
  assert.equal(await resourceGuard(options.root, true, { env: {}, exec: disk(31) }), null)
  assert.equal((await resourceGuard(options.root, true, { env: {}, exec: disk(29) })).reasonCode, "environment")
  // A configured but missing file still fails closed.
  assert.equal((await resourceGuard(options.root, false, { env: { SMITHERS_CHECK_HEALTH_FILE: join(options.root, "absent.txt") }, exec: disk(31) })).reasonCode, "environment")
  await writeFile(healthPath, "00:00 PT · mac: load 99 · disk 5 GiB · limited · mini: load 3.5 · disk 157 GiB · open")
  const mini = { env: { SMITHERS_CHECK_HEALTH_FILE: healthPath, SMITHERS_CHECK_HEALTH_HOST: "mini" }, exec: disk(31) }
  assert.equal(await resourceGuard(options.root, true, mini), null)
  assert.equal((await resourceGuard(options.root, false, { ...mini, env: { SMITHERS_CHECK_HEALTH_FILE: healthPath } })).reasonCode, "environment")
  assert.equal((await resourceGuard(options.root, false, { ...mini, env: { ...mini.env, SMITHERS_CHECK_HEALTH_HOST: "nas" } })).reasonCode, "environment")
})

test("executor profiles require host, environment, argv, toolchain and lease", async (t) => {
  const options = await fixture(t)
  const directory = join(options.root, ".specs/qa/appendices")
  await mkdir(directory, { recursive: true })
  const { hostname } = await import("node:os")
  const complete = { profile: "reference-host", hostId: hostname(), environment: "qa-reference", argv: ["node", "fixture.mjs"], toolchain: "pinned", resourceLease: "fixture-lease" }
  const config = { root: options.root, env: {}, exec: execute }
  for (const profiles of [[complete], { profiles: [complete] }]) {
    await writeFile(join(directory, "executors.json"), JSON.stringify(profiles))
    assert.equal(await probePrerequisite("reference-host", config), null)
  }
  await writeFile(join(directory, "executors.json"), JSON.stringify([{ ...complete, resourceLease: undefined }]))
  assert.equal((await probePrerequisite("reference-host", config)).reasonCode, "dependency")
  assert.equal((await probePrerequisite("built-bundle", { ...config, env: { SMITHERS_CHECK_BUNDLE: directory } })).reasonCode, "dependency")
})

test("bundle and helper prerequisites require real paths; malformed argv stays blocked", async (t) => {
  const options = await fixture(t)
  await writeFile(join(options.root, "manifest.json"), "{}")
  const config = { root: options.root, env: { SMITHERS_CHECK_BUNDLE: options.root, SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.execPath }, exec: execute }
  assert.equal(await probePrerequisite("built-bundle", config), null)
  assert.equal(await probePrerequisite("jj-helper", config), null)
  await assert.rejects(runCheck({ ...options, check: "../escape" }), /Invalid check id/)
  const escaped = await runCheck({ ...options, bindings: { [check]: { files: ["../outside.mjs"], commands: [{ argv: ["node", "fixture.mjs"] }] } } })
  assert.equal(escaped.result.reasonCode, "source_drift")
  const unbound = await runCheck({ ...options, bindings: { [check]: { commands: [{ argv: ["node", "--test", "fixture.mjs"] }], unboundSubcases: ["roster"] } } })
  assert.equal(unbound.result.status, "NOT IMPLEMENTED")
  assert.match(unbound.result.reason, /roster/)
  await symlink(join(options.root, "fixture.mjs"), join(options.root, "untrusted-link"))
  await assert.rejects(artifactHashes(options.root), /nonregular artifact/)
})

test("TAP plans, cancellation, zero-exit failures and negative counts cannot become PASS", () => {
  const fallback = parsePopulation("tap", "TAP version 13\nok 1 - edge\n1..1\n")
  assert.equal(fallback.executedCases, 1)
  assert.equal(classifyRun(goodRun, fallback, {}).status, "PASS")
  assert.equal(parsePopulation("tap", "not TAP"), null)
  assert.equal(classifyRun(goodRun, { expectedCases: -1, executedCases: 0 }, {}).reasonCode, "incompatible_result")
  assert.equal(classifyRun({ ...goodRun, error: "EACCES" }, null, {}).status, "FAIL")
  assert.equal(classifyRun({ ...goodRun, code: null, signal: "SIGTERM" }, null, {}).status, "FAIL")
  const cancel = parsePopulation("tap", "TAP version 13\nnot ok 1 - cancelled\n1..1\n# tests 1\n# pass 0\n# fail 0\n# cancelled 1\n# skipped 0\n# todo 0\n")
  assert.equal(classifyRun(goodRun, cancel, {}).status, "FAIL")
  const report = parsePopulation("vitest", JSON.stringify({ numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, testResults: [{ assertionResults: [{ fullName: "oracle", status: "failed", failureMessages: ["wrong bytes"] }] }] }))
  assert.equal(classifyRun(goodRun, report, {}).reason, "wrong bytes")
  assert.equal(parsePopulation("bun", "no summary"), null)
  assert.equal(parsePopulation("receipt", "noise\n{}\n"), null)
  assert.equal(parseAutomation('Automation: `unknown --test fixture.mjs`').commands.length, 0)
})

test("upload transfer failure keeps PASS locally and records artifact_missing", async (t) => {
  const options = await fixture(t)
  const exec = async (argv, config) => argv[0] !== "gcloud" ? execute(argv, config) : argv[1] === "auth" ? { ...goodRun, stdout: "fixture-account\n" } : { code: 1, stdout: "", stderr: "transfer failed" }
  const receipt = await runCheck({ ...options, upload: true, exec })
  assert.equal(receipt.result.status, "PASS")
  assert.equal(receipt.upload.status, "BLOCKED")
  assert.equal(receipt.upload.reasonCode, "artifact_missing")
})

test("CLI adapters return correct exit codes, expose blockers and clean up cancellation handlers", async () => {
  const output = [], errors = []
  const print = (value) => output.push(value), printError = (value) => errors.push(value)
  const receipt = { directory: "fixture", result: { check, status: "PASS", reasonCode: "complete", reason: "complete" }, upload: { status: "PASS" } }
  assert.equal(await checkMain([check], { run: async () => receipt, print, printError }), 0)
  assert.equal(await checkMain([check], { run: async ({ signal }) => {
    process.emit("SIGINT"); assert.equal(signal.aborted, true)
    return { ...receipt, result: { ...receipt.result, status: "BLOCKED" }, upload: { status: "BLOCKED", reasonCode: "environment", reason: "gcloud" } }
  }, print, printError }), 1)
  assert.equal(await checkMain([check, "--wat"], { print, printError }), 2)
  assert.ok(output.some((text) => text.includes("Durable evidence")))
  assert.ok(errors.some((text) => text.includes("Unknown argument")))
  const run = async (options) => { assert.equal(options.gate, "G-THIN"); return { output: "gate PASS", result: { status: "PASS" } } }
  assert.equal(await qualifyMain(["--gate", "G-THIN", "--sha", sha, "--evidence-root", "evidence", "--upload"], { run, print, printError }), 0)
  assert.equal(await qualifyMain(["--gate", "G-THIN"], { run: async () => ({ output: "gate BLOCKED", result: { status: "BLOCKED" } }), print, printError }), 1)
  for (const args of [[], ["--gate"], ["--unknown"], ["--sha", "--gate"]]) assert.equal(await qualifyMain(args, { print, printError }), 2)
})

test("qualification rejects missing authority, drift, duplicate ids and mismatched candidate", async (t) => {
  const options = await fixture(t)
  const obligations = [1, 2].map(() => ({ id: "duplicate", check, subcases: [], ownerTicket: "T-TST-01", ownerIssue: 42, requiredEnvironment: [] }))
  await mkdir(join(options.root, ".specs/engineering/tickets"), { recursive: true })
  await writeFile(join(options.root, ".specs/engineering/tickets/T-TST-01.md"), "wrong issue")
  const run = async () => {
    await writeFile(join(options.root, ".specs/engineering/spec.md"), "changed during run")
    return { directory: "fixture", result: { check, candidateSha: "b".repeat(40), status: "PASS" }, upload: { status: "PASS" } }
  }
  const receipt = await qualify({ ...options, obligations, sourcePaths: [".specs/engineering/spec.md", "missing.md"], run })
  assert.equal(receipt.result.status, "BLOCKED")
  for (const pattern of [/Duplicate/, /Owner|issue differs/, /Authority changed/, /Attempt candidate differs/, /Missing manifest authority/]) assert.ok(receipt.result.rejected.some((row) => pattern.test(row.reason)), pattern)
  await rm(join(options.root, ".specs/engineering/tickets/T-TST-01.md"))
  const missing = await qualify({ ...options, obligations: [obligations[0]], sourcePaths: [".specs/engineering/spec.md"], run: async () => {
    await rm(join(options.root, ".specs/engineering/spec.md"))
    return { directory: "fixture", result: { check, candidateSha: sha, status: "PASS" }, upload: { status: "PASS" } }
  } })
  assert.ok(missing.result.rejected.some((row) => /Owner ticket missing/.test(row.reason)))
  assert.ok(missing.result.rejected.some((row) => /Authority disappeared/.test(row.reason)))
})

test("unavailable executable is a named prerequisite even behind nice", async (t) => {
  const options = await fixture(t)
  const result = await runCheck({ ...options, bindings: { [check]: { commands: [{ argv: ["qa-fixture-absent-binary"], reporter: "receipt" }] } } })
  assert.equal(result.result.status, "BLOCKED")
  assert.equal(result.result.reasonCode, "environment")
  assert.match(result.result.reason, /qa-fixture-absent-binary/)
  assert.equal(result.result.commands.length, 0)
})

test("Go transport executes serial commands with budget environment and retains named cases", async (t) => {
  const options = await fixture(t)
  const exec = async (argv, config) => {
    if (argv[0] === "sysctl") return { ...goodRun, stdout: "fixture-host" }
    assert.equal(argv[0], "nice")
    assert.equal(config.env.GOMAXPROCS, "4")
    assert.equal(config.env.GOFLAGS, "-p=4")
    return { ...goodRun, stdout: [goEvent("run", "TestOne"), goEvent("pass", "TestOne")].join("\n") }
  }
  // The installed Node binary stands in only for transport. Go parsing, the
  // environment and case oracle are exercised independently above.
  const command = { argv: [process.execPath, "test"], reporter: "go", expectedCaseIds: ["TestOne"], env: { SMITHERS_REQUIRE_DATABASE_TESTS: "1" } }
  const receipt = await runCheck({ ...options, exec, bindings: { [check]: { commands: [command, command] } } })
  assert.equal(receipt.result.status, "PASS")
  assert.equal(receipt.result.commands.length, 2)
  assert.equal(receipt.result.commands[0].environment.GOFLAGS, "-p=4")
  assert.equal(receipt.result.expectedCases, 2)
  assert.equal(receipt.result.executedCases, 2)
})

test("qualification pins a read-only parent once even when no SHA is supplied", async (t) => {
  const options = await fixture(t)
  let calls = 0
  const receipt = await qualify({ ...options, sha: undefined, obligations: [], sourcePaths: [], exec: async (argv) => {
    calls++; assert.equal(argv[0], "jj"); return { ...goodRun, stdout: sha }
  } })
  assert.equal(calls, 1)
  assert.equal(receipt.result.candidateSha, sha)
  assert.equal(receipt.result.status, "FAIL", "no empty gate PASS")
})

test("cancellation while a child is running is incomplete evidence", async (t) => {
  const options = await fixture(t)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 100)
  const run = await execute([process.execPath, "-e", "setInterval(() => {}, 1000)"], { cwd: options.root, signal: controller.signal })
  clearTimeout(timer)
  assert.equal(run.cancelled, true)
  assert.equal(classifyRun(run, null, {}).reasonCode, "pending")
})

test("CLI executable boundaries reject malformed invocation without running a gate", async () => {
  for (const entry of ["run-check.mjs", "qualify.mjs"]) {
    const result = await execute([process.execPath, join(ROOT, "scripts/checks", entry), "--unknown"])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /Unknown argument/)
  }
})

test("platform receipts and required architecture distinguish Mac and other hosts", async () => {
  const config = { root: ROOT, env: {}, exec: execute }
  for (const [os, arch, passes] of [["darwin", "arm64", true], ["darwin", "x64", false], ["linux", "arm64", false]]) {
    assert.equal((await probePrerequisite("darwin-arm64", { ...config, os, arch })) === null, passes)
  }
  assert.equal(await probePrerequisite("build-budget", { ...config, guard: async (root, builds) => { assert.equal(root, ROOT); assert.equal(builds, true); return null } }), null)
  const unknown = await hostProfile(async () => ({ ...goodRun, stdout: "" }), ROOT, { os: "darwin" })
  assert.equal(unknown["hw.model"], "unknown")
  const linux = await hostProfile(execute, ROOT, { os: "linux", processors: [{ model: "fixture-cpu" }], memory: 1234, hostId: "fixture", osRelease: "fixture-release", arch: "x64" })
  assert.equal(linux["hw.model"], "fixture-cpu")
  assert.equal(linux.memory, 1234)
  assert.equal(linux.cores, 1)
  assert.equal(linux.os.platform, "linux")
  assert.equal((await hostProfile(execute, ROOT, { os: "linux", processors: [] }))["hw.model"], "unknown")
})

test("runner report fallback combinations preserve missing, pending and failed cases", () => {
  assert.equal(prepareCommand({ argv: ["bun", "test", "edge.test.ts"] }, {}, "out").reporter, "bun")
  assert.equal(prepareCommand({ argv: ["bun", "script.mjs"] }, {}, "out").reporter, "receipt")
  const go = parsePopulation("go", ["{}", '{"Action":"run","Test":"TestOne"}', '{"Action":"fail"}', '{"Action":"fail","Package":"fixture"}'].join("\n"))
  assert.equal(go.expectedCases, 1)
  assert.deepEqual(go.failures, ["Go package failed", "fixture"])
  const tap = parsePopulation("tap", "# tests 1\n# pass 0\n# fail 0\n# skipped 1\n")
  assert.equal(classifyRun(goodRun, tap, {}).status, "SKIPPED")
  const todo = parsePopulation("tap", "ok 1 - future # TODO\n")
  assert.equal(classifyRun(goodRun, todo, {}).reasonCode, "quarantine")
  const vitest = parsePopulation("vitest", JSON.stringify({ numTotalTests: 2, numFailedTests: 0, success: false,
    testResults: [{ assertionResults: [{ fullName: "future", status: "pending" }, { fullName: "oracle", status: "failed" }] }, {}] }))
  assert.deepEqual(vitest.skipped, ["future"])
  assert.deepEqual(vitest.failures, ["oracle"])
  assert.equal(vitest.incomplete, true)
  assert.equal(parsePopulation("vitest", '{"numTotalTests":0}').executedCases, 0)
  assert.equal(parsePopulation("bun", "1 fail").failures[0], "Bun test failure")
  assert.equal(parsePopulation("bun", "1 todo").quarantine, true)
})

test("filesystem and missing-parent failures never masquerade as a successful attempt", async (t) => {
  const options = await fixture(t)
  const exec = async (argv, config) => argv[0] === "jj" ? { code: 1, stdout: "", stderr: "parent unavailable" } : execute(argv, config)
  const missing = await runCheck({ ...options, sha: undefined, exec })
  assert.equal(missing.result.reasonCode, "source_drift")
  await assert.rejects(runCheck(), /Invalid check id/)
  const emptyPath = await runCheck({ ...options, env: {}, bindings: { [check]: { commands: [{ argv: ["missing-binary"], reporter: "receipt" }] } } })
  assert.equal(emptyPath.result.reasonCode, "environment")
  await rm(join(options.root, ".specs/engineering/spec.md"))
  await mkdir(join(options.root, ".specs/engineering/spec.md"))
  assert.equal((await runCheck(options)).result.reasonCode, "artifact_missing")
  const denied = join(options.root, "denied", check)
  await mkdir(denied, { recursive: true }); await chmod(denied, 0o555)
  await assert.rejects(allocate(join(options.root, "denied"), check, () => new Date()), { code: "EACCES" })
})

test("artifact trees from a runner are included, hashed and recursively sealed", async (t) => {
  const options = await fixture(t, "receipt", "`node fixture.mjs`")
  await writeFile(join(options.root, "fixture.mjs"), 'import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const dir=join(process.env.SMITHERS_CHECK_EVIDENCE_DIR,"extra"); mkdirSync(dir); writeFileSync(join(dir,"oracle.txt"),"fixed bytes"); console.log(JSON.stringify({expectedCases:1,executedCases:1}));\n')
  const receipt = await runCheck(options)
  const hashes = JSON.parse(await readFile(join(receipt.directory, "sha256s.json")))
  assert.equal(hashes["extra/oracle.txt"], digest("fixed bytes"))
  await assert.rejects(writeFile(join(receipt.directory, "extra/another.txt"), "mutation"), { code: "EACCES" })
})

test("unit process scheduler probes exited-process races and forced group termination", async () => {
  // Unit exception: ESRCH during TERM/KILL and a non-code spawn error cannot
  // be provoked deterministically in a real OS. Real process integration above
  // independently exercises start, output, timeout and active cancellation.
  const { EventEmitter } = await import("node:events")
  const child = new EventEmitter(); child.pid = 54321; child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  const calls = []
  const result = await execute(["fixture"], { timeoutMs: 1, spawnProcess: () => {
    queueMicrotask(() => { child.stdout.emit("data", Buffer.from("out")); child.stderr.emit("data", Buffer.from("err")); child.emit("error", new Error("spawn failure")) })
    return child
  }, kill: (pid, signal) => {
    calls.push([pid, signal])
    if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, "SIGKILL"))
    throw new Error("ESRCH")
  } })
  assert.deepEqual(calls, [[-54321, "SIGTERM"], [-54321, "SIGKILL"]])
  assert.equal(result.error, "spawn failure")
  assert.equal(result.timedOut, true)
  assert.equal(result.stdout, "out")
  assert.equal(result.stderr, "err")
})

test("failed candidate discovery stays unavailable in the gate's durable receipt", async (t) => {
  const options = await fixture(t)
  const receipt = await qualify({ ...options, sha: undefined, obligations: [], sourcePaths: [], exec: async () => ({ code: 1, stdout: "", stderr: "no parent" }) })
  assert.equal(receipt.result.status, "FAIL")
  assert.equal(receipt.result.candidateSha, null)
  assert.match(receipt.output, /Candidate: unavailable/)
})

test("heavy script admission distinguishes tests from build output", async (t) => {
  const options = await fixture(t)
  await writeFile(join(options.root, "bun"), "fixture executable")
  await chmod(join(options.root, "bun"), 0o755)
  const seen = []
  const receipt = await runCheck({ ...options, env: { PATH: options.root },
    bindings: { [check]: { commands: [
      { argv: ["bun", "fixture.mjs"], reporter: "receipt" },
      { argv: ["bun", "fixture.mjs"], reporter: "receipt", prerequisites: ["build-budget"] }
    ] } }, probe: async () => null,
    guard: async (root, builds) => { assert.equal(root, options.root); seen.push(builds); return null },
    exec: async (argv) => ({ ...goodRun, stdout: argv[0] === "sysctl" ? "fixture-host" : '{"expectedCases":1,"executedCases":1}\n' })
  })
  assert.equal(receipt.result.status, "PASS")
  assert.deepEqual(seen, [undefined, true])
  const errors = []
  assert.equal(await checkMain([check], { run: async () => { throw new Error("executor fault") }, printError: (message) => errors.push(message) }), 2)
  assert.deepEqual(errors, ["executor fault"])
})
