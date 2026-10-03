#!/usr/bin/env node
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { access, chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { cpus, hostname, homedir, platform, release, totalmem } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { commandProvenance, commandTable } from "./commands.mjs"

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
export const REASONS = {
  PASS: ["complete"], FAIL: ["oracle_violation"],
  "NOT IMPLEMENTED": ["behavior_absent", "runner_absent"],
  SKIPPED: ["intentional_skip", "quarantine"],
  BLOCKED: ["pending", "dependency", "environment", "oracle_conflict", "artifact_missing", "source_drift", "incompatible_result"]
}
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const outcome = (status, reasonCode, reason) => ({ status, reasonCode, reason })
const absent = (reason) => outcome("NOT IMPLEMENTED", "runner_absent", reason)
const blocked = (code, reason) => outcome("BLOCKED", code, reason)
const failed = (reason) => outcome("FAIL", "oracle_violation", reason)
const exists = async (path) => access(path).then(() => true, () => false)

async function executableAvailable(argv, env, cwd) {
  const paths = argv[0].includes("/") ? [resolve(cwd, argv[0])] : (env.PATH ?? "").split(":").map((dir) => resolve(cwd, dir, argv[0]))
  for (const path of paths) {
    if (await access(path, constants.X_OK).then(() => true, () => false)) return true
  }
  return false
}

// Tokenize literal argv, without invoking a shell or expanding variables.
// Complex shell automation needs an explicit reviewed entry in commands.mjs.
export function parseAutomation(text) {
  const line = text.match(/^Automation:\s*(.*)$/m)?.[1]
  if (!line) return { files: [], commands: [], problem: "Automation line absent" }
  const files = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((v) => /^[\w./-]+\.(?:mjs|[cm]?js|tsx?|go|sh)$/.test(v))
  const literal = line.split(/\s*·\s*Runs in:/)[0].trim()
  if (!/^`[^`]+`(?:\s*(?:&&|;)\s*`[^`]+`)*$/.test(literal)) return { files, commands: [], problem: "Automation is prose; no reviewed command binding" }
  const commands = []
  for (const match of literal.matchAll(/`([^`]+)`/g)) {
    const command = match[1]
    if (/[\n\r$<>|;&]/.test(command)) return { files, commands: [], problem: "Shell automation requires a reviewed argv binding" }
    const argv = []
    const tokens = /\s*(?:"([^"\\]*)"|'([^']*)'|([^\s'"\\]+))/gy
    let offset = 0
    while (offset < command.length) {
      tokens.lastIndex = offset
      const token = tokens.exec(command)
      if (!token) return { files, commands: [], problem: "Nonliteral argv requires a reviewed binding" }
      argv.push(token[1] ?? token[2] ?? token[3]); offset = tokens.lastIndex
    }
    if (!["node", "go", "bun", "pnpm", "smthrs"].includes(argv[0])) return { files, commands: [], problem: "No explicit executable command" }
    const commandFiles = argv.slice(1).filter((arg) => !arg.startsWith("-") && /\.(?:mjs|[cm]?js|tsx?|go|sh)$/.test(arg))
    commands.push({ argv, files: [...files, ...commandFiles], reporter: inferReporter(argv) })
  }
  return { files, commands }
}

function inferReporter(argv) {
  if (argv[0] === "go" && argv[1] === "test") return "go"
  if (argv.includes("--test")) return "tap"
  if (argv.includes("vitest")) return "vitest"
  if (argv[0] === "bun" && argv[1] === "test") return "bun"
  return "receipt"
}

export function prepareCommand(command, env, directory) {
  const argv = [...command.argv]
  const reporter = command.reporter ?? inferReporter(argv)
  if (reporter === "go" && !argv.includes("-json")) argv.splice(2, 0, "-json")
  if (reporter === "tap" && !argv.some((arg) => arg.startsWith("--test-reporter"))) argv.splice(argv.indexOf("--test") + 1, 0, "--test-reporter=tap")
  if (reporter === "vitest") {
    if (!argv.some((arg) => arg.startsWith("--reporter"))) argv.push("--reporter=json")
    if (!argv.some((arg) => arg.startsWith("--maxWorkers"))) argv.push("--maxWorkers=2")
  }
  const environment = { ...env, ...command.env, SMITHERS_CHECK_EVIDENCE_DIR: directory }
  // A Node test worker sets this internal IPC flag. An independently launched
  // node --test must report TAP rather than inherit the parent's binary IPC.
  delete environment.NODE_TEST_CONTEXT
  // Cap Go parallelism; GOCACHE stays the caller's (each host or lane sets its own).
  if (reporter === "go") Object.assign(environment, { GOMAXPROCS: "4", GOFLAGS: "-p=4" })
  return { ...command, argv, reporter, environment }
}

// Run a process group so timeout/cancellation also terminates descendants.
export async function execute(argv, { cwd, env = process.env, signal, timeoutMs = 600_000, spawnProcess = spawn, kill = process.kill } = {}) {
  return new Promise((done) => {
    if (signal?.aborted) return done({ code: null, stdout: "", stderr: "", cancelled: true })
    const child = spawnProcess(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    const stdout = [], stderr = []
    let error, timedOut = false, cancelled = false, killTimer
    const stop = () => {
      try { kill(-child.pid, "SIGTERM") } catch { /* Already exited. */ }
      killTimer = setTimeout(() => { try { kill(-child.pid, "SIGKILL") } catch { /* Already exited. */ } }, 1000)
      killTimer.unref()
    }
    const abort = () => { cancelled = true; stop() }
    signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.on("error", (cause) => { error = cause.code ?? cause.message })
    child.on("close", (code, childSignal) => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", abort)
      done({ code, signal: childSignal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), error, timedOut, cancelled })
    })
  })
}

export function parsePopulation(reporter, stdout, stderr = "", argv = []) {
  if (reporter === "go") {
    const started = new Set(), finished = new Set(), passed = new Set(), skipped = [], failures = []
    let events = 0
    for (const line of stdout.split("\n")) {
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (!event.Action) continue
      events++
      const id = event.Test ? `${event.Package ?? ""}:${event.Test}` : null
      if (id && event.Action === "run") started.add(id)
      if (id && ["pass", "fail"].includes(event.Action)) finished.add(id)
      if (id && event.Action === "pass") passed.add(id)
      if (id && event.Action === "skip") skipped.push(id)
      if (event.Action === "fail") failures.push(id ?? event.Package ?? "Go package failed")
    }
    return events ? { expectedCases: started.size, executedCases: finished.size, expectedCaseIds: [...started], executedCaseIds: [...finished], passedCaseIds: [...passed], skipped, failures } : null
  }
  if (reporter === "tap") {
    const count = (name) => Number(stdout.match(new RegExp(`^# ${name} (\\d+)\\s*$`, "m"))?.[1] ?? 0)
    const points = [...stdout.matchAll(/^\s*(not ok|ok) \d+ - (.*)$/gm)]
    const skipped = points.filter((m) => /# (SKIP|TODO)\b/i.test(m[2])).map((m) => m[2])
    const failures = points.filter((m) => m[1] === "not ok" && !/# (SKIP|TODO)\b/i.test(m[2])).map((m) => m[2])
    const summary = /^# tests \d+\s*$/m.test(stdout)
    const expectedCases = summary ? count("tests") : Number(stdout.match(/^1\.\.(\d+)\s*$/m)?.[1] ?? points.length)
    // Node counts a file with zero registered tests as one passing file test.
    // Those wrappers are not the check's expected behavioral population.
    const wrappers = points.filter((m) => argv.some((arg) => arg.replace(/^\.\//, "") === m[2].replace(/^\.\//, ""))).length
    return /^TAP version/m.test(stdout) || points.length || summary ? {
      expectedCases: expectedCases - wrappers, executedCases: (summary ? count("pass") + count("fail") + count("cancelled") : points.length - skipped.length) - wrappers,
      expectedCaseIds: points.map((m) => m[2]), executedCaseIds: points.filter((m) => !/# (SKIP|TODO)\b/i.test(m[2])).map((m) => m[2]),
      skipped: summary && count("skipped") + count("todo") > skipped.length ? ["Runner reported skipped cases", ...skipped] : skipped,
      failures, quarantine: count("todo") > 0 || skipped.some((v) => /# TODO/i.test(v)), incomplete: count("cancelled") > 0
    } : null
  }
  if (reporter === "vitest") {
    const start = stdout.indexOf('{"numTotalTestSuites"')
    let report
    try { report = JSON.parse(start >= 0 ? stdout.slice(start) : stdout) } catch { return null }
    if (!Number.isInteger(report.numTotalTests)) return null
    const cases = (report.testResults ?? []).flatMap((suite) => suite.assertionResults ?? [])
    return { expectedCases: report.numTotalTests, executedCases: (report.numPassedTests ?? 0) + (report.numFailedTests ?? 0),
      expectedCaseIds: cases.map((c) => c.fullName), executedCaseIds: cases.filter((c) => ["passed", "failed"].includes(c.status)).map((c) => c.fullName),
      skipped: cases.filter((c) => !["passed", "failed"].includes(c.status)).map((c) => c.fullName),
      failures: cases.filter((c) => c.status === "failed").map((c) => (c.failureMessages ?? [c.fullName]).join("\n")),
      incomplete: report.success === false && !(report.numFailedTests > 0),
      reportedSkipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0)
    }
  }
  if (reporter === "bun") {
    const output = `${stdout}\n${stderr}`.replace(/\x1b\[[0-9;]*m/g, "")
    const counts = [...output.matchAll(/^\s*(\d+) (pass|fail|skip|todo)\s*$/gm)]
    if (!counts.length) return null
    const sum = (kind) => counts.filter((m) => m[2] === kind).reduce((n, m) => n + Number(m[1]), 0)
    return { expectedCases: sum("pass") + sum("fail") + sum("skip") + sum("todo"), executedCases: sum("pass") + sum("fail"),
      skipped: sum("skip") + sum("todo") ? ["Bun reported skipped cases"] : [],
      failures: sum("fail") ? [output.match(/^\(fail\).*$/m)?.[0] ?? "Bun test failure"] : [], quarantine: sum("todo") > 0 }
  }
  // Script authors can emit one machine receipt. No exit-code-only PASS.
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const report = JSON.parse(line)
      if (Number.isInteger(report.expectedCases) && Number.isInteger(report.executedCases)) {
        return { skipped: [], failures: [], ...report }
      }
    } catch { /* Not a receipt. */ }
  }
  return null
}

export function classifyRun(run, population, command) {
  if (run.cancelled) return blocked("pending", "Execution cancelled; attempt preserved")
  if (run.error === "ENOENT") return blocked("environment", `Missing executable: ${command.argv[0]}`)
  if (run.timedOut) return failed("Runner timed out; process group terminated")
  if (run.error || run.code !== 0) return failed(`Command failed: ${run.error ?? run.signal ?? `exit ${run.code}`}`)
  if (!population) return blocked("incompatible_result", "Runner reported no machine-readable case population")
  if (population.expectedCases < 0 || population.executedCases < 0 || population.executedCases > population.expectedCases) return blocked("incompatible_result", "Invalid case counts")
  if (population.failures?.length) return failed(population.failures[0])
  if (population.expectedCases === 0) return failed("Empty test population")
  if (population.skipped?.length || population.reportedSkipped) return outcome("SKIPPED", population.quarantine ? "quarantine" : "intentional_skip", "Runner left cases unexecuted")
  if (population.executedCases === 0) return failed("Empty executed test population")
  if (population.executedCases !== population.expectedCases || population.incomplete) return blocked("incompatible_result", "Incomplete case population")
  const missing = (command.expectedCaseIds ?? []).filter((name) => !population.passedCaseIds?.some((id) => id.endsWith(`:${name}`)))
  if (missing.length) return blocked("incompatible_result", `Expected named tests did not pass: ${missing.join(", ")}`)
  return outcome("PASS", "complete", "Every reported case passed")
}

export async function hostProfile(exec, root, { os = platform(), processors = cpus(), memory = totalmem(), hostId = hostname(), osRelease = release(), arch = process.arch } = {}) {
  const model = os === "darwin" ? await exec(["sysctl", "-n", "hw.model"], { cwd: root }) : { stdout: processors[0]?.model ?? "unknown" }
  return { hostId, "hw.model": model.stdout.trim() || "unknown", memory, cores: processors.length, os: { platform: os, release: osRelease, arch } }
}

export async function probePrerequisite(name, { root, env, exec, os = platform(), arch = process.arch, guard = resourceGuard }) {
  if (name === "PG18") {
    if (!env.SMITHERS_TEST_DATABASE_URL) return blocked("environment", "PG18: SMITHERS_TEST_DATABASE_URL is not allocated")
    const result = await exec(["psql", "-Atqc", "SHOW server_version_num"], { cwd: root, env: { ...env, PGDATABASE: env.SMITHERS_TEST_DATABASE_URL }, timeoutMs: 5000 })
    return result.code === 0 && /^18\d{4}$/.test(result.stdout.trim()) ? null : blocked("environment", "PG18: allocated database is unavailable or not PostgreSQL 18")
  }
  if (name === "msb") {
    if (!env.SMITHERS_MICROSANDBOX_BIN || !isAbsolute(env.SMITHERS_MICROSANDBOX_BIN) || !await exists(env.SMITHERS_MICROSANDBOX_BIN)) return blocked("environment", "msb: verified absolute SMITHERS_MICROSANDBOX_BIN missing")
    const result = await exec([env.SMITHERS_MICROSANDBOX_BIN, "--version"], { cwd: root, env, timeoutMs: 5000 })
    return result.code === 0 && /\b0\.6\.16\b/.test(result.stdout) ? null : blocked("environment", "msb: version 0.6.16 required")
  }
  if (name === "darwin-arm64") return os === "darwin" && arch === "arm64" ? null : blocked("environment", "darwin-arm64 host required")
  if (name === "build-budget") return guard(root, true)
  if (name === "built-bundle") return env.SMITHERS_CHECK_BUNDLE && await exists(join(env.SMITHERS_CHECK_BUNDLE, "manifest.json")) ? null : blocked("dependency", "built-bundle: SMITHERS_CHECK_BUNDLE with manifest.json required")
  if (name === "jj-helper") return env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY && isAbsolute(env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY) && await exists(env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY) ? null : blocked("environment", "jj-helper: verified SMITHERS_WORKSPACE_JJ_EXPORT_BINARY missing")
  if (name === "QA-HOST-ACTIVATION") return blocked("oracle_conflict", "QA-HOST-ACTIVATION: 8a reference-host applicability decision required (plan §5)")
  let bindings
  try { bindings = JSON.parse(await readFile(join(root, ".specs/qa/appendices/executors.json"), "utf8")) } catch { return blocked("dependency", `${name}: executor profile is unbound (appendices/executors.json)` ) }
  const profiles = Array.isArray(bindings) ? bindings : bindings.profiles
  return profiles?.some((p) => p.profile === name && p.hostId === hostname() && p.environment && p.argv && p.toolchain && p.resourceLease) ? null : blocked("dependency", `${name}: no complete executor binding for ${hostname()}`)
}

// The shared machine budget is admission, never a skipped successful test.
export async function resourceGuard(root, builds = false, { healthPath = join(homedir(), "Desktop/back-of-house-20261002/health.txt"), exec = execute } = {}) {
  let health
  try { health = await readFile(healthPath, "utf8") } catch { return blocked("environment", `Machine budget unavailable: ${healthPath}`) }
  const load = Number(health.match(/mac: load ([\d.]+)/)?.[1])
  const free = Number(health.match(/disk (\d+) GiB/)?.[1])
  if (!Number.isFinite(load) || !Number.isFinite(free) || load >= 60 || free < (builds ? 30 : 20)) return blocked("environment", `Machine budget: load ${load}, free ${free} GiB; retry after 2 minutes`)
  // Read-only disk guard, including Go's build cache writes.
  const disk = await exec(["df", "-k", homedir()], { cwd: root })
  const availableKiB = Number(disk.stdout.trim().split("\n").at(-1)?.trim().split(/\s+/)[3])
  if (disk.code !== 0 || !Number.isFinite(availableKiB) || availableKiB < (builds ? 30 : 20) * 1024 ** 2) return blocked("environment", `Disk guard: insufficient free disk for ${builds ? "build" : "test"}`)
  return null
}

function redactor(env) {
  const secrets = Object.entries(env).filter(([key, value]) => /TOKEN|SECRET|PASSWORD|DATABASE_URL|PRIVATE_KEY/.test(key) && value?.length >= 4).map(([, v]) => v)
  return (value) => {
    let text = String(value)
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]")
    return text.replace(/([?&]token=)[^\s"'<>]+/gi, "$1[REDACTED]")
  }
}

export async function allocate(root, check, now) {
  const parent = join(root, check)
  await mkdir(parent, { recursive: true })
  let instant = now().getTime()
  for (;;) {
    const utc = new Date(instant).toISOString()
    const directory = join(parent, utc)
    try { await mkdir(directory); return { directory, utc } } catch (error) { if (error.code !== "EEXIST") throw error; instant++ }
  }
}

export async function artifactHashes(directory, prefix = "") {
  const result = {}
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) Object.assign(result, await artifactHashes(directory, path))
    else if (entry.isFile()) result[path] = digest(await readFile(join(directory, path)))
    else throw new Error(`Evidence contains nonregular artifact: ${path}`)
  }
  return result
}

export async function seal(directory) {
  // Detached manifest: all payloads, including result.json, are hashed here.
  // Its own hash is detached to avoid a circular self-hash.
  const hashes = await artifactHashes(directory)
  const bytes = `${JSON.stringify(hashes, null, 2)}\n`
  await writeFile(join(directory, "sha256s.json"), bytes, { flag: "wx" })
  await writeFile(join(directory, "sha256s.sha256"), `${digest(bytes)}  sha256s.json\n`, { flag: "wx" })
  const freeze = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await freeze(join(dir, entry.name))
      else await chmod(join(dir, entry.name), 0o444)
    }
    await chmod(dir, 0o555)
  }
  await freeze(directory)
}

const rank = { FAIL: 5, "NOT IMPLEMENTED": 4, SKIPPED: 3, BLOCKED: 2, PASS: 1 }
export const worst = (results) => results.reduce((a, b) => rank[b.status] > rank[a.status] ? b : a, outcome("PASS", "complete", "All obligations passed"))

export async function runCheck({ check, root = ROOT, sha, evidenceRoot = join(root, ".artifacts/checks"), subcases = [], upload = false,
  requiredEnvironment = [], bindings = commandTable, env = process.env, now = () => new Date(), exec = execute,
  probe = probePrerequisite, guard = resourceGuard, signal } = {}) {
  if (!/^C-[A-Z0-9]+-\d{2}$/.test(check ?? "")) throw new Error("Invalid check id")
  const { directory, utc } = await allocate(resolve(evidenceRoot), check, now)
  const startedAt = now().toISOString(), clean = redactor(env)
  const result = { schemaVersion: 1, check, subcases, candidateSha: sha ?? null, specDigest: null, checkDigest: null,
    startedAt, finishedAt: null, command: [], commands: [], hostProfile: await hostProfile(exec, root),
    requiredEnvironment, firstFailure: null, artifactSha256: {},
    runnerDigest: digest(await readFile(fileURLToPath(import.meta.url))),
    commandsDigest: digest(await readFile(new URL("./commands.mjs", import.meta.url))),
    commandProvenance: commandProvenance[check] ?? "Literal Automation argv", toolVersions: { node: process.version },
    ownerTickets: [],
    upload: { status: "BLOCKED", reasonCode: "artifact_missing", reason: "Local evidence has not been uploaded" } }
  const preflight = []
  if (!sha) {
    const parent = await exec(["jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id"], { cwd: root, env })
    result.candidateSha = parent.code === 0 ? parent.stdout.trim() : null
  }
  if (!/^[a-f0-9]{40}$/.test(result.candidateSha ?? "")) preflight.push(blocked("source_drift", "Full candidate SHA unavailable; use --sha <40 hex> or a jj parent"))
  let checkText = ""
  for (const [key, path] of [["specDigest", ".specs/engineering/spec.md"], ["checkDigest", `.specs/engineering/checks/${check}.md`]]) {
    try {
      const bytes = await readFile(join(root, path)); result[key] = digest(bytes)
      await writeFile(join(directory, key === "specDigest" ? "spec.md" : "check.md"), bytes, { flag: "wx" })
      if (key === "checkDigest") checkText = bytes.toString()
    } catch (error) {
      preflight.push(error.code === "ENOENT" && key === "checkDigest" ? absent(`Missing check file: ${path}`) : blocked("artifact_missing", `${error.code === "ENOENT" ? "Missing source" : "Unreadable source"}: ${path} (${error.code})`))
    }
  }
  const parsed = parseAutomation(checkText)
  result.ownerTickets = [...new Set(checkText.match(/T-[A-Z]+-\d{2}/g) ?? [])]
  let binding = bindings[check]
  if (subcases.length) {
    const selected = subcases.map((name) => binding?.subcases?.[name])
    if (selected.some((b) => !b)) preflight.push(absent(`Unbound subcase(s): ${subcases.filter((name) => !binding?.subcases?.[name]).join(", ")}`))
    binding = { files: selected.flatMap((b) => b?.files ?? []), commands: selected.flatMap((b) => b?.commands ?? []) }
  }
  const commands = binding?.commands ?? parsed.commands
  const files = [...new Set([...(binding?.files ?? parsed.files), ...commands.flatMap((c) => c.files ?? [])])]
  for (const file of files) {
    const path = resolve(root, file)
    if (relative(root, path).startsWith("..") || isAbsolute(file)) preflight.push(blocked("source_drift", `Automation path outside checkout: ${file}`))
    else if (!await exists(path)) preflight.push(absent(`Missing automation file: ${file}`))
  }
  if (binding?.unboundSubcases?.length) preflight.push(absent(`Unbound required subcases: ${binding.unboundSubcases.join(", ")}`))
  if (!commands.length) preflight.push(absent(parsed.problem ?? "No reviewed command binding"))
  if (binding?.behaviorAbsent) preflight.push(outcome("NOT IMPLEMENTED", "behavior_absent", binding.behaviorAbsent))
  const environment = [...new Set([...requiredEnvironment, ...(binding?.prerequisites ?? []), ...commands.flatMap((c) => c.prerequisites ?? [])])]
  // Missing automation takes precedence and must not launch a partial check.
  if (!preflight.length) {
    for (const name of environment) {
      const issue = await probe(name, { root, env, exec })
      if (issue) preflight.push({ ...issue, prerequisite: name })
    }
  }
  let decision
  const populations = []
  result.command = commands.map((c) => prepareCommand(c, env, directory).argv)
  if (preflight.length) {
    decision = worst(preflight); result.blockers = preflight
    await writeFile(join(directory, "preflight.log"), clean(preflight.map((p) => `${p.status} ${p.reasonCode}: ${p.reason}`).join("\n")) + "\n", { flag: "wx" })
  } else {
    const decisions = []
    for (const [index, item] of commands.entries()) {
      const command = prepareCommand(item, env, directory)
      if (!await executableAvailable(command.argv, command.environment, resolve(root, item.cwd ?? "."))) {
        const refusal = blocked("environment", `Missing executable: ${command.argv[0]}`)
        decisions.push(refusal)
        await writeFile(join(directory, `command-${index + 1}.admission.log`), `${refusal.reason}\n`, { flag: "wx" })
        continue
      }
      const heavy = ["go", "bun", "pnpm", "smthrs"].includes(command.argv[0])
      const budget = heavy ? await guard(root, command.reporter === "go" || command.prerequisites?.includes("build-budget")) : null
      if (budget) {
        decisions.push(budget)
        await writeFile(join(directory, `command-${index + 1}.admission.log`), `${clean(budget.reason)}\n`, { flag: "wx" })
        break
      }
      const launchArgv = ["nice", "-n", "10", ...command.argv]
      const run = await exec(launchArgv, { cwd: resolve(root, item.cwd ?? "."), env: command.environment, signal, timeoutMs: item.timeoutMs })
      await writeFile(join(directory, `command-${index + 1}.stdout.log`), clean(run.stdout), { flag: "wx" })
      await writeFile(join(directory, `command-${index + 1}.stderr.log`), clean(run.stderr), { flag: "wx" })
      const population = parsePopulation(command.reporter, run.stdout, run.stderr, command.argv)
      const status = classifyRun(run, population, command)
      if (population) populations.push(population)
      result.commands.push({ argv: command.argv, launchArgv, cwd: item.cwd ?? ".", reporter: command.reporter,
        environment: Object.fromEntries(["GOCACHE", "GOMAXPROCS", "GOFLAGS", "SMITHERS_REQUIRE_DATABASE_TESTS", "SMITHERS_REQUIRE_MICROVM_TESTS"].filter((k) => command.environment[k]).map((k) => [k, command.environment[k]])),
        expectedCaseIds: command.expectedCaseIds, exitCode: run.code, signal: run.signal, population, ...status })
      decisions.push(status)
      if (status.status !== "PASS" && !result.firstFailure) result.firstFailure = clean(population?.failures?.[0] ?? run.stderr.split("\n").find((s) => s.trim()) ?? status.reason)
    }
    decision = worst(decisions)
  }
  Object.assign(result, decision)
  if (populations.length) {
    result.expectedCases = populations.reduce((n, p) => n + p.expectedCases, 0)
    result.executedCases = populations.reduce((n, p) => n + p.executedCases, 0)
  }
  if (result.status !== "PASS" && !result.firstFailure) result.firstFailure = clean(result.reason)
  if (upload) {
    const auth = await exec(["gcloud", "auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], { cwd: root, env, timeoutMs: 10_000 })
    // An active cached account is not proof that its credential still works.
    // The access token is discarded immediately and is never saved or printed.
    const credential = auth.code === 0 && auth.stdout.trim() ? await exec(["gcloud", "auth", "print-access-token"], { cwd: root, env, timeoutMs: 10_000 }) : null
    result.upload = credential?.code === 0 && credential.stdout.trim() ? { status: "BLOCKED", reasonCode: "pending", reason: "Upload requested", durableUri: `gs://plue-prod-1771780303-check-evidence/checks/${check}/${utc}/` }
      : blocked("environment", "gcloud: no authenticated active account; upload not attempted")
  }
  result.finishedAt = now().toISOString()
  result.artifactSha256 = await artifactHashes(directory)
  await writeFile(join(directory, "result.json"), `${clean(JSON.stringify(result, null, 2))}\n`, { flag: "wx" })
  await seal(directory)
  // Upload has a separate receipt; finalized local evidence is never rewritten.
  // Authenticate before sealing, transfer only sealed payloads.
  let uploadResult = result.upload
  if (uploadResult.reasonCode === "pending") {
    const destination = `gs://plue-prod-1771780303-check-evidence/checks/${check}/`
    const copied = await exec(["gcloud", "storage", "cp", "-r", directory, destination], { cwd: root, env, timeoutMs: 60_000 })
    uploadResult = copied.code === 0 ? { ...outcome("PASS", "complete", result.upload.durableUri), durableUri: result.upload.durableUri } : blocked("artifact_missing", `gcloud: upload failed (${copied.error ?? copied.code})`)
  }
  const receipt = { directory, utc, result, upload: uploadResult }
  // This sibling is immutable and can prove a completed upload without changing
  // result.json or a single uploaded byte. Failed uploads retain their attempt.
  if (upload) {
    const path = `${directory}.upload.json`
    const bytes = `${JSON.stringify({ check, utc, resultDigest: digest(await readFile(join(directory, "result.json"))), ...uploadResult }, null, 2)}\n`
    await writeFile(path, bytes, { flag: "wx", mode: 0o444 })
    await writeFile(`${path}.sha256`, `${digest(bytes)}  ${utc}.upload.json\n`, { flag: "wx", mode: 0o444 })
  }
  return receipt
}

export function parseCli(argv) {
  const options = { subcases: [] }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--upload") options.upload = true
    else if (["--sha", "--evidence-root", "--subcase"].includes(arg)) {
      const value = argv[++index]
      if (!value || value.startsWith("--")) throw new Error(`Missing value: ${arg}`)
      if (arg === "--subcase") options.subcases.push(value)
      else options[arg === "--sha" ? "sha" : "evidenceRoot"] = value
    } else if (arg.startsWith("-") || options.check) throw new Error(`Unknown argument: ${arg}`)
    else options.check = arg
  }
  return options
}

export async function main(argv, { run = runCheck, print = console.log, printError = console.error } = {}) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once("SIGINT", abort); process.once("SIGTERM", abort)
  let exitCode
  try {
    const receipt = await run({ ...parseCli(argv), signal: controller.signal })
    print(`${receipt.result.check}: ${receipt.result.status} (${receipt.result.reasonCode}) ${receipt.result.reason}\n${receipt.directory}`)
    if (receipt.upload.status !== "PASS") print(`Durable evidence: ${receipt.upload.status} (${receipt.upload.reasonCode}) ${receipt.upload.reason}`)
    exitCode = receipt.result.status === "PASS" ? 0 : 1
  } catch (error) { printError(error.message); exitCode = 2 }
  finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort) }
  return exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
