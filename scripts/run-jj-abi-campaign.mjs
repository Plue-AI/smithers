/** Required native + real WASM ABI campaign, bypassing build-result reuse. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { isMain, repoRoot as root } from "./workspace-packages.mjs"

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const fileHash = (text) => createHash("blake2b512").update(text).digest("hex").slice(0, 10)
export const expectedDiff = (before) => `diff --git a/generated.txt b/generated.txt\nindex ${fileHash(before)}..${fileHash(`${before}changed\n`)} 100644\n--- a/generated.txt\n+++ b/generated.txt\n@@ -1,1 +1,2 @@\n ${before}+changed\n`
export const campaignConfiguration = (env = process.env) => {
  const integer = (name, fallback, maximum, minimum = 1) => {
    const value = env[name] ?? String(fallback)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${name} is outside its integer range`)
    return Number(value)
  }
  return {
    seed: integer("SMITHERS_ABI_SEED", 20260904, 0xffffffff, 0),
    cases: integer("SMITHERS_ABI_CASES", 5000, 100000),
    steps: integer("SMITHERS_ABI_STEPS", 32, 256)
  }
}

export const verifyParser = (report, configuration) => {
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.tier, "parser")
  assert.equal(report.status, "passed")
  assert.equal(report.seed, configuration.seed)
  assert.equal(report.requestedCases, configuration.cases)
  assert.equal(report.executedRawCases, configuration.cases)
  assert.equal(report.executedGrammarCases, configuration.cases)
}

export const verifyCampaign = (native, wasm, configuration, wasmSha256) => {
  const unicodeLength = Buffer.byteLength('{"op":"snapshot","root":"/repo","message":"文件🚀"}')
  for (const [tier, report] of [["native", native], ["wasm", wasm]]) {
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.tier, tier)
    assert.equal(report.status, "passed")
    assert.equal(report.seed, configuration.seed)
    assert.equal(report.requestedCases, configuration.cases)
    assert.equal(report.executedCases, configuration.cases)
    assert.equal(report.requestedSteps, configuration.steps)
    assert.equal(report.executedSteps, configuration.steps)
    assert.equal(report.requests.length, configuration.cases)
    assert.equal(report.operations.length, configuration.steps)
    assert.equal(report.healthChecks, configuration.cases + (tier === "wasm" ? 8 + unicodeLength + 4 * configuration.steps : 0))
    for (const [index, request] of report.requests.entries()) {
      assert.equal(request.index, index)
      assert.match(request.inputHex, /^(?:[a-f0-9]{2})*$/)
      assert.deepEqual(Object.keys(request.response), ["err"])
      assert.deepEqual(Object.keys(request.response.err).sort(), ["code", "command", "message"])
      assert.equal(request.response.err.code, "unknown")
      assert.equal(request.response.err.command, "jj")
      assert.match(request.response.err.message, /^jj: malformed request:/)
    }
    let state = configuration.seed
    for (const [index, operation] of report.operations.entries()) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      const before = `seed ${configuration.seed} step ${index} value ${state}\n`
      assert.equal(operation.index, index)
      for (const snapshot of [operation.first, operation.second]) {
        assert.deepEqual(Object.keys(snapshot), ["ok"])
        assert.deepEqual(Object.keys(snapshot.ok).sort(), ["changeId", "commitId", "operationId"])
        assert.match(snapshot.ok.changeId, /^[k-z]{12}$/)
        assert.match(snapshot.ok.commitId, /^[0-9a-f]{128}$/)
        assert.match(snapshot.ok.operationId, /^[0-9a-f]{128}$/)
      }
      assert.equal(operation.first.ok.changeId, operation.second.ok.changeId)
      assert.notEqual(operation.first.ok.commitId, operation.second.ok.commitId)
      assert.notEqual(operation.first.ok.operationId, operation.second.ok.operationId)
      assert.deepEqual(operation.diff, { ok: { diff: expectedDiff(before) } })
      assert.deepEqual(operation.failure, { err: { code: "invalid_ref", command: "jj restore --from kkkkkkkkkkkk", message: 'revision "kkkkkkkkkkkk" doesn\'t exist' } })
      assert.deepEqual(operation.restore, { ok: {} })
      assert.deepEqual(operation.health, { ok: { diff: "" } })
      assert.equal(operation.restoredText, before)
      assert.deepEqual(operation.revisits, Array.from({ length: 3 }, (_, turn) => {
        const target = ((configuration.seed + index) >>> turn) & 1
        return { target, response: { ok: {} }, restoredText: target === 0 ? before : `${before}changed\n`, health: { ok: { diff: "" } } }
      }))
    }
  }
  const corpus = native.requests.map((entry) => entry.inputHex)
  // Parser failures have no host-dependent paths: require the complete decoded
  // response, not only a shared error category, to agree across both runtimes.
  assert.deepEqual(wasm.requests, native.requests)
  const corpusSha256 = digest(corpus.join("\n"))
  assert.equal(wasm.corpusSha256, corpusSha256)
  assert.equal(wasm.wasmSha256, wasmSha256)
  assert.equal(wasm.liveAllocations, 0)
  assert.equal(wasm.openHostFiles, 0)
  assert.equal(wasm.allocations, wasm.frees)
  assert.ok(wasm.allocations > 2 * configuration.cases)
  assert.ok(wasm.exchanges > configuration.cases)
  assert.ok(wasm.initialMemoryBytes > 0)
  assert.ok(wasm.currentMemoryBytes > wasm.initialMemoryBytes)
  assert.ok(wasm.peakMemoryBytes >= wasm.currentMemoryBytes)
  assert.ok(wasm.peakMemoryBytes <= wasm.initialMemoryBytes + 16 * 1024 * 1024)
  assert.ok(wasm.peakLiveBytes >= 1024 * 1024 + 1)
  assert.equal(wasm.boundaryLengths.length, 3)
  assert.equal(wasm.boundaryLengths[0] + 1, wasm.boundaryLengths[1])
  assert.equal(wasm.boundaryLengths[1] + 1, wasm.boundaryLengths[2])
  assert.deepEqual(wasm.truncatedLengths, Array.from({ length: unicodeLength }, (_, index) => index))
  assert.deepEqual(wasm.rejectedAllocations, [0x80000000, 0xffffffff])
  assert.equal(wasm.growthFailures, 1)
  return { corpusSha256, wasmSha256 }
}

const run = (command, args, cwd, env, logPath, signal) => new Promise((resolveRun, reject) => {
  signal.throwIfAborted()
  const log = createWriteStream(logPath, { flags: "wx" })
  const grouped = process.platform !== "win32"
  const child = spawn(command, args, { cwd, env, detached: grouped, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  let failure
  const stop = () => {
    if (child.pid === undefined) return
    try { process.kill(grouped ? -child.pid : child.pid, "SIGKILL") }
    catch (error) { if (error.code !== "ESRCH") failure ??= error }
  }
  const timer = setTimeout(() => { failure ??= new Error(`${command} exceeded 20 minutes`); stop() }, 20 * 60 * 1000)
  const aborted = () => { failure ??= signal.reason; stop() }
  signal.addEventListener("abort", aborted, { once: true })
  if (signal.aborted) aborted()
  child.once("error", (error) => { failure ??= error })
  log.once("error", (error) => { failure ??= error; stop() })
  child.once("close", (code) => {
    clearTimeout(timer)
    signal.removeEventListener("abort", aborted)
    // A tier may have forked a worker that closed its inherited stdio early.
    // Retire the owned process group on every completion, including success.
    if (grouped) stop()
    log.end((error) => {
      failure ??= error
      if (failure) reject(failure)
      else if (code === 0) resolveRun()
      else reject(new Error(`${command} failed with ${code}; see ${logPath}`))
    })
  })
})

export const runCampaign = async (configuration = campaignConfiguration(), artifactDirectory = process.env.SMITHERS_ABI_ARTIFACT_DIR) => {
  const directory = artifactDirectory === undefined ? await mkdtemp(join(tmpdir(), "smithers-jj-abi-campaign-")) : resolve(artifactDirectory)
  await mkdir(directory, { recursive: true })
  for (const filename of ["parser.json", "native.json", "wasm.json", "campaign.json", "parser.log", "native.log", "wasm.log"]) {
    try { await access(join(directory, filename)); throw new Error(`Refusing to overwrite existing campaign evidence: ${filename}`) }
    catch (error) { if (error.code !== "ENOENT") throw error }
  }
  const report = { schemaVersion: 1, status: "running", ...configuration, artifactDirectory: directory, runtime: process.version }
  const reportPath = join(directory, "campaign.json")
  const controller = new AbortController()
  const interrupted = (signal) => {
    if (!controller.signal.aborted) controller.abort(Object.assign(new Error(`ABI campaign interrupted by ${signal}`), { code: "campaign_interrupted", signal }))
  }
  const sigint = () => interrupted("SIGINT")
  const sigterm = () => interrupted("SIGTERM")
  process.on("SIGINT", sigint)
  process.on("SIGTERM", sigterm)
  let failure
  let receiptCreated = false
  const recordFailure = (error) => {
    failure ??= error
    Object.assign(report, { status: failure.code === "campaign_interrupted" ? "interrupted" : "failed", error: String(failure), ...(failure.code === "campaign_interrupted" ? { signal: failure.signal } : {}) })
  }
  try {
    await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx" })
    receiptCreated = true
    console.log(`ABI campaign ${JSON.stringify(report)}`)
    controller.signal.throwIfAborted()
    const wasmPath = join(root, "packages/smithers/flows/jj/wasm/flows_jj.wasm")
    const wasmSha256 = digest(await readFile(wasmPath))
    const env = {
      ...process.env,
      CARGO_BUILD_JOBS: "1",
      SMITHERS_ABI_SEED: String(configuration.seed),
      SMITHERS_ABI_CASES: String(configuration.cases),
      SMITHERS_ABI_STEPS: String(configuration.steps),
      SMITHERS_ABI_ARTIFACT_DIR: directory,
      SMITHERS_ABI_NATIVE_REPORT: join(directory, "native.json")
    }
    await run("cargo", ["test", "-p", "flows-jj", "--locked", "--test", "test_abi_parser", "--", "--nocapture"], root, env, join(directory, "parser.log"), controller.signal)
    const parserBytes = await readFile(join(directory, "parser.json"))
    verifyParser(JSON.parse(parserBytes), configuration)
    assert.match(await readFile(join(directory, "parser.log"), "utf8"), new RegExp(`ABI_CAMPAIGN_PARSER seed=${configuration.seed} raw=${configuration.cases} grammar=${configuration.cases}`))
    await run("cargo", ["test", "-p", "flows-jj", "--locked", "--test", "test_abi_generated", "--", "--nocapture"], root, env, join(directory, "native.log"), controller.signal)
    assert.match(await readFile(join(directory, "native.log"), "utf8"), new RegExp(`ABI_CAMPAIGN_NATIVE seed=${configuration.seed} cases=${configuration.cases} steps=${configuration.steps}`))
    await run("pnpm", ["exec", "vitest", "run", "test/AbiGenerated.test.ts", "--maxWorkers=1", "--coverage.enabled=false"], join(root, "packages/smithers/flows/jj"), env, join(directory, "wasm.log"), controller.signal)
    const nativeBytes = await readFile(join(directory, "native.json"))
    const wasmBytes = await readFile(join(directory, "wasm.json"))
    const evidence = verifyCampaign(JSON.parse(nativeBytes), JSON.parse(wasmBytes), configuration, wasmSha256)
    controller.signal.throwIfAborted()
    Object.assign(report, evidence, { status: "passed", parserEvidenceSha256: digest(parserBytes), nativeEvidenceSha256: digest(nativeBytes), wasmEvidenceSha256: digest(wasmBytes) })
  } catch (error) {
    recordFailure(error)
  } finally {
    try {
      if (controller.signal.aborted) recordFailure(controller.signal.reason)
      if (receiptCreated) await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n")
      // Signals can also arrive while the final filesystem write is pending.
      if (controller.signal.aborted && failure === undefined) {
        recordFailure(controller.signal.reason)
        if (receiptCreated) await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n")
      }
    }
    catch (error) { failure ??= error }
    finally {
      process.off("SIGINT", sigint)
      process.off("SIGTERM", sigterm)
      console.log(JSON.stringify(report))
    }
  }
  if (failure !== undefined) throw failure
  return report
}

if (isMain(import.meta)) {
  try { await runCampaign() }
  catch (error) {
    console.error(error)
    process.exitCode = error.code === "campaign_interrupted" ? error.signal === "SIGINT" ? 130 : 143 : 1
  }
}
