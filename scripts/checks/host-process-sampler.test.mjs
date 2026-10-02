import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const sampler = fileURLToPath(new URL("./host-process-sampler.mjs", import.meta.url))

const within = async (promise, milliseconds, description) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), milliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

const waitFor = async (observe, description) => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const result = await observe()
    if (result) return result
    await delay(40)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

const readSamples = async (directory, file) => {
  let contents
  try {
    contents = await readFile(join(directory, file), "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
  // A concurrent append may not yet have written its final newline.
  return contents.slice(0, contents.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(JSON.parse)
}

const fixture = async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), `flw-sampler-${randomUUID()}-`)))
  const processes = []
  const launch = (args, options = {}) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], ...options })
    let stdout = "", stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    const completed = new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve({ code, signal }))
    })
    const running = { child, completed, stdout: () => stdout, stderr: () => stderr }
    processes.push(running)
    return running
  }
  const stop = async (running) => {
    if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGTERM")
    try {
      return await within(running.completed, 5_000, `owned process ${running.child.pid} to stop`)
    } catch (error) {
      running.child.kill("SIGKILL")
      await running.completed
      throw error
    }
  }
  t.after(async () => {
    try {
      for (const running of processes.toReversed()) await stop(running)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  const file = join(directory, "repository", "flows", "canary", "flow.ts")
  await mkdir(join(directory, "repository", "flows", "canary"), { recursive: true })
  await writeFile(file, "// Retained open file: lsof positive control.\n")
  return { directory, file, launch, stop }
}

// All fixtures carry a unique argument in their actual process command.
const holder = (role) => `const fs=require("node:fs");const fd=fs.openSync(process.argv[2],"r");` +
  `process.stdout.write(JSON.stringify({role:${JSON.stringify(role)},pid:process.pid})+"\\n");` +
  `setInterval(()=>fs.fstatSync(fd),1000);process.on("SIGTERM",()=>{fs.closeSync(fd);process.exit(0)})`

const ready = (running, role) => waitFor(async () => {
  const records = running.stdout().split("\n").filter(Boolean).map(JSON.parse)
  const record = records.find((record) => record.role === role)
  if (record) return record
  if (running.child.exitCode !== null || running.child.signalCode !== null) {
    throw new Error(`Fixture exited before ${role} was ready: ${running.stderr()}`)
  }
}, role)

test("samples a real launcher and child with exact open-file evidence and excludes a live sibling", async (t) => {
  const { directory, file, launch, stop } = await fixture(t)
  const token = `flw-sampler-parent-${randomUUID()}`
  const parentCode = `const fs=require("node:fs");const fd=fs.openSync(process.argv[2],"r");` +
    `const child=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(holder("descendant"))},process.argv[1]+"-child",process.argv[2]],{stdio:["ignore","pipe","inherit"]});` +
    `child.stdout.pipe(process.stdout);process.stdout.write(JSON.stringify({role:"launcher",pid:process.pid})+"\\n");` +
    `setInterval(()=>fs.fstatSync(fd),1000);process.on("SIGTERM",()=>{child.kill("SIGTERM");child.once("exit",()=>{fs.closeSync(fd);process.exit(0)})})`
  const parent = launch(["-e", parentCode, token, file])
  const launcher = await ready(parent, "launcher"), descendant = await ready(parent, "descendant")
  const sibling = launch(["-e", holder("sibling"), `flw-sampler-sibling-${randomUUID()}`, file])
  await ready(sibling, "sibling")
  const output = join(directory, "evidence")
  const sampling = launch([sampler, "--pid", String(launcher.pid), "--output", output, "--interval", "25"])
  await waitFor(async () => {
    const samples = await readSamples(output, "lsof-samples.jsonl")
    return [launcher.pid, descendant.pid].every((pid) => samples.some((sample) =>
      sample.pid === pid && sample.exitCode === 0 && sample.stdout.split("\n").includes(`n${file}`)))
  }, "real lsof evidence from both fixture processes")
  assert.deepEqual(await stop(sampling), { code: 0, signal: null }, sampling.stderr())
  // Stopping observation must leave the sampled processes and their sibling alive.
  for (const pid of [launcher.pid, descendant.pid, sibling.child.pid]) assert.doesNotThrow(() => process.kill(pid, 0))
  const processes = await readSamples(output, "process-samples.jsonl")
  assert.ok(processes.length > 0)
  assert.ok(processes.every((sample) => sample.root === launcher.pid))
  const childRecord = processes.flatMap((sample) => sample.processes).find((row) => row.pid === descendant.pid)
  assert.ok(childRecord)
  assert.equal(childRecord.ppid, launcher.pid)
  assert.ok(childRecord.command.includes(`${token}-child`))
  assert.ok(processes.every((sample) => !sample.processes.some((row) => row.pid === sibling.child.pid)))
  const files = await readSamples(output, "lsof-samples.jsonl")
  assert.ok(files.every((sample) => sample.pid !== sibling.child.pid))
})

test("records a real lsof spawn failure instead of reporting empty successful evidence", async (t) => {
  const { directory, file, launch, stop } = await fixture(t)
  const root = launch(["-e", holder("launcher"), `flw-sampler-failure-${randomUUID()}`, file])
  await ready(root, "launcher")
  const tools = join(directory, "real-ps-only")
  await mkdir(tools)
  const located = spawnSync("which", ["ps"], { encoding: "utf8" })
  assert.equal(located.status, 0, located.stderr)
  // Invoke the actual ps executable. lsof is genuinely unavailable in this PATH.
  await symlink(located.stdout.trim(), join(tools, "ps"))
  const output = join(directory, "failure-evidence")
  const sampling = launch([sampler, "--pid", String(root.child.pid), "--output", output, "--interval", "25"], {
    env: { ...process.env, PATH: tools }
  })
  const failure = await waitFor(async () =>
    (await readSamples(output, "lsof-samples.jsonl")).find((sample) => sample.pid === root.child.pid),
  "a real exec failure receipt")
  assert.equal(failure.exitCode, "ENOENT")
  assert.equal(failure.stdout, "")
  assert.match(failure.stderr, /lsof.*ENOENT/)
  assert.deepEqual(await stop(sampling), { code: 0, signal: null }, sampling.stderr())
})

test("rejects malformed CLI arguments before creating the evidence directory", async (t) => {
  const { directory } = await fixture(t)
  const cases = [
    [], ["--pid", "1"], ["--pid", "0"], ["--pid", "-2"], ["--pid=-2"], ["--pid", "1.5"], ["--pid", "NaN"],
    ["--pid", String(process.pid), "--interval", "24"],
    ["--pid", String(process.pid), "--interval", "1.5"],
    ["--pid", String(process.pid), "--interval", "NaN"],
    ["--pid", String(process.pid), "--unknown"]
  ]
  for (const [index, args] of cases.entries()) {
    const output = join(directory, `invalid-${index}`)
    const result = spawnSync(process.execPath, [sampler, ...args, "--output", output], { encoding: "utf8" })
    assert.equal(result.status, 1, JSON.stringify(args))
    assert.match(result.stderr, /usage:|ERR_PARSE_ARGS_/)
    await assert.rejects(access(output), { code: "ENOENT" })
  }
  const missingOutput = spawnSync(process.execPath, [sampler, "--pid", String(process.pid)], { encoding: "utf8" })
  assert.equal(missingOutput.status, 1)
  assert.match(missingOutput.stderr, /usage:/)
})

test("ends observation on its own when the supplied launcher exits", async (t) => {
  const { directory, file, launch, stop } = await fixture(t)
  const root = launch(["-e", holder("launcher"), `flw-sampler-exiting-${randomUUID()}`, file])
  await ready(root, "launcher")
  const output = join(directory, "exit-evidence")
  const sampling = launch([sampler, "--pid", String(root.child.pid), "--output", output, "--interval", "25"])
  await waitFor(async () => (await readSamples(output, "process-samples.jsonl"))
    .some((sample) => sample.processes.some((row) => row.pid === root.child.pid)), "the launcher sample")
  await stop(root)
  const completed = await within(sampling.completed, 10_000, "sampler to notice the launcher exit")
  assert.deepEqual(completed, { code: 0, signal: null }, sampling.stderr())
  const samples = await readSamples(output, "process-samples.jsonl")
  assert.equal(samples.at(-1).root, root.child.pid)
  assert.equal(samples.at(-1).processes.some((row) => row.pid === root.child.pid), false)
})
