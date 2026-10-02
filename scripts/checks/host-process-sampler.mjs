#!/usr/bin/env node
// C-SEC-02: sample only the supplied install's descendants. This script never
// reads a repository or sends a signal to a sampled process.
import { appendFile, mkdir } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { parseArgs } from "node:util"
import { join } from "node:path"

const { values } = parseArgs({ options: {
  pid: { type: "string" }, output: { type: "string" }, interval: { type: "string", default: "250" }
} })
const pid = Number(values.pid), interval = Number(values.interval)
if (!Number.isSafeInteger(pid) || pid <= 1 || !values.output || !Number.isSafeInteger(interval) || interval < 25) {
  throw new Error("usage: host-process-sampler.mjs --pid <launcher pid> --output <evidence dir> [--interval 250]")
}
const exec = promisify(execFile)
await mkdir(values.output, { recursive: true })
let stopping = false
process.on("SIGTERM", () => { stopping = true })
process.on("SIGINT", () => { stopping = true })
while (!stopping) {
  const at = new Date().toISOString()
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,uid=,command="], { maxBuffer: 16 * 1024 * 1024 })
  const rows = stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), command: match[4] }] : []
  })
  const descendants = new Set([pid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid)
        changed = true
      }
    }
  }
  const processes = rows.filter((row) => descendants.has(row.pid))
  await appendFile(join(values.output, "process-samples.jsonl"), `${JSON.stringify({ at, root: pid, processes })}\n`)
  for (const row of processes) {
    if (!/(?:^|\/)(?:node|bun|smithers-[^ /]+)(?:\s|$)/.test(row.command.split(" ")[0])) continue
    // Exited processes and lsof permission errors remain evidence, rather than
    // turning an incomplete observation into an empty successful sample.
    const result = await exec("lsof", ["-p", String(row.pid), "-Fn"], { maxBuffer: 16 * 1024 * 1024 })
      .then(({ stdout, stderr }) => ({ stdout, stderr, exitCode: 0 }))
      .catch((error) => ({ stdout: error.stdout ?? "", stderr: error.stderr || error.message, exitCode: error.code }))
    await appendFile(join(values.output, "lsof-samples.jsonl"), `${JSON.stringify({ at, ...row, ...result })}\n`)
  }
  if (!processes.some((row) => row.pid === pid)) break
  await new Promise((resolve) => setTimeout(resolve, interval))
}
