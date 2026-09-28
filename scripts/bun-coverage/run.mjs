import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { prepare, verifyArtifacts } from "./manifest.mjs"
import { atomicJSON, collect, directories, receipt, report } from "./receipts.mjs"
import { preloadArguments } from "./children.mjs"

export async function runCoverage({ root, sources, run, command = "bun", args, cwd = root, timeout = 180_000, env = process.env }) {
  const prepared = prepare(root, sources)
  mkdirSync(run, { mode: 0o700 })
  directories(run)
  const runId = randomUUID(), id = randomUUID()
  const manifestPath = join(run, "manifest.json"), configuration = join(run, "configuration.json"), artifactPath = join(run, "instrumentation.json")
  atomicJSON(manifestPath, prepared.manifest)
  atomicJSON(artifactPath, prepared.artifacts)
  atomicJSON(configuration, { schema: 1, run, runId, manifestPath, artifactPath })
  const manifest = prepared.manifest.digest
  receipt(run, "expected", id, { id, runId, manifest, parent: null, mode: args[0] === "test" ? "test" : "run" })
  const preload = fileURLToPath(new URL("./preload.mjs", import.meta.url))
  const processGroup = process.platform !== "win32"
  const child = spawn(command, preloadArguments(args, preload), { cwd, detached: processGroup, stdio: ["ignore", "inherit", "inherit"], env: { ...env,
    SMITHERS_BUN_COVERAGE_CONFIG: configuration, SMITHERS_BUN_COVERAGE_NEXT_ID: id,
    SMITHERS_BUN_COVERAGE_MODE: args[0] === "test" ? "test" : "run" } })
  // Same POSIX containment used by run-jj-abi-campaign.mjs; no process-tree traversal.
  const terminate = () => {
    if (child.pid === undefined) return
    if (!processGroup) { child.kill("SIGKILL"); return }
    try { process.kill(-child.pid, "SIGKILL") }
    catch (error) { if (error.code !== "ESRCH") throw error }
  }
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; terminate() }, timeout)
  let status
  try {
    status = await new Promise((resolveExit, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolveExit({ code, signal }))
    })
  } finally { clearTimeout(timer) }
  receipt(run, "exits", id, { id, runId, manifest, ...status })
  if (timedOut) throw new Error("Bun coverage command timed out; child receipts are incomplete")
  try {
    verifyArtifacts(prepared.manifest, JSON.parse(readFileSync(artifactPath, "utf8")))
    const result = await collect(run, prepared, runId, id)
    report(result, join(run, "report"))
    return { ...result, status, runId }
  } catch (error) {
    // A refusing report must not leave ordinary descendants of the owned root
    // alive. Explicitly detached children require a separate lifetime owner.
    terminate()
    throw error
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { parseArgs } = await import("node:util")
  const { readFileSync } = await import("node:fs")
  const parsed = parseArgs({ allowPositionals: true, options: {
    root: { type: "string" }, roster: { type: "string" }, run: { type: "string" }
  } })
  if (!parsed.values.root || !parsed.values.roster || !parsed.values.run || !parsed.positionals.length) {
    throw new Error("Usage: node scripts/bun-coverage/run.mjs --root ROOT --roster JSON --run NEW_DIRECTORY -- test ...")
  }
  const result = await runCoverage({ root: resolve(parsed.values.root),
    sources: JSON.parse(readFileSync(parsed.values.roster, "utf8")), run: resolve(parsed.values.run), args: parsed.positionals })
  console.log(JSON.stringify(result.summary))
  process.exitCode = result.status.code ?? 1
}
