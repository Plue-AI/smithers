import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream, watch } from "node:fs"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { runInNewContext } from "node:vm"
import { campaignConfiguration, expectedDiff, runCampaign, verifyCampaign, verifyParser } from "./run-jj-abi-campaign.mjs"

const configuration = { seed: 0, cases: 1, steps: 1 }

// The executable derives its root from this helper. Copy both so these
// process tests reach the isolated campaign rather than failing at import.
const copyCampaign = async (root) => {
  await mkdir(join(root, "scripts"))
  for (const file of ["run-jj-abi-campaign.mjs", "workspace-packages.mjs"]) {
    await copyFile(new URL(file, import.meta.url), join(root, "scripts", file))
  }
  return join(root, "scripts", "run-jj-abi-campaign.mjs")
}

const fixture = () => {
  const before = "seed 0 step 0 value 1013904223\n"
  const operation = { index: 0, first: { ok: { changeId: "klmnopqrstuv", commitId: "a".repeat(128) } }, second: { ok: { changeId: "lmnopqrstuvw", commitId: "b".repeat(128) } }, diff: { ok: { diff: expectedDiff(before) } }, failure: { err: { code: "invalid_ref", command: "jj restore --from kkkkkkkkkkkk", message: 'revision "kkkkkkkkkkkk" doesn\'t exist' } }, restore: { ok: {} }, health: { ok: { diff: "" } }, restoredText: before }
  operation.revisits = Array.from({ length: 3 }, () => ({ target: 0, response: { ok: {} }, restoredText: before, health: { ok: { diff: "" } } }))
  const unicodeLength = Buffer.byteLength('{"op":"snapshot","root":"/repo","message":"文件🚀"}')
  const common = { schemaVersion: 1, status: "passed", seed: 0, requestedCases: 1, executedCases: 1, requestedSteps: 1, executedSteps: 1, healthChecks: 1, requests: [{ index: 0, inputHex: "ff", response: { err: { code: "unknown", command: "jj", message: "jj: malformed request: fixture" } } }], operations: [operation] }
  return {
    native: { ...structuredClone(common), tier: "native" },
    wasm: { ...structuredClone(common), tier: "wasm", wasmSha256: "fixture-wasm", corpusSha256: createHash("sha256").update("ff").digest("hex"), allocations: 10, frees: 10, liveAllocations: 0, openHostFiles: 0, exchanges: 5, initialMemoryBytes: 65536, currentMemoryBytes: 131072, peakMemoryBytes: 131072, peakLiveBytes: 1048577, boundaryLengths: [29, 30, 31], healthChecks: 13 + unicodeLength, truncatedLengths: Array.from({ length: unicodeLength }, (_, index) => index), rejectedAllocations: [2147483648, 4294967295], growthFailures: 1 }
  }
}

test("ABI campaign accepts only bounded unsigned replay parameters", () => {
  assert.deepEqual(campaignConfiguration({}), { seed: 20260904, cases: 5000, steps: 32 })
  assert.equal(campaignConfiguration({ SMITHERS_ABI_SEED: "4294967295" }).seed, 4294967295)
  assert.equal(campaignConfiguration({ SMITHERS_ABI_SEED: "0" }).seed, 0)
  for (const env of [{ SMITHERS_ABI_SEED: "4294967296" }, { SMITHERS_ABI_SEED: "-1" }, { SMITHERS_ABI_CASES: "0" }, { SMITHERS_ABI_CASES: "100001" }, { SMITHERS_ABI_STEPS: "257" }, { SMITHERS_ABI_STEPS: "NaN" }]) assert.throws(() => campaignConfiguration(env), /integer range/)
})

test("complete matching native and WASM execution evidence is accepted", () => {
  const { native, wasm } = fixture()
  assert.equal(verifyCampaign(native, wasm, configuration, "fixture-wasm").corpusSha256, wasm.corpusSha256)
})

test("parser-only evidence must include every requested raw and grammar case", () => {
  const report = { schemaVersion: 1, tier: "parser", status: "passed", seed: 0, requestedCases: 1, executedRawCases: 1, executedGrammarCases: 1 }
  verifyParser(report, configuration)
  for (const key of Object.keys(report)) {
    const incomplete = { ...report }
    delete incomplete[key]
    assert.throws(() => verifyParser(incomplete, configuration), key)
  }
  for (const patch of [{ status: "running" }, { seed: 1 }, { executedRawCases: 0 }, { executedGrammarCases: 0 }, { executedGrammarCases: 2 }]) {
    assert.throws(() => verifyParser({ ...report, ...patch }, configuration))
  }
})

test("missing, truncated, stale and wrong-corpus evidence is refused", () => {
  const changes = [
    ["native", "status", "running"], ["native", "seed", 1], ["native", "executedCases", 0], ["wasm", "executedSteps", 0],
    ["native", "requests", []], ["wasm", "operations", []], ["native", "healthChecks", 0],
    ["wasm", "corpusSha256", "other"], ["wasm", "wasmSha256", "other"], ["wasm", "liveAllocations", 1],
    ["wasm", "openHostFiles", 1], ["wasm", "frees", 9], ["wasm", "peakMemoryBytes", 100000000], ["wasm", "boundaryLengths", [1, 2, 4]],
    ["wasm", "healthChecks", 1], ["wasm", "truncatedLengths", [0]], ["wasm", "rejectedAllocations", []], ["wasm", "growthFailures", 0]
  ]
  for (const [tier, field, value] of changes) {
    const reports = fixture()
    reports[tier][field] = value
    assert.throws(() => verifyCampaign(reports.native, reports.wasm, configuration, "fixture-wasm"), `${tier}.${field}`)
  }
  const { native, wasm } = fixture()
  wasm.requests[0].response.err.message = "jj: malformed request: different diagnostic"
  assert.throws(() => verifyCampaign(native, wasm, configuration, "fixture-wasm"))
  wasm.requests[0].inputHex = "fe"
  assert.throws(() => verifyCampaign(native, wasm, configuration, "fixture-wasm"))
  native.requests[0].response.err.command = "wrong"
  assert.throws(() => verifyCampaign(native, wasm, configuration, "fixture-wasm"))
})

test("every operation requires its complete seeded result and restored file bytes in both tiers", () => {
  const mutations = [
    (op) => { for (const key of Object.keys(op)) delete op[key] },
    (op) => { op.index = 1 },
    (op) => { op.first = { err: {} } },
    (op) => { op.first.ok.extra = true },
    (op) => { op.first.ok.changeId = "ABCDEF123456" },
    (op) => { op.second.ok.changeId = op.first.ok.changeId },
    (op) => { op.second.extra = true },
    (op) => { op.second.ok.changeId = "klmnopqrstuvx" },
    ...["first", "second"].flatMap((snapshot) => [
      (op) => { delete op[snapshot].ok.commitId },
      (op) => { op[snapshot].ok.commitId = "g".repeat(128) },
      (op) => { op[snapshot].ok.commitId = "A".repeat(128) },
      (op) => { op[snapshot].ok.commitId = "a".repeat(127) },
      (op) => { op[snapshot].ok.commitId = "a".repeat(129) },
      (op) => { op[snapshot].ok.commitId = op[snapshot === "first" ? "second" : "first"].ok.commitId }
    ]),
    (op) => { op.diff.ok.diff = "+changed\n" },
    (op) => { op.diff.ok.diff = op.diff.ok.diff.replace("@@ -1,1 +1,2 @@", "@@ -1,2 +1,3 @@") },
    (op) => { op.diff.ok.diff = op.diff.ok.diff.replace(/index [a-f0-9]/, "index 0") },
    (op) => { op.diff.ok.diff = op.diff.ok.diff.replace("1013904223", "1013904224") },
    (op) => { op.diff.ok.extra = true },
    (op) => { op.failure.err.message = "doesn't exist" },
    (op) => { op.failure.err.command = "jj" },
    (op) => { delete op.restore },
    (op) => { op.restore = { err: {} } },
    (op) => { op.health.ok.diff = "+changed\n" },
    (op) => { op.restoredText = op.restoredText.trimEnd() },
    (op) => { op.restoredText = "seed 0 step 0 value 0\n" },
    (op) => { delete op.revisits },
    (op) => { op.revisits.pop() },
    (op) => { op.revisits[0].target = 1 },
    (op) => { op.revisits[1].restoredText += "changed\n" },
    (op) => { op.revisits[2].health.ok.diff = "changed" }
  ]
  for (const tier of ["native", "wasm"]) {
    for (const [index, mutate] of mutations.entries()) {
      const reports = fixture()
      mutate(reports[tier].operations[0])
      assert.throws(() => verifyCampaign(reports.native, reports.wasm, configuration, "fixture-wasm"), `${tier} operation mutation ${index}`)
    }
  }
})

test("campaign preserves existing evidence and refuses reuse before spawning a tier", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-abi-evidence-test-"))
  try {
    await writeFile(join(root, "native.json"), "original evidence")
    await assert.rejects(runCampaign(configuration, root), /Refusing to overwrite/)
    assert.equal(await readFile(join(root, "native.json"), "utf8"), "original evidence")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("missing real WASM artifact fails the executable campaign before native or WASM work can be claimed", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-abi-missing-wasm-"))
  try {
    const executable = await copyCampaign(root)
    const evidence = join(root, "evidence")
    await assert.rejects(promisify(execFile)(process.execPath, [executable], {
      env: { ...process.env, SMITHERS_ABI_SEED: "0", SMITHERS_ABI_CASES: "1", SMITHERS_ABI_STEPS: "1", SMITHERS_ABI_ARTIFACT_DIR: evidence }
    }), /ENOENT/)
    const report = JSON.parse(await readFile(join(evidence, "campaign.json"), "utf8"))
    assert.equal(report.status, "failed")
    assert.match(report.error, /flows_jj\.wasm/)
    await assert.rejects(readFile(join(evidence, "native.json")), { code: "ENOENT" })
    await assert.rejects(readFile(join(evidence, "wasm.json")), { code: "ENOENT" })
  } finally { await rm(root, { recursive: true, force: true }) }
})

// Subscribe before checking so an atomic ready-file rename cannot fall
// between the observation and the wait. The test's cancellation closes it.
//
// The subscription is an accelerator, not the contract. macOS delivers a
// directory watch through an FSEvents stream whose first event can arrive
// seconds after the write while other work touches the same volume, and the
// process cases below budget 20 s for three real scenarios: readiness
// detection alone spent 2.5 s to 19.9 s of that and cancelled them. The poll
// bounds detection at `pollMs` no matter what the stream delivers, and the
// injectable watcher lets a case prove the poll carries the contract alone.
const whenCreated = (path, signal, { watcher = watch, pollMs = 50 } = {}) => new Promise((resolve, reject) => {
  signal.throwIfAborted()
  // Callback-style watch subscribes synchronously. An async iterator would
  // not subscribe until next(), leaving a gap after a failed initial read.
  const changes = watcher(dirname(path), { signal }, () => { void check() })
  const polling = setInterval(() => { void check() }, pollMs)
  const stop = () => { clearInterval(polling); changes.close() }
  const failed = (error) => { stop(); reject(error) }
  changes.once("error", failed)
  changes.once("close", () => { if (signal.aborted) failed(signal.reason) })
  async function check() {
    if (signal.aborted) return failed(signal.reason)
    try {
      const contents = await readFile(path, "utf8")
      stop()
      resolve(contents)
    } catch (error) {
      if (error.code !== "ENOENT") failed(error)
    }
  }
  void check()
})

test("readiness survives a watch that never delivers an event", { timeout: 10_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "smithers-abi-readiness-"))
  try {
    const target = join(root, "ready")
    // A stalled FSEvents stream, exactly: subscribed, never delivering. Only
    // the poll can see a file that appears after the subscription.
    const stalled = { once: () => {}, close: () => {} }
    const created = whenCreated(target, context.signal, { watcher: () => stalled, pollMs: 5 })
    await writeFile(target, "ready")
    assert.equal(await created, "ready")
  } finally { await rm(root, { recursive: true, force: true }) }
})
const alive = async (pid) => {
  try { process.kill(pid, 0) }
  catch (error) { if (error.code === "ESRCH") return false; throw error }
  // An orphan awaiting init's reap has exited and cannot retain resources.
  if (process.platform === "linux") {
    try { if (/^\d+ \(.*\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"))) return false }
    catch (error) { if (error.code === "ENOENT") return false; throw error }
  }
  return true
}

// IPC establishes readiness; the interval keeps the descendant alive after
// its leader disconnects. Inherited pipes make successful campaign completion
// wait for worker death. The negative control closes those pipes so leader-only
// cleanup can settle, and reads SMITHERS_ORPHAN_FILE: the worker publishes its
// pid there only from a tick that runs after it observed the disconnect, and
// publishes the sibling .exited path from its exit handler. Racing the two
// decides whether the descendant outlived its leader without any sleep.
const writeTier = async (cargo, workerStdio = "inherit") => {
  await writeFile(cargo, `#!${process.execPath}\nconst {spawn}=require('node:child_process');const fs=require('node:fs');process.on('SIGTERM',()=>{});const worker=spawn(process.execPath,['-e',"const fs=require('node:fs');process.on('SIGTERM',()=>{});process.on('message',()=>{});const orphan=process.env.SMITHERS_ORPHAN_FILE;let disconnected=false;process.on('disconnect',()=>{disconnected=true});process.on('exit',()=>{if(orphan)fs.writeFileSync(orphan+'.exited',String(process.pid))});setInterval(()=>{if(!disconnected||!orphan)return;fs.writeFileSync(orphan+'.tmp',String(process.pid));fs.renameSync(orphan+'.tmp',orphan)},50);process.send('ready')"],{stdio:['ignore','${workerStdio}','${workerStdio}','ipc']});worker.once('message',()=>{const path=process.env.SMITHERS_OWNED_PID_FILE;fs.writeFileSync(path+'.tmp',JSON.stringify({leader:process.pid,worker:worker.pid}));fs.renameSync(path+'.tmp',path)});\n`)
  await chmod(cargo, 0o755)
}

const assertRetired = async (pids) => {
  assert.equal(await alive(pids.leader), false, "owned tier survived campaign exit")
  assert.equal(await alive(pids.worker), false, "owned descendant survived campaign exit")
}

// Use the actual production runner with its group flag disabled. The negative
// control must fail the same liveness oracle used by the executable tests.
const rejectLeaderOnlyCleanup = async (context) => {
  const root = await mkdtemp(join(tmpdir(), "smithers-abi-negative-"))
  const controller = new AbortController()
  let pids
  let completion
  try {
    const source = await readFile(new URL("run-jj-abi-campaign.mjs", import.meta.url), "utf8")
    const runner = source.match(/const run = ([\s\S]+?)\n\nexport const runCampaign/)[1]
    const flag = 'const grouped = process.platform !== "win32"'
    assert.equal(runner.split(flag).length, 2, "negative control must replace exactly one group flag")
    const run = runInNewContext(
      `(${runner.replace(flag, "const grouped = false")})`,
      { spawn, createWriteStream, process, setTimeout, clearTimeout, Error }
    )
    const cargo = join(root, "cargo")
    const pidPath = join(root, "pids.json")
    const orphanPath = join(root, "orphan")
    await writeTier(cargo, "ignore")
    const interrupted = new Error("negative control interruption")
    completion = run(cargo, [], root, { ...process.env, SMITHERS_OWNED_PID_FILE: pidPath, SMITHERS_ORPHAN_FILE: orphanPath }, join(root, "tier.log"), controller.signal)
      .then(() => assert.fail("interrupted runner succeeded"), (error) => assert.equal(error, interrupted))
    pids = JSON.parse(await whenCreated(pidPath, context.signal))
    controller.abort(interrupted)
    await completion
    assert.equal(await alive(pids.leader), false)
    // Race the worker's post-disconnect tick against its own exit record. The
    // tick can only be written by a worker that is still executing after its
    // leader died, so winning that race is the barrier; a worker that merely
    // held the IPC channel loses it by exiting, and says so instead of hanging.
    const barrier = new AbortController()
    const settled = AbortSignal.any([context.signal, barrier.signal])
    const survived = whenCreated(orphanPath, settled)
    const exited = whenCreated(`${orphanPath}.exited`, settled)
    let outcome
    try {
      outcome = await Promise.race([survived.then((pid) => Number(pid)), exited.then(() => null)])
    } finally {
      barrier.abort(new Error("descendant liveness barrier settled"))
      await Promise.allSettled([survived, exited])
    }
    assert.equal(outcome, pids.worker, "owned descendant exited with its leader instead of surviving it")
    assert.equal(await alive(pids.worker), true, "negative control needs an independently live worker")
    await assert.rejects(assertRetired(pids), /owned descendant survived campaign exit/)
  } finally {
    if (pids) {
      for (const pid of Object.values(pids)) {
        try { process.kill(pid, "SIGKILL") }
        catch (error) { if (error.code !== "ESRCH") throw error }
      }
    }
    controller.abort()
    await completion
    await rm(root, { recursive: true, force: true })
  }
}

const verifyCompletionCleanup = async (context) => {
  const root = await mkdtemp(join(tmpdir(), "smithers-abi-completion-"))
  const controller = new AbortController()
  let socket
  let completion
  const connected = Promise.withResolvers()
  const outcome = Promise.withResolvers()
  const server = createServer((connection) => {
    socket = connection
    socket.on("data", () => outcome.resolve("worker executed after run resolved"))
    socket.once("close", () => outcome.resolve("worker connection closed"))
    socket.on("error", (error) => {
      if (error.code !== "ECONNRESET" && error.code !== "EPIPE") outcome.reject(error)
    })
    connected.resolve()
  })
  const cancelled = () => { socket?.destroy(); server.close() }
  context.signal.addEventListener("abort", cancelled, { once: true })
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const source = await readFile(new URL("run-jj-abi-campaign.mjs", import.meta.url), "utf8")
    const runner = source.match(/const run = ([\s\S]+?)\n\nexport const runCampaign/)[1]
    const run = runInNewContext(`(${runner})`, { spawn, createWriteStream, process, setTimeout, clearTimeout, Error })
    // The socket keeps the worker alive independently of IPC and stdio. Its
    // connect acknowledgement lets the leader exit successfully without a sleep.
    const worker = `const net=require('node:net');const socket=net.createConnection({port:Number(process.env.SMITHERS_WORKER_PORT),host:'127.0.0.1'},()=>process.send('ready'));socket.on('data',()=>socket.write('pong'));`
    const leader = `const {spawn}=require('node:child_process');const fs=require('node:fs');const worker=spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:['ignore','ignore','ignore','ipc']});worker.once('message',()=>{fs.writeFileSync(process.env.SMITHERS_WORKER_PID,String(worker.pid));process.exit(0)});`
    completion = run(process.execPath, ["-e", leader], root, {
      ...process.env,
      SMITHERS_WORKER_PORT: String(server.address().port),
      SMITHERS_WORKER_PID: join(root, "worker.pid")
    }, join(root, "tier.log"), AbortSignal.any([context.signal, controller.signal]))
    await completion
    await connected.promise
    // Only the test writes the ping, strictly after production run() resolves.
    // A pong proves post-completion execution; socket closure proves retirement
    // without confusing a dead process awaiting reap with a running worker.
    socket.write("ping", () => {})
    assert.equal(await outcome.promise, "worker connection closed")
  } finally {
    context.signal.removeEventListener("abort", cancelled)
    controller.abort()
    await completion?.catch(() => {})
    socket?.destroy()
    await new Promise((resolve) => server.close(resolve))
    try {
      const pid = Number(await readFile(join(root, "worker.pid"), "utf8"))
      process.kill(pid, "SIGKILL")
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error }
    await rm(root, { recursive: true, force: true })
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} interrupts a real running tier, retires its process group and records interruption`, { skip: process.platform === "win32", timeout: 20000 }, async (context) => {
    if (signal === "SIGINT") {
      await context.test("normal completion retires an independently live worker before run resolves", verifyCompletionCleanup)
      await context.test("descendant oracle rejects production run with leader-only cleanup", rejectLeaderOnlyCleanup)
    }
    const root = await mkdtemp(join(tmpdir(), "smithers-abi-interruption-"))
    let parent
    let pids
    const startup = new AbortController()
    try {
      const executable = await copyCampaign(root)
      await mkdir(join(root, "bin"))
      await mkdir(join(root, "packages/smithers/flows/jj/wasm"), { recursive: true })
      await writeFile(join(root, "packages/smithers/flows/jj/wasm/flows_jj.wasm"), "fixture bytes, never instantiated")
      const evidence = join(root, "evidence")
      const pidPath = join(root, "owned-processes.json")
      const cargo = join(root, "bin", "cargo")
      // The worker acknowledges its installed signal handler over IPC. Only
      // then does the leader publish readiness, without a startup sleep.
      await writeTier(cargo)
      parent = spawn(process.execPath, [executable], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, SMITHERS_OWNED_PID_FILE: pidPath, SMITHERS_ABI_SEED: "0", SMITHERS_ABI_CASES: "1", SMITHERS_ABI_STEPS: "1", SMITHERS_ABI_ARTIFACT_DIR: evidence } })
      let output = ""
      parent.stdout.on("data", (bytes) => { output += bytes })
      parent.stderr.on("data", (bytes) => { output += bytes })
      const completion = new Promise((resolve, reject) => { parent.once("error", reject); parent.once("close", (code, stoppedBy) => resolve({ code, stoppedBy })) })
      pids = JSON.parse(await Promise.race([
        whenCreated(pidPath, AbortSignal.any([context.signal, startup.signal])),
        completion.then((result) => assert.fail(`Campaign exited before tier readiness: ${JSON.stringify(result)}\n${output}`))
      ]))
      assert.equal(await alive(pids.leader), true)
      assert.equal(await alive(pids.worker), true)
      parent.kill(signal)
      assert.deepEqual(await completion, { code: signal === "SIGINT" ? 130 : 143, stoppedBy: null }, output)
      await assertRetired(pids)
      const report = JSON.parse(await readFile(join(evidence, "campaign.json"), "utf8"))
      assert.equal(report.status, "interrupted")
      assert.equal(report.signal, signal)
      assert.match(report.error, new RegExp(`interrupted by ${signal}`))
      assert.equal(report.nativeEvidenceSha256, undefined)
      await assert.rejects(readFile(join(evidence, "native.json")), { code: "ENOENT" })
      await assert.rejects(readFile(join(evidence, "wasm.log")), { code: "ENOENT" })
    } finally {
      startup.abort()
      if (parent && parent.exitCode === null) parent.kill("SIGKILL")
      if (pids) {
        try { process.kill(-pids.leader, "SIGKILL") }
        catch (error) { if (error.code !== "ESRCH") throw error }
      }
      await rm(root, { recursive: true, force: true })
    }
  })
}
