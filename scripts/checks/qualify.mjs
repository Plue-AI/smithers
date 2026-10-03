#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { allocate, digest, execute, ROOT, runCheck, seal, worst } from "./run-check.mjs"
import { thinObligations, thinSourcePaths } from "./thin.mjs"

export function gateVerdict(rows) {
  if (!rows.length) return { status: "FAIL", reasonCode: "oracle_violation", reason: "Empty obligation population", rejected: [] }
  const rejected = rows.flatMap((row) => {
    const nonPass = row.result.status !== "PASS" ? row.result : row.upload.status !== "PASS" ? row.upload : null
    return nonPass ? [{ id: row.id, check: row.result.check, ...nonPass, directory: row.directory }] : []
  })
  return { ...worst(rejected), rejected }
}

export async function qualify({ gate = "G-THIN", root = ROOT, sha, evidenceRoot = join(root, ".artifacts/checks"), upload = false,
  obligations = thinObligations, sourcePaths = thinSourcePaths, run = runCheck, exec = execute, now = () => new Date() } = {}) {
  if (gate !== "G-THIN") throw new Error(`Unknown gate: ${gate}`)
  if (!sha) {
    const parent = await exec(["jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id"], { cwd: root })
    sha = parent.code === 0 ? parent.stdout.trim() : undefined
  }
  const { directory, utc } = await allocate(resolve(evidenceRoot), gate, now)
  const startedAt = now().toISOString()
  const sourceDigests = {}, issues = []
  if (new Set(obligations.map((o) => o.id)).size !== obligations.length) issues.push({ id: gate, status: "BLOCKED", reasonCode: "source_drift", reason: "Duplicate obligation ids" })
  for (const path of sourcePaths) {
    try { sourceDigests[path] = digest(await readFile(join(root, path))) }
    catch { issues.push({ id: path, status: "BLOCKED", reasonCode: "artifact_missing", reason: `Missing manifest authority: ${path}` }) }
  }
  for (const obligation of obligations) {
    try {
      const ticket = await readFile(join(root, `.specs/engineering/tickets/${obligation.ownerTicket}.md`), "utf8")
      if (!ticket.includes(`issues/${obligation.ownerIssue})`)) issues.push({ id: obligation.id, status: "BLOCKED", reasonCode: "source_drift", reason: `${obligation.ownerTicket} issue differs from finite list` })
    } catch { issues.push({ id: obligation.id, status: "BLOCKED", reasonCode: "artifact_missing", reason: `Owner ticket missing: ${obligation.ownerTicket}` }) }
  }
  const manifest = { gate, obligations, sourceDigests }
  const denominatorDigest = digest(JSON.stringify(manifest))
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" })
  const rows = []
  // Sequential: one pinned candidate, no PostgreSQL port or machine-lease race.
  for (const obligation of obligations) {
    const receipt = await run({ check: obligation.check, subcases: obligation.subcases, requiredEnvironment: obligation.requiredEnvironment,
      root, sha, evidenceRoot, upload })
    if (receipt.result.candidateSha !== sha) issues.push({ id: obligation.id, status: "BLOCKED", reasonCode: "source_drift", reason: "Attempt candidate differs from pinned gate candidate" })
    rows.push({ id: obligation.id, ownerTicket: obligation.ownerTicket, ownerIssue: obligation.ownerIssue, ...receipt })
  }
  for (const [path, expected] of Object.entries(sourceDigests)) {
    try {
      if (digest(await readFile(join(root, path))) !== expected) issues.push({ id: path, status: "BLOCKED", reasonCode: "source_drift", reason: `Authority changed during qualification: ${path}` })
    } catch { issues.push({ id: path, status: "BLOCKED", reasonCode: "source_drift", reason: `Authority disappeared during qualification: ${path}` }) }
  }
  const verdict = gateVerdict(rows)
  const rejected = [...verdict.rejected, ...issues]
  const result = { gate, candidateSha: sha ?? null, denominatorDigest, sourceDigests,
    generatorDigest: digest(await readFile(fileURLToPath(import.meta.url))),
    manifestGeneratorDigest: digest(await readFile(new URL("./thin.mjs", import.meta.url))),
    startedAt, finishedAt: now().toISOString(), expectedObligations: obligations.length, executedObligations: rows.length,
    counts: Object.fromEntries(["PASS", "FAIL", "BLOCKED", "SKIPPED", "NOT IMPLEMENTED"].map((status) => [status, rows.filter((r) => r.result.status === status).length])),
    ...verdict, ...(issues.length ? worst(rejected) : {}), rejected,
    attempts: rows.map((r) => ({ id: r.id, ownerTicket: r.ownerTicket, directory: r.directory, status: r.result.status,
      reasonCode: r.result.reasonCode, reason: r.result.reason, upload: r.upload })) }
  await writeFile(join(directory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" })
  const output = [`${gate}: ${result.status} (${result.reasonCode})`, `Candidate: ${result.candidateSha ?? "unavailable"}`,
    `Obligations: ${rows.length}/${obligations.length}; denominator sha256 ${denominatorDigest}`,
    ...rejected.map((r) => `${r.id} ${r.check ?? ""}: ${r.status} (${r.reasonCode}) ${r.reason}`), `Evidence: ${directory}`].join("\n")
  await writeFile(join(directory, "qualification.log"), `${output}\n`, { flag: "wx" })
  await seal(directory)
  return { directory, utc, result, output }
}

export async function main(argv, { run = qualify, print = console.log, printError = console.error } = {}) {
  try {
    const options = {}
    const args = argv
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--upload") options.upload = true
      else if (["--gate", "--sha", "--evidence-root"].includes(args[i])) {
        const key = args[i] === "--evidence-root" ? "evidenceRoot" : args[i].slice(2)
        if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing value: ${args[i]}`)
        options[key] = args[++i]
      } else throw new Error(`Unknown argument: ${args[i]}`)
    }
    if (!options.gate) throw new Error("Usage: qualify.mjs --gate G-THIN [--sha <sha>]")
    const receipt = await run(options)
    print(receipt.output)
    return receipt.result.status === "PASS" ? 0 : 1
  } catch (error) { printError(error.message); return 2 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
