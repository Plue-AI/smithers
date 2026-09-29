#!/usr/bin/env node
/**
 * W4 package-API sweep harness over the force PACKAGE.ts workspace.
 *
 * Two subcommands:
 *
 *   graph <workspace>   Read-only. Runs `graph '//...'` through the smthrs
 *                       CLI against the workspace, asserts zero load errors
 *                       and exact label-set equality with the expectations
 *                       file. Safe to run against the live checkout.
 *
 *   run <workspace>     Executes each expected label in the workspace and
 *                       classifies the outcome against its expectation row.
 *                       Point this ONLY at a disposable clone (the e2e
 *                       clone); mutating targets are reset with git between
 *                       runs. Default pass runs the executes-green and
 *                       typed-refusal classes; add --heavy and/or --services
 *                       to include those classes.
 *
 * Options:
 *   --expectations <path>  expectations JSON (default: the frozen file in
 *                          this package's test/fixtures/)
 *   --cli <path>           smthrs entry module (default: this package's
 *                          src/main.js)
 *   --invoke "<template>"  execution argv template; "{label}" is replaced
 *                          (default: "run {label}"). Bind this to whatever
 *                          execution surface W2 ships (e.g. "{label}" if a
 *                          bare label becomes a command).
 *   --only <label>         run a single label (repeatable)
 *   --heavy                include class "heavy"
 *   --services             include class "service"
 *   --json <path>          write the machine-readable report (default:
 *                          package-api-sweep-report.json in the cwd)
 *   --timeout <seconds>    per-target ceiling for the cheap classes
 *                          (default 300; heavy uses 6x, services use the
 *                          readiness window + grace)
 *   --no-reset             skip git resets (debugging only)
 *
 * Exit code: 0 only when every selected row passes (alternates count as
 * passes but are listed separately); 1 on any mismatch, load error, or
 * label-set drift.
 *
 * INTERFACES THE INTEGRATOR MUST BIND (documented, not guessed):
 * 1. Execution surface: the argv template above. This lane does not invent
 *    W2's verb routing; `run {label}` is the placeholder default.
 * 2. Refusal message contract: a typed refusal's message must contain the
 *    discriminating substring recorded in the expectations row — the host
 *    bin name, the secret name, "approval", "payload", "memory", or the
 *    script's own precondition text. `refusalRecognizers` below additionally
 *    tags well-known shapes; recognizers CONFIRM, substrings DECIDE.
 * 3. Service readiness: a Serve target run standalone must emit a line
 *    matching /ready|listening|healthy|serving/i when readiness passes, and
 *    exit on SIGTERM within its declared grace.
 */

import { spawn } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDirectory = NodePath.dirname(fileURLToPath(import.meta.url))

/** Default locations relative to this script's repository. */
export const defaults = {
  expectations: NodePath.resolve(
    scriptDirectory,
    "../test/fixtures/sweep-expectations.json"
  ),
  cli: NodePath.resolve(scriptDirectory, "../src/main.js"),
  invoke: "run {label}",
  timeoutSeconds: 300,
  report: NodePath.resolve(process.cwd(), "package-api-sweep-report.json")
}

export const classes = ["executes-green", "typed-refusal", "heavy", "service"]
export const refusalCodes = [
  "host-bin-absent",
  "missing-secret",
  "approval-required",
  "needs-input",
  "memory-unavailable",
  "script-precondition"
]

/**
 * Secondary confirmation patterns for typed refusal shapes. The expectation
 * row's substring is the binding check; a recognizer hit is recorded in the
 * report so the integrator can see which typed shape actually fired.
 */
export const refusalRecognizers = {
  "host-bin-absent": /host[ ._-]?bin|not found on PATH|no such (host )?binary|host binary/i,
  "missing-secret": /missing[ _-]?secret|secret[^\n]{0,80}\b(unset|missing|not set|undefined)\b/i,
  "approval-required": /approval[ _-]?required|requires approval/i,
  "needs-input": /needs[ _-]?input|missing[ _-]?payload|payload[^\n]{0,40}\b(required|missing)\b/i,
  "memory-unavailable": /memory[ _-]?unavailable|smithers cloud[^\n]{0,40}\b(unreachable|unavailable|unconfigured)\b/i
}

const notImplementedPattern = /NotImplemented/
const readinessPattern = /ready|listening|healthy|serving/i

/** Loads and structurally validates the expectations file. Throws on defects. */
export const loadExpectations = async (path) => {
  const parsed = JSON.parse(await Fs.readFile(path, "utf8"))
  const problems = validateExpectations(parsed)
  if (problems.length > 0) {
    throw new Error(`invalid expectations file ${path}:\n  ${problems.join("\n  ")}`)
  }
  return parsed
}

/** Structural validation, exported so the vitest suite runs it too. */
export const validateExpectations = (parsed) => {
  const problems = []
  if (typeof parsed !== "object" || parsed === null || typeof parsed.labels !== "object") {
    return ["expectations must be an object with a labels map"]
  }
  const validateOutcome = (label, expect, refusal, where) => {
    if (!["green", "refusal", "red", "ready"].includes(expect)) {
      problems.push(`${label}: ${where} has unknown expect ${JSON.stringify(expect)}`)
      return
    }
    if (expect === "refusal") {
      if (refusal === undefined) problems.push(`${label}: ${where} expects refusal without a refusal object`)
      else {
        if (!refusalCodes.includes(refusal.code)) {
          problems.push(`${label}: ${where} has unknown refusal code ${JSON.stringify(refusal.code)}`)
        }
        if (typeof refusal.substring !== "string" || refusal.substring.length === 0) {
          problems.push(`${label}: ${where} refusal needs a non-empty substring`)
        }
      }
    } else if (refusal !== undefined) {
      problems.push(`${label}: ${where} carries a refusal object but does not expect refusal`)
    }
  }
  for (const [label, row] of Object.entries(parsed.labels)) {
    if (!/^\/\/[^:]*:[^:]+$/.test(label)) problems.push(`${label}: not an exact //package:target label`)
    if (!classes.includes(row.class)) {
      problems.push(`${label}: unknown class ${JSON.stringify(row.class)}`)
      continue
    }
    validateOutcome(label, expectedOutcome(row), row.refusal, "primary")
    for (const [index, alternate] of (row.alternates ?? []).entries()) {
      validateOutcome(label, alternate.expect, alternate.refusal, `alternates[${index}]`)
    }
  }
  return problems
}

/** The primary expected outcome a row implies. */
export const expectedOutcome = (row) => {
  if (row.expect !== undefined) return row.expect
  if (row.class === "executes-green") return "green"
  if (row.class === "typed-refusal") return "refusal"
  if (row.class === "heavy") return "green"
  return "ready"
}

/** Parses the JSON body a `--format json` CLI invocation printed. */
export const parseCliJson = (stdoutText) => {
  const start = stdoutText.indexOf("{")
  if (start < 0) throw new Error(`CLI printed no JSON object:\n${stdoutText.slice(0, 2000)}`)
  return JSON.parse(stdoutText.slice(start))
}

/** Set difference report between expected and observed label lists. */
export const compareLabelSets = (expected, actual) => {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  return {
    missing: [...expectedSet].filter((label) => !actualSet.has(label)).sort(),
    extra: [...actualSet].filter((label) => !expectedSet.has(label)).sort(),
    equal: expectedSet.size === actualSet.size && [...expectedSet].every((label) => actualSet.has(label))
  }
}

/**
 * Classifies one finished CLI invocation. Pure: everything observed comes in
 * as data, so the vitest suite drives it with stubbed outputs.
 */
export const classifyOutcome = ({ exitCode, signal, stdout, stderr, timedOut = false, sawReadiness = false }) => {
  const output = `${stdout}\n${stderr}`
  const detectedCodes = Object.entries(refusalRecognizers)
    .filter(([, pattern]) => pattern.test(output))
    .map(([code]) => code)
  if (notImplementedPattern.test(output) && exitCode !== 0) {
    return { outcome: "not-implemented", detectedCodes }
  }
  if (timedOut) return { outcome: sawReadiness ? "failed" : "timeout", detectedCodes }
  if (sawReadiness && (exitCode === 0 || signal === "SIGTERM")) return { outcome: "ready", detectedCodes }
  if (exitCode === 0) return { outcome: "green", detectedCodes }
  return { outcome: "failed", detectedCodes }
}

/** Whether one observed run satisfies one expected outcome shape. */
const satisfies = (expect, refusal, observed) => {
  if (expect === "green") return observed.classified.outcome === "green"
  if (expect === "ready") return observed.classified.outcome === "ready"
  if (expect === "red") {
    return observed.classified.outcome === "failed"
  }
  // refusal: nonzero exit and the discriminating substring in the output.
  return (
    observed.classified.outcome === "failed" &&
    `${observed.stdout}\n${observed.stderr}`.includes(refusal.substring)
  )
}

/**
 * Final verdict for one row: "pass" on the primary expectation, "alternate"
 * on a declared alternate, otherwise "mismatch". A NotImplemented refusal is
 * always a mismatch — the sweep is honest that execution has not landed.
 */
export const verdictFor = (row, observed) => {
  if (observed.classified.outcome === "not-implemented") {
    return { verdict: "mismatch", reason: "CLI refused with NotImplemented: execution surface not landed" }
  }
  if (satisfies(expectedOutcome(row), row.refusal, observed)) return { verdict: "pass" }
  for (const [index, alternate] of (row.alternates ?? []).entries()) {
    if (satisfies(alternate.expect, alternate.refusal, observed)) {
      return { verdict: "alternate", alternateIndex: index, reason: alternate.notes ?? "declared alternate outcome" }
    }
  }
  return {
    verdict: "mismatch",
    reason:
      `expected ${expectedOutcome(row)}` +
      (row.refusal ? ` containing ${JSON.stringify(row.refusal.substring)}` : "") +
      `, observed ${observed.classified.outcome} (exit ${observed.exitCode})`
  }
}

/** Rows selected for one `run` invocation, in a stable cheap-first order. */
export const selectRows = (expectations, { heavy = false, services = false, only = [] } = {}) => {
  const wanted = new Set(["executes-green", "typed-refusal"])
  if (heavy) wanted.add("heavy")
  if (services) wanted.add("service")
  const rank = { "typed-refusal": 0, "executes-green": 1, "heavy": 2, "service": 3 }
  return Object.entries(expectations.labels)
    .filter(([label, row]) => (only.length > 0 ? only.includes(label) : wanted.has(row.class)))
    .sort((left, right) => rank[left[1].class] - rank[right[1].class] || (left[0] < right[0] ? -1 : 1))
    .map(([label, row]) => ({ label, row }))
}

/** The git argv pairs that restore a mutated e2e clone between targets. */
export const resetCommands = (workspace) => [
  ["git", ["-C", workspace, "checkout", "--", "."]],
  [
    "git",
    [
      "-C",
      workspace,
      "clean",
      "-fd",
      "-e",
      "node_modules",
      "-e",
      ".flows",
      "-e",
      ".env.shared",
      "-e",
      ".yalc"
    ]
  ]
]

/** Spawns one process and resolves with its full observation. */
const observe = (bin, args, { cwd, timeoutMs, service = false, graceMs = 15_000 }) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let sawReadiness = false
    const finishService = () => {
      // Readiness reached: ask the service to stop and judge the shutdown.
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), graceMs).unref()
    }
    const watch = (chunk, sink) => {
      const text = chunk.toString()
      if (sink === "out") stdout += text
      else stderr += text
      if (service && !sawReadiness && readinessPattern.test(text)) {
        sawReadiness = true
        finishService()
      }
    }
    child.stdout.on("data", (chunk) => watch(chunk, "out"))
    child.stderr.on("data", (chunk) => watch(chunk, "err"))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 5000).unref()
    }, timeoutMs)
    child.on("error", (cause) => {
      clearTimeout(timer)
      reject(cause)
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        timedOut,
        sawReadiness
      })
    })
  })

const runGit = async (workspace, [bin, args]) => {
  const result = await observe(bin, args, { cwd: workspace, timeoutMs: 120_000 })
  if (result.exitCode !== 0) {
    throw new Error(`reset failed: ${bin} ${args.join(" ")}\n${result.stderr}`)
  }
}

/** Part (1): graph the workspace read-only and diff the label universe. */
export const graphCheck = async ({ workspace, cli, expectationsPath }) => {
  const expectations = await loadExpectations(expectationsPath)
  const observed = await observe(
    process.execPath,
    [cli, "graph", "//...", "--format", "json", "-w", workspace],
    { cwd: workspace, timeoutMs: 300_000 }
  )
  const report = {
    kind: "graph-check",
    workspace,
    exitCode: observed.exitCode,
    ok: false,
    loadErrors: [],
    labels: { missing: [], extra: [] },
    warnings: []
  }
  if (observed.timedOut) {
    report.loadErrors.push("graph '//...' timed out")
    return report
  }
  if (observed.exitCode !== 0) {
    report.loadErrors.push(observed.stderr.trim() || observed.stdout.trim() || "graph exited nonzero")
    return report
  }
  let parsed
  try {
    parsed = parseCliJson(observed.stdout)
  } catch (cause) {
    report.loadErrors.push(String(cause instanceof Error ? cause.message : cause))
    return report
  }
  report.warnings = parsed.warnings ?? []
  const actual = (parsed.roots ?? parsed.targets?.map((target) => target.label) ?? []).slice().sort()
  const comparison = compareLabelSets(Object.keys(expectations.labels).sort(), actual)
  report.labels = { missing: comparison.missing, extra: comparison.extra }
  report.labelCount = actual.length
  report.edgeCount = Array.isArray(parsed.edges) ? parsed.edges.length : undefined
  report.ok = comparison.equal && report.warnings.length === 0
  return report
}

/** Part (2): execute selected labels in a disposable clone and classify. */
export const runSweep = async ({
  workspace,
  cli,
  expectationsPath,
  invoke,
  heavy,
  services,
  only,
  timeoutSeconds,
  reset = true
}) => {
  const expectations = await loadExpectations(expectationsPath)
  const rows = selectRows(expectations, { heavy, services, only })
  const results = []
  for (const { label, row } of rows) {
    const args = invoke
      .split(" ")
      .filter((token) => token.length > 0)
      .map((token) => token.replaceAll("{label}", label))
    const timeoutMs =
      1000 * timeoutSeconds * (row.class === "heavy" ? 6 : 1) + (row.class === "service" ? 120_000 : 0)
    const startedAt = Date.now()
    const observed = await observe(process.execPath, [cli, ...args, "--format", "json"], {
      cwd: workspace,
      timeoutMs,
      service: row.class === "service"
    })
    const classified = classifyOutcome(observed)
    const judged = verdictFor(row, { ...observed, classified })
    results.push({
      label,
      class: row.class,
      expected: { outcome: expectedOutcome(row), refusal: row.refusal },
      observed: {
        exitCode: observed.exitCode,
        signal: observed.signal,
        outcome: classified.outcome,
        detectedCodes: classified.detectedCodes,
        timedOut: observed.timedOut,
        durationMs: Date.now() - startedAt,
        outputTail: `${observed.stdout}\n${observed.stderr}`.slice(-2000)
      },
      ...judged
    })
    if (reset && (row.mutates === true || (row.class !== "typed-refusal" && classified.outcome !== "green"))) {
      for (const command of resetCommands(workspace)) await runGit(workspace, command)
    }
  }
  const counts = {
    pass: results.filter((result) => result.verdict === "pass").length,
    alternate: results.filter((result) => result.verdict === "alternate").length,
    mismatch: results.filter((result) => result.verdict === "mismatch").length
  }
  const skipped = Object.entries(expectations.labels)
    .filter(([label]) => !results.some((result) => result.label === label))
    .map(([label, row]) => ({ label, class: row.class }))
  return {
    kind: "sweep",
    workspace,
    invoke,
    selected: rows.length,
    counts,
    ok: counts.mismatch === 0 && results.length > 0,
    results,
    skipped
  }
}

/** Renders the human summary of either report kind. */
export const summarize = (report) => {
  const lines = []
  if (report.kind === "graph-check") {
    lines.push(`graph-check ${report.ok ? "PASS" : "FAIL"} — ${report.workspace}`)
    if (report.labelCount !== undefined) {
      lines.push(`  labels: ${report.labelCount}` + (report.edgeCount === undefined ? "" : `, edges: ${report.edgeCount}`))
    }
    for (const problem of report.loadErrors) lines.push(`  load error: ${problem}`)
    for (const warning of report.warnings) lines.push(`  warning: ${JSON.stringify(warning)}`)
    for (const label of report.labels.missing) lines.push(`  missing (expected, not in graph): ${label}`)
    for (const label of report.labels.extra) lines.push(`  extra (in graph, unexpected): ${label}`)
    return lines.join("\n")
  }
  lines.push(
    `sweep ${report.ok ? "PASS" : "FAIL"} — ${report.counts.pass} pass, ${report.counts.alternate} alternate, ` +
      `${report.counts.mismatch} mismatch, ${report.skipped.length} skipped (of ${report.results.length + report.skipped.length} expected labels)`
  )
  for (const result of report.results) {
    if (result.verdict === "mismatch") {
      lines.push(`  MISMATCH ${result.label} [${result.class}]: ${result.reason}`)
    } else if (result.verdict === "alternate") {
      lines.push(`  alternate ${result.label} [${result.class}]: ${result.reason}`)
    }
  }
  const byClass = {}
  for (const row of report.skipped) byClass[row.class] = (byClass[row.class] ?? 0) + 1
  for (const [kind, count] of Object.entries(byClass)) {
    lines.push(`  skipped ${count} ${kind} target(s) — enable with ${kind === "heavy" ? "--heavy" : kind === "service" ? "--services" : "--only"}`)
  }
  return lines.join("\n")
}

const parseArguments = (argv) => {
  const [command, workspace, ...rest] = argv
  const options = {
    command,
    workspace,
    expectationsPath: defaults.expectations,
    cli: defaults.cli,
    invoke: defaults.invoke,
    timeoutSeconds: defaults.timeoutSeconds,
    report: defaults.report,
    heavy: false,
    services: false,
    reset: true,
    only: []
  }
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    const next = () => {
      index += 1
      if (rest[index] === undefined) throw new Error(`${flag} needs a value`)
      return rest[index]
    }
    if (flag === "--expectations") options.expectationsPath = NodePath.resolve(next())
    else if (flag === "--cli") options.cli = NodePath.resolve(next())
    else if (flag === "--invoke") options.invoke = next()
    else if (flag === "--only") options.only.push(next())
    else if (flag === "--json") options.report = NodePath.resolve(next())
    else if (flag === "--timeout") options.timeoutSeconds = Number(next())
    else if (flag === "--heavy") options.heavy = true
    else if (flag === "--services") options.services = true
    else if (flag === "--no-reset") options.reset = false
    else throw new Error(`unknown flag ${flag}`)
  }
  if (!["graph", "run"].includes(options.command ?? "")) {
    throw new Error("usage: package-api-sweep.mjs <graph|run> <workspacePath> [flags]")
  }
  if (options.workspace === undefined) throw new Error("workspace path is required")
  options.workspace = NodePath.resolve(options.workspace)
  return options
}

const main = async () => {
  const options = parseArguments(process.argv.slice(2))
  const report =
    options.command === "graph"
      ? await graphCheck(options)
      : await runSweep(options)
  await Fs.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log(summarize(report))
  console.log(`report: ${options.report}`)
  process.exitCode = report.ok ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : cause)
    process.exitCode = 1
  })
}
